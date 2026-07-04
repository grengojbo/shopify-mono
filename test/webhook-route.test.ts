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
  invoiceRow?: { order_id: string; payment_type: string; status: string } | null;
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
    getOrderForInvoice: vi.fn(),
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
};

async function makeFixture(
  options: {
    webhookLogHit?: boolean;
    invoiceRow?: { order_id: string; payment_type: string; status: string } | null;
    batchImpl?: () => Promise<unknown>;
    shopify?: ReturnType<typeof makeShopify>;
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
  const { db, batch, calls } = makeDb({
    ...(options.webhookLogHit !== undefined ? { webhookLogHit: options.webhookLogHit } : {}),
    invoiceRow:
      options.invoiceRow !== undefined
        ? options.invoiceRow
        : { order_id: 'gid://shopify/Order/77', payment_type: 'debit', status: 'created' },
    ...(options.batchImpl ? { batchImpl: options.batchImpl } : {}),
  });

  const app = new Hono();
  app.post(
    '/mono-webhook',
    monoWebhookHandler({ db, shopify, pubkeys, now: () => FIXED_NOW } as MonoWebhookDeps),
  );

  return { app, xSign: (body) => signAsMono(privateKey, body), shopify, batch, calls, fetchKey };
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
