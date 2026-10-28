/**
 * Verified write helpers
 *
 * Pure helpers for the verified admin write path: env parsing, the raw
 * argument allowlist and the hosted-mode tool listing. Kept out of server.js
 * (which starts the server on import) so they can be unit tested.
 */
import * as z from 'zod';

export const DEFAULT_VERIFIED_MAX_QUANTITY = 2;
export const VERIFIED_MAX_QUANTITY_LIMIT = 10;

/**
 * MCP_VERIFIED_MAX_QUANTITY: the largest quantity a verified write may set or
 * add (1-10, default 2). Anything else falls back to the default with a warning.
 */
export function parseMaxQuantity(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: DEFAULT_VERIFIED_MAX_QUANTITY, warning: null };
  }
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < 1 || value > VERIFIED_MAX_QUANTITY_LIMIT) {
    return {
      value: DEFAULT_VERIFIED_MAX_QUANTITY,
      warning: `MCP_VERIFIED_MAX_QUANTITY must be a whole number from 1 to ${VERIFIED_MAX_QUANTITY_LIMIT}; using ${DEFAULT_VERIFIED_MAX_QUANTITY}`,
    };
  }
  return { value, warning: null };
}

/**
 * MCP_VERIFIED_ADDABLE_VARIANTS: comma-separated shopifyProductId:shopifyVariantId
 * pairs that verified writes may add. Empty means nothing can be added (fail
 * closed). Malformed entries are dropped with a warning naming the entry only.
 */
export function parseAddableVariants(raw) {
  const variants = new Map();
  const warnings = [];
  for (const entry of String(raw || '').split(',').map(item => item.trim()).filter(Boolean)) {
    const match = /^(\d+):(\d+)$/.exec(entry);
    if (!match) {
      warnings.push(`MCP_VERIFIED_ADDABLE_VARIANTS entry "${entry}" is not productId:variantId (digits only); ignored`);
      continue;
    }
    const [, productId, variantId] = match;
    // Variant IDs travel as JSON numbers (create_onetime/create_subscription variant_id), so they must be exact
    if (!Number.isSafeInteger(Number(variantId))) {
      warnings.push(`MCP_VERIFIED_ADDABLE_VARIANTS entry "${entry}" has a variant ID too large to pass as a number; ignored`);
      continue;
    }
    if (variants.has(variantId) && variants.get(variantId) !== productId) {
      warnings.push(`MCP_VERIFIED_ADDABLE_VARIANTS entry "${entry}" lists variant ${variantId} under a second product; ignored`);
      continue;
    }
    variants.set(variantId, productId);
  }
  return { variants, warnings };
}

/**
 * Keys a verified write call carries that its tool does not allow. Zod strips
 * unknown keys, so this runs on the raw arguments before parsing; otherwise a
 * price or variant sent alongside a quantity would be silently dropped rather
 * than refused.
 */
export function findDisallowedVerifiedArgs(rawArgs, verifiedArgs, ignoredArgs = []) {
  if (!Array.isArray(verifiedArgs)) {
    return [];
  }
  return Object.keys(rawArgs || {}).filter(key =>
    rawArgs[key] !== undefined && !verifiedArgs.includes(key) && !ignoredArgs.includes(key)
  );
}

export function verifiedArgsRefusalMessage(tool, disallowed) {
  const scope = tool.verifiedScope || `Only ${tool.verifiedArgs.join(', ')} can be used with ${tool.name}`;
  return `${scope} here, so no change was made. This request also asked to set: ${disallowed.join(', ')}.`;
}

/**
 * Verified write tools that buy or multiply product. They take the verified
 * path only in hosted mode, never in transitional mode, where customer_email
 * is whatever the caller asserts.
 */
export const HOSTED_ONLY_VERIFIED_TOOLS = new Set(['update_subscription', 'create_onetime', 'create_subscription']);

/**
 * Whether a call to a verified write tool takes the verified path. In hosted
 * mode that is every call; in transitional mode only calls that carry
 * customer_email and no session or admin token, and never the hosted-only tools.
 */
export function isVerifiedWriteCall(name, args, { verifiedTools, verifiedAdminWrites, transitional, hostedOnlyTools = HOSTED_ONLY_VERIFIED_TOOLS }) {
  if (!verifiedTools.has(name)) {
    return false;
  }
  return verifiedAdminWrites || (
    transitional &&
    !hostedOnlyTools.has(name) &&
    Boolean(args && args.customer_email) &&
    !(args && args.session_token) &&
    !(args && args.admin_token)
  );
}

/**
 * The JSON schema a client is shown for a tool. Hosted mode hides caller IDs
 * and tokens; with verified admin writes on, a tool with verifiedArgs also
 * only shows the arguments its verified path accepts, all required except
 * customer_email (which the client fills in).
 */
export function toListedSchema(tool, { hostedMode, verifiedAdminWrites, strippedArgs }) {
  const jsonSchema = z.toJSONSchema(tool.inputSchema);
  if (!hostedMode || !jsonSchema.properties) {
    return jsonSchema;
  }
  const keep = verifiedAdminWrites && Array.isArray(tool.verifiedArgs)
    ? arg => tool.verifiedArgs.includes(arg)
    : arg => !strippedArgs.includes(arg);
  for (const arg of Object.keys(jsonSchema.properties)) {
    if (!keep(arg)) {
      delete jsonSchema.properties[arg];
    }
  }
  if (verifiedAdminWrites && Array.isArray(tool.verifiedArgs)) {
    jsonSchema.required = tool.verifiedArgs.filter(arg => arg !== 'customer_email' && jsonSchema.properties[arg]);
  } else if (Array.isArray(jsonSchema.required)) {
    jsonSchema.required = jsonSchema.required.filter(keep);
  }
  return jsonSchema;
}

/**
 * Customer-safe text for a verified call whose arguments fail the tool's
 * schema (missing quantity, a non-numeric variant_id, an unknown interval
 * unit). Names the fields only, never their values.
 */
export function verifiedSchemaRefusalMessage(zodError, tool, rawArgs) {
  const missing = (tool.verifiedArgs || []).filter(arg => arg !== 'customer_email' && (rawArgs || {})[arg] === undefined);
  const invalid = ((zodError && zodError.issues) || [])
    .filter(issue => Array.isArray(issue.path) && issue.path.length > 0)
    .map(issue => String(issue.path[0]));
  const fields = [...new Set([...missing, ...invalid])];
  return `The request was missing or had an invalid ${fields.join(', ') || 'argument'}, so no change was made.`;
}

export function listedDescription(tool, { verifiedAdminWrites, maxQuantity }) {
  if (verifiedAdminWrites && typeof tool.verifiedDescription === 'function') {
    return tool.verifiedDescription(maxQuantity);
  }
  return tool.description;
}

/**
 * Rules repeated in the listed description of every verified product and
 * quantity tool. The Intercom connector's Fin prompt needs the same text,
 * because Fin reads that rather than MCP tool descriptions.
 */
export const VERIFIED_PURCHASE_RULES =
  'Only act on a product and quantity the customer asked for; never suggest, recommend or upsell products or quantities. ' +
  'Never describe what a product does or make any health, ingredient or benefit claim; if asked, hand off to a support agent. ' +
  'Before calling, tell the customer the exact product and variant, the quantity, the price, and which upcoming order or how often, ' +
  'and get an explicit yes to that summary in the conversation (an "ok" to a different question does not count). ' +
  'If the customer has more than one address or subscription, ask which one; never guess. ' +
  'If the call is refused, relay the message, say nothing was changed, and hand off to a support agent.';
