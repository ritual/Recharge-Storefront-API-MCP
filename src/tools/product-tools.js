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
      'Do not list or present products as options. No match means it can\'t be added here; hand off to a support agent. ' +
      'Never describe what a product does or make any health, ingredient or benefit claim.',
    inputSchema: baseSchema.extend({
      query: z.string().min(1).max(100).describe('The product name the customer used'),
    }),
    execute: async (client, args) => {
      if (client.addableVariants.size === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'Adding products isn\'t available here; hand off to a support agent.',
            },
          ],
        };
      }

      // Admin catalog read; caller tokens are stripped in hosted mode, so this uses the server's admin token
      let result;
      try {
        result = await client.findAddableProducts(args.query);
      } catch (error) {
        if (process.env.DEBUG === 'true') {
          console.error(`[DEBUG] find_addable_product failed with status ${error.statusCode ?? 'unknown'}`);
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
      const text = result.products.length === 0
        ? `No product matching "${args.query}" can be added here; hand off to a support agent.`
        : `Addable Products:\n${JSON.stringify(result, null, 2)}`;

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