import { Hono } from 'hono';
import { runCron } from './cron';
import { createMonoClient } from './lib/mono-client';
import { createPubkeyProvider, type PubkeyProvider } from './lib/mono-pubkey';
import { verifySessionToken } from './lib/session-token';
import { type AdminTokenProvider, createAdminTokenProvider } from './lib/shopify-admin-token';
import { createShopifyClient, type ShopifyClient } from './lib/shopify-client';
import { createTelegramNotifier, type Notifier } from './lib/telegram';
import { captureHandler } from './routes/capture';
import { createInvoiceHandler, createInvoicePreflightHandler } from './routes/create-invoice';
import { monoWebhookHandler } from './routes/mono-webhook';

export type Env = {
  DB: D1Database;
  MONO_TOKEN: string;
  SHOPIFY_STORE_DOMAIN: string;
  CAPTURE_TOKEN: string;
  /** Client ID/secret апа Bbox-Worker-Integration — Admin API через client credentials grant. */
  SHOPIFY_ADMIN_CLIENT_ID: string;
  SHOPIFY_ADMIN_CLIENT_SECRET: string;
  /** Client secret апа з extension (Bbox MonoBank Payments) — верифікація session token. */
  SHOPIFY_APP_SECRET: string;
  /** Client ID того ж апа — звірка claim `aud` session token. */
  SHOPIFY_APP_CLIENT_ID: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
};

// Кеші на рівні модуля живуть між запитами одного ізоляту.
// Створюються ліниво, бо секрети доступні лише в контексті запиту.
let pubkeyProvider: PubkeyProvider | null = null;
let adminTokenProvider: AdminTokenProvider | null = null;

function getPubkeyProvider(env: Env): PubkeyProvider {
  if (!pubkeyProvider) {
    const mono = createMonoClient({ token: env.MONO_TOKEN });
    pubkeyProvider = createPubkeyProvider(() => mono.getPubkey());
  }
  return pubkeyProvider;
}

/** Admin-токен живе 24 год (client credentials grant) — кешується провайдером. */
function buildShopifyClient(env: Env): ShopifyClient {
  if (!adminTokenProvider) {
    adminTokenProvider = createAdminTokenProvider({
      storeDomain: env.SHOPIFY_STORE_DOMAIN,
      clientId: env.SHOPIFY_ADMIN_CLIENT_ID,
      clientSecret: env.SHOPIFY_ADMIN_CLIENT_SECRET,
      now: () => Math.floor(Date.now() / 1000),
    });
  }
  const provider = adminTokenProvider;
  return createShopifyClient({
    storeDomain: env.SHOPIFY_STORE_DOMAIN,
    getAccessToken: () => provider.get(),
  });
}

export const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/create-invoice', (c) =>
  createInvoiceHandler({
    shopify: buildShopifyClient(c.env),
    mono: createMonoClient({ token: c.env.MONO_TOKEN }),
    db: c.env.DB,
    verifyToken: (token) =>
      verifySessionToken({
        token,
        secret: c.env.SHOPIFY_APP_SECRET,
        clientId: c.env.SHOPIFY_APP_CLIENT_ID,
        shopDomain: c.env.SHOPIFY_STORE_DOMAIN,
        now: () => Math.floor(Date.now() / 1000),
      }),
    now: () => Math.floor(Date.now() / 1000),
  })(c),
);

app.options('/create-invoice', createInvoicePreflightHandler());

app.post('/mono-webhook', (c) =>
  monoWebhookHandler({
    db: c.env.DB,
    shopify: buildShopifyClient(c.env),
    pubkeys: getPubkeyProvider(c.env),
    now: () => Math.floor(Date.now() / 1000),
  })(c),
);

app.post('/capture', (c) =>
  captureHandler({
    db: c.env.DB,
    mono: createMonoClient({ token: c.env.MONO_TOKEN }),
    captureToken: c.env.CAPTURE_TOKEN,
    now: () => Math.floor(Date.now() / 1000),
  })(c),
);

/** Без телеграм-секретів (dev/тести) нагадування лише логуються. */
function buildNotifier(env: Env): Notifier {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    return createTelegramNotifier({
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    });
  }
  return {
    send(text) {
      console.warn('notifier: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не задані; повідомлення:', text);
      return Promise.resolve();
    },
  };
}

// Нагадування про неоплачені інвойси + чистка привидів (PRD §11)
async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  await runCron({
    db: env.DB,
    mono: createMonoClient({ token: env.MONO_TOKEN }),
    shopify: buildShopifyClient(env),
    notifier: buildNotifier(env),
    now: () => Math.floor(Date.now() / 1000),
  });
}

export default {
  fetch: app.fetch,
  scheduled,
};
