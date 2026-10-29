/**
 * Product catalog tools
 * Last updated: 2024-12-24
 */
import * as z from 'zod';

const baseSchema = z.object({
  customer_id: z.string().optional().describe('Customer ID for automatic session creation (optional, used when no session_token provided)'),
  customer_email: z.string().email().optional().describe('Customer email for automatic lookup and session creation (optional, used when no session_token or customer_id provided)'),
  session_token: z.string().optional().describe('Recharge session token (optional, takes precedence over environment variable if provided)'),
  admin_token: z.string().optional().describe('Recharge admin token (optional, takes precedence over environment variable if provided)'),
  store_url: z.string().optional().describe('Store URL (optional, takes precedence over environment variable if provided)'),
});

const productListSchema = z.object({
  customer_id: z.string().optional().describe('Customer ID for automatic session creation (optional, used when no session_token provided)'),
  customer_email: z.string().email().optional().describe('Customer email for automatic lookup and session creation (optional, used when no session_token or customer_id provided)'),
  session_token: z.string().optional().describe('Recharge session token (optional, takes precedence over environment variable if provided)'),
  admin_token: z.string().optional().describe('Recharge admin token (optional, takes precedence over environment variable if provided)'),
  store_url: z.string().optional().describe('Store URL (optional, takes precedence over environment variable if provided)'),
  limit: z.number().max(250).default(50).describe('Number of products to return'),
  handle: z.string().optional().describe('Filter by product handle'),
  subscription_defaults: z.boolean().optional().describe('Include subscription defaults'),
});

const productSchema = z.object({
  customer_id: z.string().optional().describe('Customer ID for automatic session creation (optional, used when no session_token provided)'),
  customer_email: z.string().email().optional().describe('Customer email for automatic lookup and session creation (optional, used when no session_token or customer_id provided)'),
  session_token: z.string().optional().describe('Recharge session token (optional, takes precedence over environment variable if provided)'),
  admin_token: z.string().optional().describe('Recharge admin token (optional, takes precedence over environment variable if provided)'),
  store_url: z.string().optional().describe('Store URL (optional, takes precedence over environment variable if provided)'),
  product_id: z.string().describe('The product ID'),
});

export const productTools = [
  {
    name: 'get_products',
    description: 'Get available products with optional filtering',
    inputSchema: productListSchema,
    execute: async (client, args) => {
      const params = { ...args };
      delete params.customer_id;
      delete params.customer_email;
      delete params.session_token;
      delete params.admin_token;
      delete params.store_url;
      const products = await client.getProducts(params, args.customer_id, args.customer_email, args.session_token);

      return {
        content: [
          {
            type: 'text',
            text: `Products:\n${JSON.stringify(products, null, 2)}`,
          },
        ],
      };
    },
  },
  {
    name: 'get_product',
    description: 'Get detailed information about a specific product',
    inputSchema: productSchema,
    execute: async (client, args) => {
      const { product_id } = args;
      const product = await client.getProduct(product_id, args.customer_id, args.customer_email, args.session_token);

      return {
        content: [
          {
            type: 'text',
            text: `Product Details:\n${JSON.stringify(product, null, 2)}`,
          },
        ],
      };
    },
  },
  {
    name: 'find_addable_product',
    description:
      'Look up only the product the customer named, among the products that can be added to their orders here. ' +
      'The query is the product name exactly as the customer said it (an old name, abbreviation, flavor or misspelling is fine), ' +
      'never a symptom, need or goal. ' +
      'The result\'s match is "name" when the customer\'s words match a product\'s title, ' +
      '"interpreted" when they did not and the store matched the customer\'s words to a product: ' +
      'confirm an interpreted product with the customer by its product name only, before quoting a price or making any change. ' +
      'Never list or offer products the customer didn\'t name, and do not present results as options. ' +
      'match "none" means it can\'t be added here; hand off to a support agent. ' +
      'Never describe what a product does or make any health, ingredient or benefit claim.',
    inputSchema: baseSchema.extend({
      query: z.string().min(1).max(100).describe('The product name the customer used, as they said it'),
    }),
    execute: async (client, args) => {
      // No allowlist or no Shopify catalog configured: nothing can be added
      if (client.addableVariants.size === 0 || !client.catalog) {
        return {
          content: [
            {
              type: 'text',
              text: 'Adding products isn\'t available here; hand off to a support agent.',
            },
          ],
        };
      }

      // Public Shopify storefront catalog read, plus admin reads (caller tokens are stripped in
      // hosted mode, so the server's admin token) of the customer's addresses and active subscriptions
      // for the country, currency and plans
      let result;
      try {
        result = await client.findAddableProducts(args.query, args.customer_email);
      } catch (error) {
        if (error && error.verifiedRefusal) {
          // Unknown or ambiguous customer: the customer-safe refusal, never a raw error
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
        if (process.env.DEBUG === 'true') {
          const code = error && error.code ? ` (${error.code})` : '';
          console.error(`[DEBUG] find_addable_product failed with status ${(error && error.statusCode) ?? 'unknown'}${code}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: 'Products could not be looked up right now, so nothing can be added; hand off to a support agent.',
            },
          ],
          isError: true,
        };
      }
      let text;
      if (result.products.length === 0) {
        text = `No product matching "${args.query}" can be added here; hand off to a support agent.`;
      } else if (result.match === 'interpreted') {
        text = 'No product title matches these words; this is the product the store matched to the customer\'s words ' +
          '(listed once per flavor or size). Confirm it with the customer by its product name only, without describing it ' +
          'or giving any reason or benefit, before quoting a price or making any change. ' +
          'Do not offer any other product or search result as a suggestion.\n' +
          `Addable Products:\n${JSON.stringify(result, null, 2)}`;
      } else {
        text = `Addable Products:\n${JSON.stringify(result, null, 2)}`;
      }

      return {
        content: [
          {
            type: 'text',
            text,
          },
        ],
      };
    },
  },
  {
    name: 'search_products',
    description: 'Search for products using a query string. Useful for finding products by name, title, or other attributes.',
    inputSchema: baseSchema.extend({
      query: z.string().describe('Search query string'),
      limit: z.number().max(250).default(50).optional().describe('Number of results to return'),
      format_version: z.enum(['2020-12', '2022-06']).default('2022-06').optional().describe('API response format version'),
    }),
    execute: async (client, args) => {
      const { query, limit, format_version } = args;
      const params = {
        ...(limit && { limit }),
        ...(format_version && { format_version }),
      };
      const products = await client.productSearch(query, params, args.customer_id, args.customer_email, args.session_token);

      return {
        content: [
          {
            type: 'text',
            text: `Search Results for "${query}":\n${JSON.stringify(products, null, 2)}`,
          },
        ],
      };
    },
  },
];