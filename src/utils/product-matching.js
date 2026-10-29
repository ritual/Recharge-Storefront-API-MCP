/**
 * find_addable_product matching
 *
 * Pure matching of a customer's words against the addable variants already
 * read from the catalog (no Recharge, no prices chosen here), so it can be
 * unit tested and run by scripts/eval-product-matching.js against the live
 * catalog.
 *
 * A query that describes a symptom, need or goal ("help me sleep",
 * "something for stress", "the one for sleep", "a pill to sleep", "I'm
 * pregnant") or names only an ingredient ("dha", "protein") instead of
 * naming a product matches nothing and is never searched: picking a product
 * for it would be a recommendation. This is defense in depth: Fin only looks
 * up a product the customer asked to add, and confirms it by name and price.
 * So the rules stay few and general rather than a list of every phrasing, and
 * a product named by a common word ("Sleep", "Iron") still matches that word.
 *
 * Stage 1 ("name"): every meaningful query word must match a word of the
 * product or variant title, after normalizing both sides (apostrophes and
 * possessives, trademark glyphs, & and "and", hyphens, plurals, "multi" and
 * "vitamins" for multivitamin, but not "vitamin d", nor "iron vitamins"
 * when it fully names a product that isn't one) and allowing a small typo
 * in longer words or a word split in two ("pre natal"). Numbers such as 18+
 * and 50+ must match exactly. When an allowlisted product that can't be sold
 * now matches as closely as any that can, nothing matches and nothing is
 * searched: the customer named it, not a sibling. Nor, when an allowlisted
 * product's title is unknown (the catalog returned none of its variants),
 * does a title the query only partly names.
 *
 * Stage 2 ("interpreted"), only when stage 1 finds nothing, every
 * allowlisted product's title is known, and every query word is a word of
 * some addable title or a reviewed product alias ("probiotic", "protein
 * powder"): Shopify's ranked storefront search for the raw query
 * picks which allowlisted products to return, among those whose title and
 * aliases have every query word. So a word that names nothing sold here
 * ("insomnia", "tired", "40+") is never searched, and the search never picks
 * a product for a word that product lacks. It never supplies a variant,
 * price, currency or availability: those always come from the variants
 * passed in.
 */

// Raw search results considered: the right product ranked first or second in every live probe,
// with non-addable bundles sometimes ahead of it; beyond five the results are only loosely related
export const INTERPRETED_SEARCH_DEPTH = 5;
// Most products an interpreted match returns (flavors sold as separate products count separately)
export const INTERPRETED_MAX_PRODUCTS = 3;

// Shopify's placeholder title for a product's only variant: never matched
const DEFAULT_VARIANT_TITLE = 'default title';
// Words that never name a product; dropped from the query only ("flavor" and "in" go with a flavor:
// "prenatal mint flavor", "the prenatal in citrus")
const FILLER_WORDS = new Set([
  'a', 'add', 'also', 'an', 'and', 'another', 'bottle', 'box', 'can', 'capsule', 'could', 'extra', 'flavor', 'flavored',
  'flavour', 'flavoured', 'for', 'get', 'have', 'i', 'id', 'im', 'in', 'item', 'just', 'like', 'may', 'me', 'more', 'my',
  'need', 'new', 'next', 'of', 'one', 'order', 'our', 'over', 'pack', 'pill', 'please', 'product', 'ritual', 's', 'shipment',
  'some', 'subscription', 'supplement', 'the', 'to', 'too', 'try', 'want', 'with', 'would', 'your',
]);
// Who an add is for ("add iron for my daughter", "add my wife's prenatal"): after "my" these name neither a
// product nor a need, so they are dropped. A closed set of people, never read as men or women: no product is
// picked for them ("baby" is left out: next to a prenatal it reads as a need)
const RECIPIENT_WORDS = new Set([
  'aunt', 'boyfriend', 'brother', 'dad', 'daughter', 'father', 'fiance', 'fiancee', 'friend', 'girlfriend', 'grandfather',
  'grandma', 'grandmother', 'grandpa', 'husband', 'kid', 'mom', 'mother', 'partner', 'sister', 'son', 'spouse', 'teen', 'uncle',
  'wife',
]);
// Words that end a request frame ("can you help me add ...", "I want to order ...")
const REQUEST_VERBS = new Set(['add', 'order']);
// Words that only frame a request before its "add" or "order": dropped with that word
const REQUEST_WORDS = new Set([
  'anything', 'else', 'going', 'hello', 'help', 'hey', 'hi', 'looking', 'now', 'ok', 'okay', 'pls', 'so', 'then', 'u', 'will', 'yes',
  'you',
]);
// Retired product-line words ("Essential for Women 18+" is now "Women's Multivitamin 18+",
// "Essential Protein Daily Shake" is "Daily Shake"): ignored unless they are the only words left. One that is
// also a product alias is only ignored next to a title word of the product it names ("protein" next to
// "shake"), so "Essential Protein 18+" never matches a multivitamin by its age band alone
const SOFT_WORDS = new Set(['essential', 'protein']);
// Words customers use for a title word ("vitamin" is decided in matchWords: "vitamin d" is not a multivitamin),
// including the abbreviations too short to match as a prefix (see MIN_PREFIX)
const SYNONYMS = new Map([
  ['choc', 'chocolate'],
  ['mag', 'magnesium'],
  ['multi', 'multivitamin'],
  ['peri', 'perimenopause'],
  ...['man', 'male', 'guy', 'him', 'his'].map(word => [word, 'men']),
  ...['woman', 'female', 'lady', 'ladies', 'her'].map(word => [word, 'women']),
]);
// Spelled-out age bands, sizes and counts ("fifty plus" is 50+, "add two sleep" is a count; see LEADING_COUNT)
const NUMBER_WORDS = new Map([
  ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['eighteen', '18'], ['thirty', '30'], ['fifty', '50'], ['sixty', '60'], ['ninety', '90'],
]);
// How many to add ("add 2 iron", "qty 2 magnesium", "iron x2"), never an age band (those are 18 and 50): a
// single digit first, with any "qty" or "x" next to it, or a digit with "x" last ("omega 3" keeps its 3)
const LEADING_COUNT = /^(?:(?:qty|x) )?\d(?: x)? (?=\S)/;
const TRAILING_COUNT = / (?:x \d|\d x)$/;
// Everyday names customers use for the kind of product they mean when its title lacks them, each with the
// title words of the products it can name. Stage 2 only: every query word must be a title word or one of
// these for the query to be searched, and an interpreted product must have each query word in its title or
// its aliases. They name a product's type or form, never a symptom, need, benefit or ingredient: what a
// product contains ("fish oil", "melatonin", "ceramides") names no product (decision 2026-10-29). "protein"
// is a nutrient, so it only counts next to another word of the product (see NUTRIENT_WORDS). New entries
// need Regulatory review
const PRODUCT_ALIASES = new Map([
  ['powder', ['shake']],
  ['prenatal', ['natalbiotic']],
  ['probiotic', ['natalbiotic', 'synbiotic']],
  ['protein', ['shake']],
]);
// Title words for who a product is for: never fuzzed, and an interpreted product for the other one is never returned
const GENDER_WORDS = new Set(['men', 'women']);
// Title words that say what a product is for rather than name it ("Stress Relief", "Fertility Support",
// "Perimenopause Health"): a query of only these ("I need relief") is a need, not a product name
const BENEFIT_WORDS = new Set(['health', 'relief', 'support']);
// Title words and aliases for a nutrient a product contains ("DHA & EPA" in "Omega-3 DHA & EPA", "protein"
// for Daily Shake): a query naming only these, with or without numbers, or a nutrient before what it is for
// ("protein for pregnancy"), names an ingredient, not a product ("dha", "protein", "i need more protein"). A
// product named for what it contains ("Iron", "Magnesium+",
// "Omega-3") is still named by that word
const NUTRIENT_WORDS = new Set(['dha', 'epa', 'protein']);
// Shortest start of a title word that matches it as that word ("magnes", "creat"), unless it lacks only the
// last letter ("omeg"): a shorter one is often another word ("heal" is not "health", "pre" not "prenatal")
const MIN_PREFIX = 5;
// Endings that make another word from a title word's stem: "perimenopausal" states a condition, it is
// not "perimenopause" misspelled
const WORD_ENDINGS = ['al', 'ed', 'ic', 'ing', 'ly'];
// A query describing a symptom, need or goal rather than naming a product ("help me sleep", "something
// for stress", "what's good for my skin", "I have trouble sleeping"). Choosing a product for it would be
// a recommendation, so it matches nothing and is never searched. Each word matches the start of a
// normalized query word (struggling, symptoms); no product title word starts with any of them. Wording
// these miss ("I can't sleep", "insomnia") still has a word that names no product, so it is never searched
const NEED_WORDS = [
  'anything', 'best', 'better', 'boost', 'help', 'improv', 'recommend', 'something', 'struggl', 'suggest', 'symptom', 'troubl',
];
// Phrases of whole normalized words with the same meaning, whose other words would otherwise match a title
// once the filler is dropped. They include a customer describing themselves rather than naming a product:
// "I'm pregnant", "I'm a woman over 50", "I've been tired", "I can't sleep", "I feel stressed", "trying to
// conceive" (a request frame before "add" is dropped first, so "I'm looking to add sleep" still names Sleep)
const NEED_PHRASES = [
  ['for', 'my'], ['good', 'for'], ['what', 'should'], ['which', 'one'],
  ['im'], ['i', 'am'], ['ive', 'been'], ['cant'], ['cannot'], ['feel'], ['feeling'], ['trying'],
];
// A goal clause names what the customer wants to happen, not a product: "to" before a word that isn't filler
// ("a pill to sleep", "I want to sleep"; "to add", "to my subscription" are filler), or a verb of needing or
// getting directly before a quantity ("I need more sleep", "get some sleep", "I need extra support"). After
// "add" or "order" a quantity is how much to add ("add one more iron", "add more magnesium"), and "get"
// asked for is a request ("can I get some creatine greens")
const GOAL_VERBS = new Set(['get', 'like', 'need', 'want']);
const QUANTITY_WORDS = new Set(['extra', 'more', 'some']);
const ASKING_WORDS = new Set(['can', 'could', 'may']);
const NUMBER = /^\d+\+?$/;

const isNumber = word => NUMBER.test(word);

/**
 * Normalized words of a title or query: lowercase ASCII, apostrophes and
 * trademark glyphs removed, & as "and", letters and digits split (omega3 is
 * "omega 3"), "50 plus" and "fifty plus" as "50+", a trailing plural or
 * possessive s dropped, synonyms applied. The same rules run on both sides.
 */
export function matchWords(text) {
  const words = spelledWords(text);
  // "vitamins" means a multivitamin ("prenatal vitamins"), but before a single letter it names one
  // vitamin ("vitamin d", "vitamin b12"), which stays "vitamin" so that no multivitamin title matches it
  return words.map((word, index) => (word === 'vitamin' && !/^[a-z]$/.test(words[index + 1] ?? '') ? 'multivitamin' : word));
}

/**
 * Whether a query's "multivitamin" only came from "vitamin" or "vitamins"
 * ("iron vitamins"), never from "multi" or "multivitamin".
 */
function multivitaminFromVitamins(query) {
  return !spelledWords(query).includes('multivitamin') && matchWords(query).includes('multivitamin');
}

/**
 * matchWords before "vitamin" is read as a multivitamin.
 */
function spelledWords(text) {
  const plain = String(text ?? '')
    .replace(/[™®©†‡*]/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['`‘’ʼ´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2');

  const words = [];
  for (const raw of plain.split(/[^a-z0-9+]+/).filter(Boolean)) {
    const previous = words[words.length - 1];
    // "+" or "plus" after a number makes it an age band (50 plus -> 50+); anywhere else it is dropped
    if (raw === '+' || raw === 'plus') {
      if (previous && /^\d+$/.test(previous)) {
        words[words.length - 1] = `${previous}+`;
      }
      continue;
    }
    let word = NUMBER_WORDS.get(raw) || (NUMBER.test(raw) ? raw : raw.replace(/\+/g, ''));
    if (!word) {
      continue;
    }
    if (!SYNONYMS.has(word) && !isNumber(word) && word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) {
      word = word.slice(0, -1);
    }
    word = SYNONYMS.get(word) || word;
    // "multi vitamin" (or "multi-vitamin") is one word, and so is "peri menopause" (or "peri-menopause")
    if (((word === 'multivitamin' || word === 'vitamin') && previous === 'multivitamin') ||
        (word === 'menopause' && previous === 'perimenopause')) {
      continue;
    }
    words.push(word);
  }
  return words;
}

/**
 * Normalized words of a query without a request frame before its first
 * "add" or "order" ("can you help me add sleep" and "I want to order sleep"
 * are "sleep").
 */
function requestWords(query) {
  const words = matchWords(query);
  const verb = words.findIndex(word => REQUEST_VERBS.has(word));
  return verb >= 0 && words.slice(0, verb).every(word => FILLER_WORDS.has(word) || REQUEST_WORDS.has(word))
    ? words.slice(verb + 1)
    : words;
}

/**
 * The words without who an add is for (see RECIPIENT_WORDS) or where it
 * goes: "for my" and the person after it ("add iron for my daughter" is "add
 * iron"), the person after any other "my" ("add my wife's prenatal" is "add
 * my prenatal"), and a last "for my" clause of only filler ("add sleep for my
 * next order" is "add sleep"; "for my stress" stays).
 */
function withoutRecipient(words) {
  const forMy = index => words[index] === 'for' && words[index + 1] === 'my';
  const fillerClause = words.findIndex((_, index) => forMy(index) && words.slice(index + 2).every(word => FILLER_WORDS.has(word)));
  return (fillerClause >= 0 ? words.slice(0, fillerClause) : words).filter((word, index) =>
    !(forMy(index) && RECIPIENT_WORDS.has(words[index + 2])) &&
    !(word === 'my' && words[index - 1] === 'for' && RECIPIENT_WORDS.has(words[index + 1])) &&
    !(RECIPIENT_WORDS.has(word) && words[index - 1] === 'my'));
}

/**
 * Whether the words have a goal clause (see GOAL_VERBS): "to" before a word
 * that isn't filler, or a verb of needing or getting directly before a
 * quantity, unless it is "get" after "can", "could" or "may".
 */
function hasGoalClause(words) {
  return words.some((word, index) => {
    const next = words[index + 1];
    if (next === undefined) {
      return false;
    }
    if (word === 'to') {
      return !FILLER_WORDS.has(next);
    }
    return GOAL_VERBS.has(word) && QUANTITY_WORDS.has(next) &&
      !(word === 'get' && words.slice(0, index).some(before => ASKING_WORDS.has(before)));
  });
}

/**
 * Whether a query describes a symptom, need or goal instead of naming a
 * product (see NEED_WORDS, NEED_PHRASES and GOAL_VERBS), names only what a
 * product is for (see BENEFIT_WORDS) or a nutrient it contains (see
 * NUTRIENT_WORDS), or puts what it is for ahead of any product name, or
 * after only a nutrient ("for pregnancy", "in pregnancy", "the one for
 * stress", "I need a supplement for sleep", "protein for pregnancy";
 * "Essential for Women" and "multi for men" name one first). "for my" before
 * a person names who the add is for, not a need ("add iron for my daughter";
 * "for my stress" is one).
 */
export function describesNeed(query) {
  const words = requestWords(query);
  const forIndex = words.findIndex(word => word === 'for' || word === 'in');
  const stated = withoutRecipient(words);
  const named = stated.filter(word => !FILLER_WORDS.has(word));
  const namedWords = named.filter(word => !isNumber(word));
  return words.some(word => NEED_WORDS.some(marker => word.startsWith(marker))) ||
    NEED_PHRASES.some(phrase => stated.some((_, index) => phrase.every((part, offset) => stated[index + offset] === part))) ||
    hasGoalClause(words) ||
    (named.length > 0 && named.every(word => BENEFIT_WORDS.has(word))) ||
    (namedWords.length > 0 && namedWords.every(word => NUTRIENT_WORDS.has(word))) ||
    // A nutrient names no product (see NUTRIENT_WORDS), so it counts as filler here
    (forIndex >= 0 && words.slice(0, forIndex).every(word => FILLER_WORDS.has(word) || NUTRIENT_WORDS.has(word)));
}

/**
 * The words of a query that must match: request frame, who it is for, filler
 * and a count dropped, and soft words dropped too unless nothing else is left
 * (one that is also an alias only next to a title word of the product it
 * names).
 */
export function queryWords(query) {
  const words = withoutRecipient(requestWords(query)).filter(word => !FILLER_WORDS.has(word))
    .join(' ').replace(LEADING_COUNT, '').replace(TRAILING_COUNT, '').split(' ').filter(Boolean);
  const ignored = word => SOFT_WORDS.has(word) &&
    (!PRODUCT_ALIASES.has(word) || PRODUCT_ALIASES.get(word).some(named => words.includes(named)));
  const firm = words.filter(word => !ignored(word));
  return firm.length > 0 ? firm : words;
}

/**
 * The query words a product's title or aliases must have: soft words never
 * do ("Essential" is in no title), unless they are aliases ("protein").
 */
function firmWords(words) {
  return words.filter(word => !SOFT_WORDS.has(word) || PRODUCT_ALIASES.has(word));
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein with adjacent
 * transpositions), giving up once it exceeds `max`.
 */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  let before = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, before[j - 2] + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) {
      return max + 1;
    }
    before = previous;
    previous = current;
  }
  return previous[b.length];
}

/**
 * How one query word matches one title word: "exact" (equal, or the start of
 * a title word of at least MIN_PREFIX letters, or 3+ letters lacking only the
 * title word's last letter), "fuzzy" (one typo for words of 5+
 * letters, two for 9+, but never the title word with letters added or its
 * ending changed), or null. Numbers never fuzz: "18" matches "18" or
 * "18+", "18+" only "18+".
 */
export function wordMatch(word, titleWord) {
  if (isNumber(word) || isNumber(titleWord)) {
    return word === titleWord || (/^\d+$/.test(word) && titleWord === `${word}+`) ? 'exact' : null;
  }
  if (word === titleWord || (word.length >= 3 && titleWord.startsWith(word) &&
      (word.length >= MIN_PREFIX || word.length === titleWord.length - 1))) {
    return 'exact';
  }
  // A longer word that starts or ends with the whole title word is another word, not a typo ("shaker" is not
  // "shake", "infertility" not "fertility")
  if (word.startsWith(titleWord) || word.endsWith(titleWord)) {
    return null;
  }
  // So is the title word's stem with a word ending ("perimenopausal" is not "perimenopause")
  if (WORD_ENDINGS.some(ending => word.endsWith(ending) && word.length - ending.length >= titleWord.length - 2 &&
      titleWord.startsWith(word.slice(0, -ending.length)))) {
    return null;
  }
  const shorter = Math.min(word.length, titleWord.length);
  const max = shorter >= 9 ? 2 : shorter >= 5 ? 1 : 0;
  return max > 0 && editDistance(word, titleWord, max) <= max ? 'fuzzy' : null;
}

/**
 * Whether a query word names a title word, for ranking: a match that isn't
 * only the start of it more than one letter short ("natal" names Natal
 * Choline but only starts Natalbiotic; "omeg" names Omega).
 */
function mentions(word, titleWord) {
  return wordMatch(word, titleWord) !== null && !(titleWord.startsWith(word) && word.length < titleWord.length - 1);
}

/**
 * The words of a product title that name it (not filler or retired
 * product-line words) and that no query word mentions.
 */
function unnamedTitleWords(words, productTitle) {
  return matchWords(productTitle).filter(titleWord =>
    !FILLER_WORDS.has(titleWord) && !SOFT_WORDS.has(titleWord) && !words.some(word => mentions(word, titleWord)));
}

/**
 * "exact" when every query word matches a title word exactly, "fuzzy" when
 * every one matches but some only with a typo, otherwise null. Two query
 * words that join into a title word count as that word. A query's numbers
 * are skipped for a title without any, unless the query is only numbers.
 */
function wordsMatch(words, titleWords) {
  // A number only has to match a title that has numbers, since the age band was dropped from some
  // titles ("Essential Protein Daily Shake 18+" is now "Daily Shake"); a query of only numbers always does
  const skipNumbers = !titleWords.some(isNumber) && words.some(word => !isNumber(word));
  let result = 'exact';
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (skipNumbers && isNumber(word)) {
      continue;
    }
    // A word split in two ("pre natal", "post natal") matches the title word it joins into, exactly only
    const next = words[index + 1];
    if (next !== undefined && !isNumber(word) && !isNumber(next) &&
      titleWords.some(titleWord => wordMatch(`${word}${next}`, titleWord) === 'exact')) {
      index += 1;
      continue;
    }
    const matches = titleWords.map(titleWord => wordMatch(word, titleWord));
    if (matches.includes('exact')) {
      continue;
    }
    if (!matches.includes('fuzzy')) {
      return null;
    }
    result = 'fuzzy';
  }
  return result;
}

function variantWords(variant) {
  const variantTitle = String(variant.variantTitle ?? '');
  return matchWords(variantTitle.trim().toLowerCase() === DEFAULT_VARIANT_TITLE ? '' : variantTitle);
}

function titleWords(variant) {
  return [...matchWords(variant.productTitle), ...variantWords(variant)];
}

/**
 * The query words that are not a flavor or size of any of the variants.
 */
function withoutVariantWords(words, variants) {
  const variantTitleWords = [...new Set(variants.flatMap(variantWords))];
  return words.filter(word => !variantTitleWords.some(titleWord => wordMatch(word, titleWord)));
}

/**
 * Stage 1 ranking: { variant, unmentioned } for the variants whose product
 * and variant title match every query word. When some titles match the
 * query's numbers, titles that only matched because they have no numbers are
 * dropped, and so are they when a title with a number matches the query
 * apart from its numbers, flavor and size words (that product doesn't come in
 * them, or not in that age band); when some match without a typo, only those
 * are kept. The closest titles come first (fewest product title words the
 * query didn't mention, `unmentioned`, so "daily shake" puts Daily Shake
 * before Daily Shake Pregnancy & Postpartum), otherwise in the order given.
 */
function rankByName(words, variants) {
  if (words.length === 0) {
    return [];
  }
  const queryHasNumbers = words.some(isNumber);
  const matched = variants
    .map(variant => {
      const titleWordsOfVariant = titleWords(variant);
      return {
        variant,
        match: wordsMatch(words, titleWordsOfVariant),
        numbersSkipped: queryHasNumbers && !titleWordsOfVariant.some(isNumber),
      };
    })
    .filter(item => item.match);
  // "multivitamin 50+" is Women's and Men's Multivitamin 50+, not also Prenatal Multivitamin (which has no number),
  // and "citrus multivitamin 50+" is no title at all, not Prenatal Multivitamin in Citrus. Titles without a number
  // only count when no title with one has the query's other words ("Essential Protein Daily Shake 18+"), whatever
  // its number: with no 50+ title left, "multivitamin 50+" is still not Prenatal Multivitamin
  const numbered = matched.filter(item => !item.numbersSkipped);
  const productWords = withoutVariantWords(words, variants).filter(word => !isNumber(word));
  const numberedTitleFits = queryHasNumbers &&
    variants.some(variant => titleWords(variant).some(isNumber) && wordsMatch(productWords, titleWords(variant)));
  const counted = numbered.length > 0 || numberedTitleFits ? numbered : matched;
  const exact = counted.filter(item => item.match === 'exact');
  return (exact.length > 0 ? exact : counted)
    .map(item => ({
      variant: item.variant,
      unmentioned: matchWords(item.variant.productTitle).filter(titleWord => !words.some(word => mentions(word, titleWord))).length,
    }))
    .sort((a, b) => a.unmentioned - b.unmentioned);
}

/**
 * Stage 1: the variants rankByName matches, closest first.
 */
export function matchByName(words, variants) {
  return rankByName(words, variants).map(item => item.variant);
}

/**
 * Stage 1 over sellable and unsellable variants together: the sellable ones
 * matched ([] when none match at all), or null when only unsellable ones
 * match, or one ranks closer than every sellable one, or as close with
 * another product title. Then the customer named a product that can't be
 * added now, never a sibling with more title words ("daily shake" for Daily
 * Shake Pregnancy & Postpartum) or another age band ("women's multivitamin"
 * for 50+ with 18+ out of stock). Another flavor or size of the same title
 * as close is not another product. When `titlesKnown` is false (an
 * allowlisted product's title is unknown), it is also null unless the query
 * names every title word of some sellable product it matched, apart from
 * filler and retired product-line words: the unknown one may be what a
 * partial name meant.
 */
function nameMatches(words, variants, unsellable, titlesKnown = true) {
  const sellable = new Set(variants);
  const ranked = rankByName(words, [...variants, ...unsellable]);
  const named = ranked.filter(item => sellable.has(item.variant));
  if (named.length === 0) {
    return ranked.length > 0 ? null : [];
  }
  const closest = named[0].unmentioned;
  const normalizedTitle = item => matchWords(item.variant.productTitle).join(' ');
  const closestTitles = new Set(named.filter(item => item.unmentioned === closest).map(normalizedTitle));
  const blocked = ranked.some(item => !sellable.has(item.variant) &&
    (item.unmentioned < closest || (item.unmentioned === closest && !closestTitles.has(normalizedTitle(item)))));
  // A not_found variant, or a partial lookup still cached, leaves its product's title unknown
  if (blocked || (!titlesKnown && !named.some(item => unnamedTitleWords(words, item.variant.productTitle).length === 0))) {
    return null;
  }
  return named.map(item => item.variant);
}

/**
 * Whether title words contradict the query: numbers (18+, 50+, 30
 * servings...) that include none of the query's, only the other gender's
 * word, or a multivitamin for a query that never said multivitamin (a single
 * nutrient such as "vitamin d" or "zinc" is in every multivitamin, so it
 * never picks one).
 */
function conflicts(words, titleWordsOfVariant) {
  const wanted = words.filter(isNumber);
  const offered = titleWordsOfVariant.filter(isNumber);
  if (wanted.length > 0 && offered.length > 0 && !wanted.some(word => offered.some(titleWord => wordMatch(word, titleWord)))) {
    return true;
  }
  const wantedGender = words.filter(word => GENDER_WORDS.has(word));
  const offeredGender = titleWordsOfVariant.filter(word => GENDER_WORDS.has(word));
  if (wantedGender.length > 0 && offeredGender.length > 0 && !offeredGender.some(word => wantedGender.includes(word))) {
    return true;
  }
  return titleWordsOfVariant.includes('multivitamin') && !words.includes('multivitamin');
}

/**
 * A product's title words and the aliases that can name it.
 */
function productVocabulary(productTitle) {
  const words = matchWords(productTitle);
  const aliases = [...PRODUCT_ALIASES].filter(([, named]) => named.some(word => words.includes(word))).map(([alias]) => alias);
  return [...words, ...aliases];
}

/**
 * Whether every query word is a word of some variant's title, a product
 * alias or a retired product-line word: only such a query is searched.
 */
function namesProducts(words, variants) {
  return wordsMatch(words, [...new Set([...variants.flatMap(titleWords), ...PRODUCT_ALIASES.keys(), ...SOFT_WORDS])]) !== null;
}

/**
 * Stage 2: the best-ranked allowlisted product within the top
 * INTERPRETED_SEARCH_DEPTH search results, plus any later ones in that window
 * with the same title (a flavor sold as its own product), in Shopify's order,
 * at most INTERPRETED_MAX_PRODUCTS. Other related products further down are
 * never added: the customer named one product. A product is only kept when
 * its title and aliases have every query word, apart from flavor and size
 * words, which each kept variant must have; and when it doesn't contradict
 * the query (numbers, gender, a multivitamin for a single nutrient, no age
 * band when a product with the query's fits). If a product that fails this
 * ranks above every kept one, the search's best guess was wrong and so are
 * the rest: nothing is returned. So is it when one that fits ranks above
 * every kept one but the flavor or size asked for is only among its title's
 * unsellable variants (out of stock): never another product in that flavor. Likewise if a product that can't be added
 * ranks above every addable one and is allowlisted (out of stock, priced in
 * another currency), matches the query by name, or can't be read (no product
 * ID, or no title to compare), the customer named something that can't be
 * added: nothing is returned. `firm` is the query words without soft words
 * that aren't aliases (never empty); `unsellable` are allowlisted variants
 * that can't be sold now, counted for whether an age band fits.
 */
function interpret(words, firm, variants, results, allowlisted, unsellable) {
  const byProduct = new Map();
  for (const variant of variants) {
    if (!byProduct.has(variant.productId)) {
      byProduct.set(variant.productId, []);
    }
    byProduct.get(variant.productId).push(variant);
  }

  // Flavor and size words are checked per variant: another listing of the product may have them
  const productWords = withoutVariantWords(firm, variants);
  const fits = (productTitle, required = productWords, given = words) => !conflicts(given, matchWords(productTitle)) &&
    wordsMatch(required, productVocabulary(productTitle)) !== null;
  // A title with an age band that has the query's other words, whatever its number, even if it can't be sold now
  const withoutNumbers = list => list.filter(word => !isNumber(word));
  const numberedFits = words.some(isNumber) && [...new Set([...variants, ...unsellable].map(variant => variant.productTitle))]
    .some(productTitle => matchWords(productTitle).some(isNumber) && fits(productTitle, withoutNumbers(productWords), withoutNumbers(words)));

  const kept = [];
  let primaryTitle = null;
  const seen = new Set();
  for (const result of results.slice(0, INTERPRETED_SEARCH_DEPTH)) {
    const productId = result && typeof result.productId === 'string' && /^\d+$/.test(result.productId) ? result.productId : null;
    // An unreadable result ranked above every kept one may be the product the customer named
    if (!productId) {
      if (kept.length === 0) {
        return [];
      }
      continue;
    }
    if (seen.has(productId)) {
      continue;
    }
    seen.add(productId);
    if (!byProduct.has(productId)) {
      const title = typeof result.title === 'string' ? result.title : '';
      if (kept.length === 0 && (allowlisted.has(productId) || !title.trim() || wordsMatch(words, matchWords(title)))) {
        return [];
      }
      continue;
    }
    const [{ productTitle }] = byProduct.get(productId);
    // "Women's Multivitamin 40+" ranking Women's 50+ and 18+ first never falls through to Prenatal,
    // nor "postpartum vitamins" ranking Prenatal first to Postnatal
    if (!fits(productTitle) || (numberedFits && !matchWords(productTitle).some(isNumber))) {
      if (kept.length === 0) {
        return [];
      }
      continue;
    }
    const vocabulary = productVocabulary(productTitle);
    const candidate = variant => !conflicts(words, titleWords(variant)) && wordsMatch(firm, [...vocabulary, ...variantWords(variant)]) !== null;
    const candidates = byProduct.get(productId).filter(candidate);
    const normalizedTitle = matchWords(productTitle).join(' ');
    if (candidates.length === 0) {
      // The flavor or size asked for exists under this title but can't be sold now: never another product's
      if (kept.length === 0 && unsellable.some(variant => matchWords(variant.productTitle).join(' ') === normalizedTitle && candidate(variant))) {
        return [];
      }
      continue;
    }
    if (primaryTitle === null) {
      primaryTitle = normalizedTitle;
    } else if (normalizedTitle !== primaryTitle) {
      continue;
    }
    kept.push(candidates);
    if (kept.length === INTERPRETED_MAX_PRODUCTS) {
      break;
    }
  }
  return kept.flat();
}

/**
 * Match a customer's query against addable variants ({ variantId, productId,
 * productTitle, variantTitle, ... }, already checked sellable and priced, in
 * allowlist order). `search(query, limit)` is the storefront search, resolving
 * to ranked [{ productId, title }]; it is only called when stage 1 finds
 * nothing and every query word names something (namesProducts), and any
 * failure or unreadable answer is no match. `allowlisted` is every
 * allowlisted product ID, sellable now or not (one with no variant in
 * `variants` or `unsellable` has an unknown title), and `unsellable` the
 * allowlisted variants (same shape) the catalog returned that can't be sold
 * now. Returns { match: "name" | "interpreted" | "none", variants } with
 * variants taken from the sellable ones passed in.
 */
export async function matchAddableVariants(query, variants, {
  search = null, onSearchError = null, allowlisted = new Set(), unsellable = [],
} = {}) {
  const words = queryWords(query);
  // A symptom, need or goal is neither matched by name nor searched
  if (words.length === 0 || describesNeed(query)) {
    return { match: 'none', variants: [] };
  }
  // Allowlisted products none of whose variants the catalog returned: their titles are unknown
  const read = new Set([...variants, ...unsellable].map(variant => variant.productId));
  const titlesKnown = [...allowlisted].every(productId => read.has(productId));
  const named = nameMatches(words, variants, unsellable, titlesKnown);
  // A product named by its title that can't be sold now (or may be unknown) is never swapped for another,
  // by name or by search
  if (named === null) {
    return { match: 'none', variants: [] };
  }
  if (named.length > 0) {
    return { match: 'name', variants: named };
  }
  // "vitamins" said of a product that isn't a multivitamin ("iron vitamins", "the sleep vitamin"): the other
  // words match it by name only if they name every word of its title but the nutrients it contains ("omega 3
  // vitamins"), so "postpartum vitamins" is never Daily Shake Pregnancy & Postpartum
  const rest = words.filter(word => word !== 'multivitamin');
  if (multivitaminFromVitamins(query) && rest.length > 0) {
    const whole = (nameMatches(rest, variants, unsellable, titlesKnown) ?? []).filter(variant =>
      !matchWords(variant.productTitle).includes('multivitamin') &&
      unnamedTitleWords(rest, variant.productTitle).every(titleWord => NUTRIENT_WORDS.has(titleWord)));
    if (whole.length > 0) {
      return { match: 'name', variants: whole };
    }
  }
  // A word that names nothing sold here ("insomnia", "tired", "40+") is never searched, nor a query of only
  // retired product-line words ("Essential"), which names no one product. Nor is anything while an allowlisted
  // product's title is unknown: it may be what the customer named, and it is in no search result to block a sibling
  const firm = firmWords(words);
  if (!titlesKnown || typeof search !== 'function' || variants.length === 0 || firm.length === 0 ||
      !namesProducts(words, variants)) {
    return { match: 'none', variants: [] };
  }

  let results;
  try {
    results = await search(String(query), INTERPRETED_SEARCH_DEPTH);
  } catch (error) {
    if (typeof onSearchError === 'function') {
      onSearchError(error);
    }
    return { match: 'none', variants: [] };
  }
  if (!Array.isArray(results)) {
    if (typeof onSearchError === 'function') {
      onSearchError(Object.assign(new Error('Catalog search returned no results list'), { code: 'unparseable' }));
    }
    return { match: 'none', variants: [] };
  }
  const interpreted = interpret(words, firm, variants, results, allowlisted, unsellable);
  return interpreted.length > 0 ? { match: 'interpreted', variants: interpreted } : { match: 'none', variants: [] };
}
