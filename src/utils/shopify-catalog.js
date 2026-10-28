/**
 * Shopify storefront catalog (UCP)
 *
 * Recharge's GET /products only works on Recharge "Custom" stores; on Shopify
 * Checkout Integration stores it returns 422 ("This API is not compatible with
 * your platform"). Verified adds instead read the variant from Shopify's
 * public UCP storefront MCP endpoint (no token), calling its lookup_catalog
 * tool with the server's UCP agent profile and the shipping country.
 *
 * Only IDs, titles, price, currency and availability are kept from the
 * response. Descriptions, media and URLs are dropped here and never returned
 * or logged.
 */

export const CATALOG_LOOKUP_CHUNK = 50;
export const DEFAULT_CATALOG_TIMEOUT_MS = 8000;

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

  async function call(gids, country) {
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
            name: 'lookup_catalog',
            arguments: {
              meta: { 'ucp-agent': { profile: profileUrl } },
              catalog: { ids: gids, context: { address_country: country } },
            },
          },
        }),
        signal: controller.signal,
        // The https check on the endpoint only covers the first hop: a redirect fails closed
        redirect: 'error',
      });
      if (!response || !response.ok) {
        throw catalogError(`Catalog lookup failed with HTTP ${response && response.status}`, {
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
      throw catalogError(timedOut ? 'Catalog lookup timed out' : 'Catalog lookup request failed', {
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
        throw catalogError(`Catalog lookup returned JSON-RPC error ${code}`, { code });
      }
      if (!message || !message.result || message.result.isError === true) {
        throw catalogError('Catalog lookup returned a tool error', { code: 'tool_error' });
      }
      content = lookupContent(message.result);
    } catch (error) {
      if (error && error.name === 'ShopifyCatalogError') {
        throw error;
      }
      throw catalogError('Catalog lookup response could not be read', { code: 'unparseable' });
    }
    if (!content || !Array.isArray(content.products)) {
      throw catalogError('Catalog lookup response had no products list', { code: 'unparseable' });
    }
    // Only "info" messages (e.g. not_found for an unknown ID) are expected; a warning or error
    // (say, a country priced from another market) means the prices can't be trusted
    if (content.messages !== undefined && content.messages !== null &&
        (!Array.isArray(content.messages) || content.messages.some(item => !item || item.type !== 'info'))) {
      throw catalogError('Catalog lookup returned a warning or error message', { code: 'catalog_message' });
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

    const found = new Map();
    const conflicting = new Set();
    for (let start = 0; start < ids.length; start += CATALOG_LOOKUP_CHUNK) {
      const chunk = ids.slice(start, start + CATALOG_LOOKUP_CHUNK);
      const requested = new Set(chunk.map(id => `${VARIANT_GID}${id}`));
      for (const product of await call([...requested], country)) {
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

  return { lookupVariants };
}
