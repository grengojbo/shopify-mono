import { Hono } from 'hono';
import { createMonoClient } from './lib/mono-client';
import { createPubkeyProvider, type PubkeyProvider } from './lib/mono-pubkey';
import { createShopifyClient } from './lib/shopify-client';
import { createInvoiceHandler } from './routes/create-invoice';
import { monoWebhookHandler } from './routes/mono-webhook';

export type Env = {
  DB: D1Database;
  MONO_TOKEN: string;
  SHOPIFY_ADMIN_TOKEN: string;
  SHOPIFY_STORE_DOMAIN: string;
};

// Кеш публічного ключа mono живе на рівні модуля — між запитами одного
// ізоляту. Створюється ліниво, бо токен доступний лише в контексті запиту.
let pubkeyProvider: PubkeyProvider | null = null;

function getPubkeyProvider(env: Env): PubkeyProvider {
  if (!pubkeyProvider) {
    const mono = createMonoClient({ token: env.MONO_TOKEN });
    pubkeyProvider = createPubkeyProvider(() => mono.getPubkey());
  }
  return pubkeyProvider;
}

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

app.post('/mono-webhook', (c) =>
  monoWebhookHandler({
    db: c.env.DB,
    shopify: createShopifyClient({
      storeDomain: c.env.SHOPIFY_STORE_DOMAIN,
      adminToken: c.env.SHOPIFY_ADMIN_TOKEN,
    }),
    pubkeys: getPubkeyProvider(c.env),
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
