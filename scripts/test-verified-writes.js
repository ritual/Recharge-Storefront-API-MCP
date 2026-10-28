#!/usr/bin/env node

/**
 * Tests for verified quantity changes and added products
 *
 * No network: the client's makeAdminRequest is replaced by an in-memory
 * router that records every call, and the server is spawned with fake
 * credentials, an unreachable RECHARGE_API_URL and an empty working directory
 * (so no .env is loaded). Every refusal asserts that no POST or PUT was sent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RechargeClient } from '../src/recharge-client.js';
import { RechargeAPIError } from '../src/utils/error-handler.js';
import { tools } from '../src/tools/index.js';
import {
  DEFAULT_VERIFIED_MAX_QUANTITY,
  findDisallowedVerifiedArgs,
  parseAddableVariants,
  parseMaxQuantity,
} from '../src/utils/verified-writes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMAIL = 'alice@example.com';
const OTHER_EMAIL = 'bob@example.com';
const FAKE_TOKEN = 'fake_admin_token_for_tests_only';
const HOSTED_STRIPPED_ARGS = ['customer_id', 'session_token', 'admin_token', 'store_url'];

const FUTURE_1 = '2099-01-15';
const FUTURE_2 = '2099-02-15';

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
        external_variant_id: { ecommerce: '9001' }, price: '30.00',
      },
      {
        id: 1002, customer_id: 100, address_id: 501, status: 'cancelled', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 2, charge_interval_frequency: 2,
        external_variant_id: { ecommerce: '9002' },
      },
      {
        id: 1003, customer_id: 100, address_id: 501, status: 'expired', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9003' },
      },
      {
        id: 1004, customer_id: 100, address_id: 501, status: 'active', quantity: 1, is_prepaid: true,
        order_interval_unit: 'week', order_interval_frequency: 4, charge_interval_frequency: 12,
        external_variant_id: { ecommerce: '9004' },
      },
      {
        id: 2001, customer_id: 200, address_id: 601, status: 'active', quantity: 1, is_prepaid: false,
        order_interval_unit: 'month', order_interval_frequency: 1, charge_interval_frequency: 1,
        external_variant_id: { ecommerce: '9001' },
      },
    ],
    addresses: [
      { id: 501, customer_id: 100 },
      { id: 502, customer_id: 100 },
      { id: 601, customer_id: 200 },
    ],
    charges: [
      { id: 3001, customer: { id: 100 }, address_id: 501, status: 'queued', scheduled_at: FUTURE_1 },
      { id: 3002, customer: { id: 100 }, address_id: 501, status: 'queued', scheduled_at: `${FUTURE_2}T00:00:00` },
      { id: 3003, customer: { id: 100 }, address_id: 501, status: 'queued', scheduled_at: '2000-01-01' },
      // Returned by the list call but owned by someone else: must never count
      { id: 3004, customer: { id: 200 }, address_id: 501, status: 'queued', scheduled_at: '2099-03-01' },
    ],
    products: {
      7001: {
        external_product_id: '7001', title: 'Essential for Women 18+', published_at: '2020-01-01T00:00:00Z',
        variants: [
          { external_variant_id: '8001', title: '30 count', prices: { unit_price: '33.00' } },
          { external_variant_id: '8006', title: '60 count', prices: { unit_price: '60.00' } },
        ],
      },
      7002: {
        external_product_id: '7002', title: 'Unpublished Thing', published_at: null,
        variants: [{ external_variant_id: '8003', title: 'Default', prices: { unit_price: '10.00' } }],
      },
      7003: {
        external_product_id: '7003', title: 'Future Thing', published_at: '2099-01-01T00:00:00Z',
        variants: [{ external_variant_id: '8004', title: 'Default', prices: { unit_price: '10.00' } }],
      },
      7005: {
        external_product_id: '7005', title: 'Protein Powder', published_at: '2020-01-01T00:00:00Z',
        variants: [{ external_variant_id: '8007', title: 'Chocolate', prices: { unit_price: '40.00' } }],
      },
    },
    plans: [
      { id: 1, type: 'subscription', deleted_at: null, external_product_id: { ecommerce: '7001' }, has_variant_restrictions: false },
      // Product 7005: only a restricted plan for a different variant, plus a deleted one
      { id: 2, type: 'subscription', deleted_at: null, external_product_id: { ecommerce: '7005' }, has_variant_restrictions: true, external_variant_ids: ['9999'] },
      { id: 3, type: 'subscription', deleted_at: '2024-01-01', external_product_id: { ecommerce: '7005' }, has_variant_restrictions: false },
    ],
    onetimes: [],
  };
}

const ADDABLE = new Map([
  ['8001', '7001'], // sellable, subscribable
  ['8003', '7002'], // unpublished
  ['8004', '7003'], // published in the future
  ['8005', '7404'], // product 404
  ['8008', '7001'], // variant missing from the product
  ['8007', '7005'], // sellable, no usable subscription plan
]);

function notFound() {
  return new RechargeAPIError('Not Found', 404);
}

/**
 * Build a client whose admin requests hit the in-memory store. `overrides`
 * maps "METHOD /path" to a handler that replaces the default one.
 */
function makeClient({ db = fixtures(), overrides = {}, addable = ADDABLE, maxQuantity = 2 } = {}) {
  const client = new RechargeClient({
    storeUrl: 'test-shop.myshopify.com',
    adminToken: FAKE_TOKEN,
    verifiedAdminWrites: true,
    verifiedMaxQuantity: maxQuantity,
    addableVariants: addable,
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
    'GET /products/:id': ({ id }) => {
      if (!db.products[id]) throw notFound();
      return { product: structuredClone(db.products[id]) };
    },
    'GET /plans': ({ params }) => ({
      plans: db.plans.filter(p => p.external_product_id.ecommerce === String(params.external_product_id)).map(p => structuredClone(p)),
    }),
    'GET /onetimes': () => ({ onetimes: db.onetimes.map(o => structuredClone(o)) }),
    'PUT /subscriptions/:id': ({ id, data }) => ({ subscription: { ...structuredClone(byId(db.subscriptions, id)), ...data } }),
    'POST /onetimes': ({ data }) => ({ onetime: { id: 4001, customer_id: 100, product_title: 'Essential for Women 18+', price: '33.00', ...data } }),
    'POST /subscriptions': ({ data }) => ({ subscription: { id: 1101, customer_id: 100, status: 'active', price: '33.00', ...data } }),
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

  return { client, calls, db };
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

  for (const [label, variantId] of [['not allowlisted', 8002], ['product 404', 8005], ['variant missing from product', 8008], ['unpublished', 8003], ['published in the future', 8004]]) {
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
    await refusal(client.verifiedCreateOnetime(onetimeArgs(), EMAIL), /no upcoming order on address 501 to add to/);
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
    await client.verifiedCreateSubscription(subscriptionArgs({ orderIntervalUnit: 'MONTH' }), EMAIL);
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

  test('interval that matches no active subscription is refused', async () => {
    const { client, calls } = makeClient();
    await refusal(client.verifiedCreateSubscription(subscriptionArgs({ orderIntervalFrequency: 2 }), EMAIL), /must match how often/);
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
  test('matches only allowlisted, published variants and reports can_subscribe', async () => {
    const { client, calls } = makeClient();
    const result = await client.findAddableProducts('essential women');
    assert.deepEqual(result.products, [{ variant_id: '8001', title: 'Essential for Women 18+', variant_title: '30 count', unit_price: '33.00', can_subscribe: true }]);
    const protein = await client.findAddableProducts('PROTEIN');
    assert.equal(protein.products[0].can_subscribe, false);
    assert.deepEqual((await client.findAddableProducts('unpublished')).products, []);
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
      await client.findAddableProducts('essential');
      await client.verifiedUpdateSubscriptionQuantity('2001', 2, EMAIL).catch(() => {});
      await client.verifiedCreateOnetime(onetimeArgs({ variantId: 8002 }), EMAIL).catch(() => {});
      await client.verifiedCreateOnetime(onetimeArgs({ variantId: 8003 }), EMAIL).catch(() => {});
      await client.verifiedCreateSubscription(subscriptionArgs({ variantId: 8007 }), EMAIL).catch(() => {});
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
    }
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
      // Hosted-stripped args are ignored, not refused; the call then proceeds to the
      // (unreachable) API, so it fails with a network error rather than the allowlist refusal
      const stripped = await callTool(request, 'update_subscription', { customer_email: EMAIL, subscription_id: '1001', quantity: 2, session_token: 'x', customer_id: '200' });
      assert.doesNotMatch(stripped.content[0].text, /This request also asked to set/);
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
});
