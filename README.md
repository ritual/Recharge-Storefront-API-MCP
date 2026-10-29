# Recharge Storefront API MCP Server

A comprehensive Model Context Protocol (MCP) server that provides complete access to the Recharge Storefront API endpoints. This server enables AI assistants and other MCP clients to interact with Recharge subscription management functionality through a standardized interface.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Authentication](#authentication)
- [Configuration](#configuration)
- [Usage](#usage)
- [Available Tools](#available-tools)
- [Usage Examples](#usage-examples)
- [Unicode and International Support](#unicode-and-international-support)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Performance](#performance)
- [Contributing](#contributing)
- [License](#license)

## Overview

The Recharge Storefront API MCP Server bridges the gap between AI assistants and Recharge's subscription management platform. It provides a complete, production-ready interface to all Recharge Storefront API endpoints through the standardized Model Context Protocol.

### What is Recharge?

Recharge is a leading subscription commerce platform that powers recurring billing for Shopify stores. It handles subscription management, billing cycles, customer portals, and recurring order processing for thousands of merchants.

### What is MCP?

Model Context Protocol (MCP) is a standardized way for AI assistants to interact with external services and APIs. This server implements MCP to make Recharge's functionality accessible to AI systems.

### Key Benefits

- **Complete API Coverage**: All 88 Recharge Storefront API endpoints
- **Intelligent Authentication**: Automatic session management with multi-customer support
- **Production Ready**: Error handling, logging, and monitoring
- **Developer Friendly**: Comprehensive documentation, examples, and debugging tools
- **Secure**: Built-in security protections and customer data isolation
- **International Support**: Full Unicode support for global customers

## Features

### Complete Storefront API Coverage

| Category | Tools | Description |
|----------|-------|-------------|
| **Customer Management** | 10 tools | Profile, portal access, notifications, churn/recovery URLs |
| **Subscription Lifecycle** | 14 tools | Create, update, cancel, skip, swap, activate, bulk operations, gifting |
| **Address Management** | 9 tools | Full CRUD, discounts, merge, and charge skipping |
| **Payment Methods** | 3 tools | View and update payment information |
| **Product Catalog** | 4 tools | Browse, search, and view subscription products |
| **Collections** | 3 tools | Browse store collections and collection products |
| **Plan Management** | 2 tools | View subscription plans and plan details |
| **Order Management** | 2 tools | View order history and tracking |
| **Charge Management** | 8 tools | Skip, process, reschedule, and manage discounts |
| **One-time Products** | 5 tools | Add products to upcoming deliveries |
| **Bundle Management** | 7 tools | Product bundle and selection management |
| **Credits** | 3 tools | Credit summary, auto-apply settings, credit accounts |
| **Gifts** | 2 tools | Gift purchases and redemption |
| **Metafields** | 3 tools | Create, update, delete resource metafields |
| **Authentication** | 8 tools | Shopify login, passwordless auth, customer portal |
| **Utilities** | 4 tools | Session cache, store settings, and shipping countries |

### Advanced Features

- **Automatic Session Management**: Intelligent session creation and caching
- **Multi-Customer Support**: Handle multiple customers in a single MCP connection
- **Flexible Authentication**: Environment variables, per-tool parameters, or explicit tokens
- **Comprehensive Error Handling**: Detailed error messages with actionable guidance
- **Debug Mode**: Extensive logging for development and troubleshooting
- **Input Validation**: Zod schema validation for all tool parameters
- **Security Protection**: Prevents accidental customer data exposure
- **Unicode Support**: Full international character support for names and addresses
- **Business Rule Validation**: Prevents invalid subscription configurations

### Session Cache Management

- **Automatic Session Caching**: Customer session tokens cached for performance
- **Environment Switching Support**: Tools to purge cache when switching between dev/test/production
- **Automatic Cleanup**: Old sessions (4+ hours) automatically purged to prevent stale tokens
- **Cache Statistics**: Monitor cached sessions and performance
- **Manual Purging**: Clear specific or all cached sessions on demand

## Installation

### Prerequisites

- **Node.js**: Version 18.0.0 or higher
- **Shopify Store**: Must have a Shopify store with Recharge installed
- **Recharge Account**: Active Recharge merchant account
- **API Access**: Recharge Admin API token for session creation

### Quick Start

```bash
# Clone or download the project
# cd recharge-storefront-api-mcp

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Start the server
npm start
```

### Automated Setup

```bash
# Make setup script executable (Linux/macOS)
chmod +x scripts/setup.sh

# Run the setup script
npm run setup
```

The setup script will:
- Validate Node.js version
- Install dependencies
- Create environment file
- Validate configuration
- Display project statistics

### Verification

```bash
# Validate installation
npm run validate

# Check API coverage
npm run coverage

# Run comprehensive tests
npm run test
```

## Authentication

### Understanding Recharge Authentication

Recharge uses a two-step authentication process:

1. **Admin API Token**: Authenticates your application with Recharge
2. **Customer Session Token**: Scopes operations to a specific customer

```
Admin API Token + Customer ID → Customer Session Token → API Operations
```

### Getting Your API Token

1. **Log into Recharge**: Access your merchant portal
2. **Navigate to API Tokens**: Go to Apps & integrations > API tokens
3. **Create Admin Token**: Create a new **Admin API** token (not Storefront API token)
4. **Set Permissions**: **IMPORTANT**: Recharge tokens have NO permissions by default. You must explicitly check ALL required permission boxes (see below)
5. **Copy Token**: Save the token (starts with your store prefix)

**Critical**: You must use **Admin API** tokens. Storefront API tokens will not work for session creation. Admin tokens typically start with your store prefix (e.g., `mystore_`) or `sk_`.

### Required Token Permissions

Your Admin API token must have **both read AND write permissions** for full functionality. **Recharge does NOT grant these by default** - you must explicitly select each permission when creating the token:

#### Required Permissions:
- ✅ **read_customers** - View customer information
- ✅ **write_customers** - Update customer profiles, create sessions
- ✅ **read_subscriptions** - View subscription details
- ✅ **write_subscriptions** - Skip, update, cancel, activate subscriptions
- ✅ **read_orders** - View order history
- ✅ **write_orders** - Modify orders and charges
- ✅ **read_products** - Browse product catalog
- ✅ **read_addresses** - View customer addresses
- ✅ **write_addresses** - Create, update, delete addresses
- ✅ **read_payment_methods** - View payment information
- ✅ **write_payment_methods** - Update billing information
- ✅ **read_discounts** - View applied discounts
- ✅ **write_discounts** - Apply and remove discount codes

**⚠️ Common Mistake**: Many users only select read permissions initially, thinking write permissions aren't needed. However, operations like "skip subscription" or "update customer" require write permissions even though they might seem like simple operations.

#### Common Permission Issues:

**Problem**: 403 errors on write operations (skip, update, cancel subscriptions)
**Cause**: Token has read permissions but missing write permissions
**Solution**: Update token permissions or create new token with full write access

**Problem**: Read operations work but write operations fail
**Cause**: Token created with "read-only" or limited permissions
**Solution**: Ensure token has ALL permissions listed above

#### How to Check Token Permissions:
1. Go to Recharge admin → Apps & integrations → API tokens
2. Find your Admin API token
3. Check the "Permissions" or "Scopes" section
4. Ensure ALL required permissions are enabled
5. If missing permissions, either update existing token or create new one

### Authentication Methods

The server supports three flexible authentication approaches:

#### Method 1: Customer Email (Recommended)

The simplest approach - provide the customer's email address:

```json
{
  "name": "get_subscriptions",
  "arguments": {
    "customer_email": "customer@example.com"
  }
}
```

**What happens automatically:**
1. Email lookup → Customer ID
2. Customer ID → Session token
3. Session token → Customer data
4. Session cached for future calls

#### Method 2: Customer ID

If you already have the customer ID:

```json
{
  "name": "get_subscriptions",
  "arguments": {
    "customer_id": "123456"
  }
}
```

#### Method 3: Explicit Session Token

For advanced use cases with existing session tokens:

```json
{
  "name": "get_subscriptions",
  "arguments": {
    "session_token": "existing_session_token"
  }
}
```

### Automatic Session Management

The server intelligently manages customer sessions:

#### Session Creation Flow

```
Customer Email/ID → Lookup → Session Creation → API Call → Cached Session Token
```

#### Session Persistence

Customer session tokens are cached within your MCP connection with automatic renewal:

```json
// First call - creates and caches session
{
  "name": "get_customer",
  "arguments": {"customer_email": "alice@example.com"}
}

// Subsequent calls - reuses cached session (fast!)
{
  "name": "get_subscriptions", 
  "arguments": {"customer_email": "alice@example.com"}
}

// Different customer - creates new cached session
{
  "name": "get_orders",
  "arguments": {"customer_email": "bob@example.com"}
```

#### Automatic Session Renewal

- **Reactive Renewal**: Expired session tokens automatically renewed when API calls fail due to expiration
- **Retry Logic**: Failed calls due to expired tokens automatically retried with fresh session

#### Performance Benefits

- **Fast**: No repeated session creation
- **Smart**: Email lookups cached too
- **Isolated**: Each customer gets separate session token
- **Automatic**: Works transparently

### Multi-Customer Support

Handle multiple customers seamlessly:

```json
// Customer A operations
{"name": "get_customer", "arguments": {"customer_email": "alice@example.com"}}
{"name": "get_subscriptions", "arguments": {"customer_email": "alice@example.com"}}

// Customer B operations  
{"name": "get_customer", "arguments": {"customer_email": "bob@example.com"}}
{"name": "get_orders", "arguments": {"customer_email": "bob@example.com"}}

// Back to Customer A - reuses cached session
{"name": "get_addresses", "arguments": {"customer_email": "alice@example.com"}}
```

The server includes built-in security protections:

#### Preventing Wrong Customer Data

```json
// Safe: Default session when no customer sessions exist
{"name": "get_subscriptions", "arguments": {}}  // Uses default session token

// Dangerous: Could expose wrong customer data
{"name": "get_customer", "arguments": {"customer_email": "alice@example.com"}}
{"name": "get_subscriptions", "arguments": {}}  // BLOCKED! Security error

// Safe: Always specify customer identification
{"name": "get_subscriptions", "arguments": {"customer_email": "alice@example.com"}}  // Safe
```

**Security Error Message:**
```
Security Error: Cannot use default session token when customer-specific sessions exist. 
Please specify 'customer_id', 'customer_email', or 'session_token' to ensure correct customer data access.
```

## Configuration

### MCP Client Configuration

To use this server with an MCP client, you'll need to configure your client to connect to this server. Here are configuration examples for popular clients:

#### Claude Desktop

Edit your Claude Desktop configuration file:

**Location**: 
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "recharge-storefront-api": {
      "command": "node",
      "args": ["path/to/recharge-storefront-api-mcp/src/server.js"],
      "env": {
        "RECHARGE_STOREFRONT_DOMAIN": "your-shop.myshopify.com",
        "RECHARGE_ADMIN_TOKEN": "your_admin_token_here"
      }
    }
  }
}
```

**If you experience JSON-RPC or timeout issues with Claude Desktop**, try this alternative configuration:

```json
{
  "mcpServers": {
    "recharge-storefront-api": {
      "command": "node",
      "args": ["index.js"],
      "cwd": "path/to/recharge-storefront-api-mcp",
      "env": {
        "RECHARGE_STOREFRONT_DOMAIN": "your-shop.myshopify.com",
        "RECHARGE_ADMIN_TOKEN": "your_admin_token_here"
      }
    }
  }
}
```

#### Cursor IDE

1. **Install the MCP extension** (if available) or configure manually
2. **Add to Cursor settings** (`Ctrl/Cmd + ,`):

```json
{
  "mcp.servers": {
    "recharge-storefront-api": {
      "command": "node",
      "args": ["src/server.js"],
      "cwd": "path/to/recharge-storefront-api-mcp",
      "env": {
        "RECHARGE_STOREFRONT_DOMAIN": "your-shop.myshopify.com",
        "RECHARGE_ADMIN_TOKEN": "your_admin_token_here"
      }
    }
  }
}
```

3. **If you experience MCP protocol issues in Cursor**, you have two options:

**Option A: Create a wrapper script** in your project root (`run-server.js`):
```javascript
#!/usr/bin/env node
import('./src/server.js').catch(console.error);
```

Then use this configuration:
```json
{
  "mcp.servers": {
    "recharge-storefront-api": {
      "command": "node",
      "args": ["run-server.js"],
      "cwd": "path/to/recharge-storefront-api-mcp",
      "env": {
        "RECHARGE_STOREFRONT_DOMAIN": "your-shop.myshopify.com",
        "RECHARGE_ADMIN_TOKEN": "your_admin_token_here"
      }
    }
  }
}
```

**Option B: Use .env file** with simpler config (if wrapper script doesn't work):

```json
{
  "mcp.servers": {
    "recharge-storefront-api": {
      "command": "node",
      "args": ["src/server.js"],
      "cwd": "path/to/recharge-storefront-api-mcp"
    }
  }
}
```

*Note: This relies on your `.env` file in the project directory containing the required environment variables.*
#### GPT-5 and OpenAI Clients

For GPT-5 and other OpenAI-based MCP clients:

```json
{
  "mcpServers": [
    {
      "name": "recharge-storefront-api",
      "command": "node",
      "args": ["index.js"],
      "cwd": "path/to/recharge-storefront-api-mcp",
      "env": {
        "RECHARGE_STOREFRONT_DOMAIN": "your-shop.myshopify.com",
        "RECHARGE_ADMIN_TOKEN": "your_admin_token_here"
      }
    }
  ]
}
```

**If experiencing protocol issues**, try using the main entry point:
```json
{
  "mcpServers": [
    {
      "name": "recharge-storefront-api",
      "command": "node",
      "args": ["src/server.js"],
      "cwd": "path/to/recharge-storefront-api-mcp"
    }
  ]
}
```

#### VSCode with GitHub Copilot

1. **Install MCP extension** for VSCode (if available)
2. **Add to VSCode settings.json** (`Ctrl/Cmd + Shift + P` → "Preferences: Open Settings (JSON)"):

```json
{
  "mcp.servers": [
    {
      "name": "recharge-storefront-api",
      "command": "node",
      "args": ["src/server.js"],
      "cwd": "path/to/recharge-storefront-api-mcp",
      "env": {
        "RECHARGE_STOREFRONT_DOMAIN": "your-shop.myshopify.com",
        "RECHARGE_ADMIN_TOKEN": "your_admin_token_here"
      }
    }
  ]
}
```

3. **Alternative: Workspace configuration** (`.vscode/settings.json` in your project):

```json
{
  "mcp.servers": [
    {
      "name": "recharge-storefront-api",
      "command": "node",
      "args": ["../recharge-storefront-api-mcp/src/server.js"],
      "cwd": "../recharge-storefront-api-mcp"
    }
  ]
}
```

#### Claude Code (Anthropic's IDE)

1. **Open Claude Code settings**
2. **Navigate to MCP Servers section**
3. **Add new server configuration**:

```json
{
  "name": "Recharge Storefront API",
  "command": "node",
  "args": ["src/server.js"],
  "cwd": "path/to/recharge-storefront-api-mcp",
  "env": {
    "RECHARGE_STOREFRONT_DOMAIN": "your-shop.myshopify.com",
    "RECHARGE_ADMIN_TOKEN": "your_admin_token_here"
  }
}
```

#### Generic MCP Client Configuration

For any MCP-compatible client:
- **Command**: `node src/server.js`
- **Working Directory**: Path to this project
- **Environment Variables**: Set in client config or .env file
- **Protocol**: stdio (standard input/output)

#### Troubleshooting MCP Client Issues

**Common Issue**: JSON-RPC or timeout errors across different MCP clients (Claude Desktop, Cursor, GPT-5, etc.)

**Root Cause**: Different MCP clients implement the protocol with slight variations, causing compatibility issues with the JSON-RPC transport layer.

**Solutions** (try in order):

1. **Use the main entry point** (`index.js` instead of `src/server.js`):
   ```json
   "args": ["index.js"]
   ```

2. **Create a wrapper script** (`run-server.js`):
   ```javascript
   #!/usr/bin/env node
   import('./src/server.js').catch(console.error);
   ```
   Then use: `"args": ["run-server.js"]`

3. **Use direct stdio execution**:
   ```bash
   # Test the server directly
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node src/server.js
   ```

4. **Enable debug mode** to see detailed protocol communication:
   ```json
   "env": {
     "DEBUG": "true",
     "RECHARGE_STOREFRONT_DOMAIN": "your-shop.myshopify.com",
     "RECHARGE_ADMIN_TOKEN": "your_admin_token_here"
   }
   ```

5. **Verify server startup** independently:
   ```bash
   cd path/to/recharge-storefront-api-mcp
   npm start
   # Should show: [INFO] Server ready - listening for MCP requests
   ```

**Why This Happens**: The MCP specification is still evolving, and different AI platforms implement it with slight variations in their JSON-RPC handling, timeout mechanisms, and transport layers.

**Best Practice**: Start with the simplest configuration (`node src/server.js`) and add complexity only if needed.

#### General Configuration Tips

1. **Use absolute paths** for reliability across different environments
2. **Environment variables** can be set in client config or .env file
3. **Test connection** after setup using client's MCP testing features
4. **Enable debug mode** by adding `"DEBUG": "true"` to env variables for troubleshooting

### Environment Variables

Create a `.env` file in the project root:

```bash
# Required: Your Shopify domain
RECHARGE_STOREFRONT_DOMAIN=your-shop.myshopify.com

# Required: Admin API token for session creation
RECHARGE_ADMIN_TOKEN=your_admin_api_token_here

# Optional: Recharge API URL (defaults to production)
RECHARGE_API_URL=https://api.rechargeapps.com

# Optional: Default customer session token (if you have one)
RECHARGE_SESSION_TOKEN=

# Optional: Server configuration
MCP_SERVER_NAME=recharge-storefront-api-mcp
MCP_SERVER_VERSION=1.0.0

# Optional: Enable debug logging
DEBUG=true
```

### Configuration Options

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `RECHARGE_STOREFRONT_DOMAIN` | Yes* | Your Shopify domain | `shop.myshopify.com` |
| `RECHARGE_ADMIN_TOKEN` | Yes* | Admin API token for session creation | `your_admin_api_token_here` |
| `RECHARGE_API_URL` | No | Recharge API endpoint (defaults to production, no fallback if invalid) | `https://api.stage.rechargeapps.com` |
| `RECHARGE_SESSION_TOKEN` | No | Default customer session token | `st_abc123` |
| `MCP_SERVER_NAME` | No | Server identification | `recharge-mcp` |
| `MCP_SERVER_VERSION` | No | Server version | `1.0.0` |
| `DEBUG` | No | Enable debug logging | `true` |
| `MCP_HOSTED_MODE` | No | Lock down for customer-facing clients (see below) | `true` |
| `MCP_TOOL_DENYLIST` | No | Comma-separated tool names to hide and reject | `cancel_subscription,process_charge` |
| `MCP_VERIFIED_ADMIN_WRITES` | No | Ownership-checked admin writes, hosted mode only (default: on in hosted mode; `false` turns it off; see below) | `false` |
| `MCP_VERIFIED_MAX_QUANTITY` | No | Largest units of one product in one order a verified write may set or add (1-10, default 2) | `2` |
| `MCP_VERIFIED_ADDABLE_VARIANTS` | No | `shopifyProductId:shopifyVariantId` pairs verified writes may add (empty: nothing) | `7482572079198:42144416137310` |
| `MCP_SHOPIFY_UCP_URL` | For adds | Shopify's public UCP storefront MCP endpoint, the catalog for added products (https only) | `https://ritual.com/api/ucp/mcp` |
| `MCP_UCP_AGENT_PROFILE` | For adds | https URL of this server's UCP agent profile (`ucp/agent-profile.json`), sent with every catalog lookup | `https://example.com/ucp/agent-profile.json` |
| `MCP_CATALOG_CACHE_DIR` | No | Directory for `find_addable_product`'s 60-minute shared catalog cache (default `<os tmpdir>/recharge-mcp-catalog-cache`; see below) | `/tmp/recharge-mcp-catalog-cache` |

*Required unless provided in each tool call

### Hosted Mode

Set `MCP_HOSTED_MODE=true` when the server sits behind a customer-facing assistant (e.g. Intercom Fin). In hosted mode:

- `customer_id`, `session_token`, `admin_token` and `store_url` are removed from every tool schema and ignored if sent, so a model can't fill them in from the conversation. Map `customer_email` from a verified contact attribute in your client.
- `RECHARGE_SESSION_TOKEN` is ignored; every call mints a session for the customer identified by `customer_email`.

Independently of hosted mode, a lookup by email that matches more than one Recharge customer fails instead of picking the first match.

### Verified Admin Writes

Storefront sessions minted for a customer by email can read but not write: Recharge returns 403 "You do not have sufficient permissions (scopes) for this object" on writes such as `set_next_charge_date` and `PUT /addresses/{id}`. With verified admin writes enabled, these tools no longer use the storefront session:

| Tool | Ownership check (admin API) | Write (admin API) |
|------|-----------------------------|-------------------|
| `set_subscription_next_charge` | `GET /subscriptions/{id}` → `customer_id` | `POST /subscriptions/{id}/set_next_charge_date` |
| `skip_subscription` | `GET /subscriptions/{id}` → `customer_id` | `POST /addresses/{address_id}/charges/skip` |
| `update_address` | `GET /addresses/{id}` → `customer_id` | `PUT /addresses/{id}` |
| `skip_charge` | `GET /charges/{id}` → `customer.id`, and every `purchase_item_id` is on the charge | `POST /charges/{id}/skip` |
| `update_subscription` (quantity only) | `GET /subscriptions/{id}` → `customer_id`; must be active, not prepaid, priced above zero and not a gift line; on an increase, units on the next order (`GET /subscriptions`, `GET /onetimes`) | `PUT /subscriptions/{id}?commit=true` with `{"quantity": N}` |
| `create_onetime` | `GET /addresses/{id}` → `customer_id` and an active subscription there, all in one currency; date of a queued charge (`GET /charges`); allowlisted variant, available and priced above zero in that currency in the Shopify storefront catalog for the address's `country_code` (UCP `lookup_catalog`, see below); no duplicate and units per order (`GET /onetimes`) | `POST /onetimes`, then the returned price and currency are checked |
| `create_subscription` | As `create_onetime`, plus no active subscription for the variant on the address, an active non-prepaid subscription there with the same interval whose next charge is the requested date, and a subscription plan for the variant on that interval (`GET /plans`) | `POST /subscriptions` with that plan's `plan_id`, then the returned price and currency are checked |

Each call looks the customer up by `customer_email` (refusing 0 or >1 matches), loads the target with the admin token, and only writes if it belongs to that customer. Missing email, unknown or ambiguous email, not-found and owned-by-someone-else are all refused before any write is sent, with an error telling the assistant to hand off to a support agent. Not-found and wrong-owner get the same message, so other customers' IDs can't be probed. `session_token`, `customer_id` and `admin_token` from the caller are never used by these tools; read tools are unchanged.

- Only available with `MCP_HOSTED_MODE=true`, and enabled by default there.
- `MCP_VERIFIED_ADMIN_WRITES=false` disables it in hosted mode (falls back to storefront-session writes).
- Without hosted mode it is always off, and `MCP_VERIFIED_ADMIN_WRITES=true` is ignored with a startup warning.
- `MCP_VERIFIED_ADMIN_WRITES=transitional` (hosted mode off only) is a cutover aid: a write call with `customer_email` and no `session_token`/`admin_token` takes the verified path, while calls that still pass a token keep the legacy behaviour. `update_subscription`, `create_onetime` and `create_subscription` never take the verified path in transitional mode (they buy or multiply product, so they need the hosted-mode verified email); there they keep the legacy behaviour. Use it only while migrating a client from token-based writes to email-based ones, then turn hosted mode on and remove it. The ownership check is only as strong as the source of `customer_email`: in hosted mode the client maps it from a verified contact, but otherwise the caller supplies it, so enabling these writes there would let any caller make admin-token writes for any customer whose email they know.
- Subscription, address and charge IDs must be digits only, the fetched record's `id` must match the requested ID, and the write uses the IDs from the verified record (for `skip_charge`, the charge's own `purchase_item_id`s), never the raw input.
- `RECHARGE_ADMIN_TOKEN` needs `read_customers`/`write_customers` (lookup, addresses), `read_subscriptions`/`write_subscriptions` and `read_orders`/`write_orders` (charges), plus `read_plans` for adding products. `read_products` is not needed: Recharge's `GET /products` only works on Recharge "Custom" stores (on Shopify Checkout Integration it returns 422 "This API is not compatible with your platform"), so added products are read from Shopify instead.

#### Quantity changes and added products

- **Only listed arguments.** In verified mode `update_subscription` accepts only `customer_email`, `subscription_id` and `quantity`; `create_onetime` only `customer_email`, `address_id`, `variant_id`, `quantity` and `next_charge_scheduled_at`; `create_subscription` those plus `order_interval_frequency` and `order_interval_unit`. Any other argument (price, variant, interval, date, properties, anything unknown) is refused before any request, rather than silently dropped. In hosted mode the listed schemas and descriptions show only these arguments and the rules for the assistant.
- **Quantity cap.** `MCP_VERIFIED_MAX_QUANTITY` (whole number 1-10, default 2) caps the units of one product in one order: the subscription quantity being set, or the added quantity, plus units of that variant already due on that date (active subscriptions and one-time items at the address). Decreases down to 1 are always allowed.
- **No quantity changes on free or gift lines.** A subscription whose price is zero or missing, or that has a gift/promo property (a name starting `_gwp`, `gift`, `free` or `promo`, leading underscores ignored), is refused. Lines with other negotiated prices (for example employee pricing) are not detected.
- **Addable products.** Only variants in `MCP_VERIFIED_ADDABLE_VARIANTS` (`shopifyProductId:shopifyVariantId` pairs) can be added, and only while the Shopify storefront catalog returns them as an exact match under that same product, available, with a price above zero. Empty or unset means nothing can be added. The allowlist is still the real sellability control: remove a variant from the list when it stops being sold.
- **Catalog source.** Variant, title, price, currency and availability come from Shopify's public UCP storefront MCP endpoint (`MCP_SHOPIFY_UCP_URL`, for Ritual `https://ritual.com/api/ucp/mcp`; no token), calling its `lookup_catalog` tool with the variant GIDs, the shipping country (`context.address_country`) and this server's agent profile (`MCP_UCP_AGENT_PROFILE`, the hosted copy of `ucp/agent-profile.json`). Both must be https URLs, and a redirect from the endpoint is treated as a failure; if either is missing or invalid the server warns at startup, `find_addable_product` says adding isn't available, and `create_onetime`/`create_subscription` refuse with no write. Product descriptions, media and URLs in the response are dropped on read and never returned or logged.
- **Country and currency.** An add is made in the currency the customer is already subscribed in: the `presentment_currency` (else `currency`) of the active subscriptions at the verified address, which must all name the same one. Subscriptions in more than one currency, or one naming no readable currency (it is never assumed to be USD), refuse the add with no write and a hand-off. The catalog is read for the address's country (`country_code`; an address without one can't be added to), so a CA address sees CAD prices, and only that country's market is ever read: when it is not priced in the subscribed currency (a CA address with USD subscriptions, say) the add is refused before the catalog is read, and a catalog price in any other currency than the subscribed one (or, for US, CA and GB, than the market's USD, CAD or GBP) is never used. `find_addable_product` takes the currency from all of the customer's active subscriptions (none, or more than one currency, is refused) and the country all of the addresses holding them share, or US when they differ; that country's market must be priced in the currency, or the search is refused. Without a `customer_email` it uses US and USD. It returns `unit_price` (in the currency's minor-unit digits) with `currency`, and skips any variant priced in another currency. It reads all allowlisted variants at once (`lookup_catalog` takes at most 10 IDs per call, so the chunks are requested in parallel and any failed chunk fails the search) and skips any variant the catalog doesn't return as addable rather than failing the search. Write-time checks always read the catalog fresh. Any catalog failure (timeout after 8 seconds, redirect, non-2xx, JSON-RPC error, tool error, a message other than `info`, unreadable body) is a customer-safe refusal: "could not be looked up" for the search, "could not be checked" with no write for an add.
- **Finding the product (`find_addable_product`).** The query is the product name as the customer said it. It is matched in two stages (`src/utils/product-matching.js`), and the response says which with a top-level `match` next to `products`:
  - `"name"`: every meaningful word of the query matches a word of an addable product or variant title. Both sides are normalized first: case, accents, straight or curly apostrophes and possessive "s", trademark glyphs (™ ‡ * ®), `&`/"and", hyphens and digits run together (`omega-3`, `omega3` and `omega 3` are the same), plurals, "50 plus", "fifty plus" and "over 50" as `50+`, "multi", "multis" or "vitamins" as multivitamin, and male, him, his, guy as men and female, her, lady, ladies as women. Filler words (the, my, please, ritual, bottle, add, more, for, "to my subscription", too and the like) are ignored, and so is a request frame ending in "add" or "order" ("can you help me add sleep" and "I want to order sleep" are "sleep") and the retired "Essential" prefix unless it is the only word ("Essential for Women 18+" matches Women's Multivitamin 18+). The retired "Protein" is only ignored next to "shake" ("Essential Protein Daily Shake 18+" is Daily Shake); otherwise it must match, so "Essential Protein 18+" never matches a multivitamin by its age band and goes to the search, where "protein" is a Daily Shake alias; "protein" alone is a nutrient and matches nothing. A word may also be the start of a title word when it has 5+ letters or lacks only the title word's last letter ("magnes", "omeg"; "heal" is not "health", and the shorter abbreviations "mag", "peri", "choc" and "multi" are synonyms instead), or have one typo (words of 5+ letters; two for 9+), but a longer word is never a typo of a shorter title word ("shaker" is not "shake"), nor is the title word's stem with another ending ("perimenopausal" is not "perimenopause"), and numbers never fuzz (`18+` never matches `50+`). Flavor and size words must match the variant title, so "mint prenatal" returns only the Mint variant. A title without a number never stands in for the query's age band when a title with any number matches apart from that number, flavor and size ("citrus multivitamin 50+" is nothing, not Prenatal Multivitamin in Citrus, and so is "multivitamin 50+" with both 50+ products unavailable). Allowlisted variants the catalog returns under their product but that can't be sold now (out of stock, another currency) are matched too: if one matches more closely than every sellable one, or as closely under another product title, nothing is returned and nothing is searched, so the product the customer named is never swapped for a sibling ("daily shake" for Daily Shake Pregnancy & Postpartum, "women's multivitamin" for 50+ when 18+ is out of stock); another flavor of the same title is not a swap. Likewise, when the catalog returned none of an allowlisted product's variants (not found, or a partial lookup still cached), its title is unknown, so a title the query only partly names is nothing ("daily shake" with Daily Shake not found is never Daily Shake Pregnancy & Postpartum); a query naming every word of a title still matches it. Shopify's placeholder variant title "Default Title" is never matched. When some titles match without a typo, typo-only matches are dropped; titles with the fewest extra words come first.
  - `"interpreted"`: only when nothing matches by name, and only when every query word is a word of some addable title or one of the reviewed product aliases in `PRODUCT_ALIASES` (everyday names for a product's type or form such as "probiotic", "powder" and "protein" next to another Daily Shake word, each tied to the products it can name; never an ingredient: "fish oil", "melatonin" and "ceramides" name no product, by decision of 2026-10-29; new ones need Regulatory review), the query (whitespace collapsed, at most 100 characters) goes to the same UCP endpoint's `search_catalog` tool for the customer's country, asking for the top 5 results. So a word that names nothing sold here ("insomnia", "tired", "40+") is never searched. The best-ranked allowlisted product among them is returned, plus later ones in those 5 with the same title (a flavor sold as its own product), in Shopify's rank order, at most 3 products, but only a product whose title and aliases have every query word, and only its variants with the flavor and size words asked for; a product whose numbers or gender contradict the query's, or without an age band when one with the query's fits, is dropped. If a product that fails this ranks above every kept one ("postpartum vitamins" ranking Prenatal Multivitamin first), the search's guess was wrong and nothing is returned. Likewise if a product that can't be added ranks above every addable one and is allowlisted (out of stock, or priced in another currency) or matches the query by name (a bundle, an accessory): the customer named something that can't be added and nothing is returned, never a substitute. The search only chooses which allowlisted products to return: variant IDs, titles, prices, currency and availability always come from the cached `lookup_catalog` read in the subscribed currency, never from the search, and the search is never cached. The tool tells the assistant to confirm an interpreted product with the customer by name before adding it.
  - `"none"` (empty `products`): nothing matched, the query was only filler words, described a symptom, need or goal ("help me sleep", "something for stress", a goal clause: "I need more sleep", "get some sleep", "a pill to sleep", "I need more protein" (a quantity after "add", "order" or "can I get" is how much to add: "add one more iron", "can I get some creatine greens"), the customer describing themselves: "I'm pregnant", "I'm a woman over 50", "I've been tired", "I can't sleep", only what a product is for: "I need relief", "support", only a nutrient it contains: "dha", "protein", or what it is for ahead of any product name: "for pregnancy", "the one for stress"), had a word that names nothing sold here, or the search failed, timed out, returned a warning or an unreadable answer (any of the top 5 results without a product ID or title), or found only products that can't be added. A query of only "Essential" names no one product and is never searched. A failed search is never an error; it is logged under `DEBUG` with its status and code only (never the query or the customer).
  - `scripts/eval-product-matching.js` is a live, read-only check of this matching against the real catalog and search (no Recharge calls): set `MCP_SHOPIFY_UCP_URL`, `MCP_UCP_AGENT_PROFILE` and `MCP_VERIFIED_ADDABLE_VARIANTS` (and optionally `EVAL_COUNTRY`, default `US`) and run `node scripts/eval-product-matching.js`. It is not part of `npm test`.
- **Search cache (60 minutes, shared).** Behind a stateless HTTP gateway (supergateway's stateless streamableHttp mode starts a new process per request) an in-memory cache never hits, so `find_addable_product`'s catalog read is cached for 60 minutes as one JSON file per catalog endpoint, agent profile, country, currency and allowlist (a SHA-256 of all five, so changing any of them never serves an old entry) in `MCP_CATALOG_CACHE_DIR` (default `<os tmpdir>/recharge-mcp-catalog-cache`), shared by every process in the container. The directory is created `0700`; an existing one must be owned by the server's user and already `0700`, otherwise it is left untouched and the cache is skipped (so never point this at a shared directory such as `/tmp` itself); files are `0600` and written atomically (temp file, then rename). Entries hold only IDs, titles, price, currency and availability, never descriptions. Only a lookup where every chunk succeeded, at least one variant came back and every variant is priced in the subscribed currency is stored; a missing, unreadable, malformed (including a price a fresh lookup could not produce), expired, wrong-version or other-currency entry is a miss, and a cache that can't be written is skipped, so the search still returns a fresh result. Only `find_addable_product` uses the cache: `create_onetime` and `create_subscription` always read the variant fresh from the catalog and never read or write it, so a price or availability change within the hour can show in a search but never in what is added or charged.
- **Price.** The price is never sent: Recharge prices the item. After the write, the price on the returned one-time or subscription must be above zero and no more than the catalog price, and in the customer's subscribed currency, which the catalog price was checked to be in too (`presentment_currency`, else `currency`; a record naming neither is only accepted when that currency is USD, the store's base currency); otherwise the record is deleted again and the add is refused (or, if that delete fails, the assistant is told not to retry and to hand off). Compare-at prices are never used.
- **One-time adds always join an existing order.** The date must be the date of one of the customer's queued charges on that address dated after today everywhere (today in UTC+14), so a charge Recharge may be processing is never joined; late in the US day this also excludes tomorrow's charges. With no such charge the add is refused rather than creating a separate shipment.
- **Recurring adds copy an existing schedule.** The requested interval must match an active, non-prepaid subscription on that address whose next charge is the requested date, and the product must have a subscription plan on that interval. The new subscription copies that subscription's interval fields (and day of month/week) and sends that plan's `plan_id`, so the plan's subscription discount can apply.
- **Checks fail closed.** If a read before the write fails (missing scope, rate limit, 5xx) or a schema check fails, the assistant gets a customer-safe refusal saying nothing was changed, never a raw API or validation error.
- **Write failures.** If Recharge rejects the write (4xx) the assistant is told nothing was changed. If the outcome is unknown (5xx or timeout) it is told not to retry and to hand off, so an add is never duplicated. With `DEBUG=true` the Recharge error message is logged (anything email-shaped removed).
- **No concurrency guard.** The checks and the write are not atomic: two simultaneous calls for the same address can both pass the duplicate and per-order checks. Fin works one conversation at a time per customer, so this is accepted rather than locked.
- `delete_onetime` is not a verified write tool, so in hosted mode an add can only be undone by a person.

### Important: API URL Behavior

- **Default**: Uses production API (`https://api.rechargeapps.com`) when `RECHARGE_API_URL` is not set
- **Custom URL**: Only uses alternative URL if explicitly specified and valid
- **No Fallback**: If custom URL is invalid, server fails to start (prevents unintentional production changes)
- **Security**: All URLs must use HTTPS protocol

### Per-Tool Configuration

Override environment variables in individual tool calls:

```json
{
  "name": "get_subscriptions",
  "arguments": {
    "store_url": "different-shop.myshopify.com",
    "admin_token": "different_admin_api_token",
    "customer_email": "customer@example.com"
  }
}
```

### Configuration Validation

```bash
# Validate configuration
npm run validate

# Test environment setup
npm run test:api-keys

# Check project health
npm run health
```

## Usage

### Starting the Server

```bash
# Production mode
npm start

# Development mode with file watching
npm run dev

# Development with debug logging
npm run dev:debug

# Debug mode (production)
DEBUG=true npm start
```

## Available Tools

### Customer Management (10 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_customer` | Get current customer information | `customer_email` or `customer_id` |
| `update_customer` | Update customer profile | `email`, `first_name`, `last_name`, `phone` |
| `get_customer_by_email` | Find customer by email (returns ID) | `email` |
| `create_customer_session_by_id` | Create session manually | `customer_id`, `return_url` |
| `get_delivery_schedule` | Get upcoming delivery schedule | `limit` |
| `get_customer_portal_access` | Get portal access URL | `page_destination` |
| `get_churn_landing_page_url` | Get cancellation landing page URL | `subscription_id`, `redirect_url` |
| `get_payment_recovery_url` | Get failed payment recovery URL | - |
| `get_gift_redemption_url` | Get gift redemption landing page | `gift_id`, `redirect_url` |
| `send_customer_notification` | Send notification to customer | `notification_type`, `address_id` |

### Subscription Management (14 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_subscriptions` | List customer subscriptions | `status`, `limit`, `page` |
| `get_subscription` | Get subscription details | `subscription_id` |
| `create_subscription` | Create new subscription | `address_id`, `variant_id`, `quantity`, `frequency` |
| `update_subscription` | Modify subscription | `subscription_id`, `quantity`, `frequency` |
| `skip_subscription` | Skip delivery date | `subscription_id`, `date` |
| `unskip_subscription` | Restore skipped delivery | `subscription_id`, `date` |
| `swap_subscription` | Change product variant | `subscription_id`, `variant_id` |
| `cancel_subscription` | Cancel subscription | `subscription_id`, `reason` |
| `activate_subscription` | Reactivate subscription | `subscription_id` |
| `set_subscription_next_charge_date` | Set next charge date | `subscription_id`, `date` |
| `change_subscription_address` | Move subscription to different address | `subscription_id`, `address_id` |
| `skip_gift_subscription_charge` | Gift subscription to recipient | `subscription_ids`, `recipient_email` |
| `bulk_create_subscriptions` | Create multiple subscriptions | `subscriptions[]` |
| `bulk_update_subscriptions` | Update multiple subscriptions (max 20) | `address_id`, `subscriptions[]` |

### Address Management (9 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_addresses` | List customer addresses | - |
| `get_address` | Get address details | `address_id` |
| `create_address` | Add new address | `address1`, `city`, `province`, `zip`, `country` |
| `update_address` | Modify address | `address_id`, address fields |
| `delete_address` | Remove address | `address_id` |
| `apply_discount_to_address` | Apply discount to all subscriptions at address | `address_id`, `discount_code` |
| `remove_discount_from_address` | Remove discounts from address subscriptions | `address_id` |
| `merge_addresses` | Merge two addresses (move subscriptions) | `address_id`, `source_address_id` |
| `skip_address_charge` | Skip a charge for all address subscriptions | `address_id`, `charge_id` |

### Payment Methods (3 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_payment_methods` | List payment methods | - |
| `get_payment_method` | Get payment details | `payment_method_id` |
| `update_payment_method` | Update billing info | `payment_method_id`, billing fields |

### Product Catalog (3 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_products` | Browse available products | `limit`, `handle` |
| `get_product` | Get product details | `product_id` |
| `search_products` | Search products by query | `query`, `limit` |

### Plan Management (2 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_plans` | List subscription plans | `limit`, `external_product_id` |
| `get_plan` | Get plan details | `plan_id` |

### Order History (2 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_orders` | List customer orders | `status`, `limit`, `page` |
| `get_order` | Get order details | `order_id` |

### Charge Management (8 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_charges` | List charges | `status`, `limit`, `page` |
| `get_charge` | Get charge details | `charge_id` |
| `apply_discount_to_charge` | Apply discount code to charge | `charge_id`, `discount_code` |
| `remove_discount_from_charge` | Remove discounts from charge | `charge_id` |
| `skip_charge` | Skip a scheduled charge | `charge_id` |
| `unskip_charge` | Unskip a previously skipped charge | `charge_id` |
| `process_charge` | Process charge immediately | `charge_id` |
| `reschedule_charge` | Reschedule charge to new date | `charge_id`, `scheduled_at` |

### One-time Products (5 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_onetimes` | List one-time products | - |
| `get_onetime` | Get one-time details | `onetime_id` |
| `create_onetime` | Add to next delivery | `variant_id`, `quantity`, `next_charge_scheduled_at` |
| `update_onetime` | Modify one-time product | `onetime_id`, update fields |
| `delete_onetime` | Remove one-time product | `onetime_id` |

### Bundle Management (7 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_bundles` | List customer bundles | `subscription_id` |
| `get_bundle` | Get bundle details | `bundle_id` |
| `get_bundle_selections` | List bundle selections | `bundle_id` |
| `get_bundle_selection` | Get selection details | `bundle_selection_id` |
| `create_bundle_selection` | Create selection | `bundle_id`, `variant_id`, `quantity` |
| `update_bundle_selection` | Update selection | `bundle_selection_id`, update fields |
| `delete_bundle_selection` | Remove selection | `bundle_selection_id` |

### Authentication (8 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `login_shopify_app_proxy` | Login via Shopify App Proxy | - |
| `login_with_shopify_storefront` | Login via Shopify Storefront API | `shopify_storefront_token` |
| `login_with_shopify_customer_account` | Login via Shopify Customer Account | `shopify_customer_access_token` |
| `send_passwordless_code` | Send passwordless login code | `email`, `send_email`, `send_sms` |
| `validate_passwordless_code` | Validate passwordless code | `email`, `session_token`, `code` |
| `send_passwordless_code_app_proxy` | Passwordless via App Proxy | `email` |
| `validate_passwordless_code_app_proxy` | Validate via App Proxy | `email`, `session_token`, `code` |
| `login_customer_portal` | Login from Customer Portal | - |

### Utility Tools (4 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `purge_session_cache` | Clear cached session tokens | `all`, `older_than_minutes`, `reason` |
| `get_session_cache_stats` | View cache statistics | - |
| `get_shipping_countries` | Get list of countries store ships to | - |
| `get_store_settings` | Get store configuration and settings | - |

### Collections (3 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_collections` | List product collections | `limit`, `sort_by`, `cursor` |
| `get_collection` | Get collection details | `collection_id` |
| `get_collection_products` | Get products in collection | `collection_id`, `format_version` |

### Credits (3 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_credit_summary` | Get customer credit balance | `include` |
| `set_apply_credits` | Enable/disable auto-apply credits | `recurring` |
| `get_credit_accounts` | List credit accounts | `limit`, `sort_by`, `cursor` |

### Gifts (2 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_gift_purchases` | List gifts available to customer | - |
| `get_gift_purchase` | Get gift details | `gift_id` |

### Metafields (3 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `create_metafield` | Create metafield on resource | `key`, `namespace`, `owner_id`, `owner_resource`, `value` |
| `update_metafield` | Update existing metafield | `metafield_id`, `value`, `description` |
| `delete_metafield` | Delete metafield | `metafield_id` |

## Usage Examples

### 1. Basic Customer Operations

#### Customer Lookup
```json
// Find customer by email
{
  "name": "get_customer_by_email",
  "arguments": {
    "email": "customer@example.com"
  }
}

// Get customer details with automatic session creation
{
  "name": "get_customer",
  "arguments": {
    "customer_email": "customer@example.com"
  }
}

// Update customer information with Unicode support
{
  "name": "update_customer",
  "arguments": {
    "customer_email": "customer@example.com",
    "first_name": "José",
    "last_name": "García",
    "phone": "+34-123-456-789"
  }
}
```

### 2. Customer Service Workflow

```json
// 1. Look up customer
{
  "name": "get_customer",
  "arguments": {"customer_email": "customer@example.com"}
}

// 2. Check their subscriptions
{
  "name": "get_subscriptions",
  "arguments": {"customer_email": "customer@example.com"}
}

// 3. View recent orders
{
  "name": "get_orders",
  "arguments": {"customer_email": "customer@example.com"}
}
```

### 3. Subscription Management Workflow

```json
// 1. Get subscription details
{
  "name": "get_subscription",
  "arguments": {
    "customer_email": "customer@example.com",
    "subscription_id": "sub_123"
  }
}

// 2. Skip next delivery
{
  "name": "skip_subscription",
  "arguments": {
    "customer_email": "customer@example.com",
    "subscription_id": "sub_123",
    "date": "2024-02-15"
  }
}

// 3. Add one-time product to next delivery
{
  "name": "create_onetime",
  "arguments": {
    "customer_email": "customer@example.com",
    "variant_id": 789012,
    "quantity": 1,
    "next_charge_scheduled_at": "2024-02-15"
  }
}
```

### 4. Advanced Multi-Customer Operations

```json
// Customer A operations
{"name": "get_subscriptions", "arguments": {"customer_email": "alice@example.com"}}

// Customer B operations  
{"name": "get_orders", "arguments": {"customer_email": "bob@example.com"}}

// Back to Customer A (reuses cached session)
{"name": "get_addresses", "arguments": {"customer_email": "alice@example.com"}}
```

### 5. Session Cache Management

```json
// Clear all cached sessions (recommended when switching environments)
{
  "name": "purge_session_cache",
  "arguments": {
    "all": true,
    "reason": "switching from dev to production"
  }
}

// Clear only sessions older than 2 hours
{
  "name": "purge_session_cache",
  "arguments": {
    "all": false,
    "older_than_minutes": 120,
    "reason": "cleanup old sessions"
  }
}

// Check cache statistics
{
  "name": "get_session_cache_stats",
  "arguments": {}
}
```

### 5. Error Handling and Troubleshooting

```json
// This will fail with helpful error message
{
  "name": "get_subscription", 
  "arguments": {
    "subscription_id": "invalid_id"
  }
}

// Error response:
{
  "content": [
    {
      "type": "text",
      "text": "API Error (404): Subscription not found\n\nTip: Verify the resource ID exists and you have access to it."
    }
  ],
  "isError": true
}
```

## Unicode and International Support

### Full Unicode Support

The server provides comprehensive Unicode support for international customers:

#### Customer Names
- **Unicode Normalization**: NFC normalization for consistent storage
- **International Characters**: Support for letters, marks, numbers from all languages
- **Character Validation**: Prevents control characters while allowing proper Unicode
- **Length Limits**: 255 characters maximum for names

#### International Addresses
- **Address Fields**: Full Unicode support for street addresses, cities, provinces
- **Postal Codes**: Country-specific validation for US, Canada, UK formats
- **Phone Numbers**: International E.164 format support
- **Character Encoding**: Proper handling of international characters and diacritics (emojis and special symbols not supported by shipping providers)

#### Validation Features
- **NFC Normalization**: Canonical decomposition and composition
- **Control Character Removal**: Strips problematic characters
- **Whitespace Normalization**: Consistent spacing handling
- **Length Validation**: Appropriate limits for each field type
- **Shipping Compatibility**: Restricts characters that may cause issues with shipping labels and payment processors

#### Examples

```json
// International customer update
{
  "name": "update_customer",
  "arguments": {
    "customer_email": "müller@example.de",
    "first_name": "François",
    "last_name": "Müller",
    "phone": "+49-30-12345678"
  }
}

// International address creation
{
  "name": "create_address",
  "arguments": {
    "customer_email": "tanaka@example.jp",
    "first_name": "Tanaka",
    "last_name": "Taro", 
    "address1": "1-2-3 Jinnan, Shibuya-ku",
    "city": "Tokyo",
    "province": "Tokyo",
    "zip": "150-0041",
    "country": "Japan",
    "phone": "+81-3-1234-5678"
  }
}

// Note: While Unicode letters are supported (José, Müller, etc.), 
// emojis and mathematical symbols are not supported by shipping providers
```

## Development

### Development Setup

```bash
# Install dependencies
npm install

# Setup environment
npm run setup

# Start development server
npm run dev
```

### Development Commands

```bash
# Development with file watching
npm run dev

# Development with debug logging
npm run dev:debug

# Validate code and configuration
npm run validate

# Check API coverage
npm run coverage

# View project statistics
npm run health
```

### Code Quality

```bash
# Lint code
npm run lint

# Validate syntax
npm run validate

# Test API key logic
npm run test:api-keys

# Health check
npm run health
```

### Adding New Tools

1. **Create tool file**: `src/tools/new-feature-tools.js`
2. **Follow patterns**: Use existing tools as templates
3. **Add to index**: Export from `src/tools/index.js`
4. **Add client methods**: Implement in `src/recharge-client.js`
5. **Test thoroughly**: Use `npm run validate`

### Debugging

Enable debug mode for detailed logging:

```bash
DEBUG=true npm start
```

Debug output includes:
- API request/response details
- Authentication flow tracing
- Session creation and caching
- Error stack traces
- Performance metrics

## Testing

### Available Test Commands

```bash
# Run all tests
npm run test

# Run comprehensive test suite
npm run test:full

# Validate API key logic
npm run test:api-keys

# Check syntax and configuration
npm run validate

# View API coverage
npm run coverage
```

### Test Categories

#### 1. Syntax and Configuration Tests
- Node.js version validation
- Package.json integrity
- Environment file validation
- Source file syntax checking

#### 2. API Integration Tests
- Authentication flow validation
- Session management testing
- Error handling verification
- Unicode support validation

#### 3. Business Logic Tests
- Subscription frequency validation
- Variant existence checking
- Address format validation
- Customer data handling

#### 4. Security Tests
- Token handling validation
- Customer data isolation
- Input sanitization
- Error message security

### Running Specific Tests

```bash
# Test environment setup
npm run test:api-keys

# Validate all configurations
npm run validate

# Check project health
npm run health

# Test MCP protocol startup
npm run mcp:test
```

## Troubleshooting

### Common Issues

#### Authentication Errors

**Problem**: `Customer not found`
```bash
# Solution: Check customer ID and merchant token
# Ensure customer exists in Recharge system
# Verify merchant token has Storefront API permissions
```

**Problem**: `Invalid merchant token`
```bash
# Solution: Verify token type and permissions
# Use Admin API token (not Storefront API)
# Check token hasn't expired or been revoked
```

**Problem**: `403 Forbidden` on write operations (skip, update, cancel)
```bash
# Solution: Check token permissions
# Your Admin API token needs WRITE permissions, not just read
# Go to Recharge admin → API tokens → Check permissions
# Ensure token has: write_subscriptions, write_customers, write_orders
# Create new token with full permissions if needed
```

**Problem**: Read operations work but write operations fail with 403
```bash
# This is a classic token permissions issue
# Your token has read permissions but missing write permissions
# Solution: Update token permissions to include ALL write scopes:
# - write_customers
# - write_subscriptions  
# - write_orders
# - write_addresses
# - write_payment_methods
# - write_discounts
```
#### Configuration Issues

**Problem**: `No store URL available`
```bash
# Solution: Set environment variable or provide in tool calls
export RECHARGE_STOREFRONT_DOMAIN=your-shop.myshopify.com
```

**Problem**: `Domain must end with .myshopify.com`
```bash
# Solution: Use correct Shopify domain format
# Correct: shop.myshopify.com
# Incorrect: shop.com
```

**Problem**: `Invalid RECHARGE_API_URL specified`
```bash
# Solution: Fix or remove the custom API URL
# The server will NOT fall back to production to prevent unintentional changes

# Option 1: Fix the URL format (must be HTTPS)
# IMPORTANT: Only specify this for non-production environments
# If invalid URL is specified, server will fail to start (no fallback to production)
# This prevents unintentional production changes when intending to use staging/test
# Production: https://api.rechargeapps.com (default - don't specify)
# Staging: https://api.stage.rechargeapps.com
# Sandbox: https://api.sandbox.rechargeapps.com
#RECHARGE_API_URL=https://api.stage.rechargeapps.com

# Option 2: Remove the setting to use production
# Comment out or delete the RECHARGE_API_URL line in .env

# Option 3: Use a valid staging/test URL
# Staging: https://api.stage.rechargeapps.com
# Sandbox: https://api.sandbox.rechargeapps.com
```

#### Unicode and Character Issues

**Problem**: `Invalid characters in name/address`
```bash
# Solution: Use proper Unicode characters
# Allowed: Letters, numbers, spaces, punctuation
# Avoid: Control characters, special symbols
# Use international formats for phone numbers
```

**Problem**: `Postal code format invalid`
```bash
# Solution: Use country-specific formats
# US: 12345 or 12345-6789
# Canada: A1A 1A1 or A1A1A1
# UK: SW1A 1AA or M1 1AA
```

#### Subscription Issues

**Problem**: `Invalid subscription frequency`
```bash
# Solution: Use valid frequency ranges
# Daily: 1-90 days
# Weekly: 1-52 weeks  
# Monthly: 1-12 months
# Maximum total: 365 days
```

**Problem**: `Variant not found or not subscription-enabled`
```bash
# Solution: Validate variant exists and is configured
# Use get_products to find valid variants
# Ensure product is enabled for subscriptions
# Check storefront_purchase_options setting
```

#### Redirect Issues

**Problem**: `Too many redirects` or `API returned redirect`
```bash
# Common causes and solutions:

# 1. Incorrect store URL format
# Use: your-shop.myshopify.com
# Not: your-shop.com or https://your-shop.myshopify.com

# 2. Invalid authentication tokens
# Verify your tokens are correct and have proper permissions

# 3. API endpoint issues
# Enable debug mode to see redirect details:
DEBUG=true npm start

# 4. Check if store has Recharge installed
# Verify Recharge is properly installed on the Shopify store

# 5. Token type mismatch  
# Ensure you're using Admin API tokens, not Storefront API tokens
# Storefront API tokens may cause OAuth redirects

# 6. Domain validation issues
# Ensure domain follows exact format: shop-name.myshopify.com
# No trailing slashes, no protocol prefix, lowercase
```

#### Session Issues

**Problem**: `Cross-environment token contamination`
```bash
# Solution: Purge session cache when switching environments
# Use the purge_session_cache tool to clear cached tokens
# This prevents dev tokens from being used in production
```

**Problem**: `Too many cached sessions affecting performance`
```bash
# Solution: Clean up old sessions periodically
# Use purge_session_cache with older_than_minutes parameter
# Or check get_session_cache_stats to monitor cache size
```

**Problem**: `Customer session token expired`
```bash
# Solution: Customer session tokens are automatically recreated
# Provide customer_id or customer_email in next call
```

**Problem**: `Security Error: Cannot use default customer session token`
```bash
# Solution: Always specify customer identification
# Add customer_email or customer_id to tool calls
```

**Problem**: `Session creation returned invalid token`
```bash
# Solution: Check admin token permissions and format
# Ensure admin token has customer session creation permissions
# Verify token is not expired or revoked
```

### Debug Mode

Enable comprehensive debugging:

```bash
DEBUG=true npm start
```

Debug information includes:
- Authentication flow details
- API request/response logging
- Customer session token creation and caching
- Error stack traces
- Performance metrics
- Unicode normalization details

### Getting Help

1. **Check Documentation**: Review this README
2. **Enable Debug Mode**: Use `DEBUG=true` for detailed logging
3. **Validate Setup**: Run `npm run validate`
4. **Test API Keys**: Run `npm run test:api-keys`
5. **Check Coverage**: Run `npm run coverage`
6. **Run Full Tests**: Run `npm run test:full`

## Security

### Security Best Practices

#### API Token Security
- **Never commit tokens** to version control
- **Use environment variables** for sensitive data
- **Rotate tokens regularly** (recommended: every 90 days)
- **Use minimum required permissions**

#### Customer Data Protection
- **Always specify customer identification** in tool calls
- **Verify customer access** before operations
- **Use session tokens** for customer-scoped operations
- **Monitor for unusual access patterns**

#### Network Security
- **Use HTTPS** for all API communications (handled automatically by axios)
- **Implement proper firewall rules**
- **Monitor API usage** for anomalies
- **Be aware of Recharge API rate limits**

#### Unicode Security
- **Normalize Unicode input** to prevent encoding attacks
- **Validate character sets** to prevent injection
- **Sanitize control characters** from user input
- **Use proper encoding** for international data

### Security Features

#### Built-in Protections
- **Customer data isolation**: Each customer gets separate session token
- **Wrong customer prevention**: Blocks ambiguous tool calls
- **Input validation**: Zod schema validation for all inputs
- **Error sanitization**: Sensitive data removed from logs and error messages
- **Session token caching**: Secure in-memory session management
- **Automatic session renewal**: Expired sessions recreated transparently
- **Parameter cleanup**: Sensitive parameters removed from API requests
- **Session cache isolation**: Environment-specific session management
- **Unicode normalization**: Prevents encoding-based attacks
- **API URL validation**: Custom URLs must use HTTPS, no fallback to production
- **Fail-fast configuration**: Invalid settings caught at startup

### Reporting Security Issues

For security issues, please follow responsible disclosure practices and contact the project maintainers directly.

## Performance

### Performance Features

#### Session Management
- **Intelligent Caching**: Customer sessions cached to avoid repeated API calls
- **Automatic Renewal**: Expired sessions renewed transparently
- **Environment Isolation**: Session cache can be purged when switching environments
- **Multi-Customer Support**: Efficient handling of multiple customer sessions

#### Request Optimization
- **Connection Pooling**: Axios instances with optimized connection handling
- **Request Timeouts**: 30-second timeouts prevent hanging requests
- **Error Recovery**: Automatic retry for expired session tokens

#### Memory Management
- **Efficient Caching**: In-memory session cache with automatic cleanup
- **Unicode Normalization**: Optimized Unicode processing
- **Garbage Collection**: Proper cleanup of expired sessions

#### Monitoring
- **Debug Logging**: Comprehensive performance metrics when enabled
- **Request Tracking**: Monitor API call patterns and response times
- **Error Tracking**: Track error rates and types

### Performance Tips

1. **Reuse Customer Sessions**: Use the same customer email/ID for related operations
2. **Enable Caching**: Let the server cache customer sessions automatically
3. **Batch Operations**: Group related operations for the same customer
4. **Purge When Switching Environments**: Use `purge_session_cache` when switching between dev/test/production
4. **Monitor Debug Output**: Use `DEBUG=true` to identify performance bottlenecks

## Contributing

Contributions are welcome! When contributing:

- **Follow existing patterns**: Use the established code structure and naming conventions
- **Add proper validation**: Use Zod schemas for all new tool parameters
- **Test thoroughly**: Run `npm run test:full` before submitting changes
- **Update documentation**: Keep the README current with any changes
- **Handle errors properly**: Use the existing error handling patterns
- **Support Unicode**: Ensure international character support in new features
- **Add business validation**: Include appropriate business rule validation

### Development Guidelines

1. **Code Quality**: Follow existing patterns and use proper TypeScript/JSDoc
2. **Testing**: Add tests for new functionality
3. **Documentation**: Update README and inline documentation
4. **Security**: Follow security best practices
5. **Performance**: Consider performance implications of changes
6. **Unicode Support**: Ensure proper international character handling

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

## Support

### Resources
- **Documentation**: This README and comprehensive inline code documentation
- **Examples**: Complete usage examples throughout this README
- **Debug Mode**: Detailed logging for troubleshooting
- **Test Suite**: Comprehensive testing tools

### Getting Help
- **Debug Mode**: Enable with `DEBUG=true` for troubleshooting
- **Validation**: Run `npm run validate` to check setup
- **Coverage**: Run `npm run coverage` to see API coverage
- **Full Tests**: Run `npm run test:full` for comprehensive testing

### Project Statistics
- **59 Tools**: Complete Recharge Storefront API coverage
- **11 Categories**: Comprehensive subscription management
- **Production Ready**: Error handling, logging, and monitoring
- **Secure**: Built-in customer data protection with session token isolation
- **International**: Full Unicode support for global customers
- **Well Documented**: Comprehensive guides and examples
- **Thoroughly Tested**: Comprehensive test suite with multiple validation layers

---

*Built with care for the Recharge and MCP communities*

**Last Updated:** January 26, 2026
