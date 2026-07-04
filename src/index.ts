import { Hono } from 'hono';
import { runCron } from './cron';
import { createMonoClient } from './lib/mono-client';
import { createPubkeyProvider, type PubkeyProvider } from './lib/mono-pubkey';
import { createShopifyClient } from './lib/shopify-client';
import { createTelegramNotifier, type Notifier } from './lib/telegram';
import { captureHandler } from './routes/capture';
import { createInvoiceHandler } from './routes/create-invoice';
import { monoWebhookHandler } from './routes/mono-webhook';

export type Env = {
  DB: D1Database;
  MONO_TOKEN: string;
  SHOPIFY_ADMIN_TOKEN: string;
  SHOPIFY_STORE_DOMAIN: string;
  CAPTURE_TOKEN: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
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
    shopify: createShopifyClient({
      storeDomain: env.SHOPIFY_STORE_DOMAIN,
      adminToken: env.SHOPIFY_ADMIN_TOKEN,
    }),
    notifier: buildNotifier(env),
    now: () => Math.floor(Date.now() / 1000),
  });
}

export default {
  fetch: app.fetch,
  scheduled,
};
