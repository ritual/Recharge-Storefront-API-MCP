import axios from 'axios';
import { handleAPIError } from './utils/error-handler.js';
import { SessionCache } from './utils/session-cache.js';
import { DEFAULT_VERIFIED_MAX_QUANTITY } from './utils/verified-writes.js';
import { currencyFractionDigits } from './utils/shopify-catalog.js';

/**
 * Resource IDs are interpolated into endpoint paths, so reject anything that
 * could change which endpoint is called (dot segments, query, fragment, encoding)
 */
function assertSafeEndpoint(endpoint) {
  const segments = endpoint.split('/').slice(1);
  if (/[?#%\\]/.test(endpoint) || segments.some(segment => segment === '.' || segment === '..' || segment === '')) {
    throw new Error(`Invalid API endpoint path: ${endpoint}. Resource IDs must be plain identifiers.`);
  }
}

const VERIFIED_HANDOFF = 'hand off to a support agent';
const VERIFIED_INTERVAL_UNITS = ['day', 'week', 'month'];
// Subscription line properties that mark a gift or promotional line (e.g. _gwp)
const VERIFIED_GIFT_PROPERTY = /^_*(gwp|gift|free|promo)/i;
// Catalog country when a customer's addresses don't share one (or no customer is given)
const DEFAULT_CATALOG_COUNTRY = 'US';
// The store's base currency: a created record that names no currency is only trusted against this
const STORE_BASE_CURRENCY = 'USD';
// Currency each store market is priced in; a catalog price in another currency is never used
const MARKET_CURRENCY = { US: 'USD', CA: 'CAD', GB: 'GBP' };

/**
 * The catalog priced this variant in the currency of the country's market
 * (countries without a known market accept whatever the catalog returned).
 */
function marketCurrencyMatches(country, currency) {
  return !MARKET_CURRENCY[country] || MARKET_CURRENCY[country] === currency;
}

/**
 * Recharge 2021-11 returns external IDs as { ecommerce: "123" } on purchase
 * items and as plain strings on catalog records; compare them as strings.
 */
function externalId(value) {
  const id = value && typeof value === 'object' ? value.ecommerce : value;
  return id === undefined || id === null ? '' : String(id).trim();
}

function chargeDate(value) {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

/**
 * The latest calendar date anywhere (UTC+14). Added items only join charges
 * dated after it, so whatever the store's timezone, a charge due today (which
 * Recharge may be processing) is never joined.
 */
function latestTodayAnywhere(now = Date.now()) {
  return new Date(now + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Recharge sends prices as strings; missing or unreadable is NaN, never 0.
 */
function money(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return NaN;
  }
  return Number(value);
}

/**
 * A Recharge address country_code as ISO alpha-2 uppercase, or '' if unusable.
 */
function countryCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

/**
 * Lowercased whole words of a product title or query, for word matching.
 */
function titleWords(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);
}

export function verifiedWriteRefusal(message) {
  const error = new Error(message.includes(VERIFIED_HANDOFF)
    ? message
    : `${message} Do not ask the customer for account IDs or tokens; ${VERIFIED_HANDOFF}.`);
  // Marks a customer-safe refusal, so pre-write checks pass it through unchanged
  error.verifiedRefusal = true;
  return error;
}

/**
 * Recharge Storefront API Client
 * Provides complete access to all Recharge Storefront API endpoints
 * Last updated: 2024-12-24
 */
export class RechargeClient {
  constructor({
    storeUrl,
    sessionToken = null,
    adminToken = null,
    verifiedAdminWrites = false,
    verifiedMaxQuantity = DEFAULT_VERIFIED_MAX_QUANTITY,
    addableVariants = new Map(),
    catalog = null,
    catalogCache = null,
  }) {
    if (!storeUrl) {
      throw new Error('Store URL is required');
    }

    // Validate session token format if provided
    if (sessionToken) {
      const sessionValidation = this.validateSessionTokenFormat(sessionToken);
      if (!sessionValidation.isValid) {
        // Check if it looks like an admin token
        if (this.looksLikeAdminToken(sessionToken)) {
          throw new Error(
            'Configuration Error: RECHARGE_SESSION_TOKEN appears to be an admin token.\n' +
            'Admin tokens cannot be used as session tokens.\n\n' +
            'Fix: Remove RECHARGE_SESSION_TOKEN from your .env file.\n' +
            'The system will automatically create customer session tokens using your admin token when needed.\n\n' +
            `Detected pattern: ${this.getTokenPattern(sessionToken)}`
          );
        } else {
          console.warn(`[WARNING] Session token validation failed: ${sessionValidation.reason}`);
          console.warn('[WARNING] This may cause authentication issues. Consider removing RECHARGE_SESSION_TOKEN to use automatic session creation.');
        }
      }
    }

    // Validate and normalize store URL
    let domain = storeUrl;
    if (storeUrl.startsWith('http://') || storeUrl.startsWith('https://')) {
      try {
        const urlObj = new URL(storeUrl);
        domain = urlObj.hostname;
      } catch (error) {
        throw new Error(`Invalid store URL format: ${storeUrl}`);
      }
    }

    if (!domain.includes('.myshopify.com')) {
      throw new Error(`Store URL must be a Shopify domain ending with .myshopify.com: ${domain}`);
    }

    this.storeUrl = domain;
    this.sessionToken = sessionToken;
    this.adminToken = adminToken;
    this.verifiedAdminWrites = verifiedAdminWrites === true;
    this.verifiedMaxQuantity = verifiedMaxQuantity;
    // Shopify variant ID -> Shopify product ID that verified writes may add
    this.addableVariants = addableVariants instanceof Map ? addableVariants : new Map();
    // Shopify storefront catalog (src/utils/shopify-catalog.js); without it nothing can be added
    this.catalog = catalog && typeof catalog.lookupVariants === 'function' ? catalog : null;
    // Shared file cache for find_addable_product only (src/utils/catalog-cache.js); write-time checks never use it
    this.catalogCache = catalogCache && typeof catalogCache.get === 'function' && typeof catalogCache.set === 'function' ? catalogCache : null;
    this.sessionCache = new SessionCache();
    this.currentDomain = domain; // Store current domain for cache management

    // Get API URL from environment variable or use production default
    let apiUrl = 'https://api.rechargeapps.com'; // Default to production

    if (process.env.RECHARGE_API_URL) {
      const validatedUrl = this.validateApiUrl(process.env.RECHARGE_API_URL);
      if (validatedUrl) {
        apiUrl = validatedUrl;
      } else {
        throw new Error(
          `Invalid RECHARGE_API_URL specified: ${process.env.RECHARGE_API_URL}\n` +
          'API URL must use HTTPS protocol and be a valid URL format.\n' +
          'Remove RECHARGE_API_URL from .env to use production API, or fix the URL format.'
        );
      }
    }

    // Create axios instances
    this.storefrontApi = axios.create({
      baseURL: apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    this.adminApi = axios.create({
      baseURL: apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    // Add request interceptors for debugging
    if (process.env.DEBUG === 'true') {
      this.storefrontApi.interceptors.request.use(request => {
        console.error(`[DEBUG] Storefront API Request: ${request.method?.toUpperCase()} ${request.url}`);
        return request;
      });

      this.adminApi.interceptors.request.use(request => {
        console.error(`[DEBUG] Admin API Request: ${request.method?.toUpperCase()} ${request.url}`);
        return request;
      });
    }

    // Explicitly bind methods to resolve parsing issues
    this.makeRequest = this.makeRequest.bind(this);
    this.makeRequestWithRetry = this.makeRequestWithRetry.bind(this);
    this.purgeSessionCache = this.purgeSessionCache.bind(this);
  }

  /**
   * Purge session cache - useful when switching environments
   * @param {Object} options - Purge options
   * @param {boolean} options.all - Clear all sessions (default: true)
   * @param {number} options.olderThanMinutes - Clear sessions older than X minutes
   * @param {string} options.reason - Reason for purging (for logging)
   */
  purgeSessionCache(options = {}) {
    const { all = true, olderThanMinutes, reason = 'manual purge' } = options;

    if (process.env.DEBUG === 'true') {
      console.error(`[DEBUG] Purging session cache: ${reason}`);
    }

    if (all) {
      const stats = this.sessionCache.getStats();
      this.sessionCache.clearAll();

      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Purged ${stats.totalSessions} sessions and ${stats.emailMappings} email mappings`);
      }

      return {
        cleared: stats.totalSessions,
        emailMappings: stats.emailMappings,
        reason
      };
    } else if (olderThanMinutes) {
      const cleared = this.sessionCache.clearExpiredSessions(olderThanMinutes);

      return {
        cleared,
        reason: `expired sessions older than ${olderThanMinutes} minutes`
      };
    }

    return { cleared: 0, reason: 'no action taken' };
  }

  /**
   * Validate API URL to prevent security issues
   * @param {string} url - URL to validate
   * @returns {string|null} Validated URL or null if invalid
   */
  validateApiUrl(url) {
    if (!url || typeof url !== 'string') {
      return null; // This is fine - means no URL was provided
    }

    try {
      const urlObj = new URL(url);

      // Only allow HTTPS for security
      if (urlObj.protocol !== 'https:') {
        if (process.env.DEBUG === 'true') {
          console.error('[DEBUG] API URL must use HTTPS protocol:', url);
        }
        return null;
      }

      // Ensure no path manipulation
      if (urlObj.pathname !== '/' && urlObj.pathname !== '') {
        if (process.env.DEBUG === 'true') {
          console.error('[DEBUG] API URL should not contain path components:', url);
        }
        return null;
      }

      // Remove any query parameters or fragments for security
      return `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}`;

    } catch (error) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Invalid API URL format: ${url}`);
      }
      return null;
    }
  }

  /**
   * Get or create session token for customer operations
   */
  async getOrCreateSessionToken(customerId = null, customerEmail = null) {
    // Auto-purge very old sessions (older than 4 hours) to prevent stale token issues
    this.sessionCache.clearExpiredSessions(240);

    // If explicit session token provided, validate and use it
    if (this.sessionToken) {
      const validationResult = this.validateSessionToken(this.sessionToken);
      if (!validationResult.isValid) {
        throw new Error(`Invalid session token: ${validationResult.reason}`);
      }
      if (process.env.DEBUG === 'true') {
        console.error('[DEBUG] Using explicit session token');
      }
      return this.sessionToken;
    }

    // If customer identification provided, get/create customer session
    if (customerId || customerEmail) {
      let finalCustomerId = customerId;

      // Validate customer ID format if provided
      if (finalCustomerId) {
        if (typeof finalCustomerId !== 'string' && typeof finalCustomerId !== 'number') {
          throw new Error('Customer ID must be a string or number');
        }
        finalCustomerId = finalCustomerId.toString();
        if (finalCustomerId.trim() === '') {
          throw new Error('Customer ID cannot be empty');
        }
      }

      // If only email provided, look up customer ID
      if (!finalCustomerId && customerEmail) {
        // Validate email format
        if (typeof customerEmail !== 'string' || customerEmail.trim() === '') {
          throw new Error('Customer email must be a non-empty string');
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(customerEmail.trim())) {
          throw new Error(`Invalid email format: ${customerEmail}`);
        }

        finalCustomerId = this.sessionCache.getCustomerIdByEmail(customerEmail);

        if (!finalCustomerId) {
          if (process.env.DEBUG === 'true') {
            console.error(`[DEBUG] Looking up customer ID for email: ${customerEmail}`);
          }
          try {
            const customer = await this.getCustomerByEmail(customerEmail);
            finalCustomerId = customer.id.toString();
            this.sessionCache.setCustomerIdByEmail(customerEmail, finalCustomerId);
          } catch (error) {
            if (process.env.DEBUG === 'true') {
              console.error(`[DEBUG] Customer lookup failed for email ${customerEmail}:`, error.message);
            }
            throw error;
          }
        }
      }

      // Validate we have a customer ID at this point
      if (!finalCustomerId) {
        throw new Error('Unable to determine customer ID from provided information');
      }

      // Check for cached session
      const cachedToken = this.sessionCache.getSessionToken(finalCustomerId);
      if (cachedToken) {
        // Validate cached token before using
        const validationResult = this.validateSessionToken(cachedToken);
        if (validationResult.isValid) {
          if (process.env.DEBUG === 'true') {
            console.error(`[DEBUG] Using cached session for customer ${finalCustomerId}`);
          }
          return cachedToken;
        } else {
          if (process.env.DEBUG === 'true') {
            console.error(`[DEBUG] Cached session invalid (${validationResult.reason}), creating new session for customer ${finalCustomerId}`);
          }
          // Clear invalid cached session
          this.sessionCache.clearSession(finalCustomerId);
        }
      }

      // Create new session with validation
      return await this.createAndValidateSession(finalCustomerId, customerEmail);
    }

    // Security check: prevent using default session when customer sessions exist
    if (this.sessionCache.hasCustomerSessions()) {
      throw new Error(
        'Security Error: Cannot use default session token when customer-specific sessions exist. ' +
        'Please specify \'customer_id\', \'customer_email\', or \'session_token\' to ensure correct customer data access.'
      );
    }

    // No customer identification and no default session
    throw new Error(
      'No session token available. Please provide customer_id, customer_email, or session_token parameter, ' +
      'or set RECHARGE_SESSION_TOKEN environment variable.'
    );
  }

  /**
   * Create and validate a new session token
   */
  async createAndValidateSession(customerId, customerEmail = null) {
    const MAX_SESSION_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
      try {
        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] Creating new session for customer ${customerId} (attempt ${attempt}/${MAX_SESSION_ATTEMPTS})`);
        }

        const session = await this.createCustomerSessionById(customerId);
        const newToken = session.apiToken;

        // Validate the new token
        const validationResult = this.validateSessionToken(newToken);
        if (!validationResult.isValid) {
          throw new Error(`Session creation returned invalid token: ${validationResult.reason}`);
        }

        // Verify token is different from any previously cached token
        const previousToken = this.sessionCache.getSessionToken(customerId);
        if (previousToken === newToken) {
          if (process.env.DEBUG === 'true') {
            console.error(`[DEBUG] New session token identical to previous token, attempt ${attempt}`);
          }
          if (attempt < MAX_SESSION_ATTEMPTS) {
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            continue;
          } else {
            throw new Error('Session creation returned same token as expired session');
          }
        }

        // Cache the new session
        this.sessionCache.setSessionToken(customerId, newToken, customerEmail);

        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] Successfully created and cached new session for customer ${customerId}`);
        }

        return newToken;
      } catch (error) {
        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] Session creation attempt ${attempt} failed for customer ${customerId}:`, error.message);
        }

        if (attempt === MAX_SESSION_ATTEMPTS) {
          throw new Error(`Session creation failed after ${MAX_SESSION_ATTEMPTS} attempts: ${error.message}`);
        }

        // Wait before retry with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Validate session token format for initial configuration check
   */
  validateSessionTokenFormat(token) {
    if (!token || typeof token !== 'string') {
      return { isValid: false, reason: 'Token must be a non-empty string' };
    }

    const trimmedToken = token.trim();
    if (trimmedToken === '') {
      return { isValid: false, reason: 'Token cannot be empty' };
    }

    if (trimmedToken.length < 10) {
      return { isValid: false, reason: 'Token appears too short' };
    }

    const placeholders = ['your_session_token_here', 'st_example', 'test_token', 'undefined', 'null'];
    if (placeholders.includes(trimmedToken.toLowerCase())) {
      return { isValid: false, reason: 'Token appears to be a placeholder value' };
    }

    return { isValid: true, reason: null };
  }

  /**
   * Check if a token looks like an admin token rather than a session token
   */
  looksLikeAdminToken(token) {
    if (!token || typeof token !== 'string') {
      return false;
    }

    const trimmedToken = token.trim().toLowerCase();
    if (trimmedToken.startsWith('sk_')) {
      return true;
    }
    if (trimmedToken.includes('admin')) {
      return true;
    }
    if (trimmedToken.length > 100 && !trimmedToken.startsWith('st_')) {
      return true;
    }

    return false;
  }

  /**
   * Get a masked pattern representation of a token for error messages
   */
  getTokenPattern(token) {
    if (!token || typeof token !== 'string') {
      return 'invalid';
    }

    const trimmed = token.trim();
    if (trimmed.length < 4) {
      return 'too_short';
    }

    const prefix = trimmed.substring(0, 3);
    const suffix = trimmed.substring(trimmed.length - 3);
    return `${prefix}...${suffix} (${trimmed.length} chars)`;
  }

  /**
   * Validate session token format and basic properties
   */
  validateSessionToken(token) {
    if (!token) {
      return { isValid: false, reason: 'Token is null or undefined' };
    }

    if (typeof token !== 'string') {
      return { isValid: false, reason: 'Token must be a string' };
    }

    const trimmedToken = token.trim();
    if (trimmedToken === '') {
      return { isValid: false, reason: 'Token cannot be empty' };
    }

    if (trimmedToken.length < 10) {
      return { isValid: false, reason: 'Token appears too short (less than 10 characters)' };
    }

    // Check for obviously invalid tokens
    const invalidTokens = [
      'undefined',
      'null',
      'your_session_token_here',
      'st_example',
      'test_token'
    ];

    if (invalidTokens.includes(trimmedToken.toLowerCase())) {
      return { isValid: false, reason: 'Token appears to be a placeholder or test value' };
    }

    // Basic format validation - session tokens typically have specific patterns
    // This is a loose validation to catch obvious issues without being too restrictive
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(trimmedToken)) {
      return { isValid: false, reason: 'Token contains invalid characters' };
    }

    return { isValid: true, reason: null };
  }

  /**
   * Make authenticated request to Storefront API
   */
  async makeRequest(method, endpoint, data = null, params = null, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequestWithRetry(method, endpoint, data, params, customerId, customerEmail, sessionToken, 0);
  }

  async get(endpoint, customerId = null, customerEmail = null, sessionToken = null, params = null) {
    return await this.makeRequest('GET', endpoint, null, params, customerId, customerEmail, sessionToken);
  }

  async post(endpoint, data = null, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('POST', endpoint, data, null, customerId, customerEmail, sessionToken);
  }

  async put(endpoint, data = null, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('PUT', endpoint, data, null, customerId, customerEmail, sessionToken);
  }

  async delete(endpoint, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('DELETE', endpoint, null, null, customerId, customerEmail, sessionToken);
  }

  /**
   * Make authenticated request with retry logic for session expiry
   */
  async makeRequestWithRetry(method, endpoint, data = null, params = null, customerId = null, customerEmail = null, sessionToken = null, retryCount = 0) {
    const MAX_RETRIES = 2;

    // Validate method
    if (!method || typeof method !== 'string') {
      throw new Error('HTTP method is required');
    }

    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    if (!validMethods.includes(method.toUpperCase())) {
      throw new Error(`Invalid HTTP method: ${method}`);
    }

    // Validate endpoint
    if (!endpoint || typeof endpoint !== 'string') {
      throw new Error('API endpoint is required');
    }

    if (!endpoint.startsWith('/')) {
      throw new Error('API endpoint must start with /');
    }

    assertSafeEndpoint(endpoint);

    try {
      sessionToken = sessionToken || await this.getOrCreateSessionToken(customerId, customerEmail);
    } catch (error) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Failed to get session token:`, error.message);
      }
      throw error;
    }

    const config = {
      method: method.toUpperCase(),
      url: endpoint,
      headers: {
        'X-Recharge-Access-Token': sessionToken,
        'X-Recharge-Version': '2021-11',
      },
    };

    if (data) {
      config.data = data;
    }

    if (params) {
      config.params = params;
    }

    try {
      const response = await this.storefrontApi.request(config);

      if (!response || !response.data) {
        throw new Error('Invalid response from API');
      }

      return response.data;
    } catch (error) {
      // Handle session expiry - detect various expiry indicators and retry with backoff
      const isSessionExpired = this.isSessionExpiredError(error);
      const canRetry = (customerId || customerEmail) && retryCount < MAX_RETRIES;

      if (isSessionExpired && canRetry) {
        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] Session expired (attempt ${retryCount + 1}/${MAX_RETRIES + 1}), clearing cache and retrying`);
        }

        // Clear the expired session atomically
        await this.clearExpiredSession(customerId, customerEmail, sessionToken);

        // Add exponential backoff delay
        const delay = Math.min(1000 * Math.pow(2, retryCount), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));

        // Retry with incremented count
        try {
          return await this.makeRequestWithRetry(method, endpoint, data, params, customerId, customerEmail, null, retryCount + 1);
        } catch (retryError) {
          if (process.env.DEBUG === 'true') {
            console.error(`[DEBUG] Session retry ${retryCount + 1} failed:`, retryError.message);
          }

          // If this was the last retry, provide enhanced error context
          if (retryCount >= MAX_RETRIES - 1) {
            const enhancedError = new Error(
              `Session refresh failed after ${MAX_RETRIES} attempts. Original error: ${error.message}. ` +
              `Final retry error: ${retryError.message}. This may indicate admin token expiry or insufficient permissions.`
            );
            enhancedError.originalError = error;
            enhancedError.retryError = retryError;
            enhancedError.retryCount = retryCount + 1;
            throw enhancedError;
          }

          throw retryError;
        }
      }

      handleAPIError(error);
    }
  }

  /**
   * Detect if an error indicates session expiry
   */
  isSessionExpiredError(error) {
    if (!error.response) {
      return false;
    }

    const status = error.response.status;
    const data = error.response.data;

    // Check for various session expiry indicators
    if (status === 401) {
      return true; // Unauthorized - classic session expiry
    }

    if (status === 403) {
      // Forbidden - could be expired session or insufficient permissions
      // Check error message for session-related keywords
      const message = (data?.message || data?.error || '').toLowerCase();
      const sessionKeywords = ['session', 'token', 'expired', 'invalid', 'unauthorized'];
      return sessionKeywords.some(keyword => message.includes(keyword));
    }

    if (status === 422) {
      // Unprocessable Entity - sometimes used for expired tokens
      const message = (data?.message || data?.error || '').toLowerCase();
      return message.includes('token') || message.includes('session') || message.includes('expired');
    }

    return false;
  }

  /**
   * Atomically clear expired session from cache
   */
  async clearExpiredSession(customerId, customerEmail, expiredToken) {
    try {
      // Determine the customer ID if not provided
      let finalCustomerId = customerId;
      if (!finalCustomerId && customerEmail) {
        finalCustomerId = this.sessionCache.getCustomerIdByEmail(customerEmail);
      }

      if (finalCustomerId) {
        // Verify we're clearing the right session by checking token match
        const cachedToken = this.sessionCache.getSessionToken(finalCustomerId);
        if (cachedToken === expiredToken || !cachedToken) {
          this.sessionCache.clearSession(finalCustomerId);
          if (process.env.DEBUG === 'true') {
            console.error(`[DEBUG] Cleared expired session for customer ${finalCustomerId}`);
          }
        } else {
          if (process.env.DEBUG === 'true') {
            console.error(`[DEBUG] Session token mismatch - not clearing (cached token may have been updated by another request)`);
          }
        }
      }

      // Also clear email mapping if provided
      if (customerEmail) {
        const emailCustomerId = this.sessionCache.getCustomerIdByEmail(customerEmail);
        if (emailCustomerId === finalCustomerId) {
          this.sessionCache.clearSessionByEmail(customerEmail);
        }
      }

    } catch (error) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Error clearing expired session:`, error.message);
      }
      // Don't throw - session clearing failure shouldn't prevent retry
    }
  }

  /**
   * Make authenticated request to Admin API
   */
  async makeAdminRequest(method, endpoint, data = null, params = null) {
    if (!this.adminToken) {
      throw new Error(
        'Admin token required for this operation. Please provide admin_token parameter or set RECHARGE_ADMIN_TOKEN environment variable.'
      );
    }

    // Validate method
    if (!method || typeof method !== 'string') {
      throw new Error('HTTP method is required');
    }

    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    if (!validMethods.includes(method.toUpperCase())) {
      throw new Error(`Invalid HTTP method: ${method}`);
    }

    // Validate endpoint
    if (!endpoint || typeof endpoint !== 'string') {
      throw new Error('API endpoint is required');
    }

    if (!endpoint.startsWith('/')) {
      throw new Error('API endpoint must start with /');
    }

    assertSafeEndpoint(endpoint);

    const config = {
      method: method.toUpperCase(),
      url: endpoint,
      headers: {
        'X-Recharge-Access-Token': this.adminToken,
        'X-Recharge-Version': '2021-11',
      },
    };

    if (data) {
      config.data = data;
    }

    if (params) {
      config.params = params;
    }

    try {
      const response = await this.adminApi.request(config);

      if (!response || !response.data) {
        throw new Error('Invalid response from Admin API');
      }

      return response.data;
    } catch (error) {
      handleAPIError(error);
    }
  }

  // Customer Management Methods
  async getCustomer(customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/customer', null, null, customerId, customerEmail, sessionToken);
  }

  async updateCustomer(updateData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!updateData || typeof updateData !== 'object') {
      throw new Error('Update data is required');
    }
    return await this.makeRequest('PUT', '/customer', updateData, null, customerId, customerEmail, sessionToken);
  }

  async getCustomerByEmail(email) {
    if (!email || typeof email !== 'string' || email.trim() === '') {
      throw new Error('Valid email address is required for customer lookup');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      throw new Error(`Invalid email format: ${email}`);
    }

    try {
      const response = await this.makeAdminRequest('GET', '/customers', null, { email: email.trim() });

      if (!response || !response.customers || !Array.isArray(response.customers)) {
        throw new Error('Invalid response format from customer lookup API');
      }

      if (response.customers.length === 0) {
        throw new Error(`Customer not found with email: ${email}`);
      }

      // Never guess between accounts sharing an email
      if (response.customers.length > 1) {
        throw new Error(`Multiple customers found with email: ${email}. This needs to be resolved by a support agent.`);
      }

      const customer = response.customers[0];
      if (!customer || !customer.id) {
        throw new Error('Customer data is incomplete - missing ID');
      }

      return customer;
    } catch (error) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Customer lookup failed for email ${email}:`, error.message);
      }
      throw error;
    }
  }

  async createCustomerSessionById(customerId, options = {}) {
    if (!customerId) {
      throw new Error('Customer ID is required for session creation');
    }

    if (!this.adminToken) {
      throw new Error('Admin token required for session creation');
    }

    const sessionData = {
      ...options
    };

    try {
      const response = await this.makeAdminRequest('POST', `/customers/${customerId}/sessions`, sessionData);

      if (!response || !response.customer_session) {
        throw new Error('Invalid response from session creation API');
      }

      return response.customer_session;
    } catch (error) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Session creation failed for customer ${customerId}:`, error.message);
      }
      throw error;
    }
  }

  // Subscription Management Methods
  async getSubscriptions(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/subscriptions', null, params, customerId, customerEmail, sessionToken);
  }

  async getSubscription(subscriptionId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    return await this.makeRequest('GET', `/subscriptions/${subscriptionId}`, null, null, customerId, customerEmail, sessionToken);
  }

  async createSubscription(subscriptionData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionData || typeof subscriptionData !== 'object') {
      throw new Error('Subscription data is required');
    }
    return await this.makeRequest('POST', '/subscriptions', subscriptionData, null, customerId, customerEmail, sessionToken);
  }

  async updateSubscription(subscriptionId, updateData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    if (!updateData || typeof updateData !== 'object') {
      throw new Error('Update data is required');
    }
    return await this.makeRequest('PUT', `/subscriptions/${subscriptionId}`, updateData, null, customerId, customerEmail, sessionToken);
  }

  async skipSubscription(subscriptionId, date, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    if (!date) {
      throw new Error('Date is required for skipping subscription');
    }
    return await this.makeRequest('POST', `/subscriptions/${subscriptionId}/skip`, { date }, null, customerId, customerEmail, sessionToken);
  }

  async cancelSubscription(subscriptionId, cancelData = {}, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    return await this.makeRequest('POST', `/subscriptions/${subscriptionId}/cancel`, cancelData, null, customerId, customerEmail, sessionToken);
  }

  async activateSubscription(subscriptionId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    return await this.makeRequest('POST', `/subscriptions/${subscriptionId}/activate`, null, null, customerId, customerEmail, sessionToken);
  }

  async setNextChargeDate(subscriptionId, date, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    if (!date) {
      throw new Error('Date is required');
    }
    return await this.makeRequest('POST', `/subscriptions/${subscriptionId}/set_next_charge_date`, { date }, null, customerId, customerEmail, sessionToken);
  }

  // Address Management Methods
  async getAddresses(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/addresses', null, params, customerId, customerEmail, sessionToken);
  }

  async getAddress(addressId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!addressId) {
      throw new Error('Address ID is required');
    }
    return await this.makeRequest('GET', `/addresses/${addressId}`, null, null, customerId, customerEmail, sessionToken);
  }

  async createAddress(addressData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!addressData || typeof addressData !== 'object') {
      throw new Error('Address data is required');
    }
    return await this.makeRequest('POST', '/addresses', addressData, null, customerId, customerEmail, sessionToken);
  }

  async updateAddress(addressId, updateData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!addressId) {
      throw new Error('Address ID is required');
    }
    if (!updateData || typeof updateData !== 'object') {
      throw new Error('Update data is required');
    }
    return await this.makeRequest('PUT', `/addresses/${addressId}`, updateData, null, customerId, customerEmail, sessionToken);
  }

  async deleteAddress(addressId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!addressId) {
      throw new Error('Address ID is required');
    }
    return await this.makeRequest('DELETE', `/addresses/${addressId}`, null, null, customerId, customerEmail, sessionToken);
  }

  // Payment Method Management
  async getPaymentMethods(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/payment_methods', null, params, customerId, customerEmail, sessionToken);
  }

  async getPaymentMethod(paymentMethodId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!paymentMethodId) {
      throw new Error('Payment method ID is required');
    }
    return await this.makeRequest('GET', `/payment_methods/${paymentMethodId}`, null, null, customerId, customerEmail, sessionToken);
  }

  async updatePaymentMethod(paymentMethodId, updateData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!paymentMethodId) {
      throw new Error('Payment method ID is required');
    }
    if (!updateData || typeof updateData !== 'object') {
      throw new Error('Update data is required');
    }
    return await this.makeRequest('PUT', `/payment_methods/${paymentMethodId}`, updateData, null, customerId, customerEmail, sessionToken);
  }

  // Product Catalog Methods
  async getProducts(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/products', null, params, customerId, customerEmail, sessionToken);
  }

  async getProduct(productId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!productId) {
      throw new Error('Product ID is required');
    }
    return await this.makeRequest('GET', `/products/${productId}`, null, null, customerId, customerEmail, sessionToken);
  }

  // Order Management Methods
  async getOrders(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/orders', null, params, customerId, customerEmail, sessionToken);
  }

  async getOrder(orderId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!orderId) {
      throw new Error('Order ID is required');
    }
    return await this.makeRequest('GET', `/orders/${orderId}`, null, null, customerId, customerEmail, sessionToken);
  }

  async delayOrder(orderId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!orderId) {
      throw new Error('Order ID is required');
    }
    return await this.makeRequest('POST', `/orders/${orderId}/delay`, null, null, customerId, customerEmail, sessionToken);
  }

  // Charge Management Methods
  async getCharges(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/charges', null, params, customerId, customerEmail, sessionToken);
  }

  async getCharge(chargeId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!chargeId) {
      throw new Error('Charge ID is required');
    }
    return await this.makeRequest('GET', `/charges/${chargeId}`, null, null, customerId, customerEmail, sessionToken);
  }

  // One-time Product Methods
  async getOnetimes(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/onetimes', null, params, customerId, customerEmail, sessionToken);
  }

  async getOnetime(onetimeId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!onetimeId) {
      throw new Error('One-time ID is required');
    }
    return await this.makeRequest('GET', `/onetimes/${onetimeId}`, null, null, customerId, customerEmail, sessionToken);
  }

  async createOnetime(onetimeData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!onetimeData || typeof onetimeData !== 'object') {
      throw new Error('One-time data is required');
    }
    return await this.makeRequest('POST', '/onetimes', onetimeData, null, customerId, customerEmail, sessionToken);
  }

  async updateOnetime(onetimeId, updateData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!onetimeId) {
      throw new Error('One-time ID is required');
    }
    if (!updateData || typeof updateData !== 'object') {
      throw new Error('Update data is required');
    }
    return await this.makeRequest('PUT', `/onetimes/${onetimeId}`, updateData, null, customerId, customerEmail, sessionToken);
  }

  async deleteOnetime(onetimeId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!onetimeId) {
      throw new Error('One-time ID is required');
    }
    return await this.makeRequest('DELETE', `/onetimes/${onetimeId}`, null, null, customerId, customerEmail, sessionToken);
  }

  // Bundle Management Methods
  async getBundles(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/bundles', null, params, customerId, customerEmail, sessionToken);
  }

  async getBundle(bundleId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!bundleId) {
      throw new Error('Bundle ID is required');
    }
    return await this.makeRequest('GET', `/bundles/${bundleId}`, null, null, customerId, customerEmail, sessionToken);
  }

  async getBundleSelections(bundleId, params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    if (!bundleId) {
      throw new Error('Bundle ID is required');
    }
    return await this.makeRequest('GET', `/bundles/${bundleId}/bundle_selections`, null, params, customerId, customerEmail, sessionToken);
  }

  async getBundleSelection(bundleSelectionId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!bundleSelectionId) {
      throw new Error('Bundle selection ID is required');
    }
    return await this.makeRequest('GET', `/bundle_selections/${bundleSelectionId}`, null, null, customerId, customerEmail, sessionToken);
  }

  async createBundleSelection(selectionData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!selectionData || typeof selectionData !== 'object') {
      throw new Error('Bundle selection data is required');
    }
    return await this.makeRequest('POST', '/bundle_selections', selectionData, null, customerId, customerEmail, sessionToken);
  }

  async updateBundleSelection(bundleSelectionId, updateData, customerId = null, customerEmail = null, sessionToken = null) {
    if (!bundleSelectionId) {
      throw new Error('Bundle selection ID is required');
    }
    if (!updateData || typeof updateData !== 'object') {
      throw new Error('Update data is required');
    }
    return await this.makeRequest('PUT', `/bundle_selections/${bundleSelectionId}`, updateData, null, customerId, customerEmail, sessionToken);
  }

  async deleteBundleSelection(bundleSelectionId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!bundleSelectionId) {
      throw new Error('Bundle selection ID is required');
    }
    return await this.makeRequest('DELETE', `/bundle_selections/${bundleSelectionId}`, null, null, customerId, customerEmail, sessionToken);
  }

  // NOTE: Direct discount endpoints (/discounts, /discounts/{id}) do not exist in the Storefront API.
  // Discounts are managed via address-specific and charge-specific endpoints:
  // - POST /addresses/{id}/apply_discount (used by apply_discount_to_address tool)
  // - POST /addresses/{id}/remove_discount (used by remove_discount_from_address tool)
  // - POST /charges/{id}/apply_discount (used by apply_discount_to_charge tool)
  // - POST /charges/{id}/remove_discount (used by remove_discount_from_charge tool)

  // Plan Management Methods
  async listPlans(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/plans', null, params, customerId, customerEmail, sessionToken);
  }

  async getPlan(planId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!planId) {
      throw new Error('Plan ID is required');
    }
    return await this.makeRequest('GET', `/plans/${planId}`, null, null, customerId, customerEmail, sessionToken);
  }

  // Product Search Method
  async productSearch(query, params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      throw new Error('Search query is required');
    }
    const searchParams = { query: query.trim(), ...params };
    return await this.makeRequest('GET', '/products/search', null, searchParams, customerId, customerEmail, sessionToken);
  }

  // Customer Delivery Schedule Method 
  async getDeliverySchedule(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/customers/delivery_schedule', null, params, customerId, customerEmail, sessionToken);
  }

  // Missing Subscription Methods - Bulk Operations
  async skipGiftSubscriptionCharge(subscriptionIds, data = {}, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionIds || !Array.isArray(subscriptionIds) || subscriptionIds.length === 0) {
      throw new Error('Subscription IDs array is required');
    }
    return await this.makeRequest('POST', '/subscriptions/skip_gift', { subscription_ids: subscriptionIds, ...data }, null, customerId, customerEmail, sessionToken);
  }

  async createSubscriptions(subscriptions = [], options = {}, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptions || !Array.isArray(subscriptions) || subscriptions.length === 0) {
      throw new Error('Subscriptions array is required');
    }
    return await this.makeRequest('POST', '/subscriptions/bulk', { subscriptions, ...options }, null, customerId, customerEmail, sessionToken);
  }

  async updateSubscriptions(addressId, subscriptions = [], options = {}, customerId = null, customerEmail = null, sessionToken = null) {
    if (!addressId) {
      throw new Error('Address ID is required');
    }
    if (!subscriptions || !Array.isArray(subscriptions) || subscriptions.length === 0) {
      throw new Error('Subscriptions array is required');
    }
    if (subscriptions.length > 20) {
      throw new Error('Maximum 20 subscriptions can be updated at once');
    }
    return await this.makeRequest('PUT', `/addresses/${addressId}/subscriptions/bulk`, { subscriptions, ...options }, null, customerId, customerEmail, sessionToken);
  }

  // Collection Methods
  async listCollections(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/collections', null, params, customerId, customerEmail, sessionToken);
  }

  async getCollection(collectionId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!collectionId) {
      throw new Error('Collection ID is required');
    }
    return await this.makeRequest('GET', `/collections/${collectionId}`, null, null, customerId, customerEmail, sessionToken);
  }

  async listCollectionProducts(collectionId, params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    if (!collectionId) {
      throw new Error('Collection ID is required');
    }
    return await this.makeRequest('GET', `/collections/${collectionId}/products`, null, params, customerId, customerEmail, sessionToken);
  }

  // Credit Methods
  async getCreditSummary(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/credits/summary', null, params, customerId, customerEmail, sessionToken);
  }

  async setApplyCreditsToNextCharge(data, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('POST', '/credits/apply_to_next_charge', data, null, customerId, customerEmail, sessionToken);
  }

  async listCreditAccounts(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/credit_accounts', null, params, customerId, customerEmail, sessionToken);
  }

  // Gift Methods
  async listGiftPurchases(customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/gift_purchases', null, null, customerId, customerEmail, sessionToken);
  }

  async getGiftPurchase(giftId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!giftId) {
      throw new Error('Gift ID is required');
    }
    return await this.makeRequest('GET', `/gift_purchases/${giftId}`, null, null, customerId, customerEmail, sessionToken);
  }

  // Metafield Methods
  async createMetafield(data, customerId = null, customerEmail = null, sessionToken = null) {
    if (!data.key || !data.namespace || !data.owner_id || !data.owner_resource) {
      throw new Error('Key, namespace, owner_id, and owner_resource are required');
    }
    return await this.makeRequest('POST', '/metafields', data, null, customerId, customerEmail, sessionToken);
  }

  async updateMetafield(metafieldId, data, customerId = null, customerEmail = null, sessionToken = null) {
    if (!metafieldId) {
      throw new Error('Metafield ID is required');
    }
    return await this.makeRequest('PUT', `/metafields/${metafieldId}`, data, null, customerId, customerEmail, sessionToken);
  }

  async deleteMetafield(metafieldId, customerId = null, customerEmail = null, sessionToken = null) {
    if (!metafieldId) {
      throw new Error('Metafield ID is required');
    }
    return await this.makeRequest('DELETE', `/metafields/${metafieldId}`, null, null, customerId, customerEmail, sessionToken);
  }

  // Customer Portal Access Methods
  async getCustomerPortalAccess(params = {}, customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/customers/portal_access', null, params, customerId, customerEmail, sessionToken);
  }

  async getActiveChurnLandingPageURL(subscriptionId, redirectUrl, customerId = null, customerEmail = null, sessionToken = null) {
    if (!subscriptionId || !redirectUrl) {
      throw new Error('Subscription ID and redirect URL are required');
    }
    return await this.makeRequest('GET', `/customers/churn_landing_page/${subscriptionId}`, null, { redirect_url: redirectUrl }, customerId, customerEmail, sessionToken);
  }

  async getFailedPaymentMethodRecoveryLandingPageURL(customerId = null, customerEmail = null, sessionToken = null) {
    return await this.makeRequest('GET', '/customers/payment_recovery_landing_page', null, null, customerId, customerEmail, sessionToken);
  }

  async getGiftRedemptionLandingPageURL(giftId, redirectUrl, customerId = null, customerEmail = null, sessionToken = null) {
    if (!giftId || !redirectUrl) {
      throw new Error('Gift ID and redirect URL are required');
    }
    return await this.makeRequest('GET', `/customers/gift_redemption_landing_page/${giftId}`, null, { redirect_url: redirectUrl }, customerId, customerEmail, sessionToken);
  }

  async sendCustomerNotification(notificationType, options = {}, customerId = null, customerEmail = null, sessionToken = null) {
    if (!notificationType) {
      throw new Error('Notification type is required');
    }
    return await this.makeRequest('POST', '/customers/notifications', { notification_type: notificationType, ...options }, null, customerId, customerEmail, sessionToken);
  }

  // Verified Admin Writes
  //
  // Email-minted storefront sessions can read but not write (Recharge returns
  // 403 "insufficient permissions (scopes)"). These methods instead resolve the
  // customer from the verified email, load the target resource with the admin
  // token, check it belongs to that customer, and only then write with the
  // admin token. Caller-supplied tokens and customer IDs are never used.

  /**
   * Resolve the customer ID for a verified email, refusing missing, unknown
   * or ambiguous emails. Always a fresh lookup (no cache) before a write.
   */
  async resolveVerifiedCustomerId(customerEmail) {
    if (!customerEmail || typeof customerEmail !== 'string' || customerEmail.trim() === '') {
      throw verifiedWriteRefusal('This customer could not be identified because no verified email was provided, so no change was made.');
    }

    let customer;
    try {
      customer = await this.getCustomerByEmail(customerEmail);
    } catch (error) {
      if (/Customer not found with email|Multiple customers found with email|Invalid email format/.test(error.message || '')) {
        const message = error.message.endsWith('.') ? error.message : `${error.message}.`;
        throw verifiedWriteRefusal(`${message} No change was made.`);
      }
      throw error;
    }

    return String(customer.id);
  }

  /**
   * Resource IDs used by verified writes must be plain digits, so the record
   * checked for ownership and the record written are always the same one.
   */
  assertVerifiedId(id, label, listTool) {
    if (!/^\d+$/.test(String(id ?? ''))) {
      throw verifiedWriteRefusal(
        `${label} ID "${id}" is not a valid ID (IDs are digits only), so nothing was changed. ` +
        `Use ${listTool} to find the right ID; if the one they mean is not listed, ${VERIFIED_HANDOFF}.`
      );
    }
    return String(id);
  }

  /**
   * Load a resource with the admin token and confirm it is the requested
   * record and belongs to the customer. Not-found and owned-by-someone-else
   * get the same message so other customers' IDs can't be probed.
   */
  async getVerifiedOwnedResource(collection, id, key, customerId, label, listTool) {
    const refusal = verifiedWriteRefusal(
      `${label} ${id} was not found on this customer's account, so it was not changed. ` +
      `Use ${listTool} to see this customer's records; if the one they mean is not listed, ${VERIFIED_HANDOFF}.`
    );
    const endpoint = `/${collection}/${id}`;

    let response;
    try {
      response = await this.makeAdminRequest('GET', endpoint);
    } catch (error) {
      if (error.statusCode === 404) {
        throw refusal;
      }
      throw error;
    }

    const record = response && response[key];
    const ownerId = record ? (record.customer_id ?? record.customer?.id) : undefined;
    if (!record || String(record.id) !== String(id) ||
        ownerId === undefined || ownerId === null || String(ownerId) !== String(customerId)) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Verified write refused: ${endpoint} is not owned by customer ${customerId}`);
      }
      throw refusal;
    }

    return record;
  }

  async verifiedSetNextChargeDate(subscriptionId, date, customerEmail) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    if (!date) {
      throw new Error('Date is required');
    }
    const id = this.assertVerifiedId(subscriptionId, 'Subscription', 'get_subscriptions');
    const customerId = await this.resolveVerifiedCustomerId(customerEmail);
    const subscription = await this.getVerifiedOwnedResource('subscriptions', id, 'subscription', customerId, 'Subscription', 'get_subscriptions');
    return await this.makeAdminRequest('POST', `/subscriptions/${subscription.id}/set_next_charge_date`, { date });
  }

  async verifiedSkipSubscription(subscriptionId, date, customerEmail) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    if (!date) {
      throw new Error('Date is required for skipping subscription');
    }
    const id = this.assertVerifiedId(subscriptionId, 'Subscription', 'get_subscriptions');
    const customerId = await this.resolveVerifiedCustomerId(customerEmail);
    const subscription = await this.getVerifiedOwnedResource('subscriptions', id, 'subscription', customerId, 'Subscription', 'get_subscriptions');
    if (!subscription.address_id) {
      throw verifiedWriteRefusal(`Subscription ${id} has no address, so it could not be skipped.`);
    }
    // The Admin API has no per-subscription skip; skip the subscription's charge on that date via its address
    return await this.makeAdminRequest('POST', `/addresses/${subscription.address_id}/charges/skip`, {
      date,
      // The verified record's own ID, never the raw input
      subscription_ids: [subscription.id],
    });
  }

  async verifiedUpdateAddress(addressId, updateData, customerEmail) {
    if (!addressId) {
      throw new Error('Address ID is required');
    }
    if (!updateData || typeof updateData !== 'object') {
      throw new Error('Update data is required');
    }
    const id = this.assertVerifiedId(addressId, 'Address', 'get_addresses');
    const customerId = await this.resolveVerifiedCustomerId(customerEmail);
    const address = await this.getVerifiedOwnedResource('addresses', id, 'address', customerId, 'Address', 'get_addresses');
    return await this.makeAdminRequest('PUT', `/addresses/${address.id}`, updateData);
  }

  async verifiedSkipCharge(chargeId, purchaseItemIds, customerEmail) {
    if (!chargeId) {
      throw new Error('Charge ID is required');
    }
    if (!Array.isArray(purchaseItemIds) || purchaseItemIds.length === 0) {
      throw new Error('Purchase item IDs are required');
    }
    const id = this.assertVerifiedId(chargeId, 'Charge', 'get_charges');
    const customerId = await this.resolveVerifiedCustomerId(customerEmail);
    const charge = await this.getVerifiedOwnedResource('charges', id, 'charge', customerId, 'Charge', 'get_charges');

    // Only skip items that are actually on this (verified) charge, sending the charge's own item IDs
    const chargeItems = new Map((charge.line_items || []).map(item => [String(item.purchase_item_id), item.purchase_item_id]));
    const foreign = purchaseItemIds.filter(itemId => !chargeItems.has(String(itemId)));
    if (foreign.length > 0) {
      throw verifiedWriteRefusal(
        `Charge ${id} does not include purchase item(s) ${foreign.join(', ')}, so it was not skipped. ` +
        `Use get_charge to see the purchase_item_id of each line item; if the item they mean is not on it, ${VERIFIED_HANDOFF}.`
      );
    }

    return await this.makeAdminRequest('POST', `/charges/${charge.id}/skip`, {
      purchase_item_ids: purchaseItemIds.map(itemId => chargeItems.get(String(itemId))),
    });
  }

  /**
   * Quantities set or added by verified writes must be whole numbers from 1
   * to the configured cap (MCP_VERIFIED_MAX_QUANTITY).
   */
  assertVerifiedQuantity(quantity) {
    const max = this.verifiedMaxQuantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
      throw verifiedWriteRefusal(
        `Quantity must be a whole number from 1 to ${max} here, so no change was made. ` +
        `If the customer wants a different quantity, ${VERIFIED_HANDOFF}.`
      );
    }
    return quantity;
  }

  /**
   * Run the reads that come before a verified write. Refusals pass through;
   * any other failure (missing scope, rate limit, 5xx, an unexpected 4xx)
   * becomes a refusal saying nothing was changed, so raw API errors never
   * reach the assistant. Nothing has been written at this point.
   */
  async verifiedPreWriteChecks(checks) {
    try {
      return await checks();
    } catch (error) {
      if (error && error.verifiedRefusal) {
        throw error;
      }
      if (process.env.DEBUG === 'true') {
        const code = error && error.code ? ` (${error.code})` : '';
        console.error(`[DEBUG] Verified pre-write check failed with status ${(error && error.statusCode) ?? 'unknown'}${code}`);
      }
      throw verifiedWriteRefusal('This could not be checked right now, so nothing was changed.');
    }
  }

  /**
   * Load an address the customer owns that still ships something. 2021-11
   * addresses have no status, so "active" means at least one active
   * subscription on it; those subscriptions are returned for later checks.
   */
  async getVerifiedActiveAddress(addressId, customerId) {
    const address = await this.getVerifiedOwnedResource('addresses', addressId, 'address', customerId, 'Address', 'get_addresses');
    const activeSubscriptions = await this.getVerifiedActiveSubscriptions(address.id, customerId);
    if (activeSubscriptions.length === 0) {
      throw verifiedWriteRefusal(
        `Address ${addressId} has no active subscription, so nothing can be added to it here and nothing was added.`
      );
    }
    return { address, activeSubscriptions };
  }

  /**
   * Active subscriptions on an address, keeping only records that belong to
   * the customer whatever the list call returns.
   */
  async getVerifiedActiveSubscriptions(addressId, customerId) {
    const response = await this.makeAdminRequest('GET', '/subscriptions', null, {
      address_id: addressId,
      status: 'active',
      limit: 250,
    });
    return ((response && response.subscriptions) || []).filter(subscription =>
      String(subscription.customer_id) === String(customerId) &&
      String(subscription.address_id) === String(addressId) &&
      String(subscription.status || '').toLowerCase() === 'active'
    );
  }

  /**
   * Live one-time items on an address the customer owns. Filtered here by
   * address only (no external_variant_id query filter, which is not
   * confirmed for 2021-11); customer_id is checked only when Recharge sends
   * it. More than one page fails closed rather than missing an item.
   */
  async getVerifiedOnetimes(addressId, customerId) {
    const response = await this.makeAdminRequest('GET', '/onetimes', null, {
      address_id: addressId,
      limit: 250,
    });
    const onetimes = (response && response.onetimes) || [];
    if ((response && response.next_cursor) || onetimes.length >= 250) {
      throw verifiedWriteRefusal('There are too many one-time items on this address to check, so nothing was changed.');
    }
    return onetimes.filter(onetime =>
      String(onetime.address_id) === String(addressId) &&
      (onetime.customer_id === undefined || onetime.customer_id === null || String(onetime.customer_id) === String(customerId)) &&
      !onetime.cancelled_at &&
      String(onetime.status || '').toLowerCase() !== 'cancelled'
    );
  }

  /**
   * The quantity cap applies per order, not per call: units of the variant
   * already due on that date (active subscriptions and one-time items) plus
   * the new quantity must stay within it.
   */
  assertVerifiedOrderUnits({ variantId, date, quantity, subscriptions, onetimes, excludeSubscriptionId = null }) {
    const due = item => externalId(item.external_variant_id) === variantId &&
      chargeDate(item.next_charge_scheduled_at) === date;
    const existing =
      subscriptions
        .filter(subscription => due(subscription) && String(subscription.id) !== String(excludeSubscriptionId))
        .reduce((sum, subscription) => sum + (Number(subscription.quantity) || 0), 0) +
      onetimes.filter(due).reduce((sum, onetime) => sum + (Number(onetime.quantity) || 0), 0);
    const max = this.verifiedMaxQuantity;
    if (existing + quantity > max) {
      throw verifiedWriteRefusal(
        `The ${date} order already has ${existing} of that product, and no more than ${max} in one order can be set here, so no change was made. ` +
        `If the customer wants more, ${VERIFIED_HANDOFF}.`
      );
    }
  }

  /**
   * Upcoming queued charge dates on an address. Added items always join one
   * of these. Only charges dated after today everywhere (UTC+14) count, so a
   * charge Recharge may already be processing in the store's timezone is
   * never joined.
   */
  async getVerifiedQueuedChargeDates(addressId, customerId) {
    const response = await this.makeAdminRequest('GET', '/charges', null, {
      address_id: addressId,
      status: 'queued',
      sort_by: 'scheduled_at-asc',
      limit: 250,
    });
    const after = latestTodayAnywhere();
    const queuedDates = [...new Set(((response && response.charges) || [])
      .filter(charge =>
        String(charge.customer?.id ?? charge.customer_id) === String(customerId) &&
        String(charge.address_id) === String(addressId) &&
        String(charge.status || '').toLowerCase() === 'queued' &&
        chargeDate(charge.scheduled_at) > after
      )
      .map(charge => chargeDate(charge.scheduled_at)))]
      .sort();

    if (queuedDates.length === 0) {
      throw verifiedWriteRefusal(
        `There is no upcoming order on address ${addressId} that can still be added to, so nothing was added.`
      );
    }
    return queuedDates;
  }

  /**
   * The requested date must be the date of one of this customer's upcoming
   * queued charges on the address. Returns that charge's own date (YYYY-MM-DD).
   */
  async getVerifiedQueuedChargeDate(addressId, customerId, date) {
    const queuedDates = await this.getVerifiedQueuedChargeDates(addressId, customerId);
    const requested = chargeDate(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested) || !queuedDates.includes(requested)) {
      throw verifiedWriteRefusal(
        `${date || 'The requested date'} is not the date of an upcoming order on this address that can still be added to, so nothing was added. ` +
        `Upcoming order dates: ${queuedDates.join(', ')}. Ask the customer which of these orders they mean; ` +
        `if it is none of them, ${VERIFIED_HANDOFF}.`
      );
    }

    return queuedDates.find(queued => queued === requested);
  }

  /**
   * Active subscription plans for a catalog product that cover the variant.
   * Recharge needs at least one before the product can be subscribed to.
   */
  async getVerifiedSubscriptionPlans(productId, variantId) {
    const response = await this.makeAdminRequest('GET', '/plans', null, {
      external_product_id: productId,
      type: 'subscription',
    });
    return ((response && response.plans) || []).filter(plan =>
      String(plan.type || '').toLowerCase() === 'subscription' &&
      (plan.deleted_at === null || plan.deleted_at === undefined) &&
      (plan.external_product_id === undefined || externalId(plan.external_product_id) === productId) &&
      (!plan.has_variant_restrictions ||
        (Array.isArray(plan.external_variant_ids) && plan.external_variant_ids.map(externalId).includes(variantId)))
    );
  }

  /**
   * Load an allowlisted variant from the Shopify storefront catalog, priced
   * for the address's country. Always a fresh read (never cached). Not
   * configured, not allowlisted, no country, missing, another product,
   * unavailable, unpriced and not-subscribable all get the same refusal.
   * Everything returned comes from the catalog record, never the caller.
   */
  async getVerifiedAddableVariant(variantId, planType, addressCountry) {
    const refusal = verifiedWriteRefusal(
      `That product can't be added here, so nothing was added. ` +
      `Use find_addable_product to look up the product the customer named; if it is not found, ${VERIFIED_HANDOFF}.`
    );
    const requested = String(variantId ?? '').trim();
    const productId = this.addableVariants.get(requested);
    if (!productId || !this.catalog) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Verified add refused: variant ${requested} is not addable${this.catalog ? '' : ' (no catalog configured)'}`);
      }
      throw refusal;
    }
    const country = countryCode(addressCountry);
    if (!country) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Verified add refused: the address has no usable country_code`);
      }
      throw refusal;
    }

    // A catalog failure propagates, so the pre-write checks refuse with "could not be checked"
    const variant = (await this.catalog.lookupVariants([requested], country)).get(requested);
    if (!variant || variant.productId !== productId || variant.available !== true ||
        !marketCurrencyMatches(country, variant.currency)) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Verified add refused: variant ${requested} is not sellable in product ${productId} for ${country}`);
      }
      throw refusal;
    }

    // A zero, missing or unreadable catalog price is never added (sample, gift or sync gap)
    const unitPrice = variant.unitPrice;
    if (!(unitPrice > 0)) {
      if (process.env.DEBUG === 'true') {
        console.error(`[DEBUG] Verified add refused: variant ${requested} has no positive catalog price`);
      }
      throw refusal;
    }

    let plans = [];
    if (planType === 'subscription') {
      plans = await this.getVerifiedSubscriptionPlans(productId, requested);
      if (plans.length === 0) {
        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] Verified add refused: variant ${requested} has no subscription plan`);
        }
        throw refusal;
      }
    }

    return {
      productId,
      variantId: requested,
      title: variant.productTitle,
      variantTitle: variant.variantTitle,
      unitPrice,
      currency: variant.currency,
      plans,
    };
  }

  /**
   * Wrap an error from the write call itself. A 4xx means Recharge rejected
   * the change; anything else (5xx, timeout, network) means the outcome is
   * unknown, so the assistant must not retry and risk a duplicate.
   */
  verifiedWriteFailure(error) {
    const status = error && error.statusCode;
    if (process.env.DEBUG === 'true') {
      // Recharge's validation message names fields, not people; strip anything email-shaped anyway
      const reason = String((error && error.message) || '').replace(/[^\s@"']+@[^\s@"']+/g, '<email>').slice(0, 300);
      console.error(`[DEBUG] Verified write failed with status ${status ?? 'unknown'}: ${reason}`);
    }
    if (status >= 400 && status < 500) {
      return verifiedWriteRefusal('Recharge did not accept this change, so nothing was changed.');
    }
    return verifiedWriteRefusal(
      `The change could not be confirmed, so it may or may not have been made. Do not retry; ${VERIFIED_HANDOFF} to check the account.`
    );
  }

  async verifiedAdminWrite(method, endpoint, data, params = null) {
    try {
      return await this.makeAdminRequest(method, endpoint, data, params);
    } catch (error) {
      throw this.verifiedWriteFailure(error);
    }
  }

  /**
   * After an add, the price Recharge set must be positive and no more than
   * the catalog list price the customer was told, and in the catalog's
   * currency (compare-at prices are never used). A record that names no
   * currency is only trusted when the catalog price is in the store's base
   * currency, since its price can't be compared with another currency.
   * Otherwise the record just created is deleted again and the add is
   * refused; if that delete fails, the assistant is told the outcome is
   * unknown. Only IDs are logged.
   */
  async verifiedCheckCreatedPrice(collection, key, response, addressId, catalogPrice, catalogCurrency) {
    const record = response && response[key];
    const price = money(record && record.price);
    const recordCurrency = record ? String(record.presentment_currency || record.currency || '').trim().toUpperCase() : '';
    const expectedCurrency = String(catalogCurrency || '').toUpperCase();
    const sameCurrency = recordCurrency === '' ? expectedCurrency === STORE_BASE_CURRENCY : recordCurrency === expectedCurrency;
    if (price > 0 && price <= catalogPrice + 0.005 && sameCurrency) {
      return response;
    }

    const id = record && record.id;
    if (process.env.DEBUG === 'true') {
      console.error(`[DEBUG] Verified add on ${collection} ${id ?? 'unknown'} was priced outside the catalog price or currency; removing it`);
    }
    let removed = false;
    if (record && /^\d+$/.test(String(id ?? '')) && String(record.address_id) === String(addressId)) {
      try {
        await this.makeAdminRequest('DELETE', `/${collection}/${id}`);
        removed = true;
      } catch (error) {
        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] Removing ${collection} ${id} failed with status ${error.statusCode ?? 'unknown'}`);
        }
      }
    }
    if (removed) {
      throw verifiedWriteRefusal(
        'Recharge priced this item differently from the catalog, so it was removed again and nothing was added.'
      );
    }
    throw verifiedWriteRefusal(
      `The item may have been added at a price that could not be confirmed. Do not retry; ${VERIFIED_HANDOFF} to check the order.`
    );
  }

  async verifiedUpdateSubscriptionQuantity(subscriptionId, quantity, customerEmail) {
    if (!subscriptionId) {
      throw new Error('Subscription ID is required');
    }
    const id = this.assertVerifiedId(subscriptionId, 'Subscription', 'get_subscriptions');
    this.assertVerifiedQuantity(quantity);

    const { customerId, record } = await this.verifiedPreWriteChecks(async () => {
      const customerId = await this.resolveVerifiedCustomerId(customerEmail);
      const owned = await this.getVerifiedOwnedResource('subscriptions', id, 'subscription', customerId, 'Subscription', 'get_subscriptions');

      const status = String(owned.status || '').toLowerCase();
      if (status !== 'active') {
        throw verifiedWriteRefusal(`Subscription ${id} is ${status || 'not active'}, so its quantity can't be changed here and nothing was changed.`);
      }
      if (owned.is_prepaid) {
        throw verifiedWriteRefusal(`Subscription ${id} is prepaid, so its quantity can't be changed here and nothing was changed.`);
      }
      // Free, gift and promotional lines (zero or missing price, or a gift property such as _gwp) are never multiplied
      const giftLine = Array.isArray(owned.properties) &&
        owned.properties.some(property => VERIFIED_GIFT_PROPERTY.test(String((property && (property.name ?? property.key)) || '')));
      if (!(money(owned.price) > 0) || giftLine) {
        throw verifiedWriteRefusal(`Subscription ${id} is a gift or has a special price, so its quantity can't be changed here and nothing was changed.`);
      }

      // Raising the quantity must keep that product within the cap on the next order
      const nextDate = chargeDate(owned.next_charge_scheduled_at);
      if (quantity > Number(owned.quantity) && nextDate && owned.address_id) {
        this.assertVerifiedOrderUnits({
          variantId: externalId(owned.external_variant_id),
          date: nextDate,
          quantity,
          subscriptions: await this.getVerifiedActiveSubscriptions(owned.address_id, customerId),
          onetimes: await this.getVerifiedOnetimes(owned.address_id, customerId),
          excludeSubscriptionId: owned.id,
        });
      }
      return { customerId, record: owned };
    });

    if (Number(record.quantity) === quantity) {
      return {
        subscription: record,
        previous_quantity: record.quantity,
        result: `The quantity is already ${quantity}, so no change was made.`,
      };
    }

    // No force_update, so Recharge itself only updates an active subscription;
    // commit=true regenerates the queued charge before responding
    const response = await this.verifiedAdminWrite('PUT', `/subscriptions/${record.id}`, { quantity }, { commit: true });
    if (process.env.DEBUG === 'true') {
      console.error(`[DEBUG] Verified quantity change on subscription ${record.id} for customer ${customerId}`);
    }
    return { ...response, previous_quantity: record.quantity };
  }

  async verifiedCreateOnetime({ addressId, variantId, quantity, date }, customerEmail) {
    if (addressId === undefined || addressId === null || addressId === '') {
      throw verifiedWriteRefusal(
        `An address_id is needed to add an item to an upcoming order, so nothing was added. ` +
        `Use get_addresses to find it; if the customer has more than one, ask which one.`
      );
    }
    const id = this.assertVerifiedId(addressId, 'Address', 'get_addresses');
    const requestedVariant = this.assertVerifiedId(variantId, 'Product variant', 'find_addable_product');
    this.assertVerifiedQuantity(quantity);

    const { customerId, address, scheduledAt, variant } = await this.verifiedPreWriteChecks(async () => {
      const customerId = await this.resolveVerifiedCustomerId(customerEmail);
      const { address, activeSubscriptions } = await this.getVerifiedActiveAddress(id, customerId);
      const scheduledAt = await this.getVerifiedQueuedChargeDate(address.id, customerId, date);
      const variant = await this.getVerifiedAddableVariant(requestedVariant, 'onetime', address.country_code);

      const onetimes = await this.getVerifiedOnetimes(address.id, customerId);
      if (onetimes.some(onetime =>
        externalId(onetime.external_variant_id) === variant.variantId &&
        chargeDate(onetime.next_charge_scheduled_at) === scheduledAt)) {
        throw verifiedWriteRefusal(`That product is already on the ${scheduledAt} order, so nothing was added.`);
      }
      this.assertVerifiedOrderUnits({
        variantId: variant.variantId,
        date: scheduledAt,
        quantity,
        subscriptions: activeSubscriptions,
        onetimes,
      });
      return { customerId, address, scheduledAt, variant };
    });

    // Recharge prices the item from the catalog: never send price, properties or titles.
    // There is no lock between the checks above and this write (see README).
    const response = await this.verifiedAdminWrite('POST', '/onetimes', {
      address_id: address.id,
      external_product_id: { ecommerce: variant.productId },
      external_variant_id: { ecommerce: variant.variantId },
      quantity,
      next_charge_scheduled_at: scheduledAt,
    });
    if (process.env.DEBUG === 'true') {
      console.error(`[DEBUG] Verified one-time add of variant ${variant.variantId} on address ${address.id} for customer ${customerId}`);
    }
    return await this.verifiedCheckCreatedPrice('onetimes', 'onetime', response, address.id, variant.unitPrice, variant.currency);
  }

  async verifiedCreateSubscription({ addressId, variantId, quantity, date, orderIntervalFrequency, orderIntervalUnit }, customerEmail) {
    if (addressId === undefined || addressId === null || addressId === '') {
      throw verifiedWriteRefusal(
        `An address_id is needed to add a subscription, so nothing was added. ` +
        `Use get_addresses to find it; if the customer has more than one, ask which one.`
      );
    }
    const id = this.assertVerifiedId(addressId, 'Address', 'get_addresses');
    const requestedVariant = this.assertVerifiedId(variantId, 'Product variant', 'find_addable_product');
    this.assertVerifiedQuantity(quantity);

    const { customerId, address, scheduledAt, variant, matched, plan } = await this.verifiedPreWriteChecks(async () => {
      const customerId = await this.resolveVerifiedCustomerId(customerEmail);
      const { address, activeSubscriptions } = await this.getVerifiedActiveAddress(id, customerId);
      const variant = await this.getVerifiedAddableVariant(requestedVariant, 'subscription', address.country_code);

      if (activeSubscriptions.some(subscription => externalId(subscription.external_variant_id) === variant.variantId)) {
        throw verifiedWriteRefusal(
          `The customer already has an active subscription for that product at this address, so nothing was added. ` +
          `To send more of it, change that subscription's quantity with update_subscription instead.`
        );
      }

      // The new item must ship with an existing (non-prepaid) subscription here: same interval...
      const unit = String(orderIntervalUnit || '').toLowerCase();
      const sameInterval = VERIFIED_INTERVAL_UNITS.includes(unit) && Number.isInteger(orderIntervalFrequency)
        ? activeSubscriptions.filter(subscription =>
            !subscription.is_prepaid &&
            String(subscription.order_interval_unit || '').toLowerCase() === unit &&
            Number(subscription.order_interval_frequency) === orderIntervalFrequency)
        : [];
      if (sameInterval.length === 0) {
        throw verifiedWriteRefusal(
          `A new subscription here must match how often the customer's current subscription at this address ships, so nothing was added.`
        );
      }

      // ...and the same next order, so it is anchored to that subscription's schedule
      const scheduledAt = await this.getVerifiedQueuedChargeDate(address.id, customerId, date);
      const matched = sameInterval.find(subscription => chargeDate(subscription.next_charge_scheduled_at) === scheduledAt);
      if (!matched) {
        const nextDates = [...new Set(sameInterval.map(subscription => chargeDate(subscription.next_charge_scheduled_at)).filter(Boolean))].sort();
        throw verifiedWriteRefusal(
          `A new subscription must start on the next order of the subscription it ships with, so nothing was added. ` +
          `Subscriptions at this address on that schedule next ship on: ${nextDates.join(', ') || 'no upcoming date'}. ` +
          `Ask the customer which order they mean; if it is none of them, ${VERIFIED_HANDOFF}.`
        );
      }

      // The product must be offered on that interval by one of its subscription plans
      const matchedUnit = String(matched.order_interval_unit || '').toLowerCase();
      const matchedCharge = Number(matched.charge_interval_frequency ?? matched.order_interval_frequency);
      const plan = variant.plans.find(item => {
        const preferences = item.subscription_preferences || {};
        return String(preferences.interval_unit || '').toLowerCase() === matchedUnit &&
          Number(preferences.order_interval_frequency) === Number(matched.order_interval_frequency) &&
          (preferences.charge_interval_frequency === undefined || preferences.charge_interval_frequency === null ||
            Number(preferences.charge_interval_frequency) === matchedCharge);
      });
      if (!plan) {
        throw verifiedWriteRefusal(
          `That product isn't offered on the same schedule as the customer's current subscription at this address, so nothing was added.`
        );
      }

      this.assertVerifiedOrderUnits({
        variantId: variant.variantId,
        date: scheduledAt,
        quantity,
        subscriptions: activeSubscriptions,
        onetimes: await this.getVerifiedOnetimes(address.id, customerId),
      });
      return { customerId, address, scheduledAt, variant, matched, plan };
    });

    // Interval and plan come from verified records, never the raw input; no price, so Recharge
    // prices it (plan_id lets the plan's subscription discount apply)
    const subscriptionData = {
      address_id: address.id,
      external_product_id: { ecommerce: variant.productId },
      external_variant_id: { ecommerce: variant.variantId },
      quantity,
      next_charge_scheduled_at: scheduledAt,
      order_interval_unit: matched.order_interval_unit,
      order_interval_frequency: matched.order_interval_frequency,
      charge_interval_frequency: matched.charge_interval_frequency ?? matched.order_interval_frequency,
      plan_id: plan.id,
    };
    if (matched.order_day_of_month !== undefined && matched.order_day_of_month !== null) {
      subscriptionData.order_day_of_month = matched.order_day_of_month;
    }
    if (matched.order_day_of_week !== undefined && matched.order_day_of_week !== null) {
      subscriptionData.order_day_of_week = matched.order_day_of_week;
    }

    const response = await this.verifiedAdminWrite('POST', '/subscriptions', subscriptionData);
    if (process.env.DEBUG === 'true') {
      console.error(`[DEBUG] Verified subscription add of variant ${variant.variantId} on address ${address.id} for customer ${customerId}`);
    }
    return await this.verifiedCheckCreatedPrice('subscriptions', 'subscription', response, address.id, variant.unitPrice, variant.currency);
  }

  /**
   * Catalog country for find_addable_product: the customer's addresses'
   * country_code when they all share one, otherwise US. Without an email
   * (local, non-hosted use) there is no customer to read, so US.
   */
  async getAddableLookupCountry(customerEmail) {
    if (typeof customerEmail !== 'string' || customerEmail.trim() === '') {
      return DEFAULT_CATALOG_COUNTRY;
    }
    const customerId = await this.resolveVerifiedCustomerId(customerEmail);
    const response = await this.makeAdminRequest('GET', '/addresses', null, { customer_id: customerId, limit: 250 });
    const countries = new Set(((response && response.addresses) || [])
      .filter(address => String(address.customer_id) === String(customerId))
      .map(address => countryCode(address.country_code)));
    const [only] = countries;
    return countries.size === 1 && only ? only : DEFAULT_CATALOG_COUNTRY;
  }

  /**
   * Every allowlisted variant from the catalog for a country, from the shared
   * file cache (60 minutes, keyed by endpoint, agent profile, country and
   * allowlist) when it has a valid entry. Only a lookup where every chunk
   * succeeded and returned at least one variant is cached. Write-time checks
   * never use this cache.
   */
  async getCachedAddableCatalog(country) {
    const ids = [...this.addableVariants.keys()].sort();
    const { endpoint, profileUrl } = this.catalog;
    const cache = this.catalogCache && typeof endpoint === 'string' && typeof profileUrl === 'string' ? this.catalogCache : null;
    const scope = { endpoint, profileUrl, country, addable: this.addableVariants };
    const cached = cache ? await cache.get(scope) : null;
    if (cached) {
      return cached;
    }
    // A failed lookup throws here, so errors and partial results are never cached;
    // nor is an empty one (a catalog blip would otherwise hide everything for an hour)
    const variants = await this.catalog.lookupVariants(ids, country);
    if (cache && variants.size > 0) {
      await cache.set(scope, variants);
    }
    return variants;
  }

  /**
   * Read-only lookup of allowlisted, available, priced variants whose
   * product or variant title matches the query, priced in the customer's
   * country. Every query word must be a whole word of the title or the start
   * of one ("men" never matches "women"). A variant the catalog doesn't
   * return for its allowlisted product is skipped, not fatal. Descriptions
   * are never read into the result.
   */
  async findAddableProducts(query, customerEmail) {
    const words = titleWords(query);
    if (this.addableVariants.size === 0 || !this.catalog || words.length === 0) {
      return { products: [] };
    }

    const country = await this.getAddableLookupCountry(customerEmail);
    const catalog = await this.getCachedAddableCatalog(country);

    const products = [];
    for (const [variantId, productId] of this.addableVariants) {
      const variant = catalog.get(variantId);
      if (!variant || variant.productId !== productId || variant.available !== true || !(variant.unitPrice > 0) ||
          !marketCurrencyMatches(country, variant.currency)) {
        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] find_addable_product skipped variant ${variantId}: not sellable in product ${productId} for ${country}`);
        }
        continue;
      }
      const titleTokens = titleWords(`${variant.productTitle} ${variant.variantTitle}`);
      if (!words.every(word => titleTokens.some(token => token === word || token.startsWith(word)))) {
        continue;
      }
      let canSubscribe = false;
      try {
        canSubscribe = (await this.getVerifiedSubscriptionPlans(productId, variantId)).length > 0;
      } catch (error) {
        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] Plan lookup failed for product ${productId}:`, error.message);
        }
      }
      products.push({
        // A number, as create_onetime and create_subscription take it (allowlisted IDs are safe integers)
        variant_id: Number(variantId),
        title: variant.productTitle,
        variant_title: variant.variantTitle,
        unit_price: variant.unitPrice.toFixed(currencyFractionDigits(variant.currency)),
        currency: variant.currency,
        can_subscribe: canSubscribe,
      });
    }
    return { products };
  }
}
