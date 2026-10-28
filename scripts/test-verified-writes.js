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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RechargeClient } from '../src/recharge-client.js';
import { RechargeAPIError, handleAPIError } from '../src/utils/error-handler.js';
import { createShopifyCatalog, parseShopifyCatalogConfig } from '../src/utils/shopify-catalog.js';
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
        id: 1001, customer_id: 100, address_id: 501, status: 'active', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9001' }, price: '30.00', next_charge_scheduled_at: FUTURE_1,
      },
      {
        id: 1002, customer_id: 100, address_id: 501, status: 'cancelled', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 2, charge_interval_frequency: 2,
        external_variant_id: { ecommerce: '9002' }, price: '30.00',
      },
      {
        id: 1003, customer_id: 100, address_id: 501, status: 'expired', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9003' },
      },
      {
        id: 1004, customer_id: 100, address_id: 501, status: 'active', quantity: 1, is_prepaid: true,
        order_interval_unit: 'week', order_interval_frequency: 4, charge_interval_frequency: 12,
        external_variant_id: { ecommerce: '9004' }, price: '30.00', next_charge_scheduled_at: FUTURE_1,
      },
      {
        // Same address, different schedule: next ships on FUTURE_2
        id: 1005, customer_id: 100, address_id: 501, status: 'active', quantity: 1, is_prepaid: false,
        order_interval_unit: 'week', order_interval_frequency: 2, charge_interval_frequency: 2,
        external_variant_id: { ecommerce: '9005' }, price: '20.00', next_charge_scheduled_at: `${FUTURE_2}T00:00:00`,
      },
      {
        id: 2001, customer_id: 200, address_id: 601, status: 'active', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9001' }, price: '30.00', next_charge_scheduled_at: FUTURE_1,
      },
      {
        // Someone else's active subscription returned for alice's address 502: must never count
        id: 2002, customer_id: 200, address_id: 502, status: 'active', quantity: 1, is_prepaid: false,
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
      ucpVariant('8001', '30 count', p8001, currency),
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
 * A real catalog client over a fake fetch. `respond(body, init)` replaces
 * the default in-memory lookup. Every request is kept on `.requests`.
 */
function makeCatalog({ db = catalogFixtures(), respond = null, timeoutMs } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    if (respond) {
      return respond(body, init);
    }
    const { ids, context } = body.params.arguments.catalog;
    const products = (db[context.address_country] || []).filter(product => product.variants.some(variant => ids.includes(variant.id)));
    const returned = new Set(products.flatMap(product => product.variants.map(variant => variant.id)));
    return jsonResponse(rpcResult(body.id, {
      products: structuredClone(products),
      messages: ids.filter(id => !returned.has(id)).map(id => ({ type: 'info', code: 'not_found', content: id })),
    }));
  };
  const catalog = createShopifyCatalog({ endpoint: UCP_URL, profileUrl: PROFILE_URL, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
  catalog.requests = requests;
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

// A fresh catalog per client (default), so the find_addable_product cache never leaks between tests
function makeClient({ db = fixtures(), overrides = {}, addable = ADDABLE, maxQuantity = 2, catalog = makeCatalog() } = {}) {
  clientCount += 1;
  const client = new RechargeClient({
    storeUrl: `test-shop-${clientCount}.myshopify.com`,
    adminToken: FAKE_TOKEN,
    verifiedAdminWrites: true,
    verifiedMaxQuantity: maxQuantity,
    addableVariants: addable,
    catalog,
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
    const result = await client.findAddableProducts('essential women', EMAIL);
    // Both allowlisted variants of the product, with variant_id as the number the add tools take;
    // 8010 (catalog says another product) is skipped
    assert.deepEqual(result.products, [
      { variant_id: 8001, title: 'Essential for Women 18+', variant_title: '30 count', unit_price: '33.00', currency: 'USD', can_subscribe: true },
      { variant_id: 8006, title: 'Essential for Women 18+', variant_title: '60 count', unit_price: '60.00', currency: 'USD', can_subscribe: true },
    ]);
    assert.deepEqual((await client.findAddableProducts('60 count', EMAIL)).products.map(product => product.variant_id), [8006]);
    const protein = await client.findAddableProducts('PROTEIN', EMAIL);
    assert.equal(protein.products[0].can_subscribe, false);
    assert.deepEqual((await client.findAddableProducts('unpublished', EMAIL)).products, []);
    assert.deepEqual((await client.findAddableProducts('future thing', EMAIL)).products, []);
    assert.equal(writes(calls).length, 0);
  });

  test('empty allowlist says adding is not available', async () => {
    const { client, calls } = makeClient({ addable: new Map() });
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential' });
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
      await client.findAddableProducts('essential', EMAIL);
      await client.verifiedUpdateSubscriptionQuantity('2001', 2, EMAIL).catch(() => {});
      await client.verifiedCreateOnetime(onetimeArgs({ variantId: 8002 }), EMAIL).catch(() => {});
      await client.verifiedCreateOnetime(onetimeArgs({ variantId: 8003 }), EMAIL).catch(() => {});
      await client.verifiedCreateSubscription(subscriptionArgs({ variantId: 8007 }), EMAIL).catch(() => {});
      await client.verifiedCreateOnetime(onetimeArgs({ variantId: 8010 }), EMAIL).catch(() => {});
      const failingCatalog = makeClient({ catalog: makeCatalog({ respond: () => new Response('nope', { status: 500 }) }) });
      await failingCatalog.client.verifiedCreateOnetime(onetimeArgs(), EMAIL).catch(() => {});
      await toolByName('find_addable_product').execute(failingCatalog.client, { customer_email: EMAIL, query: 'essential' });
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
    assert.equal((await client.findAddableProducts('wom', EMAIL)).products.length, 2);
    assert.equal((await client.findAddableProducts('18+', EMAIL)).products.length, 2);
  });

  test('catalog reads are one lookup per search and cached between searches', async () => {
    const { client, calls, catalog } = makeClient();
    await client.findAddableProducts('essential', EMAIL);
    assert.equal(catalog.requests.length, 1);
    // Every allowlisted variant in that one call
    assert.equal(catalog.requests[0].body.params.arguments.catalog.ids.length, ADDABLE.size);
    await client.findAddableProducts('protein', EMAIL);
    assert.equal(catalog.requests.length, 1);
    assert.ok(!calls.some(call => call.endpoint.startsWith('/products')));
  });

  test('a rate limit becomes a hand-off, not a raw API error', async () => {
    const { client } = makeClient({ catalog: makeCatalog({ respond: () => new Response('Too Many Requests', { status: 429 }) }) });
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential' });
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

const withCountry = (country, addressIds = [501, 502]) => {
  const db = fixtures();
  for (const address of db.addresses) {
    if (addressIds.includes(address.id)) {
      address.country_code = country;
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
        const product = ucpProduct('7001', 'Essential for Women 18+', 'e', [ucpVariant('8001', '30 count', 3300, 'USD')]);
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
          return jsonResponse(rpcResult(body.id, { products: [ucpProduct('7001', 'E', 'e', [ucpVariant('8001', '30 count', 99, 'USD')])], messages: [] }));
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
    const products = [ucpProduct('7001', 'E', 'e', [ucpVariant('8001', '30 count', 3300, 'USD')])];
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
        const structured = { products: [ucpProduct('7001', 'E', 'e', [ucpVariant('8001', '30 count', 3300, 'USD')])], messages: [] };
        const text = { products: [ucpProduct('7001', 'E', 'e', [ucpVariant('8001', '30 count', 1, 'USD')])], messages: [] };
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(text) }], structuredContent: structured, isError: false } });
      },
    });
    assert.equal((await catalog.lookupVariants(['8001'], 'US')).get('8001').unitPrice, 33);
  });

  test('a variant returned under two products is ambiguous and dropped', async () => {
    const respond = body => jsonResponse(rpcResult(body.id, {
      products: [
        ucpProduct('7001', 'Essential for Women 18+', 'e', [ucpVariant('8001', '30 count', 3300, 'USD'), ucpVariant('8006', '60 count', 6000, 'USD')]),
        ucpProduct('7007', 'Gummies', 'g', [ucpVariant('8001', '30 count', 100, 'USD')]),
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
        products: [ucpProduct('7001', 'Essential for Women 18+', 'e', [ucpVariant('8001', '30 count', amount, 'USD')])], messages: [],
      }));
      const variant = (await makeCatalog({ respond }).lookupVariants(['8001'], 'US')).get('8001');
      assert.ok(Number.isNaN(variant.unitPrice), String(amount));
      const { client, calls } = makeClient({ catalog: makeCatalog({ respond }) });
      await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /That product can't be added here/);
      assert.equal(writes(calls).length, 0, String(amount));
      assert.deepEqual((await client.findAddableProducts('30 count', EMAIL)).products, [], String(amount));
    }
  });

  test('fraction digits come from the currency (JPY 0, KWD 3, unknown currency NaN)', async () => {
    const respond = body => jsonResponse(rpcResult(body.id, {
      products: [
        ucpProduct('7001', 'E', 'e', [ucpVariant('8001', '30 count', 1000, 'JPY'), ucpVariant('8006', '60 count', 12345, 'KWD')]),
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
    await client.findAddableProducts('essential', EMAIL);
    await client.verifiedCreateOnetime(onetimeArgs(), EMAIL);
    await client.verifiedCreateOnetime(onetimeArgs({ date: FUTURE_2 }), EMAIL);
    assert.equal(catalog.requests.length, 3);
  });

  test('without a catalog nothing can be added or found', async () => {
    const { client, calls } = makeClient({ catalog: null });
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /That product can't be added here/);
    await refusal(client.verifiedCreateSubscription(subscriptionArgs(), EMAIL), /That product can't be added here/);
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential' });
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
      db: withCountry('ca'),
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

  test('a created record naming no currency is only trusted against a USD catalog price', async () => {
    // CA: the record's 68.18 could be USD under a 106.82 CAD ceiling, so it is removed again
    const ca = makeClient({
      db: withCountry('CA'),
      overrides: { 'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, ...data, price: '68.18' } }) },
    });
    await refusal(ca.client.verifiedCreateOnetime(onetimeArgs({ variantId: Number(NATALBIOTIC.variantId) }), EMAIL), /removed again/);
    assert.deepEqual(writes(ca.calls).map(call => `${call.method} ${call.endpoint}`), ['POST /onetimes', 'DELETE /onetimes/4001']);

    // US: no currency on the record, priced at the USD catalog price, is accepted
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
  test("country comes from the customer's addresses: one shared country, otherwise US", async () => {
    for (const [db, expected, currency, price] of [
      [withCountry('CA'), 'CA', 'CAD', '45.00'],
      [withCountry('CA', [501]), 'US', 'USD', '33.00'],
      [fixtures(), 'US', 'USD', '33.00'],
    ]) {
      const { client, catalog, calls } = makeClient({ db });
      const [first] = (await client.findAddableProducts('30 count', EMAIL)).products;
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
    const [first] = (await client.findAddableProducts('30 count', EMAIL)).products;
    assert.equal(catalog.requests[0].body.params.arguments.catalog.context.address_country, 'CA');
    assert.deepEqual([first.unit_price, first.currency], ['45.00', 'CAD']);
  });

  test('without customer_email the US catalog is used and no customer is read', async () => {
    const { client, catalog, calls } = makeClient({ db: withCountry('CA') });
    for (const email of [undefined, '', '   ']) {
      const result = await toolByName('find_addable_product').execute(client, { customer_email: email, query: '30 count' });
      assert.ok(!result.isError);
      assert.match(result.content[0].text, /"currency": "USD"/);
    }
    assert.equal(catalog.requests[0].body.params.arguments.catalog.context.address_country, 'US');
    assert.deepEqual(calls.filter(call => call.endpoint === '/customers' || call.endpoint === '/addresses'), []);
  });

  test('unit_price uses the currency minor-unit digits (JPY has none)', async () => {
    const catalogDb = { JP: [ucpProduct('7001', 'Essential for Women 18+', 'e', [ucpVariant('8001', '30 count', 1000, 'JPY')])] };
    const { client } = makeClient({ db: withCountry('JP'), catalog: makeCatalog({ db: catalogDb }) });
    const [first] = (await client.findAddableProducts('30 count', EMAIL)).products;
    assert.deepEqual([first.unit_price, first.currency], ['1000', 'JPY']);
  });

  test('the cache is per country', async () => {
    const db = withCountry('CA');
    const { client, catalog } = makeClient({ db });
    await client.findAddableProducts('essential', EMAIL);
    db.addresses[0].country_code = 'US';
    db.addresses[1].country_code = 'US';
    await client.findAddableProducts('essential', EMAIL);
    await client.findAddableProducts('protein', EMAIL);
    assert.deepEqual(catalog.requests.map(request => request.body.params.arguments.catalog.context.address_country), ['CA', 'US']);
  });

  test('a variant missing from the catalog is skipped and the others are returned', async () => {
    const catalogDb = catalogFixtures();
    catalogDb.US[0].variants = catalogDb.US[0].variants.filter(variant => variant.id !== variantGid('8001'));
    const { client } = makeClient({ catalog: makeCatalog({ db: catalogDb }) });
    assert.deepEqual((await client.findAddableProducts('essential', EMAIL)).products.map(product => product.variant_id), [8006]);
  });

  test('descriptions never reach the tool output', async () => {
    const { client } = makeClient();
    for (const query of ['essential', 'natalbiotic', 'protein']) {
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
    const result = await toolByName('find_addable_product').execute(client, { customer_email: EMAIL, query: 'essential' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /could not be looked up right now.*hand off to a support agent/);
    assert.doesNotMatch(result.content[0].text, /UCP|profile_malformed/);
  });

  test('an unknown customer gets the customer-safe refusal, not a lookup', async () => {
    const { client, catalog } = makeClient();
    const result = await toolByName('find_addable_product').execute(client, { customer_email: 'nobody@example.com', query: 'essential' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Customer not found.*hand off to a support agent/);
    assert.equal(catalog.requests.length, 0);
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
      if (!line) continue;
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
      const result = await callTool(request, 'find_addable_product', { customer_email: EMAIL, query: 'essential' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Products could not be looked up right now, so nothing can be added; hand off to a support agent/);
      assert.doesNotMatch(result.content[0].text, /Adding products isn't available here/);
      assert.doesNotMatch(stderr(), /MCP_SHOPIFY_UCP_URL|MCP_UCP_AGENT_PROFILE|adding products is disabled/);
    });
  });

  test('without a valid Shopify catalog, startup warns and adds are unavailable', async () => {
    const cases = [
      [{}, /MCP_VERIFIED_ADDABLE_VARIANTS is set but MCP_SHOPIFY_UCP_URL and MCP_UCP_AGENT_PROFILE are not; adding products is disabled/],
      [{ MCP_SHOPIFY_UCP_URL: 'http://127.0.0.1:9/api/ucp/mcp', MCP_UCP_AGENT_PROFILE: PROFILE_URL }, /MCP_SHOPIFY_UCP_URL must be an https URL; adding products is disabled/],
    ];
    for (const [env, pattern] of cases) {
      await withServer({ MCP_HOSTED_MODE: 'true', MCP_VERIFIED_ADDABLE_VARIANTS: '7001:8001', ...env }, async ({ request, stderr }) => {
        const result = await callTool(request, 'find_addable_product', { customer_email: EMAIL, query: 'essential' });
        assert.match(result.content[0].text, /Adding products isn't available here; hand off to a support agent/);
        assert.match(stderr(), pattern);
      });
    }
  });
});
