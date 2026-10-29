#!/usr/bin/env node

/**
 * Live eval of find_addable_product matching (not part of npm test)
 *
 * Read-only: reads the allowlisted variants from the real Shopify storefront
 * catalog (lookup_catalog) and, for queries no title matches, its
 * search_catalog, then runs src/utils/product-matching.js over a table of
 * customer phrasings. No Recharge calls, no customer, nothing is written.
 *
 *   MCP_SHOPIFY_UCP_URL=https://ritual.com/api/ucp/mcp \
 *   MCP_UCP_AGENT_PROFILE=https://.../ucp/agent-profile.json \
 *   MCP_VERIFIED_ADDABLE_VARIANTS=productId:variantId,... \
 *   [EVAL_COUNTRY=US] node scripts/eval-product-matching.js
 *
 * A case passes when the first product returned has one of the expected
 * titles (and, when given, every returned variant title contains `variant`),
 * or, for an empty expectation, when nothing is returned. Exits 1 if any
 * case fails, 2 if it can't run.
 */
import { createShopifyCatalog, parseShopifyCatalogConfig } from '../src/utils/shopify-catalog.js';
import { parseAddableVariants } from '../src/utils/verified-writes.js';
import { matchAddableVariants } from '../src/utils/product-matching.js';

// Currency each store market is priced in (as in src/recharge-client.js)
const MARKET_CURRENCY = { US: 'USD', CA: 'CAD', GB: 'GBP' };
const SEARCH_PAUSE_MS = 500;

const W18 = 'Women’s Multivitamin 18+';
const W50 = 'Women’s Multivitamin 50+';
const M18 = 'Men’s Multivitamin 18+';
const M50 = 'Men’s Multivitamin 50+';
const PRENATAL = 'Prenatal Multivitamin';
const POSTNATAL = 'Postnatal Multivitamin';
const SHAKE = 'Daily Shake';
const SHAKE_PP = 'Daily Shake Pregnancy & Postpartum';
const OMEGA = 'Omega-3 DHA & EPA';
const SYNBIOTIC = 'Synbiotic+';
const NATALBIOTIC = 'Natalbiotic™';
const HYACERA = 'HyaCera™';
const CHOLINE = 'Natal Choline';
const IRON = 'Iron';
const MAGNESIUM = 'Magnesium+';
const SLEEP = 'Sleep';
const STRESS = 'Stress Relief';
const FERTILITY = 'Fertility Support';
const PERI = 'Perimenopause Health';
const GREENS = 'Creatine Greens';
const ANY_MULTI = [W18, W50, M18, M50, PRENATAL, POSTNATAL];

// [query, expected first titles ([] = nothing returned), expected variant title text]
const CASES = [
  // Old product names
  ['Essential for Women 18+', [W18]],
  ['Essential for Women 50+', [W50]],
  ['Essential for Men 18+', [M18]],
  ['Essential for Men 50+', [M50]],
  ['Essential for Men', [M18, M50]],
  ['Essential for Women', [W18, W50]],
  ['Essential Prenatal', [PRENATAL]],
  ['Essential Postnatal', [POSTNATAL]],
  ['Essential Protein', [SHAKE, SHAKE_PP]],
  ['Essential Protein Daily Shake 18+', [SHAKE]],
  // "Protein" without "shake" must match: never a multivitamin by the age band
  ['Essential Protein 18+', [SHAKE, SHAKE_PP]],
  ['prenatal protein', []],
  ['Essential Protein Daily Shake Pregnancy & Postpartum', [SHAKE_PP]],
  ['ritual essential prenatal multivitamin', [PRENATAL]],
  // Typos
  ['multivitamn', ANY_MULTI],
  ['prenatl', [PRENATAL]],
  ['magnesum', [MAGNESIUM]],
  ['synbiotc', [SYNBIOTIC]],
  ['natalbiotc', [NATALBIOTIC]],
  ['omgea 3', [OMEGA]],
  ['perimenapause', [PERI]],
  ['creatin greens', [GREENS]],
  ['hyacerra', [HYACERA]],
  ['fertilty support', [FERTILITY]],
  ['womens multivitamen 18+', [W18]],
  ['postnatel', [POSTNATAL]],
  // Words split in two
  ['pre natal', [PRENATAL]],
  ['post natal', [POSTNATAL]],
  ['multi vitamin 50+', [W50, M50]],
  // Plurals, possessives, apostrophes, abbreviations
  ["women's multivitamin 18+", [W18]],
  ['Women’s Multivitamin 50+', [W50]],
  ['mens multivitamin 50+', [M50]],
  ["men's 18+", [M18]],
  ['womens multi', [W18, W50]],
  ['mens multi 50 plus', [M50]],
  ['multivitamin 50+', [W50, M50]],
  ['multi for men', [M18, M50]],
  ['prenatal vitamins', [PRENATAL]],
  ['prenatals', [PRENATAL]],
  ['daily shakes', [SHAKE]],
  ['omega-3s', [OMEGA]],
  ['omega3', [OMEGA]],
  ['dha', []], // ingredient wording: blocked (decision 2026-10-29)
  ['omega 3 dha', [OMEGA]],
  ['synbiotic plus', [SYNBIOTIC]],
  ['magnesium plus', [MAGNESIUM]],
  ['HyaCera', [HYACERA]],
  // Flavors
  ['mint prenatal', [PRENATAL], 'Mint'],
  ['citrus prenatal', [PRENATAL], 'Citrus'],
  ['chocolate shake', [SHAKE], 'Chocolate'],
  ['vanilla daily shake', [SHAKE], 'Vanilla'],
  ["citrus women's", [W18], 'Citrus'],
  ['mint womens multi 18+', [W18], 'Mint'],
  ['mint postnatal', [POSTNATAL], 'Mint'],
  ['chocolate protein', [SHAKE], 'Chocolate'],
  ['pregnancy shake', [SHAKE_PP]],
  // Everyday names for a product's type or form match; ingredient names never do
  ['fish oil', []], // ingredient wording: blocked (decision 2026-10-29)
  ['omega 3', [OMEGA]],
  ['probiotic', [SYNBIOTIC, NATALBIOTIC]],
  ['prenatal probiotic', [NATALBIOTIC]],
  ['creatine', [GREENS]],
  ['protein powder', [SHAKE, SHAKE_PP]],
  ['melatonin', []], // ingredient wording: blocked (decision 2026-10-29)
  ['choline', [CHOLINE]],
  ['magnesium', [MAGNESIUM]],
  ['iron', [IRON]],
  ['greens', [GREENS]],
  ['ceramides', []], // ingredient wording: blocked (decision 2026-10-29)
  ['collagen', []], // ingredient wording: blocked (decision 2026-10-29)
  ['folate', []], // ingredient wording: blocked (decision 2026-10-29)
  ['magnesium glycinate', []], // ingredient wording: blocked (decision 2026-10-29)
  ['protein', []], // ingredient wording: blocked (decision 2026-10-29)
  ['sleep', [SLEEP]],
  ['stress relief', [STRESS]],
  ['perimenopause', [PERI]],
  ['fertility', [FERTILITY]],
  // Nothing addable named
  ['ritual', []],
  ['the shaker', []],
  ['Prenatal Essential Support Ritual', []],
  ['Daily Health 18+ Support Ritual', []],
  ['gift card', []],
  // Numbers or gender the store doesn't sell: never a different multivitamin
  ["Women's Multivitamin 40+", []],
  ['mens multi 40+', []],
  ["men's prenatal", []],
  // A single nutrient never picks a multivitamin
  ['vitamin d', []],
  ['vitamin b12', []],
  ['zinc', []],
  // An age band a flavor or product line doesn't come in, or a product line the search's pick lacks
  ['citrus multivitamin 50+', []],
  ['vanilla 50+', []],
  ['postpartum vitamins', []],
  ['prenatal shake', []],
  ['chocolate daily shake pregnancy', []],
  ['mint daily shake', []],
  ['chocolate protein powder', [SHAKE], 'Chocolate'],
  // Gender words and spelled-out age bands
  ['male multivitamin 50+', [M50]],
  ['multivitamin 50+ for him', [M50]],
  ['female multivitamin', [W18, W50]],
  ['ladies multivitamin 50+', [W50]],
  ['mens multivitamin over fifty', [M50]],
  ['womens multivitamin fifty plus', [W50]],
  ['senior womens vitamins', []],
  // A request frame before "add"
  ['can you help me add sleep', [SLEEP]],
  ['anything else? add Iron', [IRON]],
  ['i want to order sleep', [SLEEP]],
  // Add requests in customers' own words
  ['can you add Iron', [IRON]],
  ["I'd like to add Magnesium+ to my next order", [MAGNESIUM]],
  ['add 2 daily shakes chocolate', [SHAKE], 'Chocolate'],
  ['please add sleep to my subscription', [SLEEP]],
  ['could I also get synbiotic', [SYNBIOTIC]],
  ['I want Stress Relief too', [STRESS]],
  ['can I get some creatine greens', [GREENS]],
  ['add one more iron', [IRON]],
  ['add more magnesium', [MAGNESIUM]],
  ['get me the iron please', [IRON]],
  ['can i also have the sleep one', [SLEEP]],
  ['protein shake', [SHAKE]],
  ['the shake for pregnancy', [SHAKE_PP]],
  ['Prénatal', [PRENATAL]],
  ['mag', [MAGNESIUM]],
  // A symptom, need or goal never picks a product (and is never searched)
  ['help me sleep', []],
  ['something for stress', []],
  ['anything for energy', []],
  ["what's good for my skin", []],
  ['I have trouble sleeping', []],
  ['best one for pregnancy', []],
  ['recommend something', []],
  ['for pregnancy', []],
  ['the one for stress', []],
  ['I need a supplement for stress', []],
  ['for my anxiety', []],
  ['i need more sleep', []],
  ['i want to sleep', []],
  ['i need some extra support', []],
  ['i need relief', []],
  ['i need more protein', []],
  ['a pill to sleep', []],
  ['supplement to sleep', []],
  ['to get more sleep', []],
  ['get some sleep', []],
  ['get more energy', []],
  ['i need extra support', []],
  ["I'm a woman over 50", []],
  ['im a man', []],
  ['im pregnant', []],
  ["i'm 52", []],
  ["I'm breastfeeding", []],
  ['heal', []],
  // Symptoms and goals no marker catches: a word that names no product is never searched
  ["I can't sleep", []],
  ['insomnia', []],
  ['sleep aid', []],
  ['what can i take for stress', []],
  ["I'm stressed", []],
  ['anxiety', []],
  ['i want more energy', []],
  ['tired all the time', []],
  ['low iron', []],
  ['to get pregnant', []],
  ['trying to conceive', []],
  ['hot flashes', []],
  ['menopause', []],
  ['im perimenopausal', []],
  ['gut health', []],
  ['bloating', []],
  ['probiotic for bloating', []],
  ['hair loss', []],
  ['for my skin', []],
  ['build muscle', []],
  ['brain health', []],
];

async function main() {
  const { config, warnings } = parseShopifyCatalogConfig(process.env.MCP_SHOPIFY_UCP_URL, process.env.MCP_UCP_AGENT_PROFILE);
  const addable = parseAddableVariants(process.env.MCP_VERIFIED_ADDABLE_VARIANTS);
  for (const warning of [...warnings, ...addable.warnings]) {
    console.error(`Warning: ${warning}`);
  }
  if (!config || addable.variants.size === 0) {
    console.error('Set MCP_SHOPIFY_UCP_URL, MCP_UCP_AGENT_PROFILE and MCP_VERIFIED_ADDABLE_VARIANTS to run the eval.');
    process.exit(2);
  }
  const country = String(process.env.EVAL_COUNTRY || 'US').trim().toUpperCase();
  const currency = MARKET_CURRENCY[country];
  if (!currency) {
    console.error(`EVAL_COUNTRY must be one of ${Object.keys(MARKET_CURRENCY).join(', ')}.`);
    process.exit(2);
  }

  const catalog = createShopifyCatalog(config);
  const found = await catalog.lookupVariants([...addable.variants.keys()], country);
  // The same sellability rule as find_addable_product
  const sellable = [];
  const unsellable = [];
  for (const [variantId, productId] of addable.variants) {
    const variant = found.get(variantId);
    if (variant && variant.productId === productId && variant.available === true && variant.unitPrice > 0 && variant.currency === currency) {
      sellable.push({ ...variant, variantId, productId });
    } else if (variant && variant.productId === productId) {
      unsellable.push({ ...variant, variantId, productId });
    }
  }
  console.log(`${sellable.length} of ${addable.variants.size} allowlisted variants sellable in ${country} (${currency})\n`);

  const rows = [];
  for (const [query, expected, variantText] of CASES) {
    let searchError = null;
    const { match, variants } = await matchAddableVariants(query, sellable, {
      allowlisted: new Set(addable.variants.values()),
      unsellable,
      // Spaced out: the storefront endpoint rate-limits bursts (HTTP 429 with a long Retry-After)
      search: async (text, limit) => {
        await new Promise(resolve => setTimeout(resolve, SEARCH_PAUSE_MS));
        return catalog.searchProducts(text, country, limit);
      },
      onSearchError: error => { searchError = (error && error.code) || 'error'; },
    });
    const got = [...new Set(variants.map(variant => variant.variantTitle === 'Default Title'
      ? variant.productTitle
      : `${variant.productTitle} (${variant.variantTitle})`))];
    const pass = expected.length === 0
      ? variants.length === 0
      : variants.length > 0 && expected.includes(variants[0].productTitle) &&
        (!variantText || variants.every(variant => variant.variantTitle.includes(variantText)));
    rows.push({
      query,
      expected: expected.length === 0 ? '(none)' : `${expected.join(' | ')}${variantText ? ` [${variantText}]` : ''}`,
      got: got.length === 0 ? `(none)${searchError ? ` search ${searchError}` : ''}` : got.join('; '),
      match,
      pass,
    });
  }

  for (const row of rows) {
    console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${row.query}\n      expected: ${row.expected}\n      got (${row.match}): ${row.got}`);
  }
  const passed = rows.filter(row => row.pass).length;
  const byMatch = rows.reduce((counts, row) => ({ ...counts, [row.match]: (counts[row.match] || 0) + 1 }), {});
  console.log(`\n${passed}/${rows.length} passed (${((100 * passed) / rows.length).toFixed(1)}%); ` +
    `match: ${Object.entries(byMatch).map(([key, count]) => `${key} ${count}`).join(', ')}`);
  process.exit(passed === rows.length ? 0 : 1);
}

main().catch(error => {
  console.error(`Eval could not run: ${error && error.message}`);
  process.exit(2);
});
