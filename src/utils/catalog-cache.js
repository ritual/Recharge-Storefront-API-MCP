/**
 * Shared file cache for find_addable_product's catalog read
 *
 * Behind supergateway's stateless streamableHttp mode every HTTP request is a
 * new child process, so an in-memory cache never hits. Child processes in one
 * container share its filesystem, so the catalog read for find_addable_product
 * is cached as one JSON file per (catalog endpoint, country, currency,
 * allowlist) in a private directory, for ADDABLE_CATALOG_CACHE_TTL_MS.
 *
 * Only the fields the find tool uses are stored (never descriptions). The
 * cache never throws: anything unreadable, invalid or expired is a miss, and
 * a failed write is skipped. Write-time checks (create_onetime,
 * create_subscription) never read or write it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { currencyFractionDigits } from './shopify-catalog.js';

export const ADDABLE_CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
export const CATALOG_CACHE_VERSION = 2;

const DIGITS = /^\d+$/;
// Only a short plain fs error code (EACCES, ENOENT) is ever logged
const SAFE_CODE = /^[A-Z0-9_]{1,32}$/;

export function defaultCatalogCacheDir() {
  return path.join(os.tmpdir(), 'recharge-mcp-catalog-cache');
}

/**
 * MCP_CATALOG_CACHE_DIR: a directory path; unset or blank is the default.
 */
export function parseCatalogCacheDir(raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  return value ? path.resolve(value) : defaultCatalogCacheDir();
}

function debugLog(action, error) {
  if (process.env.DEBUG === 'true') {
    const code = error && typeof error.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'error';
    console.error(`[DEBUG] Catalog cache ${action} skipped: ${code}`);
  }
}

function cacheError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Cache key: the endpoint, agent profile, country, currency and sorted
 * allowlist pairs, so a change to any of them never serves an old entry.
 */
function cacheKey({ endpoint, profileUrl, country, currency, addable }) {
  const pairs = [...addable].map(([variantId, productId]) => `${variantId}:${productId}`).sort();
  return createHash('sha256')
    .update(JSON.stringify([CATALOG_CACHE_VERSION, endpoint, profileUrl, country, currency, pairs]))
    .digest('hex');
}

/**
 * A stored price must be one a fresh lookup could produce: null (unreadable),
 * or a whole number of minor units of an ISO 4217 currency.
 */
function validPrice(unitPrice, currency) {
  if (unitPrice === null) {
    return true;
  }
  const digits = currencyFractionDigits(currency);
  if (typeof unitPrice !== 'number' || digits === null) {
    return false;
  }
  const minor = Math.round(unitPrice * 10 ** digits);
  return Number.isSafeInteger(minor) && minor >= 0 && minor / 10 ** digits === unitPrice;
}

/**
 * Catalog Map (variant ID -> record) as stored variants: only the fields the
 * find tool reads, an unreadable price (NaN) as null.
 */
function toStored(variants) {
  return [...variants].map(([variantId, variant]) => ({
    variantId,
    productId: variant.productId,
    productTitle: variant.productTitle,
    variantTitle: variant.variantTitle,
    unitPrice: Number.isFinite(variant.unitPrice) ? variant.unitPrice : null,
    currency: variant.currency,
    available: variant.available,
  }));
}

/**
 * A stored entry back as a catalog Map, or null if anything about it is off:
 * every field's type, allowlisted unique variant IDs, the country, the
 * currency (of the entry and every variant), and an age from 0 up to (not
 * including) the TTL.
 */
function fromStored(entry, { country, currency, addable, now, ttlMs }) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      entry.version !== CATALOG_CACHE_VERSION || entry.country !== country || entry.currency !== currency ||
      !Number.isSafeInteger(entry.storedAt) || entry.storedAt > now || now - entry.storedAt >= ttlMs ||
      !Array.isArray(entry.variants)) {
    return null;
  }
  const variants = new Map();
  for (const item of entry.variants) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.variantId !== 'string' || !addable.has(item.variantId) || variants.has(item.variantId) ||
        !(item.productId === null || (typeof item.productId === 'string' && DIGITS.test(item.productId))) ||
        typeof item.productTitle !== 'string' || typeof item.variantTitle !== 'string' ||
        typeof item.currency !== 'string' || item.currency !== currency || !validPrice(item.unitPrice, item.currency) ||
        typeof item.available !== 'boolean') {
      return null;
    }
    variants.set(item.variantId, {
      productId: item.productId,
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      unitPrice: item.unitPrice === null ? NaN : item.unitPrice,
      currency: item.currency,
      available: item.available,
    });
  }
  return variants;
}

export function createAddableCatalogCache({ dir = defaultCatalogCacheDir(), now = Date.now, ttlMs = ADDABLE_CATALOG_CACHE_TTL_MS } = {}) {
  const cacheDir = path.resolve(String(dir));
  // In front of the file layer: only hits within one process (local stdio use)
  const memory = new Map();

  /**
   * The directory must be a real directory owned by this user and private
   * (0700), so another local user can't plant or read entries. A directory
   * that isn't is never changed (it may be shared, like /tmp): the cache is
   * just unavailable.
   */
  async function checkDir() {
    const stats = await lstat(cacheDir);
    if (!stats.isDirectory()) {
      throw cacheError('ENOTDIR');
    }
    if (process.platform !== 'win32' &&
        ((typeof process.getuid === 'function' && stats.uid !== process.getuid()) || (stats.mode & 0o077) !== 0)) {
      throw cacheError('EPERM');
    }
  }

  async function get(scope) {
    try {
      const key = cacheKey(scope);
      const options = { country: scope.country, currency: scope.currency, addable: scope.addable, now: now(), ttlMs };
      const remembered = memory.get(key);
      if (remembered) {
        const variants = fromStored(remembered, options);
        if (variants) {
          return variants;
        }
        memory.delete(key);
      }
      let text;
      try {
        await checkDir();
        text = await readFile(path.join(cacheDir, `${key}.json`), 'utf8');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          debugLog('read', error);
        }
        return null;
      }
      let entry;
      try {
        entry = JSON.parse(text);
      } catch {
        return null;
      }
      const variants = fromStored(entry, options);
      if (variants) {
        memory.set(key, entry);
      }
      return variants;
    } catch (error) {
      debugLog('read', error);
      return null;
    }
  }

  /**
   * Best-effort: write a unique temp file in the cache directory, then rename
   * it over the entry, so a reader never sees a partial file.
   */
  async function set(scope, variants) {
    let tempPath = null;
    try {
      const key = cacheKey(scope);
      const entry = {
        version: CATALOG_CACHE_VERSION,
        storedAt: now(),
        country: scope.country,
        currency: scope.currency,
        variants: toStored(variants),
      };
      memory.set(key, entry);
      // Only a directory created here is set to 0700 (whatever the umask)
      const created = await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      if (created !== undefined && process.platform !== 'win32') {
        await chmod(cacheDir, 0o700);
      }
      await checkDir();
      tempPath = path.join(cacheDir, `${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(tempPath, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
      await rename(tempPath, path.join(cacheDir, `${key}.json`));
      tempPath = null;
    } catch (error) {
      debugLog('write', error);
      if (tempPath) {
        await unlink(tempPath).catch(() => {});
      }
    }
  }

  return { dir: cacheDir, get, set };
}
