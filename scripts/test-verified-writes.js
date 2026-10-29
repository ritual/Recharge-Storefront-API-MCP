#!/usr/bin/env node

/**
 * Tests for verified quantity changes and added products
 *
 * No network: the client's makeAdminRequest is replaced by an in-memory
 * router that records every call, the Shopify catalog gets a fake fetch that
 * serves records in the live UCP lookup_catalog shape, and the server is
 * spawned with fake credentials, an unreachable RECHARGE_API_URL and an empty
 * working directory (so no .env is loaded). Every refusal asserts that no
 * POST or PUT was sent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RechargeClient } from '../src/recharge-client.js';
import { RechargeAPIError, handleAPIError } from '../src/utils/error-handler.js';
import { CATALOG_SEARCH_MAX_QUERY, createShopifyCatalog, parseShopifyCatalogConfig } from '../src/utils/shopify-catalog.js';
import {
  INTERPRETED_MAX_PRODUCTS,
  INTERPRETED_SEARCH_DEPTH,
  describesNeed,
  matchAddableVariants,
  matchByName,
  matchWords,
  queryWords,
  wordMatch,
} from '../src/utils/product-matching.js';
import { ADDABLE_CATALOG_CACHE_TTL_MS, createAddableCatalogCache, parseCatalogCacheDir } from '../src/utils/catalog-cache.js';
import { tools } from '../src/tools/index.js';
import {
  DEFAULT_VERIFIED_MAX_QUANTITY,
  findDisallowedVerifiedArgs,
  isVerifiedWriteCall,
  parseAddableVariants,
  parseMaxQuantity,
} from '../src/utils/verified-writes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Live ritual.com IDs: Natalbiotic is USD 68.18 / CAD 106.82 in the storefront catalog
const NATALBIOTIC = { productId: '7482572079198', variantId: '42144416137310' };
const EMAIL = 'alice@example.com';
const OTHER_EMAIL = 'bob@example.com';
const FAKE_TOKEN = 'fake_admin_token_for_tests_only';
const HOSTED_STRIPPED_ARGS = ['customer_id', 'session_token', 'admin_token', 'store_url'];

const FUTURE_1 = '2099-01-15';
const FUTURE_2 = '2099-02-15';
// The latest calendar date anywhere (UTC+14): a charge on it may already be processing somewhere
const LATEST_TODAY = new Date(Date.now() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);

const toolByName = name => tools.find(tool => tool.name === name);

// ---------------------------------------------------------------------------
// In-memory Recharge
// ---------------------------------------------------------------------------

function fixtures() {
  return {
    customers: [{ id: 100, email: EMAIL }, { id: 200, email: OTHER_EMAIL }],
    subscriptions: [
      {
        id: 1001, customer_id: 100, address_id: 501, status: 'active', presentment_currency: 'USD', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9001' }, price: '30.00', next_charge_scheduled_at: FUTURE_1,
      },
      {
        id: 1002, customer_id: 100, address_id: 501, status: 'cancelled', presentment_currency: 'USD', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 2, charge_interval_frequency: 2,
        external_variant_id: { ecommerce: '9002' }, price: '30.00',
      },
      {
        id: 1003, customer_id: 100, address_id: 501, status: 'expired', presentment_currency: 'USD', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9003' },
      },
      {
        id: 1004, customer_id: 100, address_id: 501, status: 'active', presentment_currency: 'USD', quantity: 1, is_prepaid: true,
        order_interval_unit: 'week', order_interval_frequency: 4, charge_interval_frequency: 12,
        external_variant_id: { ecommerce: '9004' }, price: '30.00', next_charge_scheduled_at: FUTURE_1,
      },
      {
        // Same address, different schedule: next ships on FUTURE_2
        id: 1005, customer_id: 100, address_id: 501, status: 'active', presentment_currency: 'USD', quantity: 1, is_prepaid: false,
        order_interval_unit: 'week', order_interval_frequency: 2, charge_interval_frequency: 2,
        external_variant_id: { ecommerce: '9005' }, price: '20.00', next_charge_scheduled_at: `${FUTURE_2}T00:00:00`,
      },
      {
        id: 2001, customer_id: 200, address_id: 601, status: 'active', presentment_currency: 'USD', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9001' }, price: '30.00', next_charge_scheduled_at: FUTURE_1,
      },
      {
        // Someone else's active subscription returned for alice's address 502: must never count
        id: 2002, customer_id: 200, address_id: 502, status: 'active', presentment_currency: 'USD', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9001' }, price: '30.00', next_charge_scheduled_at: FUTURE_1,
      },
    ],
    addresses: [
      { id: 501, customer_id: 100, country_code: 'US' },
      { id: 502, customer_id: 100, country_code: 'US' },
      // Someone else's address in another country: must never pick alice's catalog country
      { id: 601, customer_id: 200, country_code: 'CA' },
    ],
    charges: [
      { id: 3001, customer: { id: 100 }, address_id: 501, status: 'queued', scheduled_at: FUTURE_1 },
      { id: 3002, customer: { id: 100 }, address_id: 501, status: 'queued', scheduled_at: `${FUTURE_2}T00:00:00` },
      { id: 3003, customer: { id: 100 }, address_id: 501, status: 'queued', scheduled_at: '2000-01-01' },
      // Returned by the list call but owned by someone else: must never count
      { id: 3004, customer: { id: 200 }, address_id: 501, status: 'queued', scheduled_at: '2099-03-01' },
      // Due today somewhere in the world: may already be processing, so never joinable
      { id: 3005, customer: { id: 100 }, address_id: 501, status: 'queued', scheduled_at: LATEST_TODAY },
      { id: 3006, customer: { id: 100 }, address_id: 502, status: 'queued', scheduled_at: FUTURE_1 },
    ],
    plans: [
      {
        id: 1, type: 'subscription', deleted_at: null, external_product_id: { ecommerce: '7001' }, has_variant_restrictions: false,
        subscription_preferences: { interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1 },
      },
      // Product 7005: only a restricted plan for a different variant, plus a deleted one
      { id: 2, type: 'subscription', deleted_at: null, external_product_id: { ecommerce: '7005' }, has_variant_restrictions: true, external_variant_ids: ['9999'] },
      { id: 3, type: 'subscription', deleted_at: '2024-01-01', external_product_id: { ecommerce: '7005' }, has_variant_restrictions: false },
      {
        id: 4, type: 'subscription', deleted_at: null, external_product_id: { ecommerce: NATALBIOTIC.productId }, has_variant_restrictions: false,
        subscription_preferences: { interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1 },
      },
    ],
    onetimes: [],
  };
}

const ADDABLE = new Map([
  ['8001', '7001'], // sellable, subscribable
  ['8006', '7001'], // second variant of the same product
  ['8003', '7002'], // not on the storefront (unpublished): absent from the catalog
  ['8004', '7003'], // on the storefront but unavailable
  ['8005', '7404'], // product unknown to the catalog
  ['8008', '7001'], // variant unknown to the catalog
  ['8007', '7005'], // sellable, no usable subscription plan
  ['8009', '7006'], // available but priced 0.00
  ['8010', '7001'], // the catalog has it under another product (7007)
  [NATALBIOTIC.variantId, NATALBIOTIC.productId], // real IDs and prices from ritual.com
]);

// ---------------------------------------------------------------------------
// Fake Shopify catalog (UCP lookup_catalog over JSON-RPC)
// ---------------------------------------------------------------------------

const UCP_URL = 'https://shop.example.com/api/ucp/mcp';
const PROFILE_URL = 'https://mcp.example.com/ucp/agent-profile.json';
// Present on every fake catalog record: must never reach tool output or logs
const DESCRIPTION_MARKER = 'DESCRIPTION-MARKER clinically studied';
const variantGid = id => `gid://shopify/ProductVariant/${id}`;

function ucpVariant(id, title, amount, currency, { available = true, sku = null } = {}) {
  return {
    id: variantGid(id), sku, title,
    description: { html: `<p>${DESCRIPTION_MARKER}</p>` },
    price: { amount, currency },
    availability: { available },
    inputs: [{ id: variantGid(id), match: 'exact' }],
  };
}

function ucpProduct(id, title, handle, variants) {
  return { id: `gid://shopify/Product/${id}`, title, handle, description: { html: `<p>${DESCRIPTION_MARKER}</p>` }, variants };
}

/**
 * Storefront catalog per country, in the shape of a live lookup_catalog
 * response (amounts are integer minor units, priced per country).
 */
function catalogFixtures() {
  const products = (currency, [p8001, p8006, p8007, natalbiotic]) => [
    ucpProduct('7001', 'Essential for Women 18+', 'essential-for-women', [
      ucpVariant('8001', 'essential for women 18+ 30 count', p8001, currency),
      ucpVariant('8006', '60 count', p8006, currency),
    ]),
    ucpProduct('7003', 'Future Thing', 'future-thing', [ucpVariant('8004', 'Default Title', 1000, currency, { available: false })]),
    ucpProduct('7005', 'Protein Powder', 'protein-powder', [ucpVariant('8007', 'Chocolate', p8007, currency)]),
    ucpProduct('7006', 'Free Sample', 'free-sample', [ucpVariant('8009', 'Default Title', 0, currency)]),
    ucpProduct('7007', 'Essential for Women 18+ Gummies', 'gummies', [ucpVariant('8010', 'Default Title', 2000, currency)]),
    ucpProduct(NATALBIOTIC.productId, 'Natalbiotic\u2122', 'natalbiotic', [ucpVariant(NATALBIOTIC.variantId, 'Default Title', natalbiotic, currency, { sku: 'NTLBCT0MUS' })]),
  ];
  return {
    US: products('USD', [3300, 6000, 4000, 6818]),
    CA: products('CAD', [4500, 8200, 5500, 10682]),
  };
}

const rpcResult = (id, content) => ({
  jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content, isError: false },
});

const jsonResponse = (payload, status = 200) =>
  new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/**
 * The in-memory lookup_catalog answer for one request body.
 */
function lookupResponse(db, body) {
  const { ids, context } = body.params.arguments.catalog;
  const products = (db[context.address_country] || []).filter(product => product.variants.some(variant => ids.includes(variant.id)));
  const returned = new Set(products.flatMap(product => product.variants.map(variant => variant.id)));
  return jsonResponse(rpcResult(body.id, {
    products: structuredClone(products),
    messages: ids.filter(id => !returned.has(id)).map(id => ({ type: 'info', code: 'not_found', content: id })),
  }));
}

/**
 * The in-memory search_catalog answer: `search(query, body, init)` returns ranked
 * product records (or a whole Response); by default nothing is found.
 */
async function searchResponse(search, body, init) {
  const found = search ? await search(body.params.arguments.catalog.query, body, init) : [];
  if (found instanceof Response) {
    return found;
  }
  return jsonResponse(rpcResult(body.id, { products: structuredClone(found), messages: [], pagination: { has_next_page: false } }));
}

/**
 * A real catalog client over a fake fetch. `respond(body, init)` replaces
 * the default in-memory lookup and search; `search` stubs only the search.
 * lookup_catalog requests are kept on `.requests`, search_catalog ones on
 * `.searches`.
 */
function makeCatalog({ db = catalogFixtures(), respond = null, search = null, timeoutMs, endpoint = UCP_URL, profileUrl = PROFILE_URL } = {}) {
  const requests = [];
  const searches = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const isSearch = body.params.name === 'search_catalog';
    (isSearch ? searches : requests).push({ url, init, body });
    if (respond) {
      return respond(body, init);
    }
    return isSearch ? searchResponse(search, body, init) : lookupResponse(db, body);
  };
  const catalog = createShopifyCatalog({ endpoint, profileUrl, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
  catalog.requests = requests;
  catalog.searches = searches;
  return catalog;
}

// A trimmed live response (ritual.com, CA context): only content[0].text, no structuredContent
const LIVE_LOOKUP_CA = {
  jsonrpc: '2.0',
  id: 3,
  result: {
    content: [{
      type: 'text',
      text: JSON.stringify({
        products: [
          {
            id: 'gid://shopify/Product/7482572079198', title: 'Natalbiotic\u2122', handle: 'natalbiotic',
            variants: [{
              id: 'gid://shopify/ProductVariant/42144416137310', sku: 'NTLBCT0MUS', title: 'Default Title',
              price: { amount: 10682, currency: 'CAD' }, availability: { available: true },
              inputs: [{ id: 'gid://shopify/ProductVariant/42144416137310', match: 'exact' }],
            }],
          },
          {
            id: 'gid://shopify/Product/7482572570718', title: 'Women\u2019s Multivitamin 18+', handle: 'essential-for-women-multivitamin',
            variants: [{
              id: 'gid://shopify/ProductVariant/42283036246110', sku: 'EW18MT9MUS', title: 'Mint / 30 servings',
              price: { amount: 5682, currency: 'CAD' }, availability: { available: true },
              inputs: [{ id: 'gid://shopify/ProductVariant/42283036246110', match: 'exact' }],
            }],
          },
        ],
        messages: [{ type: 'info', code: 'not_found', content: 'gid://shopify/ProductVariant/99999999999999' }],
        pagination: null,
      }),
    }],
    isError: false,
  },
};

function notFound() {
  return new RechargeAPIError('Not Found', 404);
}

/**
 * Build a client whose admin requests hit the in-memory store. `overrides`
 * maps "METHOD /path" to a handler that replaces the default one.
 */
let clientCount = 0;
// Default find_addable_product cache dirs live here, one per client, removed on exit
const CACHE_ROOT = mkdtempSync(path.join(tmpdir(), 'recharge-mcp-cache-test-'));
process.on('exit', () => rmSync(CACHE_ROOT, { recursive: true, force: true }));

// A fresh catalog and cache dir per client (default), so the find_addable_product cache never leaks between tests
function makeClient({ db = fixtures(), overrides = {}, addable = ADDABLE, maxQuantity = 2, catalog = makeCatalog(), catalogCache } = {}) {
  clientCount += 1;
  const client = new RechargeClient({
    storeUrl: `test-shop-${clientCount}.myshopify.com`,
    adminToken: FAKE_TOKEN,
    verifiedAdminWrites: true,
    verifiedMaxQuantity: maxQuantity,
    addableVariants: addable,
    catalog,
    catalogCache: catalogCache === undefined
      ? createAddableCatalogCache({ dir: path.join(CACHE_ROOT, `client-${clientCount}`) })
      : catalogCache,
  });
  const calls = [];
  const byId = (list, id) => list.find(item => String(item.id) === String(id));

  const routes = {
    'GET /customers': ({ params }) => ({ customers: db.customers.filter(c => c.email === params.email) }),
    'GET /subscriptions/:id': ({ id }) => {
      const record = byId(db.subscriptions, id);
      if (!record) throw notFound();
      return { subscription: structuredClone(record) };
    },
    'GET /subscriptions': ({ params }) => ({
      // Deliberately ignores the customer: the client must filter by owner itself
      subscriptions: db.subscriptions
        .filter(s => !params.address_id || String(s.address_id) === String(params.address_id))
        .filter(s => !params.status || s.status === params.status)
        .map(s => structuredClone(s)),
    }),
    // Deliberately ignores the customer filter: the client must filter by owner itself
    'GET /addresses': () => ({ addresses: db.addresses.map(a => structuredClone(a)) }),
    'GET /addresses/:id': ({ id }) => {
      const record = byId(db.addresses, id);
      if (!record) throw notFound();
      return { address: structuredClone(record) };
    },
    'GET /charges': ({ params }) => ({
      charges: db.charges
        .filter(c => !params.address_id || String(c.address_id) === String(params.address_id))
        .map(c => structuredClone(c)),
    }),
    'GET /plans': ({ params }) => ({
      plans: db.plans.filter(p => p.external_product_id.ecommerce === String(params.external_product_id)).map(p => structuredClone(p)),
    }),
    // Deliberately ignores every filter: the client must filter by address itself
    'GET /onetimes': () => ({ onetimes: db.onetimes.map(o => structuredClone(o)) }),
    'PUT /subscriptions/:id': ({ id, data }) => ({ subscription: { ...structuredClone(byId(db.subscriptions, id)), ...data } }),
    'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, customer_id: 100, product_title: 'Essential for Women 18+', price: '33.00', ...data } }),
    'POST /subscriptions': ({ data }) => ({ subscription: { id: 1101, customer_id: 100, status: 'active', price: '29.70', ...data } }),
    'DELETE /onetimes/:id': () => ({}),
    'DELETE /subscriptions/:id': () => ({}),
    ...overrides,
  };

  client.makeAdminRequest = async (method, endpoint, data = null, params = null) => {
    calls.push({ method, endpoint, data, params });
    const match = /^\/(\w+)\/(\d+)$/.exec(endpoint);
    const key = match ? `${method} /${match[1]}/:id` : `${method} ${endpoint}`;
    const handler = routes[key];
    if (!handler) {
      throw new Error(`Unexpected admin request in test: ${method} ${endpoint}`);
    }
    return handler({ id: match ? match[2] : null, data, params: params || {} });
  };

  return { client, calls, db, catalog };
}

const writes = calls => calls.filter(call => call.method !== 'GET');

async function refusal(promise, pattern) {
  await assert.rejects(promise, error => {
    assert.match(error.message, pattern);
    assert.match(error.message, /hand off to a support agent/);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Env parsing and the raw-argument allowlist
// ---------------------------------------------------------------------------

describe('env parsing', () => {
  test('MCP_VERIFIED_MAX_QUANTITY defaults to 2 and rejects out-of-range values', () => {
    assert.deepEqual(parseMaxQuantity(undefined), { value: DEFAULT_VERIFIED_MAX_QUANTITY, warning: null });
    assert.deepEqual(parseMaxQuantity('5'), { value: 5, warning: null });
    for (const raw of ['0', '11', '-1', '1.5', 'abc', '2x']) {
      const parsed = parseMaxQuantity(raw);
      assert.equal(parsed.value, 2, raw);
      assert.match(parsed.warning, /MCP_VERIFIED_MAX_QUANTITY/);
    }
  });

  test('MCP_VERIFIED_ADDABLE_VARIANTS parses pairs, fails closed and drops malformed entries', () => {
    assert.equal(parseAddableVariants('').variants.size, 0);
    assert.equal(parseAddableVariants(undefined).variants.size, 0);
    const parsed = parseAddableVariants(' 7001:8001, bad ,7002:x,7001:8006,7009:8001 ');
    assert.deepEqual([...parsed.variants], [['8001', '7001'], ['8006', '7001']]);
    assert.equal(parsed.warnings.length, 3);
    assert.ok(parsed.warnings.some(warning => warning.includes('"bad"')));
  });
});

describe('raw-argument allowlist', () => {
  const update = toolByName('update_subscription');

  test('only verifiedArgs and hosted-stripped args pass', () => {
    assert.deepEqual(findDisallowedVerifiedArgs({ customer_email: EMAIL, subscription_id: '1', quantity: 2, session_token: 'x' }, update.verifiedArgs, HOSTED_STRIPPED_ARGS), []);
    for (const key of ['price', 'variant_id', 'next_charge_scheduled_at', 'properties', 'order_interval_frequency', 'order_interval_unit', 'surprise']) {
      assert.deepEqual(findDisallowedVerifiedArgs({ customer_email: EMAIL, subscription_id: '1', quantity: 2, [key]: 1 }, update.verifiedArgs, HOSTED_STRIPPED_ARGS), [key]);
    }
  });

  test('existing verified tools have no verifiedArgs (unchanged behaviour)', () => {
    for (const name of ['set_subscription_next_charge', 'skip_subscription', 'update_address', 'skip_charge']) {
      assert.equal(toolByName(name).verifiedArgs, undefined, name);
      assert.deepEqual(findDisallowedVerifiedArgs({ anything: 1 }, toolByName(name).verifiedArgs, HOSTED_STRIPPED_ARGS), []);
    }
  });
});

// ---------------------------------------------------------------------------
// Quantity changes
// ---------------------------------------------------------------------------

describe('verifiedUpdateSubscriptionQuantity', () => {
  test('happy path sends exactly {quantity} with commit=true', async () => {
    const { client, calls } = makeClient();
    const result = await client.verifiedUpdateSubscriptionQuantity('1001', 2, EMAIL);
    assert.deepEqual(writes(calls), [{ method: 'PUT', endpoint: '/subscriptions/1001', data: { quantity: 2 }, params: { commit: true } }]);
    assert.equal(result.previous_quantity, 1);
    assert.equal(result.subscription.quantity, 2);
  });

  test("another customer's subscription and a missing one get the identical refusal", async () => {
    const messages = [];
    for (const id of ['2001', '9999']) {
      const { client, calls } = makeClient();
      await assert.rejects(client.verifiedUpdateSubscriptionQuantity(id, 2, EMAIL), error => {
        messages.push(error.message.replace(id, '<id>'));
        return true;
      });
      assert.equal(writes(calls).length, 0);
    }
    assert.equal(messages[0], messages[1]);
    assert.match(messages[0], /not found on this customer's account/);
  });

  test('non-digit ID is refused before any request', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedUpdateSubscriptionQuantity('10/../2001', 2, EMAIL), /not a valid ID/);
    assert.equal(calls.length, 0);
  });

  for (const quantity of [0, -1, 1.5, 3, '2', undefined, null]) {
    test(`quantity ${JSON.stringify(quantity)} is refused before any request`, async () => {
      const { client, calls } = makeClient();
      await refusal(client.verifiedUpdateSubscriptionQuantity('1001', quantity, EMAIL), /whole number from 1 to 2.*no change was made/);
      assert.equal(calls.length, 0);
    });
  }

  test('the cap follows MCP_VERIFIED_MAX_QUANTITY', async () => {
    const { client, calls } = makeClient({ maxQuantity: 4 });
    await client.verifiedUpdateSubscriptionQuantity('1001', 4, EMAIL);
    assert.equal(writes(calls).length, 1);
    await refusal(client.verifiedUpdateSubscriptionQuantity('1001', 5, EMAIL), /from 1 to 4/);
  });

  for (const [id, pattern] of [['1002', /is cancelled/], ['1003', /is expired/], ['1004', /is prepaid/]]) {
    test(`subscription ${id} is refused (${pattern.source})`, async () => {
      const { client, calls } = makeClient();
      await refusal(client.verifiedUpdateSubscriptionQuantity(id, 2, EMAIL), pattern);
      assert.equal(writes(calls).length, 0);
    });
  }

  test('same quantity makes no write', async () => {
    const { client, calls } = makeClient();
    const result = await client.verifiedUpdateSubscriptionQuantity('1001', 1, EMAIL);
    assert.equal(writes(calls).length, 0);
    assert.match(result.result, /already 1, so no change was made/);
  });

  test('unknown email is refused with no write', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedUpdateSubscriptionQuantity('1001', 2, 'nobody@example.com'), /No change was made/);
    assert.equal(writes(calls).length, 0);
  });

  test('tool execute takes the verified path and shapes the result', async () => {
    const { client, calls } = makeClient();
    const result = await toolByName('update_subscription').execute(client, { customer_email: EMAIL, subscription_id: '1001', quantity: 2 });
    assert.match(result.content[0].text, /Updated Subscription Quantity/);
    assert.match(result.content[0].text, /"previous_quantity": 1/);
    assert.equal(writes(calls).length, 1);
  });
});

// ---------------------------------------------------------------------------
// One-time adds
// ---------------------------------------------------------------------------

const onetimeArgs = (overrides = {}) => ({ addressId: '501', variantId: 8001, quantity: 1, date: FUTURE_1, ...overrides });

describe('verifiedCreateOnetime', () => {
  test('body is exactly the five fields, built from verified records', async () => {
    const { client, calls } = makeClient();
    const result = await client.verifiedCreateOnetime(onetimeArgs({ date: FUTURE_2 }), EMAIL);
    assert.deepEqual(writes(calls), [{
      method: 'POST',
      endpoint: '/onetimes',
      data: {
        address_id: 501,
        external_product_id: { ecommerce: '7001' },
        external_variant_id: { ecommerce: '8001' },
        quantity: 1,
        next_charge_scheduled_at: FUTURE_2,
      },
      params: null,
    }]);
    assert.equal(result.onetime.id, 4001);
  });

  for (const [label, variantId] of [
    ['not allowlisted', 8002],
    ['whose product is unknown to the catalog', 8005],
    ['unknown to the catalog', 8008],
    ['not on the storefront', 8003],
    ['unavailable', 8004],
    ['under another product in the catalog', 8010],
  ]) {
    test(`variant ${label} gets the same "can't be added" refusal`, async () => {
      const { client, calls } = makeClient();
      await refusal(client.verifiedCreateOnetime(onetimeArgs({ variantId }), EMAIL), /That product can't be added here, so nothing was added/);
      assert.equal(writes(calls).length, 0);
    });
  }

  test('address not owned and address missing get the same refusal', async () => {
    const messages = [];
    for (const addressId of ['601', '999']) {
      const { client, calls } = makeClient();
      await assert.rejects(client.verifiedCreateOnetime(onetimeArgs({ addressId }), EMAIL), error => {
        messages.push(error.message.replace(addressId, '<id>'));
        return true;
      });
      assert.equal(writes(calls).length, 0);
    }
    assert.equal(messages[0], messages[1]);
  });

  test('missing address_id is refused before any request', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ addressId: undefined }), EMAIL), /address_id is needed/);
    assert.equal(calls.length, 0);
  });

  test('address with no active subscription is refused', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ addressId: '502' }), EMAIL), /has no active subscription/);
    assert.equal(writes(calls).length, 0);
  });

  test('no queued charge is refused', async () => {
    const db = fixtures();
    db.charges = db.charges.filter(charge => charge.customer.id !== 100 || charge.scheduled_at < '2001');
    const { client, calls } = makeClient({ db });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /no upcoming order on address 501 that can still be added to/);
    assert.equal(writes(calls).length, 0);
  });

  test('date that is not a queued charge date lists the queued dates', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ date: '2099-01-20' }), EMAIL), new RegExp(`Upcoming order dates: ${FUTURE_1}, ${FUTURE_2}\\.`));
    assert.equal(writes(calls).length, 0);
  });

  test('past charges and charges owned by someone else in the list never count', async () => {
    for (const date of ['2000-01-01', '2099-03-01']) {
      const { client, calls } = makeClient();
      await assert.rejects(client.verifiedCreateOnetime(onetimeArgs({ date }), EMAIL), error => {
        assert.match(error.message, /is not the date of an upcoming order/);
        assert.match(error.message, new RegExp(`Upcoming order dates: ${FUTURE_1}, ${FUTURE_2}\\. `));
        return true;
      });
      assert.equal(writes(calls).length, 0);
    }
  });

  test('duplicate one-time for the same variant on that order is refused', async () => {
    const db = fixtures();
    db.onetimes.push({ id: 4000, customer_id: 100, address_id: 501, external_variant_id: { ecommerce: '8001' }, next_charge_scheduled_at: FUTURE_1 });
    const { client, calls } = makeClient({ db });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /already on the 2099-01-15 order/);
    assert.equal(writes(calls).length, 0);

    // The same variant on a different order is fine
    const second = makeClient({ db });
    await second.client.verifiedCreateOnetime(onetimeArgs({ date: FUTURE_2 }), EMAIL);
    assert.equal(writes(second.calls).length, 1);
  });

  test('quantity above the cap is refused before any request', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ quantity: 3 }), EMAIL), /whole number from 1 to 2/);
    assert.equal(calls.length, 0);
  });

  test('a 4xx write is wrapped as "nothing was changed"', async () => {
    const { client } = makeClient({ overrides: { 'POST /onetimes': () => { throw new RechargeAPIError('bad variant', 422); } } });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /Recharge did not accept this change, so nothing was changed/);
  });

  test('a 5xx or timeout write says do not retry', async () => {
    for (const error of [new RechargeAPIError('boom', 502), new RechargeAPIError('Request timeout - the server took too long to respond', 500)]) {
      const { client } = makeClient({ overrides: { 'POST /onetimes': () => { throw error; } } });
      await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /could not be confirmed.*Do not retry/);
    }
  });

  test('tool execute takes the verified path and shapes the result', async () => {
    const { client, calls } = makeClient();
    const result = await toolByName('create_onetime').execute(client, {
      customer_email: EMAIL, address_id: '501', variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1,
    });
    assert.match(result.content[0].text, /Created One-time Product/);
    assert.doesNotMatch(result.content[0].text, /customer_id/);
    assert.equal(writes(calls).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Recurring adds
// ---------------------------------------------------------------------------

const subscriptionArgs = (overrides = {}) => ({
  addressId: '501', variantId: 8001, quantity: 1, date: FUTURE_1, orderIntervalFrequency: 1, orderIntervalUnit: 'month', ...overrides,
});

describe('verifiedCreateSubscription', () => {
  test('body copies the interval from the matched subscription', async () => {
    const db = fixtures();
    db.subscriptions[0].order_day_of_month = 15;
    const { client, calls } = makeClient({ db });
    await client.verifiedCreateSubscription(subscriptionArgs(), EMAIL);
    assert.deepEqual(writes(calls), [{
      method: 'POST',
      endpoint: '/subscriptions',
      data: {
        address_id: 501,
        external_product_id: { ecommerce: '7001' },
        external_variant_id: { ecommerce: '8001' },
        quantity: 1,
        next_charge_scheduled_at: FUTURE_1,
        order_interval_unit: 'month',
        order_interval_frequency: 1,
        charge_interval_frequency: 1,
        plan_id: 1,
        order_day_of_month: 15,
      },
      params: null,
    }]);
  });

  test('product with no usable subscription plan is refused', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ variantId: 8007 }), EMAIL), /can't be added here/);
    assert.equal(writes(calls).length, 0);
  });

  test('plan restricted to other variants is refused', async () => {
    const db = fixtures();
    db.plans[0] = { ...db.plans[0], has_variant_restrictions: true, external_variant_ids: ['8006'] };
    const { client, calls } = makeClient({ db });
    await refusal(client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /can't be added here/);
    assert.equal(writes(calls).length, 0);
  });

  test('interval that matches no subscription at all is refused', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ orderIntervalFrequency: 3, orderIntervalUnit: 'day' }), EMAIL), /must match how often/);
    assert.equal(writes(calls).length, 0);
  });

  test('interval that only matches a prepaid subscription is refused', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ orderIntervalFrequency: 4, orderIntervalUnit: 'week' }), EMAIL), /must match how often/);
    assert.equal(writes(calls).length, 0);
  });

  test('interval matching only a cancelled subscription is refused', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ orderIntervalFrequency: 2 }), EMAIL), /must match how often/);
    assert.equal(writes(calls).length, 0);
  });

  test('duplicate active subscription for the variant points to a quantity change', async () => {
    const db = fixtures();
    db.subscriptions[0].external_variant_id = { ecommerce: '8001' };
    const { client, calls } = makeClient({ db });
    await refusal(client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /already has an active subscription.*update_subscription/);
    assert.equal(writes(calls).length, 0);
  });

  test('date must be a queued charge date', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ date: '2099-05-05' }), EMAIL), /Upcoming order dates/);
    assert.equal(writes(calls).length, 0);
  });

  test('tool execute takes the verified path', async () => {
    const { client, calls } = makeClient();
    const result = await toolByName('create_subscription').execute(client, {
      customer_email: EMAIL, address_id: '501', variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1,
      order_interval_frequency: 1, order_interval_unit: 'month',
    });
    assert.match(result.content[0].text, /Created Subscription/);
    assert.equal(writes(calls).length, 1);
    // The legacy storefront pre-validation is skipped
    assert.ok(!calls.some(call => call.endpoint === '/products'));
  });
});

// ---------------------------------------------------------------------------
// Product lookup
// ---------------------------------------------------------------------------

describe('find_addable_product', () => {
  test('matches only allowlisted, available variants and reports can_subscribe', async () => {
    const { client, calls } = makeClient();
    const result = await client.findAddableProducts('essential for women 18+', EMAIL);
    // Both allowlisted variants of the product, with variant_id as the number the add tools take;
    // 8010 (catalog says another product) is skipped
    assert.deepEqual(result.products, [
      { variant_id: 8001, title: 'Essential for Women 18+', variant_title: 'essential for women 18+ 30 count', unit_price: '33.00', currency: 'USD', can_subscribe: true },
      { variant_id: 8006, title: 'Essential for Women 18+', variant_title: '60 count', unit_price: '60.00', currency: 'USD', can_subscribe: true },
    ]);
    assert.deepEqual((await client.findAddableProducts('women 18+ 60 count', EMAIL)).products.map(product => product.variant_id), [8006]);
    const protein = await client.findAddableProducts('PROTEIN POWDER', EMAIL);
    assert.equal(protein.products[0].can_subscribe, false);
    assert.deepEqual((await client.findAddableProducts('unpublished', EMAIL)).products, []);
    assert.deepEqual((await client.findAddableProducts('future thing', EMAIL)).products, []);
    assert.equal(writes(calls).length, 0);
  });

  test('empty allowlist says adding is not available', async () => {
    const { client, calls } = makeClient({ addable: new Map() });
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential for women 18+' });
    assert.match(result.content[0].text, /Adding products isn't available here; hand off to a support agent/);
    assert.equal(calls.length, 0);
  });

  test('empty allowlist refuses every add', async () => {
    const { client, calls } = makeClient({ addable: new Map() });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /can't be added here/);
    await refusal(client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /can't be added here/);
    assert.equal(writes(calls).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('logging', () => {
  test('DEBUG output from the new paths never contains the email or the token', async () => {
    const previousDebug = process.env.DEBUG;
    const originalError = console.error;
    const captured = [];
    process.env.DEBUG = 'true';
    console.error = (...args) => captured.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    try {
      const { client } = makeClient();
      await client.verifiedUpdateSubscriptionQuantity('1001', 2, EMAIL);
      await client.verifiedCreateOnetime(onetimeArgs(), EMAIL);
      await client.verifiedCreateSubscription(subscriptionArgs(), EMAIL);
      await client.findAddableProducts('essential for women 18+', EMAIL);
      await client.verifiedUpdateSubscriptionQuantity('2001', 2, EMAIL).catch(() => {});
      await client.verifiedCreateOnetime(onetimeArgs({ variantId: 8002 }), EMAIL).catch(() => {});
      await client.verifiedCreateOnetime(onetimeArgs({ variantId: 8003 }), EMAIL).catch(() => {});
      await client.verifiedCreateSubscription(subscriptionArgs({ variantId: 8007 }), EMAIL).catch(() => {});
      await client.verifiedCreateOnetime(onetimeArgs({ variantId: 8010 }), EMAIL).catch(() => {});
      const failingCatalog = makeClient({ catalog: makeCatalog({ respond: () => new Response('nope', { status: 500 }) }) });
      await failingCatalog.client.verifiedCreateOnetime(onetimeArgs(), EMAIL).catch(() => {});
      await toolByName('find_addable_product').execute(failingCatalog.client, { customer_email: EMAIL, query: 'essential for women 18+' });
      const failing = makeClient({ overrides: { 'POST /onetimes': () => { throw new RechargeAPIError('boom', 502); } } });
      await failing.client.verifiedCreateOnetime(onetimeArgs(), EMAIL).catch(() => {});
    } finally {
      console.error = originalError;
      if (previousDebug === undefined) {
        delete process.env.DEBUG;
      } else {
        process.env.DEBUG = previousDebug;
      }
    }
    assert.ok(captured.length > 0, 'expected some debug output');
    for (const line of captured) {
      assert.ok(!line.includes(EMAIL), `email in log: ${line}`);
      assert.ok(!line.includes(FAKE_TOKEN), `token in log: ${line}`);
      assert.ok(!line.includes(DESCRIPTION_MARKER), `description in log: ${line}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Review fixes: price guards, per-order cap, schedules, fail-closed reads
// ---------------------------------------------------------------------------

describe('quantity changes on free, gift and promotional lines', () => {
  for (const [label, change] of [
    ['priced 0.00', { price: '0.00' }],
    ['with no price', { price: undefined }],
    ['with a _gwp property', { properties: [{ name: '_gwp', value: 'true' }] }],
    ['with a gift property', { properties: [{ name: 'Gift_Note', value: 'x' }] }],
  ]) {
    test(`a subscription ${label} is refused with no write`, async () => {
      const db = fixtures();
      Object.assign(db.subscriptions[0], change);
      const { client, calls } = makeClient({ db });
      await refusal(client.verifiedUpdateSubscriptionQuantity('1001', 2, EMAIL), /gift or has a special price.*nothing was changed/);
      assert.equal(writes(calls).length, 0);
    });
  }

  test('ordinary properties do not block a quantity change', async () => {
    const db = fixtures();
    db.subscriptions[0].properties = [{ name: 'flavor', value: 'mint' }];
    const { client, calls } = makeClient({ db });
    await client.verifiedUpdateSubscriptionQuantity('1001', 2, EMAIL);
    assert.equal(writes(calls).length, 1);
  });
});

describe('price guards on adds', () => {
  test('an allowlisted variant priced 0.00 in the catalog cannot be added or found', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ variantId: 8009 }), EMAIL), /can't be added here/);
    assert.deepEqual((await client.findAddableProducts('free sample', EMAIL)).products, []);
    assert.equal(writes(calls).length, 0);
  });

  for (const price of ['0.00', null, '99.00']) {
    test(`a one-time Recharge prices at ${JSON.stringify(price)} is deleted again and refused`, async () => {
      const { client, calls } = makeClient({
        overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, customer_id: 100, ...data, price } }) },
      });
      await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /priced this item differently.*removed again and nothing was added/);
      assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes', 'DELETE /onetimes/4001']);
    });
  }

  test('a subscription priced above the catalog is deleted again and refused', async () => {
    const { client, calls } = makeClient({
      overrides: { 'POST /subscriptions': ({ data }) => ({ subscription: { id: 1101, ...data, price: '40.00' } }) },
    });
    await refusal(client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /removed again/);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /subscriptions', 'DELETE /subscriptions/1101']);
  });

  test('a discounted subscription price is accepted', async () => {
    const { client, calls } = makeClient();
    const result = await client.verifiedCreateSubscription(subscriptionArgs(), EMAIL);
    assert.equal(result.subscription.price, '29.70');
    assert.equal(writes(calls).length, 1);
  });

  test('if the delete fails, the assistant is told not to retry', async () => {
    const { client, calls } = makeClient({
      overrides: {
        'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '0.00' } }),
        'DELETE /onetimes/:id': () => { throw new RechargeAPIError('boom', 500); },
      },
    });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /price that could not be confirmed. Do not retry/);
    assert.equal(writes(calls).length, 2);
  });

  test('a record for another address is never deleted', async () => {
    const { client, calls } = makeClient({
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, address_id: 999, price: '0.00' } }) },
    });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /Do not retry/);
    assert.deepEqual(writes(calls).map(call => call.method), ['POST']);
  });
});

describe('quantity cap per order', () => {
  test('a one-time add cannot push a product over the cap on an order', async () => {
    const db = fixtures();
    Object.assign(db.subscriptions[0], { external_variant_id: { ecommerce: '8001' }, quantity: 2 });
    const { client, calls } = makeClient({ db });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /2099-01-15 order already has 2 of that product.*no more than 2/);
    assert.equal(writes(calls).length, 0);
    // The other order has none of it, so the same add is fine there
    const second = makeClient({ db });
    await second.client.verifiedCreateOnetime(onetimeArgs({ date: FUTURE_2 }), EMAIL);
    assert.equal(writes(second.calls).length, 1);
  });

  test('raising a subscription counts one-time items of that product on its next order', async () => {
    const db = fixtures();
    db.onetimes.push({ id: 4000, address_id: 501, external_variant_id: { ecommerce: '9001' }, quantity: 1, next_charge_scheduled_at: FUTURE_1 });
    const { client, calls } = makeClient({ db });
    await refusal(client.verifiedUpdateSubscriptionQuantity('1001', 2, EMAIL), /already has 1 of that product/);
    assert.equal(writes(calls).length, 0);
  });

  test('lowering a subscription is never blocked by the per-order count', async () => {
    const db = fixtures();
    db.subscriptions[0].quantity = 2;
    db.onetimes.push({ id: 4000, address_id: 501, external_variant_id: { ecommerce: '9001' }, quantity: 2, next_charge_scheduled_at: FUTURE_1 });
    const { client, calls } = makeClient({ db });
    await client.verifiedUpdateSubscriptionQuantity('1001', 1, EMAIL);
    assert.equal(writes(calls).length, 1);
  });

  test('duplicate check needs no customer_id and no query filter, and reads by address only', async () => {
    const db = fixtures();
    db.onetimes.push({ id: 4000, address_id: 501, external_variant_id: { ecommerce: '8001' }, quantity: 1, next_charge_scheduled_at: FUTURE_1 });
    // Another address's one-time for the same variant and date must not count
    db.onetimes.push({ id: 4002, address_id: 502, external_variant_id: { ecommerce: '8001' }, quantity: 1, next_charge_scheduled_at: FUTURE_2 });
    const { client, calls } = makeClient({ db });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /already on the 2099-01-15 order/);
    assert.deepEqual(calls.find(call => call.endpoint === '/onetimes').params, { address_id: 501, limit: 250 });
    const second = makeClient({ db });
    await second.client.verifiedCreateOnetime(onetimeArgs({ date: FUTURE_2 }), EMAIL);
    assert.equal(writes(second.calls).length, 1);
  });

  test('more than one page of one-time items fails closed', async () => {
    const { client, calls } = makeClient({ overrides: { 'GET /onetimes': () => ({ onetimes: [], next_cursor: 'abc' }) } });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /too many one-time items.*nothing was changed/);
    assert.equal(writes(calls).length, 0);
  });
});

describe('dates and schedules', () => {
  test('a charge due today anywhere is not joinable', async () => {
    const { client, calls } = makeClient();
    await assert.rejects(client.verifiedCreateOnetime(onetimeArgs({ date: LATEST_TODAY }), EMAIL), error => {
      assert.match(error.message, new RegExp(`Upcoming order dates: ${FUTURE_1}, ${FUTURE_2}\\. `));
      assert.match(error.message, /hand off to a support agent/);
      return true;
    });
    assert.equal(writes(calls).length, 0);
  });

  test('a recurring add must start on the next order of the subscription whose interval it copies', async () => {
    // Monthly interval (sub 1001, next FUTURE_1) on FUTURE_2, a queued date that belongs to sub 1005
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ date: FUTURE_2 }), EMAIL),
      new RegExp(`must start on the next order of the subscription it ships with.*next ship on: ${FUTURE_1}\\.`));
    assert.equal(writes(calls).length, 0);
  });

  test('the product must have a plan on the matched interval', async () => {
    const db = fixtures();
    db.plans[0].subscription_preferences = { interval_unit: 'month', order_interval_frequency: 2, charge_interval_frequency: 2 };
    const { client, calls } = makeClient({ db });
    await refusal(client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /isn't offered on the same schedule/);
    assert.equal(writes(calls).length, 0);
  });

  test('the plan_id sent is the plan matching the interval', async () => {
    const db = fixtures();
    db.plans.unshift({
      id: 9, type: 'subscription', deleted_at: null, external_product_id: { ecommerce: '7001' }, has_variant_restrictions: false,
      subscription_preferences: { interval_unit: 'week', order_interval_frequency: 2, charge_interval_frequency: 2 },
    });
    const { client, calls } = makeClient({ db });
    await client.verifiedCreateSubscription(subscriptionArgs(), EMAIL);
    assert.equal(writes(calls)[0].data.plan_id, 1);
  });

  test("another customer's active subscription never makes an address addable", async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ addressId: '502' }), EMAIL), /has no active subscription/);
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ addressId: '502' }), EMAIL), /has no active subscription/);
    assert.equal(writes(calls).length, 0);
  });
});

describe('pre-write read failures', () => {
  const failing = status => () => { throw new RechargeAPIError(`HTTP ${status} Error`, status); };
  const cases = [
    ['GET /plans 403 (missing read_plans)', 'GET /plans', 403, client => client.verifiedCreateSubscription(subscriptionArgs(), EMAIL)],
    ['GET /charges 500', 'GET /charges', 500, client => client.verifiedCreateOnetime(onetimeArgs(), EMAIL)],
    ['GET /onetimes 422', 'GET /onetimes', 422, client => client.verifiedCreateOnetime(onetimeArgs(), EMAIL)],
    ['GET /subscriptions/:id 503', 'GET /subscriptions/:id', 503, client => client.verifiedUpdateSubscriptionQuantity('1001', 2, EMAIL)],
    ['GET /customers 500', 'GET /customers', 500, client => client.verifiedUpdateSubscriptionQuantity('1001', 2, EMAIL)],
  ];
  for (const [label, route, status, run] of cases) {
    test(`${label} is a hand-off refusal with no write`, async () => {
      const { client, calls } = makeClient({ overrides: { [route]: failing(status) } });
      await assert.rejects(run(client), error => {
        assert.equal(error.message, 'This could not be checked right now, so nothing was changed. Do not ask the customer for account IDs or tokens; hand off to a support agent.');
        return true;
      });
      assert.equal(writes(calls).length, 0);
    });
  }

  test('a catalog 429 is a hand-off refusal with no write', async () => {
    const catalog = makeCatalog({ respond: () => new Response('Too Many Requests', { status: 429 }) });
    const { client, calls } = makeClient({ catalog });
    await assert.rejects(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), error => {
      assert.equal(error.message, 'This could not be checked right now, so nothing was changed. Do not ask the customer for account IDs or tokens; hand off to a support agent.');
      return true;
    });
    assert.equal(writes(calls).length, 0);
    assert.equal(catalog.requests.length, 1);
  });
});

describe('find_addable_product matching and load', () => {
  test('whole words only: "men" never matches "women"', async () => {
    const { client } = makeClient();
    assert.deepEqual((await client.findAddableProducts('Essential for Men', EMAIL)).products, []);
    assert.deepEqual((await client.findAddableProducts('men', EMAIL)).products, []);
    assert.equal((await client.findAddableProducts('wome 18+', EMAIL)).products.length, 2);
    assert.equal((await client.findAddableProducts('women 18+', EMAIL)).products.length, 2);
  });

  test('catalog reads are one lookup per search and cached between searches', async () => {
    const { client, calls, catalog } = makeClient();
    await client.findAddableProducts('essential for women 18+', EMAIL);
    assert.equal(catalog.requests.length, 1);
    // Every allowlisted variant in that one call
    assert.equal(catalog.requests[0].body.params.arguments.catalog.ids.length, ADDABLE.size);
    await client.findAddableProducts('protein', EMAIL);
    assert.equal(catalog.requests.length, 1);
    assert.ok(!calls.some(call => call.endpoint.startsWith('/products')));
  });

  test('a rate limit becomes a hand-off, not a raw API error', async () => {
    const { client } = makeClient({ catalog: makeCatalog({ respond: () => new Response('Too Many Requests', { status: 429 }) }) });
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential for women 18+' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /could not be looked up right now.*hand off to a support agent/);
    assert.doesNotMatch(result.content[0].text, /API Error|429/);
  });
});

describe('transitional mode and legacy create_onetime', () => {
  const options = { verifiedTools: new Set(['skip_subscription', 'update_subscription', 'create_onetime', 'create_subscription']), verifiedAdminWrites: false, transitional: true };

  test('purchase and quantity tools never take the verified path in transitional mode', () => {
    for (const name of ['update_subscription', 'create_onetime', 'create_subscription']) {
      assert.equal(isVerifiedWriteCall(name, { customer_email: EMAIL }, options), false, name);
      assert.equal(isVerifiedWriteCall(name, { customer_email: EMAIL }, { ...options, verifiedAdminWrites: true }), true, name);
    }
    // Existing verified tools keep their transitional behaviour
    assert.equal(isVerifiedWriteCall('skip_subscription', { customer_email: EMAIL }, options), true);
    assert.equal(isVerifiedWriteCall('skip_subscription', { customer_email: EMAIL, session_token: 'x' }, options), false);
  });

  test('the legacy path never forwards address_id', async () => {
    const { client } = makeClient();
    client.verifiedAdminWrites = false;
    let sent;
    client.createOnetime = async data => { sent = data; return { onetime: { id: 1 } }; };
    await toolByName('create_onetime').execute(client, { customer_email: EMAIL, address_id: '501', variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1 });
    assert.deepEqual(sent, { variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1 });
  });
});

describe('write-failure logging', () => {
  test('the DEBUG line carries the Recharge message with emails removed', async () => {
    const previousDebug = process.env.DEBUG;
    const originalError = console.error;
    const captured = [];
    process.env.DEBUG = 'true';
    console.error = (...args) => captured.push(args.join(' '));
    try {
      const { client } = makeClient({ overrides: { 'POST /onetimes': () => { throw new RechargeAPIError(`next_charge_scheduled_at is invalid for ${EMAIL}`, 422); } } });
      await client.verifiedCreateOnetime(onetimeArgs(), EMAIL).catch(() => {});
    } finally {
      console.error = originalError;
      if (previousDebug === undefined) {
        delete process.env.DEBUG;
      } else {
        process.env.DEBUG = previousDebug;
      }
    }
    const line = captured.find(item => item.includes('Verified write failed'));
    assert.match(line, /status 422: next_charge_scheduled_at is invalid for <email>/);
    assert.ok(captured.every(item => !item.includes(EMAIL)));
  });
});

// ---------------------------------------------------------------------------
// Shopify storefront catalog (UCP)
// ---------------------------------------------------------------------------

// Moves the addresses to a country and (when known) their subscriptions to that market's currency
const withCountry = (country, addressIds = [501, 502], currency = { US: 'USD', CA: 'CAD', GB: 'GBP', JP: 'JPY' }[country]) => {
  const db = fixtures();
  for (const address of db.addresses) {
    if (addressIds.includes(address.id)) {
      address.country_code = country;
    }
  }
  if (currency !== undefined) {
    setCurrency(db, currency, db.subscriptions.filter(subscription => addressIds.includes(subscription.address_id)).map(subscription => subscription.id));
  }
  return db;
};

// Sets presentment_currency on the given subscriptions
const setCurrency = (db, currency, ids) => {
  for (const subscription of db.subscriptions) {
    if (ids.includes(subscription.id)) {
      subscription.presentment_currency = currency;
    }
  }
  return db;
};

describe('catalog client', () => {
  test('a lookup sends lookup_catalog with the agent profile, gids and country', async () => {
    const catalog = makeCatalog();
    const variants = await catalog.lookupVariants(['8001', NATALBIOTIC.variantId, '999'], 'CA');
    const { url, init, body } = catalog.requests[0];
    assert.equal(url, UCP_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Accept, 'application/json, text/event-stream');
    assert.equal(init.redirect, 'error');
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'lookup_catalog');
    assert.deepEqual(body.params.arguments, {
      meta: { 'ucp-agent': { profile: PROFILE_URL } },
      catalog: { ids: [variantGid('8001'), variantGid(NATALBIOTIC.variantId), variantGid('999')], context: { address_country: 'CA' } },
    });
    assert.deepEqual(variants.get(NATALBIOTIC.variantId), {
      productId: NATALBIOTIC.productId, productTitle: 'Natalbiotic™', variantTitle: 'Default Title',
      unitPrice: 106.82, currency: 'CAD', available: true,
    });
    // Not-found IDs are absent; other variants of a returned product are not added
    assert.deepEqual([...variants.keys()].sort(), ['42144416137310', '8001']);
    assert.ok(!JSON.stringify([...variants.values()]).includes(DESCRIPTION_MARKER));
  });

  test('the trimmed live response (content text only, no structuredContent) parses', async () => {
    const catalog = makeCatalog({ respond: () => jsonResponse(LIVE_LOOKUP_CA) });
    const variants = await catalog.lookupVariants([NATALBIOTIC.variantId, '42283036246110', '99999999999999'], 'CA');
    assert.equal(variants.get(NATALBIOTIC.variantId).unitPrice, 106.82);
    assert.equal(variants.get('42283036246110').unitPrice, 56.82);
    assert.equal(variants.get('42283036246110').productId, '7482572570718');
    assert.equal(variants.has('99999999999999'), false);
  });

  test('an SSE-formatted body is parsed', async () => {
    const catalog = makeCatalog({
      respond: () => new Response(`event: message\ndata: ${JSON.stringify(LIVE_LOOKUP_CA)}\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      }),
    });
    const variants = await catalog.lookupVariants([NATALBIOTIC.variantId], 'CA');
    assert.equal(variants.get(NATALBIOTIC.variantId).currency, 'CAD');
  });

  test('only exact matches on the requested ID count', async () => {
    const catalog = makeCatalog({
      respond: body => {
        const product = ucpProduct('7001', 'Essential for Women 18+', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', 3300, 'USD')]);
        product.variants[0].inputs = [{ id: variantGid('8001'), match: 'fuzzy' }];
        return jsonResponse(rpcResult(body.id, { products: [product], messages: [] }));
      },
    });
    assert.equal((await catalog.lookupVariants(['8001'], 'US')).size, 0);
  });

  test('more than 10 IDs are split into chunks of 10 (the lookup_catalog limit)', async () => {
    const catalog = makeCatalog();
    const ids = Array.from({ length: 24 }, (_, index) => String(10000 + index));
    await catalog.lookupVariants(ids, 'US');
    assert.deepEqual(catalog.requests.map(request => request.body.params.arguments.catalog.ids.length), [10, 10, 4]);
  });

  const failures = [
    ['a JSON-RPC error', () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'UCP discovery failed', data: { code: 'profile_malformed' } } }), 'profile_malformed'],
    ['isError', body => jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } }), 'tool_error'],
    ['HTTP 503', () => new Response('unavailable', { status: 503 }), 'http_error'],
    ['an unparseable body', () => new Response('<html>oops</html>', { status: 200 }), 'unparseable'],
    ['a result with no products', body => jsonResponse(rpcResult(body.id, { messages: [] })), 'unparseable'],
    ['a transport error', () => { throw new TypeError('fetch failed'); }, 'network_error'],
  ];
  for (const [label, respond, code] of failures) {
    test(`${label} throws (${code})`, async () => {
      const catalog = makeCatalog({ respond });
      await assert.rejects(catalog.lookupVariants(['8001'], 'US'), error => {
        assert.equal(error.code, code);
        return true;
      });
    });
  }

  test('a slow catalog times out', async () => {
    const catalog = makeCatalog({
      timeoutMs: 20,
      respond: (body, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    });
    await assert.rejects(catalog.lookupVariants(['8001'], 'US'), error => error.code === 'timeout');
  });

  test('country must be ISO alpha-2 uppercase and IDs digits, before any request', async () => {
    const catalog = makeCatalog();
    for (const country of ['us', 'USA', '', undefined, 'U1']) {
      await assert.rejects(catalog.lookupVariants(['8001'], country), error => error.code === 'invalid_country');
    }
    await assert.rejects(catalog.lookupVariants(['80/01'], 'US'), error => error.code === 'invalid_id');
    assert.equal(catalog.requests.length, 0);
  });

  test('a redirect is never followed', async () => {
    // Behaves like fetch: follows a redirect to an http:// host unless told not to
    const catalog = makeCatalog({
      respond: (body, init) => {
        if (init.redirect !== 'error') {
          return jsonResponse(rpcResult(body.id, { products: [ucpProduct('7001', 'E', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', 99, 'USD')])], messages: [] }));
        }
        throw new TypeError('fetch failed: unexpected redirect');
      },
    });
    await assert.rejects(catalog.lookupVariants(['8001'], 'US'), error => error.code === 'network_error');
    // A 3xx that reaches the client (redirect: 'manual' style) is not ok either
    const manual = makeCatalog({ respond: () => new Response(null, { status: 307, headers: { location: 'http://evil.example.com/' } }) });
    await assert.rejects(manual.lookupVariants(['8001'], 'US'), error => error.code === 'http_error' && error.statusCode === 307);
  });

  test('a JSON-RPC error code is only kept when it is a short plain token', async () => {
    for (const [data, expected] of [
      [{ code: 'profile_malformed' }, 'profile_malformed'],
      [{ code: { nested: true } }, 'rpc_error'],
      [{ code: `x${'y'.repeat(100)}` }, 'rpc_error'],
      [{ code: 'has spaces and <html>' }, 'rpc_error'],
      [undefined, '-32001'],
    ]) {
      const catalog = makeCatalog({ respond: () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'UCP discovery failed', data } }) });
      await assert.rejects(catalog.lookupVariants(['8001'], 'US'), error => {
        assert.equal(error.code, expected);
        assert.ok(error.message.length < 120);
        return true;
      });
    }
  });

  test('a warning or error message fails the lookup; info messages do not', async () => {
    const products = [ucpProduct('7001', 'E', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', 3300, 'USD')])];
    for (const messages of [
      [{ type: 'warning', code: 'market_fallback', content: 'priced from the default market' }],
      [{ type: 'error', code: 'pricing_unavailable', content: variantGid('8001') }],
      [null],
      'oops',
    ]) {
      const catalog = makeCatalog({ respond: body => jsonResponse(rpcResult(body.id, { products, messages })) });
      await assert.rejects(catalog.lookupVariants(['8001'], 'US'), error => error.code === 'catalog_message', JSON.stringify(messages));
    }
    for (const messages of [[{ type: 'info', code: 'not_found', content: variantGid('999') }], [], undefined]) {
      const catalog = makeCatalog({ respond: body => jsonResponse(rpcResult(body.id, { products, messages })) });
      assert.equal((await catalog.lookupVariants(['8001', '999'], 'US')).get('8001').unitPrice, 33);
    }
  });

  test('structuredContent wins over the text copy', async () => {
    const catalog = makeCatalog({
      respond: body => {
        const structured = { products: [ucpProduct('7001', 'E', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', 3300, 'USD')])], messages: [] };
        const text = { products: [ucpProduct('7001', 'E', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', 1, 'USD')])], messages: [] };
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(text) }], structuredContent: structured, isError: false } });
      },
    });
    assert.equal((await catalog.lookupVariants(['8001'], 'US')).get('8001').unitPrice, 33);
  });

  test('a variant returned under two products is ambiguous and dropped', async () => {
    const respond = body => jsonResponse(rpcResult(body.id, {
      products: [
        ucpProduct('7001', 'Essential for Women 18+', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', 3300, 'USD'), ucpVariant('8006', '60 count', 6000, 'USD')]),
        ucpProduct('7007', 'Gummies', 'g', [ucpVariant('8001', 'essential for women 18+ 30 count', 100, 'USD')]),
      ],
      messages: [],
    }));
    const variants = await makeCatalog({ respond }).lookupVariants(['8001', '8006'], 'US');
    assert.deepEqual([...variants.keys()], ['8006']);
    const { client, calls } = makeClient({ catalog: makeCatalog({ respond }) });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /That product can't be added here/);
    assert.equal(writes(calls).length, 0);
  });

  test('a non-integer, negative or string amount is never a price', async () => {
    for (const amount of [68.18, '6818', -1, null, Number.MAX_SAFE_INTEGER + 2]) {
      const respond = body => jsonResponse(rpcResult(body.id, {
        products: [ucpProduct('7001', 'Essential for Women 18+', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', amount, 'USD')])], messages: [],
      }));
      const variant = (await makeCatalog({ respond }).lookupVariants(['8001'], 'US')).get('8001');
      assert.ok(Number.isNaN(variant.unitPrice), String(amount));
      const { client, calls } = makeClient({ catalog: makeCatalog({ respond }) });
      await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /That product can't be added here/);
      assert.equal(writes(calls).length, 0, String(amount));
      assert.deepEqual((await client.findAddableProducts('essential for women 18+ 30 count', EMAIL)).products, [], String(amount));
    }
  });

  test('fraction digits come from the currency (JPY 0, KWD 3, unknown currency NaN)', async () => {
    const respond = body => jsonResponse(rpcResult(body.id, {
      products: [
        ucpProduct('7001', 'E', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', 1000, 'JPY'), ucpVariant('8006', '60 count', 12345, 'KWD')]),
        ucpProduct('7005', 'P', 'p', [ucpVariant('8007', 'Chocolate', 3300, 'XYZ1')]),
      ],
      messages: [],
    }));
    const variants = await makeCatalog({ respond }).lookupVariants(['8001', '8006', '8007'], 'JP');
    assert.equal(variants.get('8001').unitPrice, 1000);
    assert.equal(variants.get('8006').unitPrice, 12.345);
    assert.ok(Number.isNaN(variants.get('8007').unitPrice));
  });

  test('MCP_SHOPIFY_UCP_URL and MCP_UCP_AGENT_PROFILE must both be https URLs', () => {
    assert.deepEqual(parseShopifyCatalogConfig(undefined, ''), { config: null, warnings: [] });
    assert.deepEqual(parseShopifyCatalogConfig(UCP_URL, PROFILE_URL), { config: { endpoint: UCP_URL, profileUrl: PROFILE_URL }, warnings: [] });
    for (const [endpoint, profile, pattern] of [
      ['http://shop.example.com/api/ucp/mcp', PROFILE_URL, /MCP_SHOPIFY_UCP_URL must be an https URL/],
      [UCP_URL, 'not a url', /MCP_UCP_AGENT_PROFILE must be an https URL/],
      ['https://user:pw@shop.example.com/mcp', PROFILE_URL, /MCP_SHOPIFY_UCP_URL must be an https URL/],
      [UCP_URL, undefined, /MCP_UCP_AGENT_PROFILE is not set/],
    ]) {
      const parsed = parseShopifyCatalogConfig(endpoint, profile);
      assert.equal(parsed.config, null);
      assert.match(parsed.warnings.join(' '), pattern);
      assert.ok(!parsed.warnings.join(' ').includes('pw@'));
    }
  });
});

describe('adds priced from the Shopify catalog', () => {
  test('a CA address looks up with CA context and is checked against the CAD price', async () => {
    const { client, calls, catalog } = makeClient({
      db: withCountry('CA'),
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '106.82', presentment_currency: 'CAD' } }) },
    });
    const result = await client.verifiedCreateOnetime(onetimeArgs({ variantId: Number(NATALBIOTIC.variantId) }), EMAIL);
    assert.equal(result.onetime.price, '106.82');
    assert.deepEqual(catalog.requests.map(request => request.body.params.arguments.catalog), [
      { ids: [variantGid(NATALBIOTIC.variantId)], context: { address_country: 'CA' } },
    ]);
    assert.deepEqual(writes(calls)[0].data.external_product_id, { ecommerce: NATALBIOTIC.productId });
  });

  test('the same price on a US address is above the USD catalog price, so it is removed again', async () => {
    const { client, calls } = makeClient({
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '106.82', presentment_currency: 'USD' } }) },
    });
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ variantId: Number(NATALBIOTIC.variantId) }), EMAIL), /removed again/);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes', 'DELETE /onetimes/4001']);
  });

  test('a CA subscription at the 12% plan price is accepted', async () => {
    const db = withCountry('CA');
    const { client, calls } = makeClient({
      db,
      overrides: { 'POST /subscriptions': ({ data }) => ({ subscription: { id: 1101, ...data, price: '94.00', presentment_currency: 'CAD' } }) },
    });
    await client.verifiedCreateSubscription(subscriptionArgs({ variantId: Number(NATALBIOTIC.variantId) }), EMAIL);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /subscriptions']);
    assert.equal(writes(calls)[0].data.plan_id, 4);
  });

  test('a product gid that differs from the allowlist is refused with no write', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ variantId: 8010 }), EMAIL), /That product can't be added here/);
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ variantId: 8010 }), EMAIL), /That product can't be added here/);
    assert.equal(writes(calls).length, 0);
  });

  test('an unavailable variant is refused with no write', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ variantId: 8004 }), EMAIL), /That product can't be added here/);
    assert.equal(writes(calls).length, 0);
  });

  test('an address with no usable country is refused before the catalog is read', async () => {
    for (const country of [undefined, '', 'Canada']) {
      const { client, calls, catalog } = makeClient({ db: withCountry(country) });
      await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /That product can't be added here/);
      assert.equal(writes(calls).length, 0);
      assert.equal(catalog.requests.length, 0);
    }
  });

  test('a catalog failure is a "could not be checked" refusal and nothing is posted', async () => {
    for (const respond of [
      () => { throw new TypeError('fetch failed'); },
      () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'UCP discovery failed', data: { code: 'profile_malformed' } } }),
    ]) {
      const { client, calls } = makeClient({ catalog: makeCatalog({ respond }) });
      await refusal(client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /could not be checked right now, so nothing was changed/);
      assert.equal(writes(calls).length, 0);
    }
  });

  test('write-time checks always read the catalog fresh', async () => {
    const { client, catalog } = makeClient();
    await client.findAddableProducts('essential for women 18+', EMAIL);
    await client.verifiedCreateOnetime(onetimeArgs(), EMAIL);
    await client.verifiedCreateOnetime(onetimeArgs({ date: FUTURE_2 }), EMAIL);
    assert.equal(catalog.requests.length, 3);
  });

  test('without a catalog nothing can be added or found', async () => {
    const { client, calls } = makeClient({ catalog: null });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /That product can't be added here/);
    await refusal(client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /That product can't be added here/);
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential for women 18+' });
    assert.match(result.content[0].text, /Adding products isn't available here; hand off to a support agent/);
    assert.equal(writes(calls).length, 0);
  });

  test('a created record in another currency is deleted again and refused', async () => {
    const { client, calls } = makeClient({
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '33.00', presentment_currency: 'CAD' } }) },
    });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /priced this item differently.*removed again/);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes', 'DELETE /onetimes/4001']);

    const second = makeClient({
      overrides: { 'POST /subscriptions': ({ data }) => ({ subscription: { id: 1101, ...data, price: '29.70', currency: 'GBP' } }) },
    });
    await refusal(second.client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /removed again/);
    assert.deepEqual(writes(second.calls).map(call => `${call.method} ${call.endpoint}`), ['POST /subscriptions', 'DELETE /subscriptions/1101']);
  });

  test('a lowercase country_code is used as the uppercase country', async () => {
    const { client, catalog } = makeClient({
      db: withCountry('ca', [501, 502], 'CAD'),
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '106.82', presentment_currency: 'CAD' } }) },
    });
    await client.verifiedCreateOnetime(onetimeArgs({ variantId: Number(NATALBIOTIC.variantId) }), EMAIL);
    assert.equal(catalog.requests[0].body.params.arguments.catalog.context.address_country, 'CA');
  });

  test("a catalog price in another market's currency is refused with no write", async () => {
    // A CA address priced in USD (e.g. a default-market fallback)
    const catalogDb = catalogFixtures();
    catalogDb.CA = catalogDb.US;
    const { client, calls } = makeClient({ db: withCountry('CA'), catalog: makeCatalog({ db: catalogDb }) });
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ variantId: Number(NATALBIOTIC.variantId) }), EMAIL), /That product can't be added here/);
    assert.equal(writes(calls).length, 0);
    assert.deepEqual((await client.findAddableProducts('natalbiotic', EMAIL)).products, []);
  });

  test('a created record naming no currency is only trusted when subscribed in USD', async () => {
    // CA (CAD subscriptions): the record's 68.18 could be USD under a 106.82 CAD ceiling, so it is removed again
    const ca = makeClient({
      db: withCountry('CA'),
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '68.18' } }) },
    });
    await refusal(ca.client.verifiedCreateOnetime(onetimeArgs({ variantId: Number(NATALBIOTIC.variantId) }), EMAIL), /removed again/);
    assert.deepEqual(writes(ca.calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes', 'DELETE /onetimes/4001']);

    // US (USD subscriptions): no currency on the record, priced at the USD catalog price, is accepted
    const us = makeClient({
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '68.18' } }) },
    });
    await us.client.verifiedCreateOnetime(onetimeArgs({ variantId: Number(NATALBIOTIC.variantId) }), EMAIL);
    assert.deepEqual(writes(us.calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes']);
  });

  test('an empty presentment_currency falls back to currency', async () => {
    const { client, calls } = makeClient({
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '33.00', presentment_currency: '', currency: 'CAD' } }) },
    });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /removed again/);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes', 'DELETE /onetimes/4001']);
  });
});

describe('find_addable_product with the Shopify catalog', () => {
  test("country comes from the customer's subscribed addresses: one shared country, otherwise US", async () => {
    for (const [db, expected, currency, price] of [
      [withCountry('CA'), 'CA', 'CAD', '45.00'],
      // 502 (US) holds none of alice's subscriptions, so only 501 (CA) picks the country
      [withCountry('CA', [501]), 'CA', 'CAD', '45.00'],
      [fixtures(), 'US', 'USD', '33.00'],
    ]) {
      const { client, catalog, calls } = makeClient({ db });
      const [first] = (await client.findAddableProducts('essential for women 18+ 30 count', EMAIL)).products;
      assert.equal(catalog.requests[0].body.params.arguments.catalog.context.address_country, expected);
      assert.deepEqual([first.unit_price, first.currency], [price, currency]);
      assert.deepEqual(calls.find(call => call.endpoint === '/addresses').params, { customer_id: '100', limit: 250 });
    }
  });

  test("only the customer's own addresses pick the country", async () => {
    // alice's addresses are all CA; someone else's address (returned by the unfiltered list) is US
    const db = withCountry('CA');
    db.addresses.find(address => address.id === 601).country_code = 'US';
    const { client, catalog } = makeClient({ db });
    const [first] = (await client.findAddableProducts('essential for women 18+ 30 count', EMAIL)).products;
    assert.equal(catalog.requests[0].body.params.arguments.catalog.context.address_country, 'CA');
    assert.deepEqual([first.unit_price, first.currency], ['45.00', 'CAD']);
  });

  test('without customer_email the US catalog is used and no customer is read', async () => {
    const { client, catalog, calls } = makeClient({ db: withCountry('CA') });
    for (const email of [undefined, '', '   ']) {
      const result = await toolByName('find_addable_product').execute(client, { customer_email: email, query: 'essential for women 18+ 30 count' });
      assert.ok(!result.isError);
      assert.match(result.content[0].text, /"currency": "USD"/);
    }
    assert.equal(catalog.requests[0].body.params.arguments.catalog.context.address_country, 'US');
    assert.deepEqual(calls.filter(call => ['/customers', '/addresses', '/subscriptions'].includes(call.endpoint)), []);
  });

  test('unit_price uses the currency minor-unit digits (JPY has none)', async () => {
    const catalogDb = { JP: [ucpProduct('7001', 'Essential for Women 18+', 'e', [ucpVariant('8001', 'essential for women 18+ 30 count', 1000, 'JPY')])] };
    const { client } = makeClient({ db: withCountry('JP'), catalog: makeCatalog({ db: catalogDb }) });
    const [first] = (await client.findAddableProducts('essential for women 18+ 30 count', EMAIL)).products;
    assert.deepEqual([first.unit_price, first.currency], ['1000', 'JPY']);
  });

  test('the cache is per country', async () => {
    const db = withCountry('CA');
    const { client, catalog } = makeClient({ db });
    await client.findAddableProducts('essential for women 18+', EMAIL);
    db.addresses[0].country_code = 'US';
    db.addresses[1].country_code = 'US';
    setCurrency(db, 'USD', db.subscriptions.map(subscription => subscription.id));
    await client.findAddableProducts('essential for women 18+', EMAIL);
    await client.findAddableProducts('protein', EMAIL);
    assert.deepEqual(catalog.requests.map(request => request.body.params.arguments.catalog.context.address_country), ['CA', 'US']);
  });

  test('a variant missing from the catalog is skipped and the others are returned', async () => {
    const catalogDb = catalogFixtures();
    catalogDb.US[0].variants = catalogDb.US[0].variants.filter(variant => variant.id !== variantGid('8001'));
    const { client } = makeClient({ catalog: makeCatalog({ db: catalogDb }) });
    assert.deepEqual((await client.findAddableProducts('essential for women 18+', EMAIL)).products.map(product => product.variant_id), [8006]);
  });

  test('descriptions never reach the tool output', async () => {
    const { client } = makeClient();
    for (const query of ['essential for women 18+', 'natalbiotic', 'protein']) {
      const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query });
      assert.ok(!result.isError, query);
      assert.ok(!result.content[0].text.includes(DESCRIPTION_MARKER), query);
      assert.doesNotMatch(result.content[0].text, /description|html|handle|sku/i, query);
    }
    const natalbiotic = await client.findAddableProducts('natalbiotic', EMAIL);
    assert.deepEqual(natalbiotic.products, [{
      variant_id: Number(NATALBIOTIC.variantId), title: 'Natalbiotic™', variant_title: 'Default Title',
      unit_price: '68.18', currency: 'USD', can_subscribe: true,
    }]);
  });

  test('a JSON-RPC error becomes the "could not be looked up" hand-off', async () => {
    const { client } = makeClient({
      catalog: makeCatalog({ respond: () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'UCP discovery failed', data: { code: 'profile_malformed' } } }) }),
    });
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential for women 18+' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /could not be looked up right now.*hand off to a support agent/);
    assert.doesNotMatch(result.content[0].text, /UCP|profile_malformed/);
  });

  test('an unknown customer gets the customer-safe refusal, not a lookup', async () => {
    const { client, catalog } = makeClient();
    const result = await toolByName('find_addable_product').execute(client, { customer_email: 'nobody@example.com', query: 'essential for women 18+' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Customer not found.*hand off to a support agent/);
    assert.equal(catalog.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// find_addable_product matching: by name (stage 1), then interpreted by search (stage 2)
// ---------------------------------------------------------------------------

// Live ritual.com titles (curly apostrophes and trademark glyphs as served); IDs and some flavors are made up
const MATCH_PRODUCTS = [
  ['7101', 'Women’s Multivitamin 18+', [['8101', 'Mint / 30 servings', 3750], ['8102', 'Citrus / 30 servings', 3750]]],
  ['7102', 'Women’s Multivitamin 50+', [['8103', 'Default Title', 4432]]],
  ['7103', 'Men’s Multivitamin 18+', [['8104', '30 servings', 3750]]],
  ['7104', 'Men’s Multivitamin 50+', [['8105', 'Default Title', 4432]]],
  ['7105', 'Prenatal Multivitamin', [['8106', 'Citrus', 4432], ['8107', 'Mint', 4432]]],
  ['7106', 'Daily Shake', [['8108', 'Vanilla', 5000]]],
  ['7107', 'Daily Shake', [['8109', 'Chocolate', 5000]]],
  ['7108', 'Daily Shake Pregnancy & Postpartum', [['8110', 'Vanilla', 5000]]],
  ['7109', 'Omega-3 DHA & EPA', [['8111', 'Default Title', 3750]]],
  ['7110', 'Natalbiotic™', [['8112', 'Default Title', 6818]]],
  ['7111', 'Synbiotic+', [['8113', '30 servings', 6136]]],
  ['7112', 'Sleep', [['8114', 'Default Title', 2841]]],
  ['7113', 'Magnesium+', [['8115', 'Default Title', 5682]]],
  ['7114', 'Creatine Greens', [['8116', 'Default Title', 6591]]],
  ['7115', 'Daily Shake', [['8117', 'Strawberry', 5000]]],
  ['7116', 'Daily Shake', [['8118', 'Coffee', 5000]]],
];
// On the storefront and in search results, but not allowlisted
const MATCH_NOT_ADDABLE = [
  ['7201', 'Prenatal Essential Support Ritual*', [['8201', 'Default Title', 9000]]],
  ['7202', 'The Shaker', [['8202', 'Default Title', 1500]]],
  ['7203', 'Daily Health 18+ Support Ritual*', [['8203', 'Default Title', 8700]]],
  ['7204', 'Gut & Skin Support Ritual*', [['8204', 'Default Title', 10800]]],
  ['7205', 'Mom-to-Baby Support Ritual*', [['8205', 'Default Title', 9900]]],
];
const MATCH_ADDABLE = new Map(MATCH_PRODUCTS.flatMap(([productId, , variants]) => variants.map(([variantId]) => [variantId, productId])));

function matchCatalogDb() {
  const build = (currency, factor) => [...MATCH_PRODUCTS, ...MATCH_NOT_ADDABLE].map(([id, title, variants]) =>
    ucpProduct(id, title, `handle-${id}`, variants.map(([variantId, variantTitle, amount]) =>
      ucpVariant(variantId, variantTitle, Math.round(amount * factor), currency))));
  return { US: build('USD', 1), CA: build('CAD', 1.5) };
}

/**
 * search_catalog records for product IDs in rank order. Each is priced at 1
 * EUR minor unit with only a search-only variant, so any price, currency or
 * variant taken from the search instead of the lookup would show.
 */
function searchRecords(ids) {
  return ids.map(id => {
    const known = [...MATCH_PRODUCTS, ...MATCH_NOT_ADDABLE].find(([productId]) => productId === id);
    return ucpProduct(id, known ? known[1] : `Unknown ${id}`, `handle-${id}`, [ucpVariant(`9${id}`, 'Search Only', 1, 'EUR')]);
  });
}

// A search stub answering each query with the product IDs listed for it, and nothing for any other query
const searchFor = answers => query => searchRecords(answers[query] || []);

function matchClient({ answers = {}, search = searchFor(answers), db, catalogDb = matchCatalogDb(), timeoutMs } = {}) {
  return makeClient({
    ...(db ? { db } : {}),
    addable: MATCH_ADDABLE,
    catalog: makeCatalog({ db: catalogDb, search, ...(timeoutMs ? { timeoutMs } : {}) }),
  });
}

// matchCatalogDb() with one variant (or each of a list) changed in every country
function matchCatalogDbWith(variantIds, change) {
  const db = matchCatalogDb();
  const changed = [].concat(variantIds).map(variantGid);
  for (const products of Object.values(db)) {
    for (const variant of products.flatMap(product => product.variants)) {
      if (changed.includes(variant.id)) {
        change(variant);
      }
    }
  }
  return db;
}

// Every live addable product title, for matcher-only tests (IDs and flavors made up)
const LIVE_PRODUCTS = [
  ['101', 'Women’s Multivitamin 18+', ['Mint', 'Citrus']],
  ['102', 'Women’s Multivitamin 50+', ['Default Title']],
  ['103', 'Men’s Multivitamin 18+', ['Default Title']],
  ['104', 'Men’s Multivitamin 50+', ['Default Title']],
  ['105', 'Prenatal Multivitamin', ['Citrus', 'Mint']],
  ['106', 'Postnatal Multivitamin', ['Citrus', 'Mint']],
  ['107', 'Daily Shake', ['Vanilla']],
  ['108', 'Daily Shake', ['Chocolate']],
  ['109', 'Daily Shake Pregnancy & Postpartum', ['Vanilla']],
  ['110', 'Natalbiotic™', ['Default Title']],
  ['111', 'Synbiotic+', ['Default Title']],
  ['112', 'Omega-3 DHA & EPA', ['Default Title']],
  ['113', 'Sleep', ['Default Title']],
  ['114', 'Stress Relief', ['Default Title']],
  ['115', 'Iron', ['Default Title']],
  ['116', 'Magnesium+', ['Default Title']],
  ['117', 'HyaCera™', ['Default Title']],
  ['118', 'Creatine Greens', ['Default Title']],
  ['119', 'Fertility Support', ['Default Title']],
  ['120', 'Perimenopause Health', ['Default Title']],
  ['121', 'Natal Choline', ['Default Title']],
];
const LIVE_VARIANTS = LIVE_PRODUCTS.flatMap(([productId, productTitle, variantTitles]) =>
  variantTitles.map((variantTitle, index) => ({ variantId: `${productId}${index}`, productId, productTitle, variantTitle })));

// Search results ranking the given LIVE_PRODUCTS IDs
const liveRanking = ranking => ranking.map(productId => ({ productId, title: LIVE_PRODUCTS.find(([id]) => id === productId)[1] }));

/**
 * matchAddableVariants over LIVE_VARIANTS with a search ranking the given
 * product IDs, as "Title [variant]" strings, and whether it searched. The
 * products or variants listed in `unsellable` are passed as unsellable.
 */
async function matchLive(query, ranking = [], unsellable = []) {
  let searched = false;
  const search = async () => {
    searched = true;
    return liveRanking(ranking);
  };
  const gone = variant => unsellable.includes(variant.productId) || unsellable.includes(variant.variantId);
  const { match, variants } = await matchAddableVariants(query, LIVE_VARIANTS.filter(variant => !gone(variant)), {
    search,
    unsellable: LIVE_VARIANTS.filter(gone),
  });
  return { match, titles: variants.map(variant => `${variant.productTitle} [${variant.variantTitle}]`), searched };
}

const variantIds = result => result.products.map(product => product.variant_id);

describe('find_addable_product matching by name', () => {
  test('old names, possessives, curly apostrophes, symbols and abbreviations match by name with no search', async () => {
    const { client, catalog } = matchClient();
    for (const [query, expected] of [
      ['Essential for Women 18+', [8101, 8102]],
      ["women's multivitamin 18+", [8101, 8102]],
      ['Women’s Multivitamin 18+', [8101, 8102]],
      ['WOMENS MULTI 18', [8101, 8102]],
      ['mens multi 50 plus', [8105]],
      ['Essential Prenatal', [8106, 8107]],
      ['prenatal vitamins', [8106, 8107]],
      ['Natalbiotic™', [8112]],
      ['natalbiotic', [8112]],
      ['Omega-3 DHA and EPA', [8111]],
      ['omega3', [8111]],
      ['omega 3s', [8111]],
      ['synbiotic plus', [8113]],
      ['Magnesium+', [8115]],
      ['greens', [8116]],
      ['please add one more bottle of my ritual sleep', [8114]],
    ]) {
      const result = await client.findAddableProducts(query, EMAIL);
      assert.equal(result.match, 'name', query);
      assert.deepEqual(variantIds(result), expected, query);
    }
    assert.equal(catalog.searches.length, 0);
  });

  test('plurals match, and the closest titles come first', async () => {
    const { client } = matchClient();
    // Every Daily Shake before Daily Shake Pregnancy & Postpartum, which has words the customer didn't say
    assert.deepEqual(variantIds(await client.findAddableProducts('daily shakes', EMAIL)), [8108, 8109, 8117, 8118, 8110]);
  });

  test('small typos match; short words and longer words never fuzz', async () => {
    const { client } = matchClient();
    for (const [query, expected] of [
      ['prenatl', [8106, 8107]],
      ['magnesum', [8115]],
      ['omgea 3', [8111]],
      ['synbiotc', [8113]],
      ['womens multivitamen 18+', [8101, 8102]],
      ['creatin greens', [8116]],
      // The trademark glyph is dropped, not read as "tm": "natalbiotictm" would be two typos away
      ['natalbiotc', [8112]],
      // Two typos in a word of 9+ letters
      ['multivitmn', [8106, 8107, 8101, 8102, 8103, 8104, 8105]],
    ]) {
      const result = await client.findAddableProducts(query, EMAIL);
      assert.equal(result.match, 'name', query);
      assert.deepEqual(variantIds(result), expected, query);
    }
    // "slep" is too short for a typo; "shaker" is another word, not "shake" misspelled
    for (const query of ['slep', 'shaker']) {
      assert.deepEqual(await client.findAddableProducts(query, EMAIL), { match: 'none', products: [] }, query);
    }
    assert.equal(wordMatch('men', 'women'), null);
    assert.equal(wordMatch('wome', 'women'), 'exact');
    assert.equal(wordMatch('postnatal', 'prenatal'), null);
    assert.equal(wordMatch('multivitamn', 'multivitamin'), 'fuzzy');
    assert.equal(wordMatch('perimenapause', 'perimenopause'), 'fuzzy');
    // Another ending on the title word's stem is another word: "perimenopausal" states a condition
    assert.equal(wordMatch('perimenopausal', 'perimenopause'), null);
    // So is the whole title word with letters in front: "infertility" names a condition, not Fertility Support
    assert.equal(wordMatch('infertility', 'fertility'), null);
    assert.equal(wordMatch('asleep', 'sleep'), null);
    assert.equal(wordMatch('fertilty', 'fertility'), 'fuzzy');
    assert.equal(wordMatch('symbiotic', 'synbiotic'), 'fuzzy');
    assert.deepEqual(matchWords('Natalbiotic™'), ['natalbiotic']);
    // One typo from 5 letters, two from 9: never two below 9
    assert.equal(wordMatch('prenatl', 'prenatal'), 'fuzzy');
    assert.equal(wordMatch('prentl', 'prenatal'), null);
    assert.equal(wordMatch('multivitmn', 'multivitamin'), 'fuzzy');
    assert.equal(wordMatch('sinbiotik', 'synbiotic'), 'fuzzy');
    assert.equal(wordMatch('prinatel', 'prenatal'), null);
  });

  test('a prefix needs 5 letters, or all but the last letter: "heal" is not Health, "d3" is not Omega-3 DHA & EPA', async () => {
    assert.equal(wordMatch('d', 'dha'), null);
    assert.equal(wordMatch('dh', 'dha'), null);
    assert.equal(wordMatch('pr', 'prenatal'), null);
    // Shorter starts are often other words
    for (const [word, titleWord] of [['heal', 'health'], ['pre', 'prenatal'], ['post', 'postnatal'], ['wom', 'women'], ['supp', 'support'],
      ['rel', 'relief'], ['fert', 'fertility'], ['stre', 'stress'], ['magn', 'magnesium'], ['cho', 'choline']]) {
      assert.equal(wordMatch(word, titleWord), null, `${word} ${titleWord}`);
    }
    for (const [word, titleWord] of [['omega', 'omega'], ['omeg', 'omega'], ['iro', 'iron'], ['slee', 'sleep'], ['wome', 'women'],
      ['magnes', 'magnesium'], ['creat', 'creatine'], ['prena', 'prenatal'], ['multivit', 'multivitamin'], ['healt', 'health']]) {
      assert.equal(wordMatch(word, titleWord), 'exact', `${word} ${titleWord}`);
    }
    // Abbreviations too short for a prefix are synonyms
    assert.deepEqual(queryWords('mag peri choc multi'), ['magnesium', 'perimenopause', 'chocolate', 'multivitamin']);
    for (const [query, expected] of [
      ['heal', []], ['perimenopause heal', []], ['pre', []], ['supp', []],
      ['omega', ['Omega-3 DHA & EPA [Default Title]']], ['magnes', ['Magnesium+ [Default Title]']], ['mag', ['Magnesium+ [Default Title]']],
      ['creat greens', ['Creatine Greens [Default Title]']], ['peri', ['Perimenopause Health [Default Title]']],
      ['choc shake', ['Daily Shake [Chocolate]']],
    ]) {
      const result = await matchLive(query, ['120', '105']);
      assert.deepEqual(result.titles, expected, query);
      assert.equal(result.searched, false, query);
    }
    const { client, catalog } = matchClient();
    assert.deepEqual(await client.findAddableProducts('d3', EMAIL), { match: 'none', products: [] });
    assert.equal(catalog.searches.length, 0);
  });

  test('a title matched without a typo hides titles matched only with one', () => {
    const variants = [
      { variantId: '1', productId: '1', productTitle: 'Sheep', variantTitle: 'Default Title' },
      { variantId: '2', productId: '2', productTitle: 'Sleep', variantTitle: 'Default Title' },
    ];
    assert.deepEqual(matchByName(queryWords('sleep'), variants).map(variant => variant.variantId), ['2']);
    assert.deepEqual(matchByName(queryWords('sleeep'), variants).map(variant => variant.variantId), ['2']);
  });

  test('numbers never fuzz: 18+ and 50+ never match each other', async () => {
    assert.equal(wordMatch('18', '18+'), 'exact');
    assert.equal(wordMatch('18+', '18+'), 'exact');
    for (const [word, titleWord] of [['18+', '50+'], ['50+', '18+'], ['18+', '18'], ['1', '18+'], ['50', '5'], ['30', '3']]) {
      assert.equal(wordMatch(word, titleWord), null, `${word} ${titleWord}`);
    }
    const { client, catalog } = matchClient({ answers: { "Women's Multivitamin 40+": ['7101', '7102'] } });
    assert.deepEqual(variantIds(await client.findAddableProducts("women's multivitamin 50+", EMAIL)), [8103]);
    assert.deepEqual(variantIds(await client.findAddableProducts('Essential for Men 18+', EMAIL)), [8104]);
    assert.deepEqual(variantIds(await client.findAddableProducts('women 18', EMAIL)), [8101, 8102]);
    // A title without a number doesn't need one; the retired "Essential Protein" name is Daily Shake
    const shake = await client.findAddableProducts('Essential Protein Daily Shake 18+', EMAIL);
    assert.equal(shake.match, 'name');
    assert.deepEqual(variantIds(shake).slice(0, 2), [8108, 8109]);
    // No title has 40+, so it is never searched; a query of only that number never matches a title without one
    assert.deepEqual(await client.findAddableProducts("Women's Multivitamin 40+", EMAIL), { match: 'none', products: [] });
    assert.deepEqual(await client.findAddableProducts('40+', EMAIL), { match: 'none', products: [] });
    assert.equal(catalog.searches.length, 0);
    const variants = MATCH_PRODUCTS.flatMap(([productId, productTitle, productVariants]) =>
      productVariants.map(([variantId, variantTitle]) => ({ variantId, productId, productTitle, variantTitle })));
    assert.deepEqual(matchByName(queryWords('the 40+ one'), variants), []);
  });

  test('flavor words narrow to the variants named', async () => {
    const { client } = matchClient();
    for (const [query, expected] of [
      ['mint prenatal', [8107]],
      ["citrus women's", [8102]],
      ['mint womens 18+', [8101]],
      ['chocolate shake', [8109]],
      ['vanilla shake', [8108, 8110]],
    ]) {
      assert.deepEqual(variantIds(await client.findAddableProducts(query, EMAIL)), expected, query);
    }
  });

  test('a query of filler words matches nothing and never searches', async () => {
    const { client, catalog } = matchClient({ search: () => searchRecords(['7112']) });
    for (const query of ['ritual', 'the', 'please add my', '   ']) {
      assert.deepEqual(await client.findAddableProducts(query, EMAIL), { match: 'none', products: [] }, query);
    }
    assert.equal(catalog.searches.length, 0);
  });

  test('titles that matched the query\'s number hide titles that only had no number to match', async () => {
    const { client } = matchClient();
    assert.deepEqual(variantIds(await client.findAddableProducts('multivitamin 50+', EMAIL)), [8103, 8105]);
    // Allowlist order reversed: Postnatal and Prenatal first still never match "50+"
    const variants = [
      ['1', 'Postnatal Multivitamin', 'Default Title'],
      ['2', 'Prenatal Multivitamin', 'Mint'],
      ['3', 'Men’s Multivitamin 50+', 'Default Title'],
      ['4', 'Women’s Multivitamin 50+', 'Default Title'],
      ['5', 'Women’s Multivitamin 18+', 'Mint / 30 servings'],
    ].map(([id, productTitle, variantTitle]) => ({ variantId: id, productId: id, productTitle, variantTitle }));
    assert.deepEqual(matchByName(queryWords('multivitamin 50+'), variants).map(variant => variant.variantId), ['3', '4']);
    assert.deepEqual(matchByName(queryWords('womens multi 50 plus'), variants).map(variant => variant.variantId), ['4']);
    // With no title carrying the number, the numberless titles still match ("Daily Shake" for the retired 18+ name)
    assert.deepEqual(matchByName(queryWords('postnatal 18+'), variants).map(variant => variant.variantId), ['1']);
    // A 50+ title matches apart from the flavor, which it doesn't come in: never the numberless title in that flavor
    for (const query of ['mint multivitamin 50+', 'mint multi 50+', 'mins multivitamin 50+']) {
      assert.deepEqual(matchByName(queryWords(query), variants), [], query);
    }
  });

  test('with no title left in the query\'s age band, a title without one never stands in for it', async () => {
    for (const [query, gone] of [['multivitamin 50+', ['102', '104']], ['multi 50 plus', ['102', '104']], ['multivitamin 18+', ['101', '103']]]) {
      const variants = LIVE_VARIANTS.filter(variant => !gone.includes(variant.productId));
      assert.deepEqual(matchByName(queryWords(query), variants), [], query);
      // Nor by search, even when it ranks the numberless titles first
      const search = async () => liveRanking(['105', '106']);
      assert.deepEqual(await matchAddableVariants(query, variants, { search }), { match: 'none', variants: [] }, query);
    }
    // With 50+ only in the other gender's title (so the query is searched), a numberless women's title never stands in
    const variants = [['1', 'Women’s Multivitamin 18+'], ['2', 'Men’s Multivitamin 50+'], ['3', 'Women’s Multivitamin']]
      .map(([id, productTitle]) => ({ variantId: id, productId: id, productTitle, variantTitle: 'Default Title' }));
    const search = async () => [{ productId: '3', title: 'Women’s Multivitamin' }, { productId: '1', title: 'Women’s Multivitamin 18+' }];
    assert.deepEqual(await matchAddableVariants("women's multivitamin 50+", variants, { search }), { match: 'none', variants: [] });
  });

  test('"protein" without a shake word must match: "Essential Protein 18+" is never a multivitamin by its age band', async () => {
    for (const query of ['essential protein 18+', 'essential protein 50+']) {
      assert.deepEqual(await matchLive(query, ['107']), { match: 'interpreted', titles: ['Daily Shake [Vanilla]'], searched: true }, query);
    }
    for (const query of ['prenatal protein', 'mens protein', 'womens protein', 'essential protein 18+']) {
      assert.deepEqual(await matchLive(query, ['105', '103', '101']), { match: 'none', titles: [], searched: true }, query);
    }
    // Alone (with or without an age band) it is a nutrient, never searched
    for (const query of ['protein', 'protein 50+', 'PROTEIN']) {
      assert.deepEqual(await matchLive(query, ['107']), { match: 'none', titles: [], searched: false }, query);
    }
    // Next to "shake" it is still the retired name
    const shake = await matchLive('essential protein daily shake 18+');
    assert.equal(shake.match, 'name');
    assert.deepEqual(shake.titles.slice(0, 2), ['Daily Shake [Vanilla]', 'Daily Shake [Chocolate]']);
    assert.deepEqual(queryWords('essential protein shake'), ['shake']);
    assert.deepEqual(queryWords('essential protein 18+'), ['protein', '18+']);
  });

  test('a product named by its title that can\'t be sold now is nothing, never a sibling or another age band', async () => {
    for (const [query, unsellable] of [
      ['daily shake', ['107', '108']],
      ['shake', ['107', '108']],
      ['essential protein daily shake', ['107', '108']],
      ['daily shake 18+', ['107', '108']],
      ['daily shake vanilla', ['107']],
      ['womens multivitamin', ['101']],
      ['multivitamin 50+', ['102', '104']],
      ['sleep', ['113']],
    ]) {
      assert.deepEqual(await matchLive(query, ['109', '102', '113'], unsellable), { match: 'none', titles: [], searched: false }, query);
    }
    // Another flavor or size of the same title is not another product, nor is a sibling ranked below the closest one
    for (const [query, unsellable, expected] of [
      ['daily shake', ['107'], ['Daily Shake [Chocolate]', 'Daily Shake Pregnancy & Postpartum [Vanilla]']],
      ['womens multivitamin 18+', ['1010'], ['Women’s Multivitamin 18+ [Citrus]']],
      ['womens multivitamin', ['1010'], ['Women’s Multivitamin 18+ [Citrus]', 'Women’s Multivitamin 50+ [Default Title]']],
      ['daily shake pregnancy', ['107', '108'], ['Daily Shake Pregnancy & Postpartum [Vanilla]']],
    ]) {
      assert.deepEqual(await matchLive(query, [], unsellable), { match: 'name', titles: expected, searched: false }, query);
    }
    // Through the client: the catalog's out-of-stock variants are the unsellable ones
    const outOfStock = variant => { variant.availability.available = false; };
    for (const [query, gone, answers] of [
      ['vanilla daily shake', '8108'],
      ["women's multivitamin", ['8101', '8102']],
      ['mint multivitamin', '8107'],
      ['prenatal', ['8106', '8107'], { prenatal: ['7110'] }],
    ]) {
      const { client, catalog } = matchClient({ catalogDb: matchCatalogDbWith(gone, outOfStock), answers });
      assert.deepEqual(await client.findAddableProducts(query, EMAIL), { match: 'none', products: [] }, query);
      assert.equal(catalog.searches.length, 0, query);
    }
    // An out-of-stock product still has a known title, so it never blocks partial names of the others
    for (const [query, gone, expected] of [
      ['women', '8113', [8101, 8102, 8103]],
      ['shake', '8113', [8108, 8109, 8117, 8118, 8110]],
      ['omega', '8114', [8111]],
    ]) {
      const { client } = matchClient({ catalogDb: matchCatalogDbWith(gone, outOfStock) });
      const result = await client.findAddableProducts(query, EMAIL);
      assert.equal(result.match, 'name', query);
      assert.deepEqual(variantIds(result), expected, query);
    }
  });

  test('only retired product-line words name no one product: nothing, and never searched', async () => {
    for (const query of ['essential', 'Essential', 'the essential one please']) {
      assert.deepEqual(await matchLive(query, ['113']), { match: 'none', titles: [], searched: false }, query);
    }
  });

  test('an age band and a flavor the age band doesn\'t come in match nothing, by name or by search', async () => {
    const { client, catalog } = matchClient({
      answers: { 'citrus multivitamin 50+': ['7105', '7102'], 'mint multi 50+': ['7102', '7105'], 'vanilla 50+': ['7106', '7108'] },
    });
    for (const query of ['citrus multivitamin 50+', 'mint multi 50+', 'vanilla 50+']) {
      assert.deepEqual(await client.findAddableProducts(query, EMAIL), { match: 'none', products: [] }, query);
    }
    assert.equal(catalog.searches.length, 3);
    assert.deepEqual(variantIds(await client.findAddableProducts('citrus multivitamin', EMAIL)), [8106, 8102]);
  });

  test('other gender words, spelled-out age bands and "over" are normalized and match by name', async () => {
    const { client, catalog } = matchClient();
    for (const [query, expected] of [
      ['male multivitamin 50+', [8105]],
      ['multivitamin 50+ for him', [8105]],
      ['his multivitamin', [8104, 8105]],
      ['female multivitamin', [8101, 8102, 8103]],
      ['ladies multivitamin 50+', [8103]],
      ['multi for her 18+', [8101, 8102]],
      ['mens multivitamin over fifty', [8105]],
      ['womens multivitamin fifty plus', [8103]],
      ['eighteen plus womens multi', [8101, 8102]],
    ]) {
      const result = await client.findAddableProducts(query, EMAIL);
      assert.equal(result.match, 'name', query);
      assert.deepEqual(variantIds(result), expected, query);
    }
    assert.equal(catalog.searches.length, 0);
    assert.deepEqual(queryWords('fifty plus'), ['50+']);
    assert.deepEqual(queryWords('males guys ladies females'), ['men', 'men', 'women', 'women']);
    // An age description no title has is never searched
    assert.deepEqual(await client.findAddableProducts('senior womens vitamins', EMAIL), { match: 'none', products: [] });
    assert.equal(catalog.searches.length, 0);
  });

  test('a request frame ending in "add" is dropped; need wording before "add" is not', async () => {
    const { client, catalog } = matchClient({ search: () => searchRecords(['7114']) });
    for (const [query, expected] of [
      ['can you help me add sleep', [8114]],
      ['please help me add magnesium', [8115]],
      ['help me add the prenatal', [8106, 8107]],
      ['can you help me add Synbiotic+', [8113]],
      ['anything else? add Sleep', [8114]],
      ['i want to order sleep', [8114]],
      ['i need to add magnesium', [8115]],
    ]) {
      assert.equal(describesNeed(query), false, query);
      const result = await client.findAddableProducts(query, EMAIL);
      assert.equal(result.match, 'name', query);
      assert.deepEqual(variantIds(result), expected, query);
    }
    for (const query of ['something for stress, add sleep', 'help me sleep and add it', 'can you add something for sleep']) {
      assert.deepEqual(await client.findAddableProducts(query, EMAIL), { match: 'none', products: [] }, query);
    }
    assert.equal(catalog.searches.length, 0);
  });

  test('a word split in two matches the title word it joins into; "men" still never matches "women"', async () => {
    const { client, catalog } = matchClient();
    for (const [query, expected] of [
      ['pre natal', [8106, 8107]],
      ['pre-natal vitamins', [8106, 8107]],
      ['mint pre natal', [8107]],
      ['multi vitamin 50+', [8103, 8105]],
      ['mens multi', [8104, 8105]],
      ["men's multi vitamin", [8104, 8105]],
    ]) {
      const result = await client.findAddableProducts(query, EMAIL);
      assert.equal(result.match, 'name', query);
      assert.deepEqual(variantIds(result), expected, query);
    }
    assert.equal(catalog.searches.length, 0);
    const postnatal = [{ variantId: '1', productId: '1', productTitle: 'Postnatal Multivitamin', variantTitle: 'Default Title' }];
    assert.deepEqual(matchByName(queryWords('post natal'), postnatal), postnatal);
    assert.equal(wordMatch('men', 'women'), null);
    // The joined word must match exactly: "post natl" is one typo from "postnatal" joined, but that is no join
    assert.equal(wordMatch('postnatl', 'postnatal'), 'fuzzy');
    for (const query of ['post natl', 'pre natl', 'pre natel']) {
      assert.deepEqual(matchByName(queryWords(query), LIVE_VARIANTS), [], query);
    }
  });

  test('a title word\'s stem with another ending is another word only when the stem is nearly the whole title word', () => {
    // "perimenopausal" and "postpartal" keep all but the last letter or two of the title word: other words
    assert.equal(wordMatch('perimenopausal', 'perimenopause'), null);
    assert.equal(wordMatch('postpartal', 'postpartum'), null);
    // "synbioic" ends in "ic" too, but its stem drops three letters: it is "synbiotic" with a letter missed
    assert.equal(wordMatch('synbioic', 'synbiotic'), 'fuzzy');
    assert.equal(wordMatch('natalbioic', 'natalbiotic'), 'fuzzy');
    assert.deepEqual(matchByName(queryWords('synbioic'), LIVE_VARIANTS).map(variant => variant.productTitle), ['Synbiotic+']);
  });

  test('Shopify\'s "Default Title" placeholder is never matched, by name or by search', async () => {
    for (const query of ['default', 'title', 'default title', 'the default one', 'sleep default']) {
      assert.deepEqual(await matchLive(query, ['113']), { match: 'none', titles: [], searched: false }, query);
    }
  });

  test('accents are dropped on both sides', async () => {
    assert.deepEqual(matchWords('Prénatal Multivitamín'), ['prenatal', 'multivitamin']);
    for (const query of ['Prénatal', 'prénatal mint', 'MAGNÉSIUM']) {
      const result = await matchLive(query);
      assert.equal(result.match, 'name', query);
    }
    assert.deepEqual((await matchLive('prénatal mint')).titles, ['Prenatal Multivitamin [Mint]']);
    const accented = [{ variantId: '1', productId: '1', productTitle: 'Crème Sleep', variantTitle: 'Default Title' }];
    assert.deepEqual(await matchAddableVariants('creme sleep', accented), { match: 'name', variants: accented });
  });

  test('a query of only a number no title has matches nothing and is never searched', async () => {
    for (const query of ['40+', '52', '7', '30 plus', 'the 40+ one']) {
      assert.deepEqual(await matchLive(query, ['101']), { match: 'none', titles: [], searched: false }, query);
    }
  });

  test('"vitamin d", "vitamin b12" and "zinc" never match a multivitamin; "vitamin", "multi" and "multivitamin" do', async () => {
    const multivitamins = [8101, 8102, 8103, 8104, 8105, 8106, 8107];
    // The search ranks multivitamins first, as a nutrient search on the live store can
    const { client, catalog } = matchClient({
      answers: { 'vitamin d': ['7101', '7105'], 'vitamin b12': ['7102', '7105', '7109'], zinc: ['7103', '7113'], 'womens vitamin d3': ['7101'] },
    });
    for (const query of ['vitamin d', 'vitamin b12', 'zinc', 'womens vitamin d3']) {
      assert.deepEqual(await client.findAddableProducts(query, EMAIL), { match: 'none', products: [] }, query);
    }
    // No title or alias has "vitamin", "d", "b" or "zinc", so none of them is even searched
    assert.equal(catalog.searches.length, 0);
    for (const query of ['vitamin', 'vitamins', 'multi', 'multivitamin']) {
      const result = await client.findAddableProducts(query, EMAIL);
      assert.equal(result.match, 'name', query);
      // Prenatal Multivitamin first: it has fewest title words the query didn't mention
      assert.deepEqual(variantIds(result).sort(), multivitamins, query);
    }
    assert.deepEqual(queryWords('vitamin b12'), ['vitamin', 'b', '12']);
    assert.deepEqual(queryWords('prenatal vitamins'), ['prenatal', 'multivitamin']);
  });

  test('"vitamins" said of a product that isn\'t a multivitamin matches it only when the rest names its whole title', async () => {
    // The search ranks the named product first; the name match never needs it
    for (const [query, expected] of [
      ['iron vitamins', 'Iron [Default Title]'],
      ['my iron vitamin', 'Iron [Default Title]'],
      ['add the iron vitamins', 'Iron [Default Title]'],
      ['the sleep vitamins', 'Sleep [Default Title]'],
      ['magnesium vitamin', 'Magnesium+ [Default Title]'],
      // The nutrients a title names are what it contains, not its name
      ['omega 3 vitamins', 'Omega-3 DHA & EPA [Default Title]'],
      ['natal choline vitamin', 'Natal Choline [Default Title]'],
    ]) {
      const ranking = [LIVE_PRODUCTS.find(([, productTitle]) => expected.startsWith(`${productTitle} [`))[0]];
      assert.deepEqual(await matchLive(query, ranking), { match: 'name', titles: [expected], searched: false }, query);
    }
    // Part of a title is not enough ("postpartum" is not Daily Shake Pregnancy & Postpartum), nor a single nutrient
    for (const [query, ranking] of [['postpartum vitamins', ['109']], ['fertility vitamins', ['119']], ['stress vitamins', ['114']]]) {
      assert.equal((await matchLive(query, ranking)).match, 'none', query);
    }
    for (const [query, ranking] of [['vitamin d', ['102']], ['senior womens vitamins', ['102']]]) {
      assert.deepEqual(await matchLive(query, ranking), { match: 'none', titles: [], searched: false }, query);
    }
    // "multi" and "multivitamin" are never read as only "vitamins", and an unsellable Iron is never another product
    assert.equal((await matchLive('iron multivitamin', ['115'])).match, 'none');
    assert.equal((await matchLive('iron multi', ['115'])).match, 'none');
    assert.equal((await matchLive('iron vitamins', ['115'], ['115'])).match, 'none');
    assert.equal((await matchLive('prenatal vitamins')).titles.length, 2);
  });
});

describe('find_addable_product never picks a product for a symptom, need or goal', () => {
  const NEED_QUERIES = [
    'help me sleep',
    'something for stress',
    'anything for energy',
    'what\'s good for my skin',
    'I have trouble sleeping',
    'best one for pregnancy',
    'recommend something',
    'what should I take for sleep',
    'which one is for stress',
    'struggling to sleep',
    'boost my energy',
    'better sleep',
    'improve my sleep',
    'suggest a probiotic',
    'symptoms of menopause',
    // What it is for, ahead of any product name: a title word after it would otherwise match by name
    'for pregnancy',
    'the one for pregnancy',
    'the one for stress',
    'I need a supplement for stress',
    'i want the one for stress',
    'a product for stress',
    'for my stress',
    'sleep for my stress',
    'stress relief for my stress',
    'a pill for sleep',
    'i need a supplement for sleep',
    'for sleep',
    'supplement for perimenopause',
    'for my anxiety',
    'for my skin',
    'for insomnia',
    'for digestion',
    'in pregnancy',
    // Who it is for, with no product named
    'for my wife',
    'the one for my husband',
    'a pill for my daughter',
    'for my wife\'s sleep',
    // Wanting more of something or wanting to do something: the rest would match a title once filler is dropped
    'i need more sleep',
    'i want to sleep',
    'i just want to sleep',
    'i need to sleep',
    'i want to get some sleep',
    'i need more sleep please',
    'i need some relief',
    'i need some extra support',
    'i need more greens',
    'i want more greens',
    'i need more protein',
    'i want more protein',
    'i need extra protein',
    "I'd like more sleep",
    'i would like some iron',
    "i'd like more stress relief",
    'i need extra sleep',
    'i need extra iron',
    // A goal clause: "to" before a word that isn't filler, or getting more or some of something
    'a pill to sleep',
    'supplement to sleep',
    'something to sleep',
    'to get more sleep',
    'get more energy',
    'get some sleep',
    'get more greens',
    'i need extra support',
    // A customer describing themselves, not naming a product
    "I'm a woman over 50",
    'im pregnant',
    'im a man',
    "i'm 52",
    "I'm perimenopausal",
    "I'm breastfeeding",
    'i am a man over 50',
    "i've been feeling tired",
    'ive been stressed',
    "i can't sleep",
    'i feel stressed',
    'trying to sleep',
    // Only a nutrient a product contains
    'dha',
    'epa',
    'dha and epa',
    'protein',
    'protein 50+',
    'more protein',
    // A nutrient before what it is for names no product either
    'protein for pregnancy',
    'I want protein for pregnancy',
    'I need protein for pregnancy',
    'extra protein for pregnancy',
    "I'd like protein for pregnancy",
    'protein for pregnancy and postpartum',
    'protein for postpartum',
    'protein in pregnancy',
    'dha for pregnancy',
    'protein for my wife',
    // Only what a product is for, never its name
    'i need relief',
    'i want relief',
    'i need support',
    'i want support',
    'i need health',
    'relief',
    'support',
  ];
  // Symptom, need and goal wording that no marker above catches: each has a word that names no product
  // sold here, so it is never searched (the search would rank the related product first)
  const UNNAMED_QUERIES = [
    ["I'm stressed", '114'],
    ['i feel stressed', '114'],
    ['anxiety', '114'],
    ['calm', '114'],
    ['to relax', '114'],
    ['what can i take for stress', '114'],
    ["i can't sleep", '113'],
    ['cant fall asleep', '113'],
    ['i keep waking up at night', '113'],
    ['insomnia', '113'],
    ['sleep aid', '113'],
    ['what do you have for sleep', '113'],
    ['top pick for sleep', '113'],
    ['feeling tired all the time', '115'],
    ['i want more energy', '115'],
    ['i need more energy', '115'],
    ['fatigue', '115'],
    ['low energy', '115'],
    ['low iron', '115'],
    ["I'm pregnant", '105'],
    ["I'm trying to get pregnant", '119'],
    ['to get pregnant', '119'],
    ['trying to conceive', '119'],
    ['ttc', '119'],
    ['infertility', '119'],
    ['I have infertility', '119'],
    ['infertility support', '119'],
    ['add the infertility one', '119'],
    ['asleep', '113'],
    ['hot flashes', '120'],
    ['menopause', '120'],
    ['im perimenopausal', '120'],
    ['perimenopausal', '120'],
    ['gut health', '111'],
    ['bloating', '111'],
    ['probiotic for bloating', '111'],
    ['hair loss', '117'],
    ['dry skin', '117'],
    ['build muscle', '118'],
    ['leg cramps', '116'],
    ['brain health', '112'],
  ];

  test('need and goal wording matches nothing, by name or by search, and never searches', async () => {
    const { client, catalog } = matchClient({ search: () => searchRecords(['7112', '7113']) });
    for (const query of NEED_QUERIES) {
      assert.equal(describesNeed(query), true, query);
      assert.deepEqual(await client.findAddableProducts(query, EMAIL), { match: 'none', products: [] }, query);
    }
    assert.equal(catalog.searches.length, 0);
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'help me sleep' });
    assert.match(result.content[0].text, /No product matching "help me sleep" can be added here; hand off to a support agent/);
  });

  test('wording with a word that names no product is never searched, so the search never picks one for it', async () => {
    for (const [query, related] of UNNAMED_QUERIES) {
      assert.deepEqual(await matchLive(query, [related]), { match: 'none', titles: [], searched: false }, query);
    }
    const { client, catalog } = matchClient({ search: () => searchRecords(['7112', '7113']) });
    for (const query of ['for my anxiety', 'i want more energy', 'to get pregnant', 'I need a supplement for stress']) {
      const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query });
      assert.equal(result.content[0].text, `No product matching "${query}" can be added here; hand off to a support agent.`, query);
    }
    assert.equal(catalog.searches.length, 0);
  });

  test('product names are still matched', async () => {
    const { client } = matchClient();
    for (const [query, expected] of [
      ['Sleep', [8114]],
      ['add sleep', [8114]],
      ['Essential for Women 18+', [8101, 8102]],
      ['Essential for Women', [8101, 8102, 8103]],
      ['multi for men', [8104, 8105]],
      ['Daily Shake for pregnancy', [8110]],
      ['protein shake for pregnancy', [8110]],
      ['the shake in vanilla for pregnancy', [8110]],
    ]) {
      assert.equal(describesNeed(query), false, query);
      assert.deepEqual(variantIds(await client.findAddableProducts(query, EMAIL)), expected, query);
    }
    const variants = ['Stress Relief', 'Fertility Support', 'Perimenopause Health'].map((productTitle, index) =>
      ({ variantId: String(index + 1), productId: String(index + 1), productTitle, variantTitle: 'Default Title' }));
    for (const [index, { productTitle }] of variants.entries()) {
      assert.equal(describesNeed(productTitle), false, productTitle);
      assert.deepEqual(await matchAddableVariants(productTitle, variants), { match: 'name', variants: [variants[index]] }, productTitle);
    }
    for (const { productTitle } of LIVE_VARIANTS) {
      assert.equal(describesNeed(productTitle), false, productTitle);
    }
  });

  test('ingredient wording names no product: nothing, and never searched (decision 2026-10-29)', async () => {
    // The search ranks the product with that ingredient first, as the live store does
    for (const [query, related] of [
      ['fish oil', '112'], ['fish', '112'], ['oil', '112'], ['omega oil', '112'], ['melatonin', '113'], ['ceramides', '117'],
      ['ceramide', '117'], ['vitamin d', '102'], ['zinc', '103'], ['collagen', '117'], ['folate', '105'], ['magnesium glycinate', '116'],
      ['dha', '112'], ['epa', '112'], ['dha epa', '112'], ['protein', '107'], ['need more protein', '107'], ['i need more protein', '107'],
      // A nutrient before what it is for: the search would rank Daily Shake Pregnancy & Postpartum first
      ['protein for pregnancy', '109'], ['protein for postpartum', '109'], ['more protein for pregnancy', '109'],
      ['protein in pregnancy', '109'],
    ]) {
      assert.deepEqual(await matchLive(query, [related]), { match: 'none', titles: [], searched: false }, query);
    }
    // A product named for what it contains, or an ingredient word next to its name, is still that product
    for (const [query, expected] of [
      ['magnesium', 'Magnesium+ [Default Title]'],
      ['iron', 'Iron [Default Title]'],
      ['omega 3', 'Omega-3 DHA & EPA [Default Title]'],
      ['omega 3 dha', 'Omega-3 DHA & EPA [Default Title]'],
      ['omega-3 dha & epa', 'Omega-3 DHA & EPA [Default Title]'],
      ['creatine', 'Creatine Greens [Default Title]'],
      ['choline', 'Natal Choline [Default Title]'],
    ]) {
      const result = await matchLive(query);
      assert.equal(result.match, 'name', query);
      assert.deepEqual(result.titles, [expected], query);
    }
    // "protein" next to another word of Daily Shake is still searched
    assert.deepEqual(await matchLive('protein powder', ['108']), { match: 'interpreted', titles: ['Daily Shake [Chocolate]'], searched: true });
  });

  test('a quantity after "add", "order" or an asked "get" is how much to add, and a frame before "add" is not a state', async () => {
    for (const [query, expected] of [
      ['add one more iron', 'Iron [Default Title]'],
      ['add more magnesium', 'Magnesium+ [Default Title]'],
      ['order some more sleep', 'Sleep [Default Title]'],
      ['get me the iron please', 'Iron [Default Title]'],
      ['can I get some creatine greens', 'Creatine Greens [Default Title]'],
      ['could i get more iron', 'Iron [Default Title]'],
      ["I'd like to add Magnesium+", 'Magnesium+ [Default Title]'],
      ["I'd like to try the sleep", 'Sleep [Default Title]'],
      ["I'm looking to add sleep", 'Sleep [Default Title]'],
      ["i'm going to add some iron", 'Iron [Default Title]'],
      ['please add sleep to my subscription', 'Sleep [Default Title]'],
      ['add iron to my next shipment too', 'Iron [Default Title]'],
      // "for my" before only filler is where the add goes, not a need
      ['add sleep for my next order', 'Sleep [Default Title]'],
      ['add sleep for my order', 'Sleep [Default Title]'],
      ['add iron for my next shipment', 'Iron [Default Title]'],
      ['add iron for my subscription', 'Iron [Default Title]'],
      ['add magnesium for my subscription', 'Magnesium+ [Default Title]'],
      ['please add synbiotic for my next box', 'Synbiotic+ [Default Title]'],
    ]) {
      assert.equal(describesNeed(query), false, query);
      const result = await matchLive(query);
      assert.equal(result.match, 'name', query);
      assert.deepEqual(result.titles, [expected], query);
    }
  });

  test('add requests in customers\' own words find the product they named', async () => {
    // [query, ranking for a query no title matches, first product title]
    for (const [query, ranking, expected] of [
      ['can you add Iron', [], 'Iron'],
      ["I'd like to add Magnesium+ to my next order", [], 'Magnesium+'],
      ['add 2 daily shakes chocolate', [], 'Daily Shake'],
      ['I want to add the omega', [], 'Omega-3 DHA & EPA'],
      ['omega 3', [], 'Omega-3 DHA & EPA'],
      ['please add sleep to my subscription', [], 'Sleep'],
      ["add women's 50+", [], 'Women’s Multivitamin 50+'],
      ['could I also get synbiotic', [], 'Synbiotic+'],
      ['add natalbiotic', [], 'Natalbiotic™'],
      ['add the prenatal mint', [], 'Prenatal Multivitamin'],
      ['I want Stress Relief too', [], 'Stress Relief'],
      ['can I get some creatine greens', [], 'Creatine Greens'],
      ['add one more iron', [], 'Iron'],
      ['I want to add another bottle of HyaCera', [], 'HyaCera™'],
      ['i need to add my prenatal', [], 'Prenatal Multivitamin'],
      ["I'd like the essential for women 18+", [], 'Women’s Multivitamin 18+'],
      ['Essential Protein Daily Shake', [], 'Daily Shake'],
      ['protein shake', [], 'Daily Shake'],
      ['protein powder', ['107'], 'Daily Shake'],
      ['chocolate protein', ['108'], 'Daily Shake'],
      ['probiotic', ['111'], 'Synbiotic+'],
      ['prenatal probiotic', ['110'], 'Natalbiotic™'],
      ["add the men's multi", [], 'Men’s Multivitamin 18+'],
      ['mens 50 plus', [], 'Men’s Multivitamin 50+'],
      ['fertility support please', [], 'Fertility Support'],
      ['perimenopause', [], 'Perimenopause Health'],
      ['natal choline', [], 'Natal Choline'],
      ['postnatal', [], 'Postnatal Multivitamin'],
      ['multivitamn', [], 'Prenatal Multivitamin'],
      ['the shake for pregnancy', [], 'Daily Shake Pregnancy & Postpartum'],
      ['Daily Shake Pregnancy & Postpartum', [], 'Daily Shake Pregnancy & Postpartum'],
      ['vanilla shake', [], 'Daily Shake'],
      ['add more magnesium', [], 'Magnesium+'],
      ["i want the women's multivitamin", [], 'Women’s Multivitamin 18+'],
      ['get me the iron please', [], 'Iron'],
      ['can i also have the sleep one', [], 'Sleep'],
      ["add 2 women's multivitamin 18+", [], 'Women’s Multivitamin 18+'],
      ['add 2 omega 3', [], 'Omega-3 DHA & EPA'],
      ['add two bottles of iron', [], 'Iron'],
      ['add a prenatal for my wife', [], 'Prenatal Multivitamin'],
      ['peri-menopause', [], 'Perimenopause Health'],
      ['prenatal mint flavor', [], 'Prenatal Multivitamin'],
    ]) {
      assert.equal(describesNeed(query), false, query);
      const result = await matchLive(query, ranking);
      assert.equal(result.match, ranking.length > 0 ? 'interpreted' : 'name', query);
      assert.ok(result.titles.length > 0 && result.titles[0].startsWith(`${expected} [`), `${query}: ${result.titles[0]}`);
    }
  });

  test('a count, a flavor word and who an add is for are not product words; "peri-menopause" is one word', async () => {
    for (const [query, expected] of [
      // A count is how many to add, never an age band, whatever the title's numbers
      ["add 2 women's multivitamin 18+", ['Women’s Multivitamin 18+ [Mint]', 'Women’s Multivitamin 18+ [Citrus]']],
      ["add 2 men's 50+", ['Men’s Multivitamin 50+ [Default Title]']],
      ["I'd like 2 of the men's 18+", ['Men’s Multivitamin 18+ [Default Title]']],
      ["add 2 bottles of women's 50+", ['Women’s Multivitamin 50+ [Default Title]']],
      ['add 2 omega 3', ['Omega-3 DHA & EPA [Default Title]']],
      ['2 omega-3 please', ['Omega-3 DHA & EPA [Default Title]']],
      ['omega three', ['Omega-3 DHA & EPA [Default Title]']],
      ['add two bottles of iron', ['Iron [Default Title]']],
      ['add two sleep', ['Sleep [Default Title]']],
      ['add three daily shakes', ['Daily Shake [Vanilla]', 'Daily Shake [Chocolate]', 'Daily Shake Pregnancy & Postpartum [Vanilla]']],
      ['iron x2', ['Iron [Default Title]']],
      ['add 1x iron', ['Iron [Default Title]']],
      ['qty 2 magnesium', ['Magnesium+ [Default Title]']],
      // Age bands are still numbers to match
      ['50 women', ['Women’s Multivitamin 50+ [Default Title]']],
      ['add 18 womens', ['Women’s Multivitamin 18+ [Mint]', 'Women’s Multivitamin 18+ [Citrus]']],
      // Flavor words
      ['prenatal mint flavor', ['Prenatal Multivitamin [Mint]']],
      ['citrus flavour prenatal', ['Prenatal Multivitamin [Citrus]']],
      ['the mint flavored prenatal', ['Prenatal Multivitamin [Mint]']],
      ["women's 18+ mint flavor", ['Women’s Multivitamin 18+ [Mint]']],
      ['add the chocolate flavor daily shake', ['Daily Shake [Chocolate]']],
      ['add the prenatal in citrus', ['Prenatal Multivitamin [Citrus]']],
      ["add the women's multivitamin in citrus", ['Women’s Multivitamin 18+ [Citrus]']],
      // Who it is for: never read as men or women, so only the product named
      ["add a men's multi for my husband", ['Men’s Multivitamin 18+ [Default Title]', 'Men’s Multivitamin 50+ [Default Title]']],
      ['add a prenatal for my wife', ['Prenatal Multivitamin [Citrus]', 'Prenatal Multivitamin [Mint]']],
      ['add iron for my daughter', ['Iron [Default Title]']],
      ['add the sleep for my husband', ['Sleep [Default Title]']],
      ['sleep for my wife', ['Sleep [Default Title]']],
      ['add iron for my sister', ['Iron [Default Title]']],
      ['add the prenatal for my sister', ['Prenatal Multivitamin [Citrus]', 'Prenatal Multivitamin [Mint]']],
      ["add a men's multi for my brother", ['Men’s Multivitamin 18+ [Default Title]', 'Men’s Multivitamin 50+ [Default Title]']],
      ['add iron for my friend', ['Iron [Default Title]']],
      ['add sleep for my grandma', ['Sleep [Default Title]']],
      ['add iron for my teen', ['Iron [Default Title]']],
      // A possessive after "my" names who it is for too
      ["add my wife's prenatal", ['Prenatal Multivitamin [Citrus]', 'Prenatal Multivitamin [Mint]']],
      ["add my daughter's iron", ['Iron [Default Title]']],
      ["I'd like to add my mom's women's 50+", ['Women’s Multivitamin 50+ [Default Title]']],
      // "peri" and "menopause" join into the title word
      ['peri-menopause', ['Perimenopause Health [Default Title]']],
      ['peri menopause', ['Perimenopause Health [Default Title]']],
      ['Peri-Menopause Health', ['Perimenopause Health [Default Title]']],
    ]) {
      assert.equal(describesNeed(query), false, query);
      assert.deepEqual(await matchLive(query), { match: 'name', titles: expected, searched: false }, query);
    }
    // Every multivitamin, never only Men's for "my husband"
    assert.equal((await matchLive('add the multivitamin for my husband')).titles.length, 9);
    // A need for that person, or the condition word alone, is still nothing
    for (const [query, related] of [['iron for my anemia', '115'], ['menopause', '120'], ['peri-menopausal', '120'], ['for my sister', '115']]) {
      assert.deepEqual(await matchLive(query, [related]), { match: 'none', titles: [], searched: false }, query);
    }
  });
});

describe('find_addable_product interpreted by the storefront search', () => {
  test('search runs only when no title matches, with the query, country and top-K limit', async () => {
    const { client, catalog } = matchClient({ answers: { 'protein powder': ['7106'] } });
    await client.findAddableProducts('prenatal', EMAIL);
    assert.equal(catalog.searches.length, 0);

    const result = await client.findAddableProducts('  protein   powder ', EMAIL);
    assert.equal(result.match, 'interpreted');
    assert.deepEqual(variantIds(result), [8108]);
    assert.equal(catalog.searches.length, 1);
    const [{ url, init, body }] = catalog.searches;
    assert.equal(url, UCP_URL);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(body.params.arguments, {
      meta: { 'ucp-agent': { profile: PROFILE_URL } },
      catalog: { query: 'protein powder', context: { address_country: 'US' }, pagination: { limit: INTERPRETED_SEARCH_DEPTH } },
    });
  });

  test("only allowlisted products, in Shopify's rank order, and only the first one's title", async () => {
    // A bundle ranks first; Daily Shake Pregnancy & Postpartum is a different product than the first addable one
    const { client } = matchClient({ answers: { 'protein powder': ['7203', '7107', '7108', '7106'] } });
    const result = await client.findAddableProducts('protein powder', EMAIL);
    assert.equal(result.match, 'interpreted');
    // Chocolate before vanilla, as ranked (the allowlist lists vanilla first)
    assert.deepEqual(variantIds(result), [8109, 8108]);
  });

  test(`only the top ${INTERPRETED_SEARCH_DEPTH} raw results count`, async () => {
    const notAddable = MATCH_NOT_ADDABLE.map(([id]) => id);
    assert.equal(notAddable.length, INTERPRETED_SEARCH_DEPTH);
    // The stub ignores the requested limit and returns six results
    const late = matchClient({ answers: { probiotic: [...notAddable, '7111'] } });
    assert.deepEqual(await late.client.findAddableProducts('probiotic', EMAIL), { match: 'none', products: [] });
    const inWindow = matchClient({ answers: { probiotic: [...notAddable.slice(1), '7111'] } });
    assert.deepEqual(variantIds(await inWindow.client.findAddableProducts('probiotic', EMAIL)), [8113]);
  });

  test(`at most ${INTERPRETED_MAX_PRODUCTS} products`, async () => {
    const { client } = matchClient({ answers: { 'protein powder': ['7106', '7107', '7115', '7116'] } });
    const result = await client.findAddableProducts('protein powder', EMAIL);
    assert.deepEqual(variantIds(result), [8108, 8109, 8117]);
  });

  test('a product the customer named that cannot be added returns nothing, not a substitute', async () => {
    const { client } = matchClient({
      answers: {
        'the shaker': ['7202', '7106'],
        'Prenatal Essential Support Ritual': ['7201', '7105'],
        'prenatal probiotic': ['7201', '7110'],
      },
    });
    assert.deepEqual(await client.findAddableProducts('the shaker', EMAIL), { match: 'none', products: [] });
    assert.deepEqual(await client.findAddableProducts('Prenatal Essential Support Ritual', EMAIL), { match: 'none', products: [] });
    // A bundle ranked first that the customer didn't name doesn't block the addable product after it
    const result = await client.findAddableProducts('prenatal probiotic', EMAIL);
    assert.equal(result.match, 'interpreted');
    assert.deepEqual(variantIds(result), [8112]);
    // A product that isn't allowlisted with every searched word in its title, ranked above one they fit by alias
    const allowlisted = new Set(LIVE_PRODUCTS.map(([productId]) => productId));
    for (const [query, ranking] of [
      ['probiotic', [['900', 'Probiotic Travel Pack'], ['111', 'Synbiotic+']]],
      ['protein powder', [['901', 'Protein Powder Sample'], ['107', 'Daily Shake']]],
    ]) {
      const search = async () => ranking.map(([productId, title]) => ({ productId, title }));
      assert.deepEqual(await matchAddableVariants(query, LIVE_VARIANTS, { search, allowlisted }), { match: 'none', variants: [] }, query);
    }
  });

  test('an unreadable or untitled result ranked above every addable one is nothing, never the next product', async () => {
    const variants = [{ variantId: '1', productId: '10', productTitle: 'Synbiotic+', variantTitle: 'Default Title' }];
    const synbiotic = { productId: '10', title: 'Synbiotic+' };
    for (const top of [null, {}, { productId: 'gid://shopify/Product/999', title: 'Probiotic' }, { productId: '999' }, { productId: '999', title: ' ' }]) {
      const search = async () => [top, synbiotic];
      assert.deepEqual(await matchAddableVariants('probiotic', variants, { search }), { match: 'none', variants: [] }, JSON.stringify(top));
    }
    // After a kept product it is skipped
    assert.equal((await matchAddableVariants('probiotic', variants, { search: async () => [synbiotic, null] })).match, 'interpreted');
    // Through the client, a malformed entry ranked first fails the search
    for (const top of [
      { id: '999', title: 'Protein Powder Sampler' },
      { id: 'gid://shopify/ProductBundle/999', title: 'Protein Powder Sampler' },
      { id: 'gid://shopify/Product/999' },
      null,
    ]) {
      const { client, catalog } = matchClient({ search: () => [top, ...searchRecords(['7106'])] });
      assert.deepEqual(await client.findAddableProducts('protein powder', EMAIL), { match: 'none', products: [] }, JSON.stringify(top));
      assert.equal(catalog.searches.length, 1);
    }
  });

  test('an allowlisted product ranked first that can\'t be sold now is nothing, never the next product', async () => {
    for (const [label, change] of [
      ['out of stock', variant => { variant.availability.available = false; }],
      ['priced in another currency', variant => { variant.price.currency = 'EUR'; }],
    ]) {
      // Vanilla Daily Shake is ranked first for "protein powder", Synbiotic+ for "probiotic"; the product after each
      // also fits the words
      for (const [query, unsellable, ranking] of [['protein powder', '8108', ['7106', '7107']], ['probiotic', '8113', ['7111', '7110']]]) {
        const { client, catalog } = matchClient({ catalogDb: matchCatalogDbWith(unsellable, change), answers: { [query]: ranking } });
        assert.deepEqual(await client.findAddableProducts(query, EMAIL), { match: 'none', products: [] }, `${label}: ${query}`);
        assert.equal(catalog.searches.length, 1, `${label}: ${query}`);
      }
    }
    // In stock, the first one is returned
    const { client } = matchClient({ answers: { probiotic: ['7111', '7110'] } });
    assert.deepEqual(variantIds(await client.findAddableProducts('probiotic', EMAIL)), [8113]);
    // Ranked after a kept product, one that can't be added (allowlisted, or named by the query) is skipped.
    // The catalog read 900 as out of stock (an allowlisted product with no title read stops the search)
    const allowlisted = new Set([...LIVE_PRODUCTS.map(([productId]) => productId), '900']);
    const shakes = LIVE_VARIANTS.filter(variant => variant.productId !== '108');
    const unsellable = [
      ...LIVE_VARIANTS.filter(variant => variant.productId === '108'),
      { variantId: '9000', productId: '900', productTitle: 'Travel Pack', variantTitle: 'Default Title' },
    ];
    for (const after of [{ productId: '108', title: 'Daily Shake' }, { productId: '900', title: 'Protein Powder Sampler' }, { productId: '901', title: 'Protein Powder Sampler' }]) {
      const search = async () => [{ productId: '107', title: 'Daily Shake' }, after];
      assert.deepEqual((await matchAddableVariants('protein powder', shakes, { search, allowlisted, unsellable })).variants.map(variant => variant.variantId),
        ['1070'], JSON.stringify(after));
      // Ranked first, it is nothing
      const first = async () => [after, { productId: '107', title: 'Daily Shake' }];
      assert.deepEqual(await matchAddableVariants('protein powder', shakes, { search: first, allowlisted, unsellable }), { match: 'none', variants: [] }, JSON.stringify(after));
    }
  });

  test('with nothing sellable, nothing is searched', async () => {
    let searched = false;
    const search = async () => { searched = true; return liveRanking(['111']); };
    for (const query of ['probiotic', 'protein powder', 'sleep']) {
      assert.deepEqual(await matchAddableVariants(query, [], { search }), { match: 'none', variants: [] }, query);
      assert.deepEqual(await matchAddableVariants(query, [], { search, unsellable: LIVE_VARIANTS }), { match: 'none', variants: [] }, query);
    }
    assert.equal(searched, false);
  });

  test('a flavor asked for that only the top product\'s unsellable listing has is nothing, never another product in it', async () => {
    // Daily Shake as one product with Vanilla out of stock, or with each flavor its own listing and Vanilla's
    // hidden from the search
    const oneProduct = LIVE_VARIANTS.map(variant => (variant.productId === '108' ? { ...variant, productId: '107' } : variant));
    const vanilla = oneProduct.filter(variant => variant.variantId === '1070');
    for (const [label, variants, unsellable, ranking] of [
      ['one product', oneProduct.filter(variant => variant.variantId !== '1070'), vanilla, [['107', 'Daily Shake'], ['109', 'Daily Shake Pregnancy & Postpartum']]],
      ['separate listings', LIVE_VARIANTS.filter(variant => variant.productId !== '107'), LIVE_VARIANTS.filter(variant => variant.productId === '107'),
        [['108', 'Daily Shake'], ['109', 'Daily Shake Pregnancy & Postpartum']]],
    ]) {
      const search = async () => ranking.map(([productId, title]) => ({ productId, title }));
      const allowlisted = new Set([...variants, ...unsellable].map(variant => variant.productId));
      for (const query of ['vanilla protein powder', 'protein powder vanilla', 'vanilla essential protein']) {
        assert.deepEqual(await matchAddableVariants(query, variants, { search, allowlisted, unsellable }), { match: 'none', variants: [] }, `${label}: ${query}`);
      }
      // A flavor it does have is still that product
      assert.deepEqual((await matchAddableVariants('chocolate protein powder', variants, { search, allowlisted, unsellable })).variants.map(variant => variant.variantTitle),
        ['Chocolate'], label);
    }
  });

  test('an addable product ranked first that doesn\'t fit the words is nothing, never the next one', async () => {
    for (const [query, ranking] of [['protein pregnancy', ['117', '109']], ['powder', ['117', '109']], ['prenatal probiotic', ['101', '110']]]) {
      assert.deepEqual(await matchLive(query, ranking), { match: 'none', titles: [], searched: true }, query);
    }
    assert.equal((await matchLive('protein pregnancy', ['109'])).match, 'interpreted');
  });

  test('a product named only by its unsellable listings is nothing and never searched', async () => {
    // Prenatal Multivitamin out of stock: "prenatal" is never searched, where Natalbiotic would be found by alias
    for (const query of ['prenatal', 'pre natal', 'Essential Prenatal']) {
      assert.deepEqual(await matchLive(query, ['110'], ['105']), { match: 'none', titles: [], searched: false }, query);
    }
  });

  test('an allowlisted product the catalog returned nothing for is never swapped for a sibling a partial name matches', async () => {
    const allowlisted = new Set(LIVE_PRODUCTS.map(([productId]) => productId));
    const without = gone => LIVE_VARIANTS.filter(variant => !gone.includes(variant.productId));
    let searched = false;
    const search = async () => { searched = true; return liveRanking(['109']); };
    // Daily Shake (both flavors) or Women's Multivitamin 18+ not_found: their titles are unknown, so a partial name may mean them
    for (const [query, gone] of [
      ['daily shake', ['107', '108']],
      ['shake', ['107', '108']],
      ['vanilla shake', ['107', '108']],
      ['womens multivitamin', ['101']],
      ['multivitamin 50+', ['101']],
      ['sleep', ['113']],
      // Nor is anything searched: the unknown product isn't in the results to stop a sibling found by alias
      ['prenatal', ['105']],
      ['Essential Prenatal', ['105']],
      ['pre natal', ['105']],
      ['protein powder', ['107', '108']],
      ['essential protein', ['107', '108']],
      ['vanilla protein powder', ['107', '108']],
    ]) {
      assert.deepEqual(await matchAddableVariants(query, without(gone), { search, allowlisted }), { match: 'none', variants: [] }, query);
    }
    assert.equal(searched, false);
    // A query naming every word of a title it matches is that product, whatever else is unknown
    for (const [query, gone, expected] of [
      ['daily shake pregnancy & postpartum', ['107', '108'], ['109']],
      ['daily shake pregnancy postpartum', ['107', '108'], ['109']],
      ["women's multivitamin 50+", ['101'], ['102']],
      ['iron', ['107', '108'], ['115']],
      // The other flavor's listing is not unknown: same title, so Daily Shake is fully named
      ['daily shake', ['107'], ['108', '109']],
    ]) {
      const result = await matchAddableVariants(query, without(gone), { search, allowlisted });
      assert.equal(result.match, 'name', query);
      assert.deepEqual([...new Set(result.variants.map(variant => variant.productId))], expected, query);
    }
    // "natal" is a whole word of Natal Choline but only the start of Natalbiotic, so with Natal Choline unknown
    // or out of stock it is never Natalbiotic; with both sellable they rank alike, in allowlist order
    for (const query of ['natal', 'add the natal']) {
      assert.deepEqual(await matchAddableVariants(query, without(['121']), { search, allowlisted }), { match: 'none', variants: [] }, query);
      assert.deepEqual(await matchLive(query, ['110'], ['121']), { match: 'none', titles: [], searched: false }, query);
    }
    assert.deepEqual((await matchLive('natal')).titles, ['Natalbiotic™ [Default Title]', 'Natal Choline [Default Title]']);
    assert.equal((await matchLive('natal', [], ['110'])).match, 'none');
    // A prefix that is the only product it starts still matches it
    assert.equal((await matchAddableVariants('magnes', LIVE_VARIANTS, { search, allowlisted })).match, 'name');
    // Without an allowlist (or with every allowlisted title read) a partial name matches as before
    assert.equal((await matchAddableVariants('daily shake', without(['107', '108']), { search })).match, 'name');
    assert.equal((await matchAddableVariants('daily shake', LIVE_VARIANTS, { search, allowlisted })).match, 'name');

    // Through the client, a lookup missing every Daily Shake variant (not_found) fails closed, and so does
    // the same partial lookup read back from the cache
    const catalogDb = matchCatalogDb();
    for (const country of Object.keys(catalogDb)) {
      catalogDb[country] = catalogDb[country].filter(product => !['7106', '7107', '7115', '7116'].includes(product.id.split('/').pop()));
    }
    const { client, catalog } = matchClient({ catalogDb, answers: { 'daily shake': ['7106', '7108'] } });
    for (const attempt of [1, 2]) {
      assert.deepEqual(await client.findAddableProducts('daily shake', EMAIL), { match: 'none', products: [] }, String(attempt));
    }
    assert.deepEqual(variantIds(await client.findAddableProducts('daily shake pregnancy & postpartum', EMAIL)), [8110]);
    // One lookup (two chunks of IDs), then cache hits
    assert.equal(catalog.requests.length, 2);
    assert.equal(catalog.searches.length, 0);
  });

  test('flavor and size words narrow interpreted products; a different size is nothing', async () => {
    const { client } = matchClient({ answers: { 'chocolate protein powder': ['7106', '7107'], 'synbiotic 90 servings': ['7111'] } });
    // Vanilla Daily Shake ranked first, but only the chocolate listing has the flavor asked for
    const chocolate = await client.findAddableProducts('chocolate protein powder', EMAIL);
    assert.equal(chocolate.match, 'interpreted');
    assert.deepEqual(variantIds(chocolate), [8109]);
    assert.deepEqual(await client.findAddableProducts('synbiotic 90 servings', EMAIL), { match: 'none', products: [] });
  });

  test('a product line, flavor or other word the kept product lacks is nothing, never the search\'s top pick', async () => {
    for (const [query, ranking] of [
      ['postpartum vitamins', ['105', '106']],
      ['post partum multivitamin', ['105', '106']],
      ['prenatal shake', ['107', '109']],
      ['chocolate daily shake pregnancy', ['108', '109']],
      ['chocolate daily shake pregnancy', ['109', '108']],
      ['mint daily shake', ['107', '108']],
      ['magnesium for sleep', ['113', '116']],
      ['sleep stress', ['116', '113', '114']],
      ['probiotic sleep', ['111']],
    ]) {
      assert.deepEqual(await matchLive(query, ranking), { match: 'none', titles: [], searched: true }, `${query} ${ranking}`);
    }
    for (const [query, ranking, expected] of [
      ['prenatal probiotic', ['110'], ['Natalbiotic™ [Default Title]']],
      ['Essential Protein', ['109', '107'], ['Daily Shake Pregnancy & Postpartum [Vanilla]']],
      ['chocolate protein powder', ['109', '107', '108'], ['Daily Shake [Chocolate]']],
    ]) {
      assert.deepEqual(await matchLive(query, ranking), { match: 'interpreted', titles: expected, searched: true }, query);
    }
    // With the fixture catalog's strawberry Daily Shake, "strawberry" is a flavor Prenatal Multivitamin lacks
    const { client } = matchClient({ answers: { 'strawberry prenatal vitamins': ['7105', '7115'] } });
    assert.deepEqual(await client.findAddableProducts('strawberry prenatal vitamins', EMAIL), { match: 'none', products: [] });
  });

  test('a product contradicting the query\'s numbers, ranked above every addable one, means nothing is returned', async () => {
    const { client, catalog } = matchClient({
      answers: {
        "mint women's multivitamin 50+": ['7101', '7102', '7105'],
        'citrus mens multi 50+': ['7103', '7104', '7105'],
      },
    });
    // Never falls through to Prenatal Multivitamin, which has no number to contradict
    assert.deepEqual(await client.findAddableProducts("mint women's multivitamin 50+", EMAIL), { match: 'none', products: [] });
    assert.deepEqual(await client.findAddableProducts('citrus mens multi 50+', EMAIL), { match: 'none', products: [] });
    assert.equal(catalog.searches.length, 2);
    // A number no title has is never searched
    assert.deepEqual(await client.findAddableProducts('mens multi 40+', EMAIL), { match: 'none', products: [] });
    assert.equal(catalog.searches.length, 2);
  });

  test('gender words never fuzz or cross in an interpreted match', async () => {
    const { client } = matchClient({
      answers: { "men's prenatal": ['7105', '7103'], 'mens multi pack daily': ['7101', '7103'], 'womens multi pack daily': ['7101', '7103'] },
    });
    assert.deepEqual(queryWords("men's prenatal"), ['men', 'prenatal']);
    assert.deepEqual(await client.findAddableProducts("men's prenatal", EMAIL), { match: 'none', products: [] });
    // A women's product ranked first for a men's query is a contradiction, not a substitute; for a women's
    // query "daily" names another product, which the women's one lacks
    assert.deepEqual(await client.findAddableProducts('mens multi pack daily', EMAIL), { match: 'none', products: [] });
    assert.deepEqual(await client.findAddableProducts('womens multi pack daily', EMAIL), { match: 'none', products: [] });
  });

  test('the search is never cached: a repeated query searches again', async () => {
    const { client, catalog } = matchClient({ answers: { probiotic: ['7111'] } });
    for (const attempt of [1, 2]) {
      const result = await client.findAddableProducts('probiotic', EMAIL);
      assert.equal(result.match, 'interpreted');
      assert.equal(catalog.searches.length, attempt);
    }
  });

  test('the description and the interpreted text tell Fin to confirm by product name and never suggest', async () => {
    const { description } = toolByName('find_addable_product');
    assert.match(description, /The query is the product name exactly as the customer said it \(an old name, abbreviation, flavor or misspelling is fine\)/);
    assert.match(description, /never a symptom, need or goal/);
    assert.match(description, /confirm an interpreted product with the customer by its product name only, before quoting a price or making any change/);
    assert.match(description, /Never list or offer products the customer didn't name/);
    assert.match(description, /Never describe what a product does or make any health, ingredient or benefit claim/);

    const { client } = matchClient({ answers: { probiotic: ['7111'] } });
    const [{ text }] = (await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'probiotic' })).content;
    assert.match(text, /this is the product the store matched to the customer's words/);
    assert.match(text, /Confirm it with the customer by its product name only, without describing it or giving any reason or benefit, before quoting a price or making any change/);
    assert.match(text, /Do not offer any other product or search result as a suggestion/);
    assert.doesNotMatch(text, /closest/);
  });

  test('price, currency and variants come from the catalog lookup in the subscribed currency, never the search', async () => {
    const us = matchClient({ answers: { probiotic: ['7111'] } });
    assert.deepEqual(await us.client.findAddableProducts('probiotic', EMAIL), {
      match: 'interpreted',
      products: [{ variant_id: 8113, title: 'Synbiotic+', variant_title: '30 servings', unit_price: '61.36', currency: 'USD', can_subscribe: false }],
    });

    const ca = matchClient({ db: withCountry('CA'), answers: { probiotic: ['7111'] } });
    const [first] = (await ca.client.findAddableProducts('probiotic', EMAIL)).products;
    assert.deepEqual([first.unit_price, first.currency], ['92.04', 'CAD']);
    assert.equal(ca.catalog.searches[0].body.params.arguments.catalog.context.address_country, 'CA');
  });

  test('a search failure, timeout or malformed answer is no match, never an error, and never blocks name matches', async () => {
    const rpcBody = (body, result) => jsonResponse({ jsonrpc: '2.0', id: body.id, result });
    for (const [label, search, timeoutMs] of [
      ['HTTP 500', () => new Response('nope', { status: 500 })],
      ['HTTP 429', () => new Response('Too Many Requests', { status: 429 })],
      ['network error', () => { throw new TypeError('fetch failed'); }],
      ['JSON-RPC error', (query, body) => jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'UCP discovery failed' } })],
      ['tool error', (query, body) => rpcBody(body, { isError: true, content: [{ type: 'text', text: 'bad request' }] })],
      ['no products list', (query, body) => jsonResponse(rpcResult(body.id, { products: 'nope' }))],
      ['a warning message', (query, body) => jsonResponse(rpcResult(body.id, {
        products: searchRecords(['7111']), messages: [{ type: 'warning', code: 'market_fallback', content: 'x' }],
      }))],
      ['unreadable body', () => new Response('<html>oops</html>', { status: 200 })],
      ['no product IDs', (query, body) => jsonResponse(rpcResult(body.id, {
        products: [{ id: 'Product/7109', title: 'Omega' }, null, { id: 'gid://shopify/Product/abc' }],
      }))],
      ['timeout', (query, body, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }), 20],
    ]) {
      const { client, catalog, calls } = matchClient({ search, timeoutMs });
      const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'probiotic' });
      assert.ok(!result.isError, label);
      assert.match(result.content[0].text, /No product matching "probiotic" can be added here; hand off to a support agent/, label);
      assert.deepEqual(await client.findAddableProducts('probiotic', EMAIL), { match: 'none', products: [] }, label);
      assert.ok(catalog.searches.length >= 1, label);
      assert.deepEqual(variantIds(await client.findAddableProducts('prenatal', EMAIL)), [8106, 8107], label);
      assert.equal(writes(calls).length, 0, label);
    }
  });

  test('the tool says when a result is interpreted, and no description, handle or search price reaches it', async () => {
    const { client } = matchClient({ answers: { probiotic: ['7111'] } });
    const interpreted = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'probiotic' });
    assert.ok(!interpreted.isError);
    assert.match(interpreted.content[0].text, /Confirm it with the customer by its product name only/);
    assert.match(interpreted.content[0].text, /"match": "interpreted"/);
    const named = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'omega 3' });
    assert.match(named.content[0].text, /"match": "name"/);
    assert.doesNotMatch(named.content[0].text, /Confirm it/);
    for (const result of [interpreted, named]) {
      assert.ok(!result.content[0].text.includes(DESCRIPTION_MARKER));
      assert.doesNotMatch(result.content[0].text, /description|html|handle|sku|EUR|Search Only|97111/i);
    }
  });

  test('a failed search is logged under DEBUG without the email, the query or descriptions', async () => {
    const previousDebug = process.env.DEBUG;
    const originalError = console.error;
    const captured = [];
    process.env.DEBUG = 'true';
    console.error = (...args) => captured.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    try {
      const { client } = matchClient({ search: () => new Response('nope', { status: 503 }) });
      await client.findAddableProducts('probiotic', EMAIL);
    } finally {
      console.error = originalError;
      if (previousDebug === undefined) {
        delete process.env.DEBUG;
      } else {
        process.env.DEBUG = previousDebug;
      }
    }
    assert.ok(captured.some(line => /find_addable_product search failed with status 503 \(http_error\); no match/.test(line)));
    for (const line of captured) {
      assert.ok(!line.includes(EMAIL), line);
      assert.ok(!line.includes('probiotic'), line);
      assert.ok(!line.includes(DESCRIPTION_MARKER), line);
    }
  });

  test('the matcher runs on a plain variant list and search function, with no Recharge', async () => {
    const variants = [
      { variantId: '1', productId: '10', productTitle: 'Synbiotic+', variantTitle: 'Default Title', unitPrice: 61.36, currency: 'USD' },
      { variantId: '2', productId: '20', productTitle: 'Sleep', variantTitle: 'Default Title', unitPrice: 28.41, currency: 'USD' },
    ];
    const searched = [];
    const search = async (query, limit) => { searched.push([query, limit]); return [{ productId: '99', title: 'Other' }, { productId: '10', title: 'Synbiotic' }]; };
    assert.deepEqual(await matchAddableVariants('sleep', variants, { search }), { match: 'name', variants: [variants[1]] });
    assert.deepEqual(searched, []);
    assert.deepEqual(await matchAddableVariants('probiotic', variants, { search }), { match: 'interpreted', variants: [variants[0]] });
    assert.deepEqual(searched, [['probiotic', INTERPRETED_SEARCH_DEPTH]]);

    const errors = [];
    const onSearchError = error => errors.push(error.code);
    assert.deepEqual(await matchAddableVariants('probiotic', variants, { search: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); }, onSearchError }), { match: 'none', variants: [] });
    assert.deepEqual(await matchAddableVariants('probiotic', variants, { search: async () => ({ products: [] }), onSearchError }), { match: 'none', variants: [] });
    assert.deepEqual(errors, ['timeout', 'unparseable']);
    assert.deepEqual(await matchAddableVariants('probiotic', variants), { match: 'none', variants: [] });
  });
});

describe('Shopify catalog search (search_catalog)', () => {
  test('sends the query, country and limit, and keeps only ranked product IDs and titles', async () => {
    const catalog = makeCatalog({ search: () => searchRecords(['7109', '7201', '7109']) });
    const results = await catalog.searchProducts(' fish\n\t oil ', 'US', 5);
    assert.deepEqual(results, [{ productId: '7109', title: 'Omega-3 DHA & EPA' }, { productId: '7201', title: 'Prenatal Essential Support Ritual*' }]);
    const [{ body, init }] = catalog.searches;
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'search_catalog');
    assert.deepEqual(body.params.arguments.catalog, { query: 'fish oil', context: { address_country: 'US' }, pagination: { limit: 5 } });
    assert.equal(init.redirect, 'error');
    assert.equal(catalog.requests.length, 0);
  });

  test('a result without a product ID or title fails the search wherever it ranks; past the limit it is never read', async () => {
    for (const entry of [
      { id: '999', title: 'Protein Powder Sampler' },
      { id: 'gid://shopify/ProductBundle/999', title: 'Protein Powder Sampler' },
      { id: 'gid://shopify/Product/999' },
      { id: 'gid://shopify/Product/999', title: '  ' },
      null,
    ]) {
      for (const products of [[entry, ...searchRecords(['7106'])], [...searchRecords(['7106']), entry]]) {
        const catalog = makeCatalog({ search: () => products });
        await assert.rejects(catalog.searchProducts('protein powder', 'US', 5), error => error.code === 'unparseable', JSON.stringify(entry));
      }
    }
    const catalog = makeCatalog({ search: () => [...searchRecords(['7106']), null] });
    assert.deepEqual(await catalog.searchProducts('protein powder', 'US', 1), [{ productId: '7106', title: 'Daily Shake' }]);
  });

  test('results past the limit are ignored and the query is capped', async () => {
    const catalog = makeCatalog({ search: () => searchRecords(['7101', '7102', '7103', '7104', '7105']) });
    assert.deepEqual((await catalog.searchProducts('multi', 'US', 3)).map(result => result.productId), ['7101', '7102', '7103']);
    await catalog.searchProducts('x'.repeat(150), 'US', 3);
    assert.equal(catalog.searches[1].body.params.arguments.catalog.query.length, CATALOG_SEARCH_MAX_QUERY);
  });

  test('country, limit and query are checked before any request', async () => {
    const catalog = makeCatalog();
    for (const country of ['us', 'USA', '', undefined]) {
      await assert.rejects(catalog.searchProducts('sleep', country, 5), error => error.code === 'invalid_country');
    }
    for (const limit of [0, 11, 2.5, '5', undefined]) {
      await assert.rejects(catalog.searchProducts('sleep', 'US', limit), error => error.code === 'invalid_limit');
    }
    for (const query of ['', '   ', '\u0000\u0007', null]) {
      await assert.rejects(catalog.searchProducts(query, 'US', 5), error => error.code === 'invalid_query');
    }
    assert.equal(catalog.searches.length, 0);
  });

  test('a failed search says "search", not "lookup", and keeps the transport error codes', async () => {
    const catalog = makeCatalog({ search: () => new Response('nope', { status: 500 }) });
    await assert.rejects(catalog.searchProducts('sleep', 'US', 5), error => {
      assert.equal(error.name, 'ShopifyCatalogError');
      assert.equal(error.code, 'http_error');
      assert.match(error.message, /^Catalog search failed with HTTP 500$/);
      return true;
    });
  });
});

describe('Recharge error messages', () => {
  test('errors keyed by field produce a readable message, not "HTTP 422 Error"', () => {
    const axiosError = {
      message: 'Request failed with status code 422',
      config: { url: '/products/7001', method: 'get' },
      response: { status: 422, headers: {}, data: { errors: { platform: ['This API is not compatible with your platform'] } } },
    };
    assert.throws(() => handleAPIError(axiosError), error => {
      assert.ok(error instanceof RechargeAPIError);
      assert.equal(error.statusCode, 422);
      assert.equal(error.message, 'platform: This API is not compatible with your platform');
      return true;
    });
    const several = { ...axiosError, response: { ...axiosError.response, data: { errors: { quantity: ['is invalid', 'must be positive'], price: 'is not allowed' } } } };
    assert.throws(() => handleAPIError(several), /quantity: is invalid, must be positive; price: is not allowed/);
    const text = { ...axiosError, response: { ...axiosError.response, data: { errors: 'Platform not supported' } } };
    assert.throws(() => handleAPIError(text), error => error.message === 'Platform not supported' && error.statusCode === 422);
  });
});

// ---------------------------------------------------------------------------
// find_addable_product shared file cache (one file per endpoint, country and allowlist)
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 1);
const STORED_FIELDS = ['available', 'currency', 'productId', 'productTitle', 'unitPrice', 'variantId', 'variantTitle'];
// 25 allowlisted IDs: three lookup_catalog chunks (10 + 10 + 5); the extras are unknown to the catalog
const BIG_ADDABLE = new Map([...ADDABLE, ...Array.from({ length: 15 }, (_, index) => [String(8100 + index), '7001'])]);

/**
 * A cache dir that doesn't exist yet, inside a per-test temp dir removed after the test
 */
function tempCacheDir(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'recharge-mcp-cache-case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'cache');
}

const cacheFiles = dir => (existsSync(dir) ? readdirSync(dir).sort() : []);
const fileMode = file => statSync(file).mode & 0o777;

describe('find_addable_product shared file cache', () => {
  test('the TTL is 60 minutes and MCP_CATALOG_CACHE_DIR overrides the tmpdir default', () => {
    assert.equal(ADDABLE_CATALOG_CACHE_TTL_MS, 60 * 60 * 1000);
    assert.equal(parseCatalogCacheDir(undefined), path.join(tmpdir(), 'recharge-mcp-catalog-cache'));
    assert.equal(parseCatalogCacheDir('   '), path.join(tmpdir(), 'recharge-mcp-catalog-cache'));
    assert.equal(parseCatalogCacheDir(' /var/cache/mcp '), path.resolve('/var/cache/mcp'));
  });

  test('an entry written by one process is used by the next with no catalog call', async t => {
    const dir = tempCacheDir(t);
    const first = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
    const expected = {};
    for (const query of ['essential for women 18+', 'natalbiotic', 'protein']) {
      expected[query] = (await first.client.findAddableProducts(query, EMAIL)).products;
    }
    assert.equal(first.catalog.requests.length, 1);
    assert.equal(cacheFiles(dir).length, 1);
    assert.match(cacheFiles(dir)[0], /^[0-9a-f]{64}\.json$/);

    // A new client, catalog and cache object over the same dir: a new child process
    const second = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
    for (const query of ['essential for women 18+', 'natalbiotic', 'protein']) {
      assert.deepEqual((await second.client.findAddableProducts(query, EMAIL)).products, expected[query], query);
    }
    assert.equal(second.catalog.requests.length, 0);
  });

  test('an entry is a hit up to 59:59 and a miss from 60:00', async t => {
    const dir = tempCacheDir(t);
    const clock = { now: T0 };
    const now = () => clock.now;
    await makeClient({ catalogCache: createAddableCatalogCache({ dir, now }) }).client.findAddableProducts('essential for women 18+', EMAIL);
    const file = path.join(dir, cacheFiles(dir)[0]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).storedAt, T0);

    // Literal offsets, so this pins 60 minutes independently of the exported constant
    for (const offset of [60 * 60 * 1000 - 1000, 60 * 60 * 1000 - 1]) {
      clock.now = T0 + offset;
      const reader = makeClient({ catalogCache: createAddableCatalogCache({ dir, now }) });
      assert.equal((await reader.client.findAddableProducts('essential for women 18+', EMAIL)).products.length, 2);
      assert.equal(reader.catalog.requests.length, 0, `hit at +${offset}ms`);
    }

    clock.now = T0 + 60 * 60 * 1000;
    const expired = makeClient({ catalogCache: createAddableCatalogCache({ dir, now }) });
    assert.equal((await expired.client.findAddableProducts('essential for women 18+', EMAIL)).products.length, 2);
    assert.equal(expired.catalog.requests.length, 1);
    // The fresh lookup replaced the entry
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).storedAt, T0 + 60 * 60 * 1000);
  });

  test('the in-memory layer expires with the same TTL', async t => {
    const clock = { now: T0 };
    const { client, catalog } = makeClient({ catalogCache: createAddableCatalogCache({ dir: tempCacheDir(t), now: () => clock.now }) });
    await client.findAddableProducts('essential for women 18+', EMAIL);
    clock.now = T0 + ADDABLE_CATALOG_CACHE_TTL_MS - 1000;
    await client.findAddableProducts('essential for women 18+', EMAIL);
    assert.equal(catalog.requests.length, 1);
    clock.now = T0 + ADDABLE_CATALOG_CACHE_TTL_MS;
    await client.findAddableProducts('essential for women 18+', EMAIL);
    assert.equal(catalog.requests.length, 2);
  });

  test('country, allowlist (variant or product), endpoint and agent profile each get their own entry', async t => {
    const dir = tempCacheDir(t);
    const cache = () => createAddableCatalogCache({ dir });
    const remapped = new Map(ADDABLE);
    remapped.set('8001', '7999');
    const cases = [
      ['US', {}],
      ['CA', { db: withCountry('CA') }],
      ['fewer variants', { addable: new Map([...ADDABLE].slice(0, 5)) }],
      ['another product ID', { addable: remapped }],
      ['another endpoint', { catalog: makeCatalog({ endpoint: 'https://other.example.com/api/ucp/mcp' }) }],
      ['another agent profile', { catalog: makeCatalog({ profileUrl: 'https://mcp.example.com/ucp/other-profile.json' }) }],
    ];
    for (const [index, [label, options]] of cases.entries()) {
      const { client, catalog } = makeClient({ ...options, catalogCache: cache() });
      await client.findAddableProducts('essential for women 18+', EMAIL);
      assert.equal(catalog.requests.length, 1, label);
      assert.equal(cacheFiles(dir).length, index + 1, label);
    }
    // Every entry is still there for its own scope (a new catalog object with the same endpoint and profile)
    const sameCatalog = catalog => makeCatalog({ endpoint: catalog.endpoint, profileUrl: catalog.profileUrl });
    for (const [label, options] of cases) {
      const fresh = { ...options, ...(options.catalog ? { catalog: sameCatalog(options.catalog) } : {}) };
      const { client, catalog } = makeClient({ ...fresh, catalogCache: cache() });
      await client.findAddableProducts('essential for women 18+', EMAIL);
      assert.equal(catalog.requests.length, 0, label);
    }
    // The key uses the sorted allowlist: the same pairs in another order are the same entry
    const reordered = makeClient({ addable: new Map([...ADDABLE].reverse()), catalogCache: cache() });
    await reordered.client.findAddableProducts('essential for women 18+', EMAIL);
    assert.equal(reordered.catalog.requests.length, 0);
    assert.equal(cacheFiles(dir).length, cases.length);
  });

  test('a corrupt, wrong-version, future, mis-scoped (country or currency) or mistyped entry is a miss and is overwritten', async t => {
    const dir = tempCacheDir(t);
    const seeded = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
    const expected = (await seeded.client.findAddableProducts('essential for women 18+', EMAIL)).products;
    const file = path.join(dir, cacheFiles(dir)[0]);
    const good = JSON.parse(readFileSync(file, 'utf8'));
    const withVariant = (field, value) => ({
      ...good,
      variants: good.variants.map((variant, index) => (index === 0 ? { ...variant, [field]: value } : variant)),
    });
    const without = field => ({ ...good, variants: good.variants.map(({ [field]: _dropped, ...rest }) => rest) });

    const cases = {
      'truncated JSON': '{"version":1,"storedAt":',
      'not JSON': 'hello',
      'null': 'null',
      'an array': '[]',
      'wrong version': { ...good, version: 1 },
      'no version': { ...good, version: undefined },
      'future storedAt': { ...good, storedAt: Date.now() + 60 * 1000 },
      'storedAt as a string': { ...good, storedAt: String(good.storedAt) },
      'fractional storedAt': { ...good, storedAt: good.storedAt + 0.5 },
      'another country': { ...good, country: 'CA' },
      'another currency': { ...good, currency: 'CAD' },
      'no currency': { ...good, currency: undefined },
      'variants not an array': { ...good, variants: {} },
      'variant not an object': { ...good, variants: [...good.variants.slice(1), 'x'] },
      'variantId not allowlisted': withVariant('variantId', '123'),
      'variantId as a number': withVariant('variantId', 8001),
      'duplicate variantId': { ...good, variants: [...good.variants, good.variants[0]] },
      'productId as a number': withVariant('productId', 7001),
      'productId not digits': withVariant('productId', 'gid://shopify/Product/7001'),
      'productTitle as a number': withVariant('productTitle', 1),
      'variantTitle missing': without('variantTitle'),
      'unitPrice as a string': withVariant('unitPrice', '33.00'),
      'unitPrice negative': withVariant('unitPrice', -1),
      'unitPrice finer than the currency': withVariant('unitPrice', 33.005),
      'currency missing': without('currency'),
      'currency not an ISO 4217 code': withVariant('currency', 'USDX'),
      'currency lowercase': withVariant('currency', 'usd'),
      'currency empty with a price': withVariant('currency', ''),
      'variant in another currency': withVariant('currency', 'CAD'),
      'available as a string': withVariant('available', 'true'),
    };
    for (const [label, entry] of Object.entries(cases)) {
      writeFileSync(file, typeof entry === 'string' ? entry : JSON.stringify(entry));
      const { client, catalog } = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
      assert.deepEqual((await client.findAddableProducts('essential for women 18+', EMAIL)).products, expected, label);
      assert.equal(catalog.requests.length, 1, label);
      const rewritten = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(rewritten.version, 2, label);
      assert.equal(rewritten.currency, 'USD', label);
      assert.deepEqual(rewritten.variants, good.variants, label);
      assert.deepEqual(cacheFiles(dir), [path.basename(file)], label);
    }
  });

  test('a failing chunk fails the search and nothing is cached', async t => {
    const dir = tempCacheDir(t);
    const failing = body => (body.params.arguments.catalog.ids.includes(variantGid('8112'))
      ? new Response('nope', { status: 500 })
      : lookupResponse(catalogFixtures(), body));
    const { client, catalog } = makeClient({ addable: BIG_ADDABLE, catalog: makeCatalog({ respond: failing }), catalogCache: createAddableCatalogCache({ dir }) });
    await assert.rejects(client.findAddableProducts('essential for women 18+', EMAIL));
    assert.equal(catalog.requests.length, 3);
    assert.deepEqual(cacheFiles(dir), []);

    // The next search reads the catalog again (no error or partial result was kept)
    const next = makeClient({ addable: BIG_ADDABLE, catalogCache: createAddableCatalogCache({ dir }) });
    assert.equal((await next.client.findAddableProducts('essential for women 18+', EMAIL)).products.length, 2);
    assert.equal(next.catalog.requests.length, 3);
    assert.equal(cacheFiles(dir).length, 1);
  });

  test('an unusable cache dir still returns a fresh result', async t => {
    const root = path.dirname(tempCacheDir(t));
    const blocker = path.join(root, 'a-file');
    writeFileSync(blocker, 'x');
    const dirs = [blocker, path.join(blocker, 'cache')];
    const canDenyWrites = process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0);
    if (canDenyWrites) {
      const readOnly = path.join(root, 'read-only');
      mkdirSync(readOnly, { mode: 0o700 });
      chmodSync(readOnly, 0o500);
      dirs.push(readOnly);
    }
    try {
      for (const dir of dirs) {
        for (let run = 0; run < 2; run += 1) {
          const { client, catalog } = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
          const { products } = await client.findAddableProducts('essential for women 18+', EMAIL);
          assert.deepEqual(products.map(product => product.variant_id), [8001, 8006], dir);
          assert.equal(catalog.requests.length, 1, dir);
        }
      }
      if (canDenyWrites) {
        assert.deepEqual(cacheFiles(path.join(root, 'read-only')), []);
      }
    } finally {
      if (canDenyWrites) {
        chmodSync(path.join(root, 'read-only'), 0o700);
      }
    }
  });

  test('create_onetime and create_subscription never read or write the cache', async t => {
    const dir = tempCacheDir(t);
    await makeClient({ catalogCache: createAddableCatalogCache({ dir }) }).client.findAddableProducts('essential for women 18+', EMAIL);
    const file = path.join(dir, cacheFiles(dir)[0]);
    const before = readFileSync(file, 'utf8');

    const real = createAddableCatalogCache({ dir });
    const used = [];
    const spy = {
      get: scope => { used.push('get'); return real.get(scope); },
      set: (scope, variants) => { used.push('set'); return real.set(scope, variants); },
    };
    const { client, catalog } = makeClient({ catalogCache: spy });
    await client.verifiedCreateOnetime(onetimeArgs(), EMAIL);
    await client.verifiedCreateSubscription(subscriptionArgs(), EMAIL);
    // Both read the one variant fresh, although a valid entry covers it
    assert.deepEqual(catalog.requests.map(request => request.body.params.arguments.catalog.ids), [[variantGid('8001')], [variantGid('8001')]]);
    assert.deepEqual(used, []);
    assert.equal(readFileSync(file, 'utf8'), before);

    // The entry was valid all along: a search on the same client uses it
    await client.findAddableProducts('essential for women 18+', EMAIL);
    assert.equal(catalog.requests.length, 2);
    assert.deepEqual(used, ['get']);

    // With an empty cache dir, adds create nothing there
    const emptyDir = tempCacheDir(t);
    const fresh = makeClient({ catalogCache: createAddableCatalogCache({ dir: emptyDir }) });
    await fresh.client.verifiedCreateOnetime(onetimeArgs(), EMAIL);
    await fresh.client.verifiedCreateSubscription(subscriptionArgs(), EMAIL);
    assert.equal(fresh.catalog.requests.length, 2);
    assert.equal(existsSync(emptyDir), false);
  });

  test('entries hold only the find fields (no descriptions), in a 0700 dir as 0600 files', async t => {
    const dir = path.join(tempCacheDir(t), 'nested');
    const { client } = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
    await client.findAddableProducts('essential for women 18+', EMAIL);
    const [name] = cacheFiles(dir);
    const text = readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!text.includes(DESCRIPTION_MARKER));
    assert.doesNotMatch(text, /description|html|handle|sku|<p>/i);
    const entry = JSON.parse(text);
    assert.deepEqual(Object.keys(entry).sort(), ['country', 'currency', 'storedAt', 'variants', 'version']);
    assert.ok(entry.variants.length > 0);
    for (const variant of entry.variants) {
      assert.deepEqual(Object.keys(variant).sort(), STORED_FIELDS);
    }
    if (process.platform !== 'win32') {
      assert.equal(fileMode(dir), 0o700);
      assert.equal(fileMode(path.join(dir, name)), 0o600);
    }
  });

  test('an existing cache dir that is not private is left untouched and not used', { skip: process.platform === 'win32' }, async t => {
    // e.g. MCP_CATALOG_CACHE_DIR=/tmp: never chmod a directory the cache didn't create
    for (const mode of [0o755, 0o1777, 0o2770]) {
      const dir = tempCacheDir(t);
      mkdirSync(dir);
      chmodSync(dir, mode);
      for (let run = 0; run < 2; run += 1) {
        const { client, catalog } = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
        assert.equal((await client.findAddableProducts('essential for women 18+', EMAIL)).products.length, 2);
        assert.equal(catalog.requests.length, 1, mode.toString(8));
      }
      assert.equal(statSync(dir).mode & 0o7777, mode);
      assert.deepEqual(cacheFiles(dir), []);
    }
  });

  test('an empty successful lookup is not cached', async t => {
    const dir = tempCacheDir(t);
    // Every chunk succeeds but the catalog returns nothing (e.g. a brief unpublish or a catalog blip)
    const empty = makeClient({ catalog: makeCatalog({ db: {} }), catalogCache: createAddableCatalogCache({ dir }) });
    assert.deepEqual((await empty.client.findAddableProducts('essential for women 18+', EMAIL)).products, []);
    assert.equal(empty.catalog.requests.length, 1);
    assert.deepEqual(cacheFiles(dir), []);
    // The next search (same process or another) reads the catalog again
    await empty.client.findAddableProducts('essential for women 18+', EMAIL);
    assert.equal(empty.catalog.requests.length, 2);
    const next = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
    assert.equal((await next.client.findAddableProducts('essential for women 18+', EMAIL)).products.length, 2);
    assert.equal(next.catalog.requests.length, 1);
    assert.equal(cacheFiles(dir).length, 1);
  });

  test('an unreadable price and an unmatched product ID round-trip as a hit and stay unsellable', async t => {
    const dir = tempCacheDir(t);
    const db = catalogFixtures();
    // 8001: price not in minor units; 8006: moved to a product whose ID isn't a Product GID
    db.US[0].variants[0].price.amount = '33.00';
    db.US.push({ ...ucpProduct('7001', 'Essential for Women 18+', 'essential-2', [db.US[0].variants.pop()]), id: 'Product/7001' });
    const first = makeClient({ catalog: makeCatalog({ db }), catalogCache: createAddableCatalogCache({ dir }) });
    assert.deepEqual((await first.client.findAddableProducts('essential for women 18+', EMAIL)).products, []);
    const stored = JSON.parse(readFileSync(path.join(dir, cacheFiles(dir)[0]), 'utf8')).variants;
    assert.equal(stored.find(variant => variant.variantId === '8001').unitPrice, null);
    assert.equal(stored.find(variant => variant.variantId === '8006').productId, null);

    const second = makeClient({ catalog: makeCatalog({ db }), catalogCache: createAddableCatalogCache({ dir }) });
    assert.deepEqual((await second.client.findAddableProducts('essential for women 18+', EMAIL)).products, []);
    assert.deepEqual((await second.client.findAddableProducts('natalbiotic', EMAIL)).products.map(product => product.variant_id), [42144416137310]);
    assert.equal(second.catalog.requests.length, 0);
  });

  test('entries are written atomically: a temp file renamed over the entry, never written through', { skip: process.platform === 'win32' }, async t => {
    const dir = tempCacheDir(t);
    await makeClient({ catalogCache: createAddableCatalogCache({ dir }) }).client.findAddableProducts('essential for women 18+', EMAIL);
    const [name] = cacheFiles(dir);
    const file = path.join(dir, name);
    const good = readFileSync(file, 'utf8');

    // A symlink at the entry path is replaced, its target never written
    const victim = path.join(path.dirname(dir), 'victim.txt');
    writeFileSync(victim, 'original');
    rmSync(file);
    symlinkSync(victim, file);
    const relinked = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
    assert.equal((await relinked.client.findAddableProducts('essential for women 18+', EMAIL)).products.length, 2);
    assert.equal(relinked.catalog.requests.length, 1);
    assert.equal(readFileSync(victim, 'utf8'), 'original');
    assert.ok(lstatSync(file).isFile());
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).variants, JSON.parse(good).variants);
    assert.deepEqual(cacheFiles(dir), [name]);

    // A rename that fails (a directory at the entry path) leaves no temp file behind
    rmSync(file);
    mkdirSync(file);
    writeFileSync(path.join(file, 'keep'), 'x');
    for (let run = 0; run < 2; run += 1) {
      const blocked = makeClient({ catalogCache: createAddableCatalogCache({ dir }) });
      assert.equal((await blocked.client.findAddableProducts('essential for women 18+', EMAIL)).products.length, 2);
      assert.equal(blocked.catalog.requests.length, 1);
      assert.deepEqual(cacheFiles(dir), [name]);
    }
  });

  test('lookup chunks are all requested before any response arrives', async () => {
    const release = [];
    const db = catalogFixtures();
    // Variants in the second and third chunks, and one returned under two products
    db.US.push(ucpProduct('7100', 'Extra', 'extra', [ucpVariant('8100', 'A', 100, 'USD'), ucpVariant('8113', 'C', 100, 'USD')]));
    db.US.push(ucpProduct('7101', 'Extra Two', 'extra-two', [ucpVariant('8110', 'B', 100, 'USD'), ucpVariant('8113', 'C', 100, 'USD')]));
    const catalog = makeCatalog({
      respond: body => new Promise(resolve => release.push(() => resolve(lookupResponse(db, body)))),
    });
    const pending = catalog.lookupVariants([...BIG_ADDABLE.keys()], 'US');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(catalog.requests.length, 3);
    assert.deepEqual(catalog.requests.map(request => request.body.params.arguments.catalog.ids.length), [10, 10, 5]);
    // Release in reverse order: the merge still follows chunk order
    for (const resolve of release.reverse()) {
      resolve();
    }
    const found = await pending;
    assert.deepEqual([...found.keys()], ['8001', '8006', '8004', '8007', '8009', '8010', NATALBIOTIC.variantId, '8100', '8110']);
    // One variant under two products is still dropped as ambiguous
    assert.equal(found.has('8113'), false);
  });

  test('a chunk that fails while the others are pending fails the search and nothing is cached', async t => {
    const dir = tempCacheDir(t);
    const release = [];
    const respond = body => (body.params.arguments.catalog.ids.includes(variantGid('8112'))
      ? new Response('nope', { status: 500 })
      : new Promise(resolve => release.push(() => resolve(lookupResponse(catalogFixtures(), body)))));
    const { client, catalog } = makeClient({ addable: BIG_ADDABLE, catalog: makeCatalog({ respond }), catalogCache: createAddableCatalogCache({ dir }) });
    try {
      await assert.rejects(client.findAddableProducts('essential for women 18+', EMAIL));
      assert.equal(catalog.requests.length, 3);
      assert.equal(release.length, 2);
      assert.deepEqual(cacheFiles(dir), []);
    } finally {
      for (const resolve of release) {
        resolve();
      }
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(cacheFiles(dir), []);
  });
});

// ---------------------------------------------------------------------------
// Adds in the customer's subscribed currency
// ---------------------------------------------------------------------------

// A refused add: the hand-off text, "No change was made" and no write
async function currencyRefusal(calls, promise, pattern) {
  await refusal(promise, pattern);
  await refusal(promise, /No change was made/);
  assert.equal(writes(calls).length, 0);
}

const natalbioticArgs = args => args({ variantId: Number(NATALBIOTIC.variantId) });
// The catalog for a market Shopify has no known currency for (MX), priced as the given currency per variant
const mxCatalog = (currencyFor = () => 'MXN') => {
  const catalogDb = catalogFixtures();
  catalogDb.MX = structuredClone(catalogDb.US);
  for (const product of catalogDb.MX) {
    for (const variant of product.variants) {
      variant.price.currency = currencyFor(variant.id);
    }
  }
  return catalogDb;
};
const findCatalogContext = catalog => catalog.requests.map(request => request.body.params.arguments.catalog.context.address_country);

describe('adds in the subscribed currency', () => {
  test('a one-time add in the subscribed currency goes through', async () => {
    const { client, calls, catalog } = makeClient({
      db: withCountry('CA'),
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '106.82', presentment_currency: 'CAD' } }) },
    });
    await client.verifiedCreateOnetime(natalbioticArgs(onetimeArgs), EMAIL);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes']);
    assert.deepEqual(findCatalogContext(catalog), ['CA']);
  });

  test('a subscription add in the subscribed currency goes through', async () => {
    const { client, calls, catalog } = makeClient({
      db: withCountry('CA'),
      overrides: { 'POST /subscriptions': ({ data }) => ({ subscription: { id: 1101, ...data, price: '94.00', presentment_currency: 'CAD' } }) },
    });
    await client.verifiedCreateSubscription(natalbioticArgs(subscriptionArgs), EMAIL);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /subscriptions']);
    assert.equal(writes(calls)[0].data.plan_id, 4);
    assert.deepEqual(findCatalogContext(catalog), ['CA']);
  });

  test('CAD subscriptions on an address whose country is priced in USD are refused before the catalog is read', async () => {
    const { client, calls, catalog } = makeClient({ db: setCurrency(fixtures(), 'CAD', [1001, 1004, 1005]) });
    await currencyRefusal(calls, client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /can't be priced in CAD/);
    await currencyRefusal(calls, client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /can't be priced in CAD/);
    assert.equal(catalog.requests.length, 0);
  });

  test('USD subscriptions on a CA address are refused before the catalog is read', async () => {
    const { client, calls, catalog } = makeClient({ db: withCountry('CA', [501, 502], 'USD') });
    await currencyRefusal(calls, client.verifiedCreateOnetime(natalbioticArgs(onetimeArgs), EMAIL), /can't be priced in USD/);
    await currencyRefusal(calls, client.verifiedCreateSubscription(natalbioticArgs(subscriptionArgs), EMAIL), /can't be priced in USD/);
    assert.equal(catalog.requests.length, 0);
  });

  test('subscriptions in more than one currency at the address are refused', async () => {
    const { client, calls, catalog } = makeClient({ db: setCurrency(fixtures(), 'CAD', [1005]) });
    await currencyRefusal(calls, client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /not all billed in one currency/);
    await currencyRefusal(calls, client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /not all billed in one currency/);
    assert.equal(catalog.requests.length, 0);
  });

  test('a subscription naming no currency is refused, never assumed to be USD', async () => {
    const db = fixtures();
    delete db.subscriptions.find(subscription => subscription.id === 1004).presentment_currency;
    const { client, calls, catalog } = makeClient({ db });
    await currencyRefusal(calls, client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /not all billed in one currency/);
    await currencyRefusal(calls, client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /not all billed in one currency/);
    assert.equal(catalog.requests.length, 0);

    // An empty presentment_currency falls back to currency, read case-insensitively
    const fallback = fixtures();
    for (const subscription of fallback.subscriptions) {
      subscription.presentment_currency = '';
      subscription.currency = 'usd';
    }
    const accepted = makeClient({ db: fallback });
    await accepted.client.verifiedCreateOnetime(onetimeArgs(), EMAIL);
    assert.deepEqual(writes(accepted.calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes']);
  });

  test("cancelled, expired and other customers' subscriptions never set the currency", async () => {
    const db = setCurrency(fixtures(), 'CAD', [1002, 1003]);
    db.subscriptions.push({ ...structuredClone(db.subscriptions[5]), id: 2003, address_id: 501, presentment_currency: 'CAD' });
    // Ignores the status filter too, so the cancelled and expired CAD records reach the client
    const everyStatus = {
      'GET /subscriptions': ({ params }) => ({
        subscriptions: db.subscriptions
          .filter(s => !params.address_id || String(s.address_id) === String(params.address_id))
          .map(s => structuredClone(s)),
      }),
    };
    const { client, calls, catalog } = makeClient({ db, overrides: everyStatus });
    await client.verifiedCreateOnetime(onetimeArgs(), EMAIL);
    await client.verifiedCreateSubscription(subscriptionArgs(), EMAIL);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes', 'POST /subscriptions']);
    const [first] = (await client.findAddableProducts('essential for women 18+ 30 count', EMAIL)).products;
    assert.deepEqual([first.unit_price, first.currency], ['33.00', 'USD']);
    assert.deepEqual(findCatalogContext(catalog), ['US', 'US', 'US']);
  });

  test('an add follows the currency of the subscriptions at that address, not the rest of the account', async () => {
    // 501 stays US with USD subscriptions; 502 is CA and holds alice's CAD subscription
    const twoCurrencies = () => {
      const db = fixtures();
      db.addresses.find(address => address.id === 502).country_code = 'CA';
      db.subscriptions.push({ ...structuredClone(db.subscriptions[0]), id: 1006, address_id: 502, presentment_currency: 'CAD' });
      return db;
    };
    const add = async (addressId, recordCurrency) => {
      const { client, calls, catalog } = makeClient({
        db: twoCurrencies(),
        overrides: {
          'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '33.00', presentment_currency: recordCurrency } }),
          'POST /subscriptions': ({ data }) => ({ subscription: { id: 1101, ...data, price: '29.70', presentment_currency: recordCurrency } }),
        },
      });
      const results = await Promise.allSettled([
        client.verifiedCreateOnetime(onetimeArgs({ addressId }), EMAIL),
        client.verifiedCreateSubscription(subscriptionArgs({ addressId }), EMAIL),
      ]);
      return { results, calls, catalog };
    };

    for (const [addressId, country, currency] of [['501', 'US', 'USD'], ['502', 'CA', 'CAD']]) {
      const { results, calls, catalog } = await add(addressId, currency);
      assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'], addressId);
      assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`).sort(), ['POST /onetimes', 'POST /subscriptions'], addressId);
      assert.deepEqual(findCatalogContext(catalog), [country, country], addressId);
    }

    // The created record is held to that address's currency, not the other one on the account
    for (const [addressId, otherCurrency] of [['501', 'CAD'], ['502', 'USD']]) {
      const { results, calls } = await add(addressId, otherCurrency);
      for (const result of results) {
        assert.equal(result.status, 'rejected', addressId);
        assert.match(result.reason.message, /removed again/);
      }
      assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`).sort(),
        ['DELETE /onetimes/4001', 'DELETE /subscriptions/1101', 'POST /onetimes', 'POST /subscriptions'], addressId);
    }
  });

  test('presentment_currency is read before currency when a subscription has both', async () => {
    // presentment_currency is the customer's market; currency may be the store's base currency
    const withBase = db => {
      for (const subscription of db.subscriptions) {
        subscription.currency = 'USD';
      }
      return db;
    };
    const { client, calls, catalog } = makeClient({
      db: withBase(withCountry('CA')),
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '106.82', presentment_currency: 'CAD' } }) },
    });
    await client.verifiedCreateOnetime(natalbioticArgs(onetimeArgs), EMAIL);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes']);
    const [first] = (await client.findAddableProducts('essential for women 18+ 30 count', EMAIL)).products;
    assert.deepEqual([first.unit_price, first.currency], ['45.00', 'CAD']);
    assert.deepEqual(findCatalogContext(catalog), ['CA', 'CA']);

    const us = makeClient({ db: withBase(setCurrency(fixtures(), 'CAD', [1001, 1004, 1005])) });
    await currencyRefusal(us.calls, us.client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /can't be priced in CAD/);
    const result = await toolByName('find_addable_product').execute(us.client, { customer_email: EMAIL, query: 'essential for women 18+' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /can't be priced in CAD.*No change was made/);
    assert.equal(us.catalog.requests.length, 0);
  });

  test('an address with no subscriptions is still refused, whatever the customer is billed in', async () => {
    const { client, calls, catalog } = makeClient();
    await refusal(client.verifiedCreateOnetime(onetimeArgs({ addressId: '502' }), EMAIL), /has no active subscription/);
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ addressId: '502' }), EMAIL), /has no active subscription/);
    assert.equal(writes(calls).length, 0);
    assert.equal(catalog.requests.length, 0);
  });

  test('a catalog price in another currency for a country with no known market is refused', async () => {
    const { client, calls, catalog } = makeClient({
      db: withCountry('MX', [501, 502], 'MXN'),
      catalog: makeCatalog({ db: mxCatalog(() => 'USD') }),
    });
    await currencyRefusal(calls, client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /can't be priced in MXN/);
    assert.deepEqual(findCatalogContext(catalog), ['MX']);
  });

  test('a created record in another currency than the subscribed one is deleted again and refused', async () => {
    const onetime = makeClient({
      db: withCountry('CA'),
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '68.18', presentment_currency: 'USD' } }) },
    });
    await refusal(onetime.client.verifiedCreateOnetime(natalbioticArgs(onetimeArgs), EMAIL), /removed again/);
    assert.deepEqual(writes(onetime.calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes', 'DELETE /onetimes/4001']);

    const subscription = makeClient({
      db: withCountry('CA'),
      overrides: { 'POST /subscriptions': ({ data }) => ({ subscription: { id: 1101, ...data, price: '94.00', currency: 'GBP' } }) },
    });
    await refusal(subscription.client.verifiedCreateSubscription(natalbioticArgs(subscriptionArgs), EMAIL), /removed again/);
    assert.deepEqual(writes(subscription.calls).map(call => `${call.method} ${call.endpoint}`), ['POST /subscriptions', 'DELETE /subscriptions/1101']);
  });

  test('the created record is checked against the subscribed currency', async () => {
    const { client, calls } = makeClient();
    const response = { onetime: { id: 4001, address_id: 501, price: '106.82', presentment_currency: 'CAD' } };
    assert.equal(await client.verifiedCheckCreatedPrice('onetimes', 'onetime', response, 501, 106.82, 'CAD'), response);
    assert.equal(writes(calls).length, 0);
    await refusal(client.verifiedCheckCreatedPrice('onetimes', 'onetime', response, 501, 106.82, 'USD'), /removed again/);
    assert.deepEqual(writes(calls).map(call => `${call.method} ${call.endpoint}`), ['DELETE /onetimes/4001']);
  });
});

describe('find_addable_product in the subscribed currency', () => {
  test('prices are quoted in the currency of the active subscriptions', async () => {
    for (const [db, country, currency, price] of [[withCountry('CA'), 'CA', 'CAD', '45.00'], [fixtures(), 'US', 'USD', '33.00']]) {
      const { client, calls, catalog } = makeClient({ db });
      const [first] = (await client.findAddableProducts('essential for women 18+ 30 count', EMAIL)).products;
      assert.deepEqual([first.unit_price, first.currency], [price, currency]);
      assert.deepEqual(findCatalogContext(catalog), [country]);
      assert.deepEqual(calls.find(call => call.endpoint === '/subscriptions').params, { customer_id: '100', status: 'active', limit: 250 });
    }
  });

  test('an address with no subscriptions does not pick the country', async () => {
    // 501 is CA with CAD subscriptions; 502 is US and holds none of alice's
    const { client, catalog } = makeClient({ db: withCountry('CA', [501]) });
    const [first] = (await client.findAddableProducts('essential for women 18+ 30 count', EMAIL)).products;
    assert.deepEqual(findCatalogContext(catalog), ['CA']);
    assert.deepEqual([first.unit_price, first.currency], ['45.00', 'CAD']);
  });

  test('customer subscriptions in more than one currency are refused', async () => {
    const db = fixtures();
    db.subscriptions.push({ ...structuredClone(db.subscriptions[0]), id: 1006, address_id: 502, presentment_currency: 'CAD' });
    const { client, catalog, calls } = makeClient({ db });
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential for women 18+' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not all billed in one currency.*No change was made.*hand off to a support agent/);
    assert.equal(catalog.requests.length, 0);
    assert.equal(writes(calls).length, 0);
  });

  test('a customer with no active subscription is refused', async () => {
    const db = fixtures();
    for (const subscription of db.subscriptions.filter(item => item.customer_id === 100)) {
      subscription.status = 'cancelled';
    }
    const { client, catalog } = makeClient({ db });
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential for women 18+' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no active subscription.*No change was made.*hand off to a support agent/);
    assert.equal(catalog.requests.length, 0);
  });

  test("a subscribed currency the country's market is not priced in is refused and nothing is cached", async t => {
    const dir = tempCacheDir(t);
    const { client, catalog } = makeClient({ db: setCurrency(fixtures(), 'CAD', [1001, 1004, 1005]), catalogCache: createAddableCatalogCache({ dir }) });
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential for women 18+' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /can't be priced in CAD.*No change was made.*hand off to a support agent/);
    assert.equal(catalog.requests.length, 0);
    assert.deepEqual(cacheFiles(dir), []);
  });

  test('a variant priced in another currency is skipped and the lookup is not cached', async t => {
    const dir = tempCacheDir(t);
    const { client, catalog } = makeClient({
      db: withCountry('MX', [501, 502], 'MXN'),
      catalog: makeCatalog({ db: mxCatalog(id => (id === variantGid('8006') ? 'USD' : 'MXN')) }),
      catalogCache: createAddableCatalogCache({ dir }),
    });
    const { products } = await client.findAddableProducts('essential for women 18+', EMAIL);
    assert.deepEqual(products.map(product => [product.variant_id, product.currency]), [[8001, 'MXN']]);
    assert.deepEqual(findCatalogContext(catalog), ['MX']);
    assert.deepEqual(cacheFiles(dir), []);
  });

  test('more than one page of subscriptions fails closed', async () => {
    // A next_cursor, or a full page of 250 with none (the rest may be missing either way)
    const fullPage = Array.from({ length: 250 }, (_, index) => ({ ...structuredClone(fixtures().subscriptions[0]), id: 10000 + index }));
    for (const page of [{ subscriptions: [], next_cursor: 'next' }, { subscriptions: fullPage }]) {
      const { client, catalog } = makeClient({ overrides: { 'GET /subscriptions': () => structuredClone(page) } });
      const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential for women 18+' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /too many subscriptions on this account to check.*No change was made.*hand off to a support agent/);
      assert.equal(catalog.requests.length, 0);
    }
  });

  test('the cache keeps the same country in another currency as its own entry', async t => {
    const dir = tempCacheDir(t);
    const cache = createAddableCatalogCache({ dir });
    const scope = { endpoint: UCP_URL, profileUrl: PROFILE_URL, country: 'US', addable: new Map([['8001', '7001']]) };
    const variant = currency => new Map([['8001', { productId: '7001', productTitle: 'Essential for Women 18+', variantTitle: 'essential for women 18+ 30 count', unitPrice: 33, currency, available: true }]]);
    await cache.set({ ...scope, currency: 'USD' }, variant('USD'));
    assert.equal(await createAddableCatalogCache({ dir }).get({ ...scope, currency: 'CAD' }), null);
    assert.equal((await createAddableCatalogCache({ dir }).get({ ...scope, currency: 'USD' })).get('8001').currency, 'USD');
    await cache.set({ ...scope, currency: 'CAD' }, variant('CAD'));
    assert.equal((await createAddableCatalogCache({ dir }).get({ ...scope, currency: 'CAD' })).get('8001').currency, 'CAD');
    assert.equal(cacheFiles(dir).length, 2);
  });
});

// ---------------------------------------------------------------------------
// Server: listing and raw-argument refusal over stdio (no network)
// ---------------------------------------------------------------------------

async function withServer(env, fn) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'recharge-mcp-test-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    cwd,
    env: {
      PATH: process.env.PATH,
      RECHARGE_STOREFRONT_DOMAIN: 'test-shop.myshopify.com',
      RECHARGE_ADMIN_TOKEN: FAKE_TOKEN,
      // Unreachable: any request that slips through fails instead of leaving the machine
      RECHARGE_API_URL: 'https://127.0.0.1:9',
      MCP_CATALOG_CACHE_DIR: path.join(cwd, 'catalog-cache'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      // dotenv's own debug lines (DEBUG=true) also go to stdout: skip anything that isn't a JSON object
      if (!line.startsWith('{')) continue;
      const message = JSON.parse(line);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 10000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return await fn({ request, stderr: () => stderr });
  } finally {
    child.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
}

const listTools = async request => (await request('tools/list', {})).result.tools;
const callTool = async (request, name, args) => (await request('tools/call', { name, arguments: args })).result;

describe('server (stdio)', () => {
  test('hosted + verified listing shows only verifiedArgs and the verified description', async () => {
    await withServer({ MCP_HOSTED_MODE: 'true', MCP_VERIFIED_MAX_QUANTITY: '3' }, async ({ request }) => {
      const listed = await listTools(request);
      const byName = name => listed.find(tool => tool.name === name);
      assert.deepEqual(Object.keys(byName('update_subscription').inputSchema.properties).sort(), ['customer_email', 'quantity', 'subscription_id']);
      // Everything the verified path needs is listed as required (customer_email is filled in by the client)
      assert.deepEqual(byName('update_subscription').inputSchema.required, ['subscription_id', 'quantity']);
      assert.deepEqual(byName('create_onetime').inputSchema.required, ['address_id', 'variant_id', 'quantity', 'next_charge_scheduled_at']);
      assert.deepEqual(byName('create_subscription').inputSchema.required,
        ['address_id', 'variant_id', 'quantity', 'next_charge_scheduled_at', 'order_interval_frequency', 'order_interval_unit']);
      assert.match(byName('update_subscription').description, /\(1-3\)/);
      assert.deepEqual(Object.keys(byName('create_onetime').inputSchema.properties).sort(),
        ['address_id', 'customer_email', 'next_charge_scheduled_at', 'quantity', 'variant_id']);
      assert.deepEqual(Object.keys(byName('create_subscription').inputSchema.properties).sort(),
        ['address_id', 'customer_email', 'next_charge_scheduled_at', 'order_interval_frequency', 'order_interval_unit', 'quantity', 'variant_id']);
      assert.match(byName('create_subscription').description, /never suggest, recommend or upsell/);
      // Existing verified tools: only the hosted strip, as before
      assert.deepEqual(Object.keys(byName('skip_subscription').inputSchema.properties).sort(), ['customer_email', 'date', 'subscription_id']);
      assert.equal(byName('skip_subscription').description, toolByName('skip_subscription').description);
      // Other tools keep their non-ID arguments
      assert.ok(byName('get_subscriptions').inputSchema.properties.status);
    });
  });

  test('legacy and transitional listings are unchanged', async () => {
    for (const env of [{}, { MCP_VERIFIED_ADMIN_WRITES: 'transitional' }, { MCP_HOSTED_MODE: 'true', MCP_VERIFIED_ADMIN_WRITES: 'false' }]) {
      await withServer(env, async ({ request }) => {
        const update = (await listTools(request)).find(tool => tool.name === 'update_subscription');
        assert.equal(update.description, toolByName('update_subscription').description);
        assert.ok(update.inputSchema.properties.variant_id, JSON.stringify(env));
        assert.ok(update.inputSchema.properties.properties);
        assert.equal(Boolean(update.inputSchema.properties.session_token), env.MCP_HOSTED_MODE !== 'true');
      });
    }
  });

  test('extra fields are refused before any request is sent', async () => {
    await withServer({ MCP_HOSTED_MODE: 'true' }, async ({ request }) => {
      for (const extra of [{ price: 1 }, { variant_id: 5 }, { next_charge_scheduled_at: FUTURE_1 }, { properties: [] }, { order_interval_frequency: 1 }, { surprise: true }]) {
        const result = await callTool(request, 'update_subscription', { customer_email: EMAIL, subscription_id: '1001', quantity: 2, ...extra });
        assert.equal(result.isError, true);
        const text = result.content[0].text;
        assert.match(text, /Only the quantity of an existing subscription can be changed here, so no change was made/);
        assert.match(text, new RegExp(Object.keys(extra)[0]));
        assert.match(text, /hand off to a support agent/);
      }
      const onetime = await callTool(request, 'create_onetime', {
        customer_email: EMAIL, address_id: '501', variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1, price: 0.01,
      });
      assert.match(onetime.content[0].text, /Only a product and a quantity can be added.*price/);
      const props = await callTool(request, 'create_onetime', {
        customer_email: EMAIL, address_id: '501', variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1, properties: [],
      });
      assert.match(props.content[0].text, /no change was made.*properties/);
      const subscriptionArgsRaw = {
        customer_email: EMAIL, address_id: '501', variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1,
        order_interval_frequency: 1, order_interval_unit: 'month',
      };
      for (const extra of [{ price: 0.01 }, { properties: [{ name: '_gwp', value: 'true' }] }, { plan_id: 1 }]) {
        const result = await callTool(request, 'create_subscription', { ...subscriptionArgsRaw, ...extra });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, new RegExp(`schedule matching an existing subscription can be set.*no change was made.*${Object.keys(extra)[0]}`));
      }
      // Hosted-stripped args are ignored, not refused; the call then proceeds to the
      // (unreachable) API, so it fails with a network error rather than the allowlist refusal
      const stripped = await callTool(request, 'update_subscription', { customer_email: EMAIL, subscription_id: '1001', quantity: 2, session_token: 'x', customer_id: '200' });
      assert.doesNotMatch(stripped.content[0].text, /This request also asked to set/);
    });
  });

  test('schema failures on verified calls are customer-safe refusals, not raw validation errors', async () => {
    await withServer({ MCP_HOSTED_MODE: 'true' }, async ({ request }) => {
      const cases = [
        ['update_subscription', { customer_email: EMAIL, subscription_id: '1001' }, /missing or had an invalid quantity, so/],
        ['create_onetime', { customer_email: EMAIL, address_id: '501', variant_id: '8001', quantity: 1, next_charge_scheduled_at: FUTURE_1 }, /invalid variant_id/],
        ['create_subscription', {
          customer_email: EMAIL, address_id: '501', variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1,
          order_interval_frequency: 1, order_interval_unit: 'Month',
        }, /invalid order_interval_unit/],
      ];
      for (const [name, args, pattern] of cases) {
        const result = await callTool(request, name, args);
        assert.equal(result.isError, true, name);
        const text = result.content[0].text;
        assert.match(text, pattern, name);
        assert.match(text, /so no change was made.*hand off to a support agent/, name);
        assert.doesNotMatch(text, /"code"|invalid_type|\[\s*\{/, name);
      }
    });
  });

  test('transitional mode never routes purchase or quantity tools to the verified path', async () => {
    await withServer({ MCP_VERIFIED_ADMIN_WRITES: 'transitional' }, async ({ request }) => {
      // On the legacy path the extra price argument is not refused by the verified allowlist
      const result = await callTool(request, 'create_onetime', {
        customer_email: EMAIL, address_id: '501', variant_id: 8001, quantity: 1, next_charge_scheduled_at: FUTURE_1, price: 0.01,
      });
      assert.doesNotMatch(result.content[0].text, /This request also asked to set/);
    });
  });

  test('startup warns on bad config without echoing anything but the entry', async () => {
    await withServer({ MCP_HOSTED_MODE: 'true', MCP_VERIFIED_MAX_QUANTITY: '50', MCP_VERIFIED_ADDABLE_VARIANTS: '7001:8001,oops' }, async ({ request, stderr }) => {
      await listTools(request);
      assert.match(stderr(), /MCP_VERIFIED_MAX_QUANTITY must be a whole number/);
      assert.match(stderr(), /entry "oops"/);
      assert.ok(!stderr().includes(FAKE_TOKEN));
    });
  });

  test('with a valid Shopify catalog, find_addable_product reaches it (unreachable here, so a hand-off)', async () => {
    // Valid https config pointing nowhere: nothing leaves the machine
    await withServer({
      MCP_HOSTED_MODE: 'true', MCP_VERIFIED_ADDABLE_VARIANTS: '7001:8001',
      MCP_SHOPIFY_UCP_URL: 'https://127.0.0.1:9/api/ucp/mcp', MCP_UCP_AGENT_PROFILE: PROFILE_URL,
    }, async ({ request, stderr }) => {
      const result = await callTool(request, 'find_addable_product', { customer_email: EMAIL, query: 'essential for women 18+' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Products could not be looked up right now, so nothing can be added; hand off to a support agent/);
      assert.doesNotMatch(result.content[0].text, /Adding products isn't available here/);
      assert.doesNotMatch(stderr(), /MCP_SHOPIFY_UCP_URL|MCP_UCP_AGENT_PROFILE|adding products is disabled/);
    });
  });

  test('find_addable_product reads the MCP_CATALOG_CACHE_DIR entry in every server process', async t => {
    // Seed the entry another process would have written; the catalog itself is unreachable here
    const dir = tempCacheDir(t);
    const endpoint = 'https://127.0.0.1:9/api/ucp/mcp';
    const seed = createShopifyCatalog({ endpoint, profileUrl: PROFILE_URL, fetchImpl: async () => { throw new Error('no network'); } });
    await createAddableCatalogCache({ dir }).set(
      { endpoint: seed.endpoint, profileUrl: seed.profileUrl, country: 'US', currency: 'USD', addable: new Map([['8001', '7001']]) },
      new Map([['8001', { productId: '7001', productTitle: 'Essential for Women 18+', variantTitle: 'essential for women 18+ 30 count', unitPrice: 33, currency: 'USD', available: true }]]),
    );
    assert.equal(cacheFiles(dir).length, 1);
    const env = { MCP_VERIFIED_ADDABLE_VARIANTS: '7001:8001', MCP_SHOPIFY_UCP_URL: endpoint, MCP_UCP_AGENT_PROFILE: PROFILE_URL };
    // Two separate processes (as behind a stateless gateway): both answer from the entry, no email so no Recharge read
    for (const debugEnv of [{ DEBUG: 'true' }, {}]) {
      await withServer({ ...env, ...debugEnv, MCP_CATALOG_CACHE_DIR: dir }, async ({ request, stderr }) => {
        const result = await callTool(request, 'find_addable_product', { query: 'essential for women 18+' });
        assert.ok(!result.isError, result.content[0].text);
        assert.match(result.content[0].text, /Addable Products/);
        assert.match(result.content[0].text, /"variant_id": 8001/);
        assert.match(result.content[0].text, /"unit_price": "33.00"/);
        if (debugEnv.DEBUG) {
          assert.ok(stderr().includes(`find_addable_product catalog cache: ${dir}`), stderr());
        }
      });
    }
    // Another (empty) MCP_CATALOG_CACHE_DIR: the unreachable catalog is read, so a hand-off
    await withServer({ ...env, MCP_CATALOG_CACHE_DIR: tempCacheDir(t) }, async ({ request }) => {
      const result = await callTool(request, 'find_addable_product', { query: 'essential for women 18+' });
      assert.match(result.content[0].text, /Products could not be looked up right now/);
    });
  });

  test('without a valid Shopify catalog, startup warns and adds are unavailable', async () => {
    const cases = [
      [{}, /MCP_VERIFIED_ADDABLE_VARIANTS is set but MCP_SHOPIFY_UCP_URL and MCP_UCP_AGENT_PROFILE are not; adding products is disabled/],
      [{ MCP_SHOPIFY_UCP_URL: 'http://127.0.0.1:9/api/ucp/mcp', MCP_UCP_AGENT_PROFILE: PROFILE_URL }, /MCP_SHOPIFY_UCP_URL must be an https URL; adding products is disabled/],
    ];
    for (const [env, pattern] of cases) {
      await withServer({ MCP_HOSTED_MODE: 'true', MCP_VERIFIED_ADDABLE_VARIANTS: '7001:8001', ...env }, async ({ request, stderr }) => {
        const result = await callTool(request, 'find_addable_product', { customer_email: EMAIL, query: 'essential for women 18+' });
        assert.match(result.content[0].text, /Adding products isn't available here; hand off to a support agent/);
        assert.match(stderr(), pattern);
      });
    }
  });
});
