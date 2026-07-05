import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { MonoClient } from '../src/lib/mono-client';
import type { OrderForInvoice } from '../src/lib/shopify-client';
import {
  type CreateInvoiceDeps,
  createInvoiceHandler,
  createInvoicePreflightHandler,
} from '../src/routes/create-invoice';

const FIXED_NOW = 1_800_000_000;

function makeOrder(overrides: Partial<OrderForInvoice> = {}): OrderForInvoice {
  return {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    financialStatus: 'PENDING',
    statusPageUrl: 'https://bbox.myshopify.com/orders/abc/status',
    totalOutstandingKopecks: 42000,
    currencyCode: 'UAH',
    paymentGatewayNames: ['monobank'],
    lineItems: [
      {
        title: 'Літофан "Кіт"',
        quantity: 1,
        sku: 'LITO-CAT-01',
        unitPriceKopecks: 42000,
        imageUrl: null,
        productTags: [],
      },
    ],
    ...overrides,
  };
}

function makeMonoClient(overrides: Partial<MonoClient> = {}): MonoClient {
  return {
    createInvoice: vi
      .fn()
      .mockResolvedValue({ invoiceId: 'p2_new', pageUrl: 'https://pay.mbnk.biz/p2_new' }),
    invoiceStatus: vi.fn(),
    finalizeInvoice: vi.fn(),
    cancelInvoice: vi.fn(),
    removeInvoice: vi.fn().mockResolvedValue(undefined),
    getPubkey: vi.fn(),
    ...overrides,
  };
}

function makeDb(overrides: { first?: unknown; runImpl?: () => Promise<unknown> } = {}) {
  const bind = vi.fn();
  const first = vi.fn().mockResolvedValue(overrides.first ?? null);
  const run = vi.fn(overrides.runImpl ?? (() => Promise.resolve({ success: true })));
  const statement = { bind: bind.mockReturnThis(), first, run };
  const prepare = vi.fn().mockReturnValue(statement);
  return {
    prepare,
    _statement: statement,
    _bind: bind,
    _first: first,
    _run: run,
  } as unknown as D1Database & {
    _statement: typeof statement;
    _bind: typeof bind;
    _first: typeof first;
    _run: typeof run;
  };
}

const VALID_TOKEN = 'valid-session-token'; // фікстура

function makeApp(deps: Omit<CreateInvoiceDeps, 'verifyToken'> & Partial<CreateInvoiceDeps>) {
  const app = new Hono();
  const fullDeps: CreateInvoiceDeps = {
    verifyToken: (token) => Promise.resolve(token === VALID_TOKEN),
    ...deps,
  };
  app.post('/create-invoice', createInvoiceHandler(fullDeps));
  app.options('/create-invoice', createInvoicePreflightHandler());
  return app;
}

async function postOrder(
  app: Hono,
  body: unknown,
  url = 'https://worker.example.com/create-invoice',
  authorization: string | null = `Bearer ${VALID_TOKEN}`,
) {
  return app.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /create-invoice — happy path', () => {
  it('debit: створює mono-інвойс і записує в D1', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder()),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      invoiceId: 'p2_new',
      pageUrl: 'https://pay.mbnk.biz/p2_new',
      paymentType: 'debit',
    });

    expect(mono.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 42000, ccy: 980, paymentType: 'debit' }),
    );
    expect(db._run).toHaveBeenCalledTimes(1);
    expect(db._bind).toHaveBeenCalledWith(
      'p2_new',
      'gid://shopify/Order/1',
      42000,
      980,
      'debit',
      'created',
      'https://pay.mbnk.biz/p2_new',
      FIXED_NOW,
    );
  });

  it('hold: визначає paymentType за тегом made-to-order', async () => {
    const order = makeOrder({
      lineItems: [
        {
          title: 'На замовлення',
          quantity: 1,
          sku: 'CUSTOM-1',
          unitPriceKopecks: 42000,
          imageUrl: null,
          productTags: ['made-to-order'],
        },
      ],
    });
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(order),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as { paymentType: string };
    expect(responseBody.paymentType).toBe('hold');
    expect(mono.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ paymentType: 'hold' }),
    );
  });

  it('будує webHookUrl з origin запиту', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder()),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    await postOrder(
      app,
      { orderId: 'gid://shopify/Order/1' },
      'https://worker.example.com/create-invoice',
    );

    expect(mono.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ webHookUrl: 'https://worker.example.com/mono-webhook' }),
    );
  });

  it('не передає redirectUrl, якщо Shopify не повернув statusPageUrl', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder({ statusPageUrl: null })),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    const call = (mono.createInvoice as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call).not.toHaveProperty('redirectUrl');
  });
});

describe('POST /create-invoice — amount integrity', () => {
  it('ігнорує клієнтський amount — сума завжди з Shopify', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder({ totalOutstandingKopecks: 99900 })),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    await postOrder(app, { orderId: 'gid://shopify/Order/1', amount: 1 });

    expect(mono.createInvoice).toHaveBeenCalledWith(expect.objectContaining({ amount: 99900 }));
  });
});

describe('POST /create-invoice — ідемпотентність', () => {
  it('повертає наявний created-інвойс без повторного виклику mono', async () => {
    const shopify = { getOrderForInvoice: vi.fn(), orderMarkAsPaid: vi.fn() };
    const mono = makeMonoClient();
    const db = makeDb({
      first: { invoice_id: 'p2_existing', page_url: 'https://pay.mbnk.biz/p2_existing' },
    });
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      invoiceId: 'p2_existing',
      pageUrl: 'https://pay.mbnk.biz/p2_existing',
    });
    expect(shopify.getOrderForInvoice).not.toHaveBeenCalled();
    expect(mono.createInvoice).not.toHaveBeenCalled();
  });
});

describe('POST /create-invoice — валідація та стан замовлення', () => {
  it('невалідне тіло (без orderId) → 400', async () => {
    const shopify = { getOrderForInvoice: vi.fn(), orderMarkAsPaid: vi.fn() };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, {});

    expect(res.status).toBe(400);
    expect(mono.createInvoice).not.toHaveBeenCalled();
  });

  it('замовлення не знайдено → 404', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(null),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/missing' });

    expect(res.status).toBe(404);
  });

  it('замовлення вже PAID → 409', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder({ financialStatus: 'PAID' })),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(409);
    expect(mono.createInvoice).not.toHaveBeenCalled();
  });

  it('валюта не UAH → 422', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder({ currencyCode: 'EUR' })),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(422);
    expect(mono.createInvoice).not.toHaveBeenCalled();
  });

  it('сума до сплати 0 → 422', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder({ totalOutstandingKopecks: 0 })),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(422);
  });
});

describe('POST /create-invoice — fail-closed на помилках апстрімів', () => {
  it('shopify.getOrderForInvoice впав → 502, mono не викликається', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockRejectedValue(new Error('shopify 401')),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(502);
    expect(mono.createInvoice).not.toHaveBeenCalled();
    expect(db._run).not.toHaveBeenCalled();
  });

  it('mono createInvoice впав → 502, D1 не викликається', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder()),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient({
      createInvoice: vi.fn().mockRejectedValue(new Error('mono down')),
    });
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(502);
    expect(db._run).not.toHaveBeenCalled();
  });

  it('D1 INSERT впав → mono removeInvoice викликано, відповідь 500', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder()),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb({
      runImpl: () => Promise.reject(new Error('D1 unavailable')),
    });
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(500);
    expect(mono.removeInvoice).toHaveBeenCalledWith({ invoiceId: 'p2_new' });
  });

  it('D1 INSERT впав і removeInvoice теж впав → все одно 500, без падіння процесу', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder()),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient({
      removeInvoice: vi.fn().mockRejectedValue(new Error('mono down')),
    });
    const db = makeDb({ runImpl: () => Promise.reject(new Error('D1 unavailable')) });
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(500);
  });
});

describe('POST /create-invoice — авторизація session token', () => {
  it('без Authorization → 401, нуль викликів db/shopify/mono', async () => {
    const shopify = { getOrderForInvoice: vi.fn(), orderMarkAsPaid: vi.fn() };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' }, undefined, null);

    expect(res.status).toBe(401);
    expect(shopify.getOrderForInvoice).not.toHaveBeenCalled();
    expect(mono.createInvoice).not.toHaveBeenCalled();
    expect((db as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled();
  });

  it('невалідний токен → 401 без side effects', async () => {
    const shopify = { getOrderForInvoice: vi.fn(), orderMarkAsPaid: vi.fn() };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(
      app,
      { orderId: 'gid://shopify/Order/1' },
      undefined,
      'Bearer forged-token',
    );

    expect(res.status).toBe(401);
    expect(mono.createInvoice).not.toHaveBeenCalled();
  });

  it('заголовок без схеми Bearer → 401', async () => {
    const shopify = { getOrderForInvoice: vi.fn(), orderMarkAsPaid: vi.fn() };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'x' }, undefined, VALID_TOKEN);

    expect(res.status).toBe(401);
  });

  it('успішна відповідь містить CORS-заголовок', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder()),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('OPTIONS (CORS preflight) → 204 з дозволеними методами й заголовками', async () => {
    const shopify = { getOrderForInvoice: vi.fn(), orderMarkAsPaid: vi.fn() };
    const app = makeApp({ shopify, mono: makeMonoClient(), db: makeDb(), now: () => FIXED_NOW });

    const res = await app.request('https://worker.example.com/create-invoice', {
      method: 'OPTIONS',
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

describe('POST /create-invoice — фільтр за методом оплати', () => {
  it('COD-замовлення (накладений платіж) → 409, mono не викликається', async () => {
    const shopify = {
      getOrderForInvoice: vi
        .fn()
        .mockResolvedValue(makeOrder({ paymentGatewayNames: ['Накладений платіж (COD)'] })),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(409);
    expect(mono.createInvoice).not.toHaveBeenCalled();
  });

  it('назва методу з іншим регістром і обгорткою проходить', async () => {
    const shopify = {
      getOrderForInvoice: vi
        .fn()
        .mockResolvedValue(makeOrder({ paymentGatewayNames: ['Оплата карткою Monobank'] })),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(200);
    expect(mono.createInvoice).toHaveBeenCalled();
  });

  it('порожній список методів → 409', async () => {
    const shopify = {
      getOrderForInvoice: vi.fn().mockResolvedValue(makeOrder({ paymentGatewayNames: [] })),
      orderMarkAsPaid: vi.fn(),
    };
    const mono = makeMonoClient();
    const db = makeDb();
    const app = makeApp({ shopify, mono, db, now: () => FIXED_NOW });

    const res = await postOrder(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(409);
  });
});
