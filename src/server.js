#!/usr/bin/env node

/**
 * Recharge Storefront API MCP Server
 *
 * A comprehensive Model Context Protocol server that provides complete access
 * to the Recharge Storefront API for subscription management.
 * Last updated: 2024-12-24
 */

const debug = process.env.DEBUG === 'true';

// Load environment variables first. Must use quiet: true so dotenv@17 does not write
// to stdout (e.g. "[dotenv@17.x] injecting env..."), which would corrupt the MCP stdio JSON-RPC stream.
import dotenv from 'dotenv';
dotenv.config({ debug: debug, quiet: !debug });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RechargeClient, verifiedWriteRefusal } from './recharge-client.js';
import { tools } from './tools/index.js';
import { formatErrorResponse, validateAuthParams } from './utils/error-handler.js';
import {
  findDisallowedVerifiedArgs,
  isVerifiedWriteCall,
  listedDescription,
  parseAddableVariants,
  parseMaxQuantity,
  toListedSchema,
  verifiedArgsRefusalMessage,
  verifiedSchemaRefusalMessage,
} from './utils/verified-writes.js';
import { createShopifyCatalog, parseShopifyCatalogConfig } from './utils/shopify-catalog.js';

/**
 * Server statistics tracking
 */
const serverStats = {
  startTime: new Date(),
  toolCalls: 0,
  errors: 0,
  customers: new Set(),
  lastActivity: new Date(),
};

/**
 * Hosted mode (e.g. behind Intercom Fin): the customer is identified only by
 * customer_email, which the client maps from a verified contact attribute.
 * IDs, tokens and store overrides that a model could fill in from the
 * conversation are removed from tool schemas and ignored on calls.
 */
const hostedMode = process.env.MCP_HOSTED_MODE === 'true';
const HOSTED_STRIPPED_ARGS = ['customer_id', 'session_token', 'admin_token', 'store_url'];
const HOSTED_HANDOFF_HINT = 'Do not ask the customer for account IDs or tokens; hand off to a support agent.';
const HOSTED_IDENTITY_ERRORS = /Customer not found with email|Multiple customers found with email|No session token available/;

/**
 * Verified admin writes: email-minted storefront sessions are read-only, so
 * set_subscription_next_charge, skip_subscription, skip_charge,
 * update_address, update_subscription (quantity only), create_onetime and
 * create_subscription instead check (with the admin token) that the target belongs
 * to the customer identified by customer_email, then write with the admin
 * token. Only available in hosted mode, where customer_email comes from the
 * client's verified contact rather than the caller: on by default there, and
 * MCP_VERIFIED_ADMIN_WRITES=false turns it off. Outside hosted mode the email
 * is caller-asserted, so MCP_VERIFIED_ADMIN_WRITES=true is ignored (with a
 * startup warning) rather than letting any caller write to any customer.
 */
const verifiedAdminWrites = hostedMode && process.env.MCP_VERIFIED_ADMIN_WRITES !== 'false';
const verifiedAdminWritesIgnored = !hostedMode && process.env.MCP_VERIFIED_ADMIN_WRITES === 'true';
/**
 * Cutover aid for clients migrating from token-based writes: outside hosted
 * mode, MCP_VERIFIED_ADMIN_WRITES=transitional sends a write call through the
 * verified path only when it carries customer_email and no session/admin
 * token; calls that still pass a token keep the legacy behaviour. Remove once
 * every client sends customer_email and hosted mode is on.
 */
const verifiedAdminWritesTransitional = !hostedMode && process.env.MCP_VERIFIED_ADMIN_WRITES === 'transitional';
const VERIFIED_WRITE_TOOLS = new Set([
  'set_subscription_next_charge',
  'skip_subscription',
  'update_address',
  'skip_charge',
  'update_subscription',
  'create_onetime',
  'create_subscription',
]);

/**
 * Limits for verified quantity changes and added products. The quantity cap
 * (MCP_VERIFIED_MAX_QUANTITY, 1-10, default 2) applies to both; only variants
 * in MCP_VERIFIED_ADDABLE_VARIANTS (productId:variantId pairs) can be added,
 * and an empty list means nothing can be added.
 */
const verifiedMaxQuantity = parseMaxQuantity(process.env.MCP_VERIFIED_MAX_QUANTITY);
const addableVariants = parseAddableVariants(process.env.MCP_VERIFIED_ADDABLE_VARIANTS);

/**
 * Catalog for added products: Recharge's GET /products only works on Custom
 * stores (422 on Shopify Checkout Integration), so variant, price and
 * availability come from Shopify's public UCP storefront MCP endpoint
 * (MCP_SHOPIFY_UCP_URL, e.g. https://ritual.com/api/ucp/mcp), identified by
 * the server's UCP agent profile (MCP_UCP_AGENT_PROFILE). Both must be https
 * URLs; if either is missing or invalid nothing can be added.
 */
const shopifyCatalogConfig = parseShopifyCatalogConfig(process.env.MCP_SHOPIFY_UCP_URL, process.env.MCP_UCP_AGENT_PROFILE);
const shopifyCatalog = shopifyCatalogConfig.config ? createShopifyCatalog(shopifyCatalogConfig.config) : null;
if (!shopifyCatalog && shopifyCatalogConfig.warnings.length === 0 && addableVariants.variants.size > 0) {
  shopifyCatalogConfig.warnings.push('MCP_VERIFIED_ADDABLE_VARIANTS is set but MCP_SHOPIFY_UCP_URL and MCP_UCP_AGENT_PROFILE are not; adding products is disabled');
}

/**
 * Tools hidden from listing and rejected on call (comma-separated names)
 */
const toolDenylist = new Set(
  (process.env.MCP_TOOL_DENYLIST || '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
);
const exposedTools = tools.filter(tool => !toolDenylist.has(tool.name));
const listingOptions = {
  hostedMode,
  verifiedAdminWrites,
  strippedArgs: HOSTED_STRIPPED_ARGS,
  maxQuantity: verifiedMaxQuantity.value,
};

/**
 * MCP Server instance
 */
const server = new Server(
  {
    name: process.env.MCP_SERVER_NAME || 'recharge-storefront-api-mcp',
    version: process.env.MCP_SERVER_VERSION || '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Health check function
 */
function getHealthStatus() {
  const uptime = Date.now() - serverStats.startTime.getTime();
  const uptimeHours = Math.floor(uptime / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
  
  return {
    status: 'healthy',
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
    toolCalls: serverStats.toolCalls,
    errors: serverStats.errors,
    uniqueCustomers: serverStats.customers.size,
    lastActivity: serverStats.lastActivity.toISOString(),
    memoryUsage: process.memoryUsage(),
    nodeVersion: process.version,
    serverName: process.env.MCP_SERVER_NAME || 'recharge-storefront-api-mcp',
    serverVersion: process.env.MCP_SERVER_VERSION || '1.0.0',
  };
}

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (debug) {
    console.error(`[DEBUG] Listing ${exposedTools.length} available tools`);
  }

  return {
    tools: exposedTools.map(tool => ({
      name: tool.name,
      description: listedDescription(tool, listingOptions),
      inputSchema: toListedSchema(tool, listingOptions),
    })),
  };
});

/**
 * Handle tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  // Update statistics
  serverStats.toolCalls++;
  serverStats.lastActivity = new Date();
  
  if (debug) {
    console.error(`[DEBUG] Executing tool: ${name}`);
    // Sanitize arguments for logging (remove sensitive data)
    const sanitizedArgs = { ...args };
    if (sanitizedArgs.session_token) sanitizedArgs.session_token = '***';
    if (sanitizedArgs.admin_token) sanitizedArgs.admin_token = '***';
    console.error(`[DEBUG] Arguments:`, JSON.stringify(sanitizedArgs, null, 2));
  }

  // Find the requested tool
  const tool = exposedTools.find(t => t.name === name);
  if (!tool) {
    serverStats.errors++;
    const error = new Error(`Tool not found: ${name}`);
    if (debug) {
      console.error(`[DEBUG] Tool not found: ${name}`);
    }
    return formatErrorResponse(error);
  }

  try {
    // Validate input schema
    const rawArgs = { ...(args || {}) };
    if (hostedMode) {
      for (const arg of HOSTED_STRIPPED_ARGS) {
        delete rawArgs[arg];
      }
    }
    // Decided on the raw arguments so disallowed fields are refused before Zod strips them
    const verifiedWrite = isVerifiedWriteCall(name, rawArgs, {
      verifiedTools: VERIFIED_WRITE_TOOLS,
      verifiedAdminWrites,
      transitional: verifiedAdminWritesTransitional,
    });
    if (verifiedWrite) {
      const disallowed = findDisallowedVerifiedArgs(rawArgs, tool.verifiedArgs, HOSTED_STRIPPED_ARGS);
      if (disallowed.length > 0) {
        throw verifiedWriteRefusal(verifiedArgsRefusalMessage(tool, disallowed));
      }
    }
    // Verified quantity and product tools refuse a schema failure in customer-safe text, not a raw Zod error
    if (verifiedWrite && Array.isArray(tool.verifiedArgs)) {
      const parsed = tool.inputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw verifiedWriteRefusal(verifiedSchemaRefusalMessage(parsed.error, tool, rawArgs));
      }
    }
    const validatedArgs = tool.inputSchema.parse(rawArgs);

    if (hostedMode && !validatedArgs.customer_email) {
      throw new Error(`This customer could not be identified because no verified email was provided. ${HOSTED_HANDOFF_HINT}`);
    }

    // Validate authentication parameters
    validateAuthParams(validatedArgs);

    // Extract authentication and configuration
    const storeUrl = validatedArgs.store_url || process.env.RECHARGE_STOREFRONT_DOMAIN;
    // In hosted mode every call must mint a session for the identified customer
    const sessionToken = hostedMode ? null : (validatedArgs.session_token || process.env.RECHARGE_SESSION_TOKEN);
    // Verified writes act with the server's own admin token only, never a caller-supplied one
    const adminToken = verifiedWrite ? process.env.RECHARGE_ADMIN_TOKEN : (validatedArgs.admin_token || process.env.RECHARGE_ADMIN_TOKEN);
    
    // Validate required configuration
    if (!storeUrl) {
      throw new Error(
        'No store URL available. Please provide store_url parameter in your tool call or set RECHARGE_STOREFRONT_DOMAIN environment variable.\n' +
        'Example: your-shop.myshopify.com'
      );
    }
    
    // Validate store URL is not placeholder
    if (storeUrl === 'your-shop.myshopify.com') {
      throw new Error(
        'Please configure your actual store URL. The placeholder "your-shop.myshopify.com" is not valid.\n' +
        'Update RECHARGE_STOREFRONT_DOMAIN in your .env file or provide store_url parameter.'
      );
    }
    
    // Validate store URL format
    let domain;
    try {
      if (storeUrl.startsWith('http://') || storeUrl.startsWith('https://')) {
        const urlObj = new URL(storeUrl);
        domain = urlObj.hostname;
      } else {
        domain = storeUrl;
      }
      
      if (!domain || !domain.includes('.myshopify.com')) {
        throw new Error('Invalid domain format');
      }
    } catch (urlError) {
      throw new Error(
        `Invalid store URL format: ${storeUrl}\n` +
        'Store URL must be a Shopify domain ending with .myshopify.com\n' +
        'Example: your-shop.myshopify.com'
      );
    }
    
    // Validate domain is not a placeholder
    if (domain === 'your-shop.myshopify.com') {
      throw new Error(
        'Please configure your actual store domain. The placeholder "your-shop.myshopify.com" is not valid.\n' +
        'Update RECHARGE_STOREFRONT_DOMAIN in your .env file or provide store_url parameter.'
      );
    }
    
    // Validate admin token is not placeholder when needed for customer operations
    if ((validatedArgs.customer_id || validatedArgs.customer_email) && !sessionToken) {
      if (!adminToken) {
        throw new Error(
          'Admin token required for customer operations. Please provide admin_token parameter or set RECHARGE_ADMIN_TOKEN environment variable.'
        );
      }
      
      if (adminToken === 'your_admin_token_here' || adminToken === 'your_admin_api_token_here') {
        throw new Error(
          'Please configure your actual admin token. The placeholder "your_admin_token_here" is not valid.\n' +
          'Update RECHARGE_ADMIN_TOKEN in your .env file or provide admin_token parameter.'
        );
      }
    }
    
    // Create client with available tokens
    const client = new RechargeClient({
      storeUrl: domain,
      sessionToken,
      adminToken,
      verifiedAdminWrites: verifiedWrite,
      verifiedMaxQuantity: verifiedMaxQuantity.value,
      addableVariants: addableVariants.variants,
      catalog: shopifyCatalog,
    });
    
    // Track customer for statistics
    if (validatedArgs.customer_id) {
      serverStats.customers.add(validatedArgs.customer_id);
    }
    if (validatedArgs.customer_email) {
      serverStats.customers.add(validatedArgs.customer_email);
    }
    
    // Execute the tool
    const result = await tool.execute(client, validatedArgs);
    
    if (debug) {
      console.error(`[DEBUG] Tool ${name} executed successfully`);
    }
    
    return result;
  } catch (error) {
    serverStats.errors++;
    
    if (debug) {
      console.error(`[DEBUG] Tool ${name} failed:`, error.message);
      if (error.stack) {
        console.error(`[DEBUG] Error stack:`, error.stack);
      }
    }

    if (hostedMode && HOSTED_IDENTITY_ERRORS.test(error.message || '') && !/hand off to a support agent/.test(error.message)) {
      return formatErrorResponse(new Error(`${error.message} ${HOSTED_HANDOFF_HINT}`));
    }

    return formatErrorResponse(error);
  }
});

/**
 * Handle health check requests
 */
// Note: Health check would be handled by MCP client, not as a custom request handler

/**
 * Graceful shutdown handling
 */
process.on('SIGINT', async () => {
  if (debug) {
    console.error('[DEBUG] Received SIGINT, shutting down gracefully...');
    console.error('[DEBUG] Final statistics:', serverStats);
  }
  
  try {
    await server.close();
    if (debug) {
      console.error('[DEBUG] Server closed successfully');
    }
  } catch (error) {
    console.error('[ERROR] Error during shutdown:', error.message);
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (debug) {
    console.error('[DEBUG] Received SIGTERM, shutting down gracefully...');
  }
  
  try {
    await server.close();
  } catch (error) {
    console.error('[ERROR] Error during shutdown:', error.message);
  }
  
  process.exit(0);
});

/**
 * Start the server
 */
async function main() {
  try {
    // Validate Node.js version
    const nodeVersion = process.version.slice(1).split('.').map(Number);
    const requiredVersion = [18, 0, 0];
    const isValidVersion = nodeVersion[0] > requiredVersion[0] || 
      (nodeVersion[0] === requiredVersion[0] && nodeVersion[1] > requiredVersion[1]) ||
      (nodeVersion[0] === requiredVersion[0] && nodeVersion[1] === requiredVersion[1] && nodeVersion[2] >= requiredVersion[2]);
    
    if (!isValidVersion) {
      console.error(`[FATAL] Node.js version ${process.version} is not supported.`);
      console.error('[INFO] Please install Node.js 18.0.0 or higher.');
      console.error('[INFO] Visit https://nodejs.org/ to download the latest version.');
      process.exit(1);
    }
    
    // Validate required dependencies
    try {
      const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
      const z = await import('zod');
      const axios = await import('axios');
      const dotenv = await import('dotenv');
      
      // Validate that imports are functional
      if (!Server || !z || !axios || !dotenv) {
        throw new Error('Failed to import required modules');
      }
    } catch (error) {
      console.error('[FATAL] Missing required dependencies. Please run: npm install');
      console.error('[DEBUG] Missing dependency:', error.message);
      process.exit(1);
    }
    
    // Validate environment
    const hasStoreDomain = process.env.RECHARGE_STOREFRONT_DOMAIN && 
      process.env.RECHARGE_STOREFRONT_DOMAIN.trim() !== '' && 
      process.env.RECHARGE_STOREFRONT_DOMAIN !== 'your-shop.myshopify.com';
    const hasAdminToken = process.env.RECHARGE_ADMIN_TOKEN && 
      process.env.RECHARGE_ADMIN_TOKEN.trim() !== '' && 
      process.env.RECHARGE_ADMIN_TOKEN !== 'your_admin_token_here';
    
    if (!hasStoreDomain && !hasAdminToken) {
      console.error('[WARNING] No environment variables configured. Tools will require parameters for each call.');
    }
    
    if (process.env.RECHARGE_STOREFRONT_DOMAIN === 'your-shop.myshopify.com') {
      console.error('[WARNING] Please update RECHARGE_STOREFRONT_DOMAIN with your actual domain');
    }
    
    if (verifiedAdminWritesIgnored) {
      console.error('[WARNING] MCP_VERIFIED_ADMIN_WRITES=true is ignored without MCP_HOSTED_MODE=true (customer_email is only trusted in hosted mode)');
    }
    
    if (verifiedMaxQuantity.warning) {
      console.error(`[WARNING] ${verifiedMaxQuantity.warning}`);
    }
    for (const warning of addableVariants.warnings) {
      console.error(`[WARNING] ${warning}`);
    }
    for (const warning of shopifyCatalogConfig.warnings) {
      console.error(`[WARNING] ${warning}`);
    }
    
    if (process.env.RECHARGE_ADMIN_TOKEN === 'your_admin_token_here') {
      console.error('[WARNING] Please update RECHARGE_ADMIN_TOKEN with your actual admin token');
    }
    
    // Start server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    if (debug) {
      console.error('[DEBUG] Recharge Storefront API MCP Server started');
      console.error('[DEBUG] Server name:', process.env.MCP_SERVER_NAME || 'recharge-storefront-api-mcp');
      console.error('[DEBUG] Server version:', process.env.MCP_SERVER_VERSION || '1.0.0');
      console.error('[DEBUG] Available tools:', tools.length);
      console.error('[DEBUG] Store domain:', hasStoreDomain ? process.env.RECHARGE_STOREFRONT_DOMAIN : 'Not configured');
      console.error('[DEBUG] Admin token:', hasAdminToken ? 'Configured' : 'Not configured');
      console.error('[DEBUG] Verified admin writes:', verifiedAdminWrites ? 'Enabled' : (verifiedAdminWritesTransitional ? 'Transitional' : 'Disabled'));
      console.error('[DEBUG] Verified max quantity:', verifiedMaxQuantity.value, '- addable variants:', addableVariants.variants.size);
      console.error('[DEBUG] Shopify catalog for adds:', shopifyCatalog ? 'Configured' : 'Not configured');
      console.error('[DEBUG] Session token:', (process.env.RECHARGE_SESSION_TOKEN && process.env.RECHARGE_SESSION_TOKEN.trim() !== '') ? 'Configured' : 'Not configured');
      console.error('[INFO] Server ready - listening for MCP requests');
    }
    
  } catch (error) {
    console.error('[FATAL] Failed to start server:', error.message);
    
    // Provide helpful error messages for common issues
    if (error.code === 'MODULE_NOT_FOUND') {
      console.error('[INFO] Missing dependencies. Please run: npm install');
    } else if (error.message.includes('Cannot resolve module')) {
      console.error('[INFO] Module resolution error. Please check your Node.js installation.');
    } else if (error.message.includes('Permission denied')) {
      console.error('[INFO] Permission error. Please check file permissions.');
    }
    
    if (debug) {
      console.error('[DEBUG] Startup error stack:', error.stack);
    }
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error.message);
  if (debug) {
    console.error('[DEBUG] Error stack:', error.stack);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
  if (debug) {
    console.error('[DEBUG] Rejection details:', reason);
  }
  process.exit(1);
});

// Start the server
main().catch((error) => {
  console.error('[FATAL] Server startup failed:', error.message);
  if (debug) {
    console.error('[DEBUG] Startup error stack:', error.stack);
  }
  process.exit(1);
});