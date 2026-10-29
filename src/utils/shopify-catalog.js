/**
 * Shopify storefront catalog (UCP)
 *
 * Recharge's GET /products only works on Recharge "Custom" stores; on Shopify
 * Checkout Integration stores it returns 422 ("This API is not compatible with
 * your platform"). Verified adds instead read the variant from Shopify's
 * public UCP storefront MCP endpoint (no token), calling its lookup_catalog
 * tool with the server's UCP agent profile and the shipping country.
 *
 * find_addable_product can also call its search_catalog tool when the
 * customer's words don't name an addable product; only the ranked product IDs
 * and titles are kept from a search, never its prices or variants.
 *
 * Only IDs, titles, price, currency and availability are kept from the
 * response. Descriptions, media and URLs are dropped here and never returned
 * or logged.
 */

// lookup_catalog rejects more than 10 IDs per call ("array size at `/catalog/ids` is greater than: 10")
export const CATALOG_LOOKUP_CHUNK = 10;
export const DEFAULT_CATALOG_TIMEOUT_MS = 8000;
// Longest search query sent to search_catalog (find_addable_product caps the query at 100 too)
export const CATALOG_SEARCH_MAX_QUERY = 100;
// Most search results asked for in one call (search_catalog's own default page size)
export const CATALOG_SEARCH_MAX_LIMIT = 10;

const VARIANT_GID = 'gid://shopify/ProductVariant/';
// A remote error code is only kept for DEBUG logs when it is a short plain token
const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/i;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/(\d+)$/;

function catalogError(message, { statusCode = null, code = 'catalog_error' } = {}) {
  const error = new Error(message);
  error.name = 'ShopifyCatalogError';
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/**
 * A URL the server may call or send as its profile: https only, no credentials.
 */
function httpsUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/**
 * MCP_SHOPIFY_UCP_URL and MCP_UCP_AGENT_PROFILE: both must be https URLs.
 * Unset (both) is not configured; anything else that is not valid disables
 * the catalog with a warning naming the variable only.
 */
export function parseShopifyCatalogConfig(rawEndpoint, rawProfile) {
  const isSet = value => value !== undefined && value !== null && String(value).trim() !== '';
  if (!isSet(rawEndpoint) && !isSet(rawProfile)) {
    return { config: null, warnings: [] };
  }
  const warnings = [];
  const endpoint = isSet(rawEndpoint) ? httpsUrl(rawEndpoint) : null;
  const profileUrl = isSet(rawProfile) ? httpsUrl(rawProfile) : null;
  for (const [name, raw, value] of [['MCP_SHOPIFY_UCP_URL', rawEndpoint, endpoint], ['MCP_UCP_AGENT_PROFILE', rawProfile, profileUrl]]) {
    if (!isSet(raw)) {
      warnings.push(`${name} is not set; adding products is disabled`);
    } else if (!value) {
      warnings.push(`${name} must be an https URL; adding products is disabled`);
    }
  }
  return { config: warnings.length === 0 ? { endpoint, profileUrl } : null, warnings };
}

/**
 * Minor-unit digits of an ISO 4217 currency (USD 2, JPY 0); null if unknown.
 */
export function currencyFractionDigits(currency) {
  if (!/^[A-Z]{3}$/.test(String(currency || ''))) {
    return null;
  }
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return null;
  }
}

/**
 * The JSON-RPC response from a plain JSON body or an SSE body ("data: {...}"
 * lines, one event per blank-line-separated block).
 */
function parseRpcBody(text) {
  const body = String(text || '').trim();
  if (body.startsWith('{')) {
    return JSON.parse(body);
  }
  const events = body.split(/\r?\n\r?\n/).map(block => block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n'))
    .filter(Boolean);
  for (const data of events) {
    const message = JSON.parse(data);
    if (message && (message.result !== undefined || message.error !== undefined)) {
      return message;
    }
  }
  throw new Error('no JSON-RPC response in event stream');
}

/**
 * lookup_catalog's result: structuredContent, or the same object as JSON text
 */
function lookupContent(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = Array.isArray(result && result.content)
    ? result.content.find(item => item && item.type === 'text' && typeof item.text === 'string')
    : undefined;
  return text ? JSON.parse(text.text) : null;
}

export function createShopifyCatalog({ endpoint, profileUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_CATALOG_TIMEOUT_MS }) {
  if (!httpsUrl(endpoint) || !httpsUrl(profileUrl)) {
    throw new Error('Shopify catalog endpoint and agent profile must be https URLs');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Shopify catalog needs a fetch implementation');
  }
  let nextId = 1;

  /**
   * One tools/call to the UCP endpoint; `action` ("lookup" or "search") only
   * names the call in error messages. Returns the result's products list.
   */
  async function call(tool, catalogArgs, action) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'tools/call',
          params: {
            name: tool,
            arguments: {
              meta: { 'ucp-agent': { profile: profileUrl } },
              catalog: catalogArgs,
            },
          },
        }),
        signal: controller.signal,
        // The https check on the endpoint only covers the first hop: a redirect fails closed
        redirect: 'error',
      });
      if (!response || !response.ok) {
        throw catalogError(`Catalog ${action} failed with HTTP ${response && response.status}`, {
          statusCode: (response && response.status) || null,
          code: 'http_error',
        });
      }
      text = await response.text();
    } catch (error) {
      if (error && error.name === 'ShopifyCatalogError') {
        throw error;
      }
      const timedOut = controller.signal.aborted;
      throw catalogError(timedOut ? `Catalog ${action} timed out` : `Catalog ${action} request failed`, {
        code: timedOut ? 'timeout' : 'network_error',
      });
    } finally {
      clearTimeout(timer);
    }

    let message;
    let content;
    try {
      message = parseRpcBody(text);
      if (message && message.error) {
        const raw = (message.error.data && message.error.data.code) || message.error.code;
        const code = (typeof raw === 'string' || typeof raw === 'number') && SAFE_CODE.test(String(raw)) ? String(raw) : 'rpc_error';
        throw catalogError(`Catalog ${action} returned JSON-RPC error ${code}`, { code });
      }
      if (!message || !message.result || message.result.isError === true) {
        throw catalogError(`Catalog ${action} returned a tool error`, { code: 'tool_error' });
      }
      content = lookupContent(message.result);
    } catch (error) {
      if (error && error.name === 'ShopifyCatalogError') {
        throw error;
      }
      throw catalogError(`Catalog ${action} response could not be read`, { code: 'unparseable' });
    }
    if (!content || !Array.isArray(content.products)) {
      throw catalogError(`Catalog ${action} response had no products list`, { code: 'unparseable' });
    }
    // Only "info" messages (e.g. not_found for an unknown ID) are expected; a warning or error
    // (say, a country priced from another market) means the prices can't be trusted, and a
    // search answered with one is treated the same way
    if (content.messages !== undefined && content.messages !== null &&
        (!Array.isArray(content.messages) || content.messages.some(item => !item || item.type !== 'info'))) {
      throw catalogError(`Catalog ${action} returned a warning or error message`, { code: 'catalog_message' });
    }
    return content.products;
  }

  /**
   * Shopify variant ID (digits) -> { productId, productTitle, variantTitle,
   * unitPrice, currency, available } for the variants the catalog returned
   * as exact matches, priced for the given country. Unknown IDs are absent.
   */
  async function lookupVariants(variantIds, country) {
    if (!/^[A-Z]{2}$/.test(String(country || ''))) {
      throw catalogError('Catalog lookup needs an ISO 3166-1 alpha-2 country', { code: 'invalid_country' });
    }
    const ids = [...new Set((variantIds || []).map(id => String(id ?? '').trim()))];
    if (ids.some(id => !/^\d+$/.test(id))) {
      throw catalogError('Catalog lookup variant IDs must be digits', { code: 'invalid_id' });
    }

    // Chunks are looked up in parallel; any failed chunk fails the whole lookup
    const chunks = [];
    for (let start = 0; start < ids.length; start += CATALOG_LOOKUP_CHUNK) {
      chunks.push(new Set(ids.slice(start, start + CATALOG_LOOKUP_CHUNK).map(id => `${VARIANT_GID}${id}`)));
    }
    const responses = await Promise.all(chunks.map(requested =>
      call('lookup_catalog', { ids: [...requested], context: { address_country: country } }, 'lookup')));

    const found = new Map();
    const conflicting = new Set();
    for (const [index, requested] of chunks.entries()) {
      for (const product of responses[index]) {
        const productMatch = PRODUCT_GID.exec(String((product && product.id) || ''));
        for (const variant of (product && Array.isArray(product.variants) ? product.variants : [])) {
          const gid = String((variant && variant.id) || '');
          if (!requested.has(gid)) {
            continue;
          }
          // When the catalog says how it matched an input, only an exact match on this ID counts
          if (Array.isArray(variant.inputs) && variant.inputs.length > 0 &&
              !variant.inputs.some(input => input && input.id === gid && input.match === 'exact')) {
            continue;
          }
          const id = gid.slice(VARIANT_GID.length);
          if (found.has(id)) {
            // The same variant under two products is ambiguous: drop it
            conflicting.add(id);
            continue;
          }
          const currency = String((variant.price && variant.price.currency) || '');
          const amount = variant.price ? variant.price.amount : undefined;
          const digits = currencyFractionDigits(currency);
          found.set(id, {
            productId: productMatch ? productMatch[1] : null,
            productTitle: String(product.title ?? ''),
            variantTitle: String(variant.title ?? ''),
            // Minor units -> major units; anything unreadable is NaN, never 0
            unitPrice: Number.isSafeInteger(amount) && amount >= 0 && digits !== null ? amount / 10 ** digits : NaN,
            currency,
            available: Boolean(variant.availability) && variant.availability.available === true,
          });
        }
      }
    }
    for (const id of conflicting) {
      found.delete(id);
    }
    return found;
  }

  /**
   * Shopify's ranked search for the query in the given country: up to `limit`
   * { productId, title } in Shopify's order, products only (no prices,
   * variants or descriptions). The query is sent as typed (whitespace
   * collapsed, capped at CATALOG_SEARCH_MAX_QUERY characters). Never cached.
   * Any of those results without a product ID or title fails the search;
   * a repeated product ID is skipped.
   */
  async function searchProducts(query, country, limit) {
    if (!/^[A-Z]{2}$/.test(String(country || ''))) {
      throw catalogError('Catalog search needs an ISO 3166-1 alpha-2 country', { code: 'invalid_country' });
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_SEARCH_MAX_LIMIT) {
      throw catalogError(`Catalog search limit must be a whole number from 1 to ${CATALOG_SEARCH_MAX_LIMIT}`, { code: 'invalid_limit' });
    }
    // Control characters are dropped; anything else is Shopify's to interpret
    const text = String(query ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CATALOG_SEARCH_MAX_QUERY).trim();
    if (!text) {
      throw catalogError('Catalog search needs a query', { code: 'invalid_query' });
    }

    const products = await call('search_catalog', {
      query: text,
      context: { address_country: country },
      pagination: { limit },
    }, 'search');

    const results = [];
    const seen = new Set();
    // Only the first `limit` results count, even if the endpoint returned more
    for (const product of products.slice(0, limit)) {
      const productMatch = PRODUCT_GID.exec(String((product && product.id) || ''));
      // An entry without a product ID or title may be the product ranked first: the ranking can't be read
      if (!productMatch || typeof product.title !== 'string' || !product.title.trim()) {
        throw catalogError('Catalog search response could not be read', { code: 'unparseable' });
      }
      if (seen.has(productMatch[1])) {
        continue;
      }
      seen.add(productMatch[1]);
      results.push({ productId: productMatch[1], title: String(product.title ?? '') });
    }
    return results;
  }

  // The endpoint and agent profile are part of the find_addable_product cache key
  return { endpoint: httpsUrl(endpoint), profileUrl: httpsUrl(profileUrl), lookupVariants, searchProducts };
}
