import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createPubkeyProvider } from '../src/lib/mono-pubkey';
import { type MonoWebhookDeps, monoWebhookHandler } from '../src/routes/mono-webhook';

const FIXED_NOW = 1_800_000_000;

// ---------------------------------------------------------------------------
// Крипто-хелпери — той самий формат, що й у ecdsa-verify.test.ts:
// ключ base64(PEM(SPKI)), підпис DER у X-Sign.
// ---------------------------------------------------------------------------

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function encodeDerInteger(half: Uint8Array): Uint8Array {
  let start = 0;
  while (start < half.length - 1 && half[start] === 0) {
    start += 1;
  }
  const trimmed = half.slice(start);
  const needsPad = (trimmed[0] ?? 0) >= 0x80;
  const content = needsPad ? new Uint8Array([0, ...trimmed]) : trimmed;
  return new Uint8Array([0x02, content.length, ...content]);
}

function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const r = encodeDerInteger(p1363.slice(0, 32));
  const s = encodeDerInteger(p1363.slice(32, 64));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function makeKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function exportMonoStyleKey(publicKey: CryptoKey): Promise<string> {
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer);
  const pem = `-----BEGIN PUBLIC KEY-----\n${toBase64(spki)}\n-----END PUBLIC KEY-----\n`;
  return toBase64(new TextEncoder().encode(pem));
}

async function signAsMono(privateKey: CryptoKey, body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const p1363 = new Uint8Array(
    await crypto.subtle.sign(SIGN_ALG, privateKey, bytes as BufferSource),
  );
  return toBase64(p1363ToDer(p1363));
}

// ---------------------------------------------------------------------------
// Моки залежностей
// ---------------------------------------------------------------------------

type DbCall = { sql: string; params: unknown[] };

function makeDb(options: {
  webhookLogHit?: boolean;
  invoiceRow?: { order_id: string; payment_type: string; status: string; amount: number } | null;
  batchImpl?: () => Promise<unknown>;
}) {
  const calls: DbCall[] = [];
  const batch = vi.fn(options.batchImpl ?? (() => Promise.resolve([])));

  const db = {
    prepare(sql: string) {
      const statement = {
        _sql: sql,
        _params: [] as unknown[],
        bind(...params: unknown[]) {
          statement._params = params;
          calls.push({ sql, params });
          return statement;
        },
        first: vi.fn(() => {
          if (sql.includes('webhook_log')) {
            return Promise.resolve(options.webhookLogHit ? { id: 1 } : null);
          }
          return Promise.resolve(options.invoiceRow ?? null);
        }),
        run: vi.fn(() => Promise.resolve({ success: true })),
      };
      return statement;
    },
    batch,
  } as unknown as D1Database;

  return { db, batch, calls };
}

function makeShopify(overrides: Partial<{ orderMarkAsPaid: ReturnType<typeof vi.fn> }> = {}) {
  return {
    // Чинне неоплачене замовлення із залишком, рівним сумі інвойсу у фікстурі
    getOrderForInvoice: vi.fn().mockResolvedValue({
      id: 'gid://shopify/Order/77',
      name: '#1077',
      financialStatus: 'PENDING',
      cancelledAt: null,
      statusPageUrl: null,
      totalOutstandingKopecks: 42000,
      currencyCode: 'UAH',
      paymentGatewayNames: ['monobank'],
      lineItems: [],
    }),
    orderMarkAsPaid: overrides.orderMarkAsPaid ?? vi.fn().mockResolvedValue(undefined),
  };
}

type Fixture = {
  app: Hono;
  xSign: (body: string) => Promise<string>;
  shopify: ReturnType<typeof makeShopify>;
  batch: ReturnType<typeof vi.fn>;
  calls: DbCall[];
  fetchKey: ReturnType<typeof vi.fn<() => Promise<string>>>;
  notifier: { send: ReturnType<typeof vi.fn> };
};

async function makeFixture(
  options: {
    webhookLogHit?: boolean;
    /** amount за замовчуванням 42000 — як у SUCCESS_BODY. */
    invoiceRow?: {
      order_id: string;
      payment_type: string;
      status: string;
      amount?: number;
    } | null;
    batchImpl?: () => Promise<unknown>;
    shopify?: ReturnType<typeof makeShopify>;
    notifySendImpl?: () => Promise<void>;
    /** Ключ у провайдері не збігається з ключем підпису до refresh (ротація). */
    staleCachedKey?: boolean;
  } = {},
): Promise<Fixture> {
  const { publicKey, privateKey } = await makeKeyPair();
  const realKey = await exportMonoStyleKey(publicKey);

  let fetchKey: ReturnType<typeof vi.fn<() => Promise<string>>>;
  if (options.staleCachedKey) {
    const stale = await makeKeyPair();
    const staleKey = await exportMonoStyleKey(stale.publicKey);
    fetchKey = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(staleKey)
      .mockResolvedValue(realKey);
  } else {
    fetchKey = vi.fn<() => Promise<string>>().mockResolvedValue(realKey);
  }

  const pubkeys = createPubkeyProvider(fetchKey);
  const shopify = options.shopify ?? makeShopify();
  const notifier = { send: vi.fn(options.notifySendImpl ?? (() => Promise.resolve())) };
  const { db, batch, calls } = makeDb({
    ...(options.webhookLogHit !== undefined ? { webhookLogHit: options.webhookLogHit } : {}),
    invoiceRow:
      options.invoiceRow === null
        ? null
        : {
            order_id: 'gid://shopify/Order/77',
            payment_type: 'debit',
            status: 'created',
            amount: 42000,
            ...options.invoiceRow,
          },
    ...(options.batchImpl ? { batchImpl: options.batchImpl } : {}),
  });

  const app = new Hono();
  app.post(
    '/mono-webhook',
    monoWebhookHandler({
      db,
      shopify,
      pubkeys,
      notifier,
      now: () => FIXED_NOW,
    } as MonoWebhookDeps),
  );

  return {
    app,
    xSign: (body) => signAsMono(privateKey, body),
    shopify,
    batch,
    calls,
    fetchKey,
    notifier,
  };
}

const SUCCESS_BODY = JSON.stringify({
  invoiceId: 'p2_9ZgpZVsl3',
  status: 'success',
  amount: 42000,
  ccy: 980,
  finalAmount: 42000,
  paymentInfo: { maskedPan: '444403******1902', approvalCode: '662476', rrn: '060189181768' },
});

async function post(app: Hono, body: string, xSign?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (xSign !== undefined) {
    headers['X-Sign'] = xSign;
  }
  return app.request('https://worker.example.com/mono-webhook', {
    method: 'POST',
    headers,
    body,
  });
}

// ---------------------------------------------------------------------------

describe('POST /mono-webhook — криптографія', () => {
  it('валідний підпис success → 200, mark-paid, batch записано', async () => {
    const f = await makeFixture();

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).toHaveBeenCalledWith('gid://shopify/Order/77');
    expect(f.batch).toHaveBeenCalledTimes(1);
  });

  it('відсутній X-Sign → 400, нуль звернень до D1 і Shopify', async () => {
    const f = await makeFixture();

    const res = await post(f.app, SUCCESS_BODY);

    expect(res.status).toBe(400);
    expect(f.calls).toHaveLength(0);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.batch).not.toHaveBeenCalled();
  });

  it('змінене тіло → 400 без side effects', async () => {
    const f = await makeFixture();
    const xSign = await f.xSign(SUCCESS_BODY);
    const tampered = SUCCESS_BODY.replace('42000', '10000');

    const res = await post(f.app, tampered, xSign);

    expect(res.status).toBe(400);
    expect(f.calls).toHaveLength(0);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
  });

  it('битий base64 у X-Sign → 400 без side effects', async () => {
    const f = await makeFixture();

    const res = await post(f.app, SUCCESS_BODY, '!!!not-base64!!!');

    expect(res.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('валідний base64, але битий DER → 400 без side effects', async () => {
    const f = await makeFixture();

    const res = await post(f.app, SUCCESS_BODY, toBase64(new Uint8Array([1, 2, 3])));

    expect(res.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('ротація ключа: провал зі старим ключем → refresh → 200', async () => {
    const f = await makeFixture({ staleCachedKey: true });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    expect(f.fetchKey).toHaveBeenCalledTimes(2);
  });

  it('невалідний підпис і після refresh → 400', async () => {
    const f = await makeFixture();
    const attacker = await makeKeyPair();
    const forged = await signAsMono(attacker.privateKey, SUCCESS_BODY);

    const res = await post(f.app, SUCCESS_BODY, forged);

    expect(res.status).toBe(400);
    expect(f.fetchKey).toHaveBeenCalledTimes(2); // початковий get + один refresh
    expect(f.calls).toHaveLength(0);
  });
});

describe('POST /mono-webhook — ідемпотентність і рейси', () => {
  it('повторний invoiceId+status → 200 без mark-paid і без batch', async () => {
    const f = await makeFixture({ webhookLogHit: true });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.batch).not.toHaveBeenCalled();
  });

  it('невідомий інвойс (вебхук раніше за INSERT) → 404 без записів', async () => {
    const f = await makeFixture({ invoiceRow: null });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(404);
    expect(f.batch).not.toHaveBeenCalled();
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
  });

  it('тіло без invoiceId/status → 400', async () => {
    const f = await makeFixture();
    const body = JSON.stringify({ foo: 'bar' });

    const res = await post(f.app, body, await f.xSign(body));

    expect(res.status).toBe(400);
    expect(f.batch).not.toHaveBeenCalled();
  });

  it('коректно підписане, але не-JSON тіло → 400', async () => {
    const f = await makeFixture();
    const body = 'не json взагалі';

    const res = await post(f.app, body, await f.xSign(body));

    expect(res.status).toBe(400);
    expect(f.batch).not.toHaveBeenCalled();
  });
});

describe('POST /mono-webhook — статуси', () => {
  it('hold (авторизація) → batch без Shopify', async () => {
    const f = await makeFixture({
      invoiceRow: { order_id: 'gid://shopify/Order/77', payment_type: 'hold', status: 'created' },
    });
    const body = JSON.stringify({ invoiceId: 'p2_9ZgpZVsl3', status: 'hold', amount: 42000 });

    const res = await post(f.app, body, await f.xSign(body));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.batch).toHaveBeenCalledTimes(1);
  });

  it('failure → batch без Shopify', async () => {
    const f = await makeFixture();
    const body = JSON.stringify({ invoiceId: 'p2_9ZgpZVsl3', status: 'failure' });

    const res = await post(f.app, body, await f.xSign(body));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.batch).toHaveBeenCalledTimes(1);
  });

  it('пізній processing після success → лише лог, без UPDATE і без пониження', async () => {
    const f = await makeFixture({
      invoiceRow: { order_id: 'gid://shopify/Order/77', payment_type: 'debit', status: 'success' },
    });
    const body = JSON.stringify({ invoiceId: 'p2_9ZgpZVsl3', status: 'processing' });

    const res = await post(f.app, body, await f.xSign(body));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    // Записується тільки webhook_log (без UPDATE invoices) — batch з одним стейтментом
    expect(f.batch).toHaveBeenCalledTimes(1);
    const batchArg = f.batch.mock.calls[0]?.[0] as unknown[];
    expect(batchArg).toHaveLength(1);
  });

  it('reversed після success (повернення коштів) → статус оновлюється', async () => {
    const f = await makeFixture({
      invoiceRow: { order_id: 'gid://shopify/Order/77', payment_type: 'debit', status: 'success' },
    });
    const body = JSON.stringify({ invoiceId: 'p2_9ZgpZVsl3', status: 'reversed' });

    const res = await post(f.app, body, await f.xSign(body));

    expect(res.status).toBe(200);
    const batchArg = f.batch.mock.calls[0]?.[0] as unknown[];
    expect(batchArg).toHaveLength(2); // log + update
  });

  it('запізнілий ретрай success після reversed → лише лог: повернутий платіж не стає Paid', async () => {
    const f = await makeFixture({
      invoiceRow: { order_id: 'gid://shopify/Order/77', payment_type: 'debit', status: 'reversed' },
    });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    const batchArg = f.batch.mock.calls[0]?.[0] as unknown[];
    expect(batchArg).toHaveLength(1); // лише webhook_log
  });

  for (const late of ['failure', 'expired']) {
    it(`${late} після success → лише лог: оплачений інвойс не знецінюється`, async () => {
      const f = await makeFixture({
        invoiceRow: {
          order_id: 'gid://shopify/Order/77',
          payment_type: 'debit',
          status: 'success',
        },
      });
      const body = JSON.stringify({ invoiceId: 'p2_9ZgpZVsl3', status: late });

      const res = await post(f.app, body, await f.xSign(body));

      expect(res.status).toBe(200);
      const batchArg = f.batch.mock.calls[0]?.[0] as unknown[];
      expect(batchArg).toHaveLength(1);
    });
  }

  it('success після success без запису в лозі (cron-backstop) → реквізити платежу дозаписуються', async () => {
    const f = await makeFixture({
      invoiceRow: { order_id: 'gid://shopify/Order/77', payment_type: 'debit', status: 'success' },
    });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    const batchArg = f.batch.mock.calls[0]?.[0] as unknown[];
    expect(batchArg).toHaveLength(2); // log + update з approval_code/rrn
  });

  it('success після failure → оплата справжня: mark-paid і UPDATE', async () => {
    const f = await makeFixture({
      invoiceRow: { order_id: 'gid://shopify/Order/77', payment_type: 'debit', status: 'failure' },
    });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).toHaveBeenCalledWith('gid://shopify/Order/77');
    const batchArg = f.batch.mock.calls[0]?.[0] as unknown[];
    expect(batchArg).toHaveLength(2);
  });

  it('final_amount/approval_code/rrn з вебхука потрапляють в UPDATE', async () => {
    const f = await makeFixture();

    await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    const updateCall = f.calls.find((c) => c.sql.includes('UPDATE invoices'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.params).toEqual([
      'success',
      FIXED_NOW,
      42000,
      '662476',
      '060189181768',
      'p2_9ZgpZVsl3',
    ]);
  });

  it('hold-інвойс + success (capture) → UPDATE ставить captured_at', async () => {
    const f = await makeFixture({
      invoiceRow: { order_id: 'gid://shopify/Order/77', payment_type: 'hold', status: 'hold' },
    });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    const updateCall = f.calls.find((c) => c.sql.includes('UPDATE invoices'));
    expect(updateCall?.sql).toContain('captured_at');
    expect(updateCall?.params).toEqual([
      'success',
      FIXED_NOW,
      42000,
      '662476',
      '060189181768',
      FIXED_NOW, // captured_at
      'p2_9ZgpZVsl3',
    ]);
  });

  it('debit-інвойс + success → captured_at НЕ встановлюється', async () => {
    const f = await makeFixture(); // debit за замовчуванням

    await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    const updateCall = f.calls.find((c) => c.sql.includes('UPDATE invoices'));
    expect(updateCall?.sql).not.toContain('captured_at');
  });

  it('raw_body зберігається дослівно у webhook_log', async () => {
    const f = await makeFixture();

    await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    const insertCall = f.calls.find((c) => c.sql.includes('INSERT INTO webhook_log'));
    expect(insertCall?.params).toEqual(['p2_9ZgpZVsl3', 'success', SUCCESS_BODY, FIXED_NOW]);
  });
});

describe('POST /mono-webhook — звірка суми', () => {
  const body = (extra: Record<string, unknown>) =>
    JSON.stringify({ invoiceId: 'p2_9ZgpZVsl3', status: 'success', ccy: 980, ...extra });

  it('списано менше, ніж в інвойсі → без mark-paid, оператору йде сповіщення, сума фіксується', async () => {
    const f = await makeFixture();
    const partial = body({ amount: 42000, finalAmount: 100 });

    const res = await post(f.app, partial, await f.xSign(partial));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.notifier.send).toHaveBeenCalledTimes(1);
    const text = f.notifier.send.mock.calls[0]?.[0] as string;
    expect(text).toContain('gid://shopify/Order/77');
    expect(text).toContain('420.00');
    expect(text).toContain('1.00');
    const updateCall = f.calls.find((c) => c.sql.includes('UPDATE invoices'));
    expect(updateCall?.params.slice(0, 3)).toEqual(['success', FIXED_NOW, 100]);
    const review = f.calls.find((c) => c.sql.includes('review_outstanding'));
    expect(review?.params).toEqual([42000, 'p2_9ZgpZVsl3']);
    expect(f.batch.mock.calls[0]?.[0]).toHaveLength(3); // log + update + review
  });

  it('суми у вебхуку немає взагалі → fail-closed: без mark-paid, сповіщення «невідомо»', async () => {
    const f = await makeFixture();
    const noAmount = body({});

    const res = await post(f.app, noAmount, await f.xSign(noAmount));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.notifier.send.mock.calls[0]?.[0]).toContain('невідомо');
  });

  it('finalAmount відсутній, amount збігається → mark-paid, без сповіщення', async () => {
    const f = await makeFixture();
    const amountOnly = body({ amount: 42000 });

    const res = await post(f.app, amountOnly, await f.xSign(amountOnly));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).toHaveBeenCalledTimes(1);
    expect(f.notifier.send).not.toHaveBeenCalled();
  });

  it('замовлення відредаговано після створення інвойсу → без mark-paid, сповіщення, залишок фіксується', async () => {
    const f = await makeFixture();
    f.shopify.getOrderForInvoice.mockResolvedValue({
      financialStatus: 'PENDING',
      cancelledAt: null,
      totalOutstandingKopecks: 50000,
    });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.notifier.send.mock.calls[0]?.[0]).toContain('залишок замовлення змінився');
    const review = f.calls.find((c) => c.sql.includes('review_outstanding'));
    expect(review?.params).toEqual([50000, 'p2_9ZgpZVsl3']);
  });

  it('замовлення скасовано, а оплата пройшла → без mark-paid, сповіщення оператору', async () => {
    const f = await makeFixture();
    f.shopify.getOrderForInvoice.mockResolvedValue({
      financialStatus: 'PENDING',
      cancelledAt: '2027-01-15T10:00:00Z',
      totalOutstandingKopecks: 42000,
    });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(200);
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.notifier.send.mock.calls[0]?.[0]).toContain('замовлення скасовано');
  });

  it('Shopify недоступний під час звірки → 500 без запису в D1 (mono повторить)', async () => {
    const f = await makeFixture();
    f.shopify.getOrderForInvoice.mockRejectedValue(new Error('shopify down'));

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(500);
    expect(f.batch).not.toHaveBeenCalled();
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
  });

  it('сповіщення не відправилось → 500 без запису в D1: mono повторить, оператор таки дізнається', async () => {
    const f = await makeFixture({
      notifySendImpl: () => Promise.reject(new Error('telegram down')),
    });
    const partial = body({ amount: 42000, finalAmount: 100 });

    const res = await post(f.app, partial, await f.xSign(partial));

    expect(res.status).toBe(500);
    expect(f.batch).not.toHaveBeenCalled();
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
  });

  it('запізнілий success із розбіжністю після reversed → лише лог, без сповіщення', async () => {
    const f = await makeFixture({
      invoiceRow: { order_id: 'gid://shopify/Order/77', payment_type: 'debit', status: 'reversed' },
    });
    const partial = body({ amount: 42000, finalAmount: 100 });

    await post(f.app, partial, await f.xSign(partial));

    expect(f.notifier.send).not.toHaveBeenCalled();
  });
});

describe('POST /mono-webhook — fail-closed', () => {
  it('mark-paid впав → 500, batch не викликано (mono ретраїть)', async () => {
    const shopify = makeShopify({
      orderMarkAsPaid: vi.fn().mockRejectedValue(new Error('shopify down')),
    });
    const f = await makeFixture({ shopify });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(500);
    expect(f.batch).not.toHaveBeenCalled();
  });

  it('batch впав після успішного mark-paid → 500', async () => {
    const f = await makeFixture({ batchImpl: () => Promise.reject(new Error('D1 down')) });

    const res = await post(f.app, SUCCESS_BODY, await f.xSign(SUCCESS_BODY));

    expect(res.status).toBe(500);
    expect(f.shopify.orderMarkAsPaid).toHaveBeenCalledTimes(1);
  });
});
