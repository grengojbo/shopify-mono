import { Hono } from 'hono';
import { createMonoClient } from './lib/mono-client';
import { createShopifyClient } from './lib/shopify-client';
import { createInvoiceHandler } from './routes/create-invoice';

export type Env = {
  DB: D1Database;
  MONO_TOKEN: string;
  SHOPIFY_ADMIN_TOKEN: string;
  SHOPIFY_STORE_DOMAIN: string;
};

export const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/create-invoice', (c) =>
  createInvoiceHandler({
    shopify: createShopifyClient({
      storeDomain: c.env.SHOPIFY_STORE_DOMAIN,
      adminToken: c.env.SHOPIFY_ADMIN_TOKEN,
    }),
    mono: createMonoClient({ token: c.env.MONO_TOKEN }),
    db: c.env.DB,
    now: () => Math.floor(Date.now() / 1000),
  })(c),
);

// Наповнюється на етапі 6 (нагадування + чистка unpaid, PRD §11).
async function scheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {}

export default {
  fetch: app.fetch,
  scheduled,
};
