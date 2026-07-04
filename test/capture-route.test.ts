import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { type CaptureDeps, captureHandler } from '../src/routes/capture';

const CAPTURE_TOKEN = 'test-capture-token-fixture'; // фікстура, не реальний секрет
const FIXED_NOW = 1_800_000_000;

type InvoiceRow = {
  invoice_id: string;
  amount: number;
  status: string;
};

function makeDb(invoiceRow: InvoiceRow | null) {
  const bind = vi.fn();
  const first = vi.fn().mockResolvedValue(invoiceRow);
  const statement = { bind: bind.mockReturnThis(), first };
  const prepare = vi.fn().mockReturnValue(statement);
  return { prepare, _bind: bind, _first: first } as unknown as D1Database & {
    _bind: ReturnType<typeof vi.fn>;
    _first: ReturnType<typeof vi.fn>;
  };
}

function makeMono(overrides: { finalizeImpl?: () => Promise<{ status: 'success' }> } = {}) {
  return {
    finalizeInvoice: vi.fn(
      overrides.finalizeImpl ?? (() => Promise.resolve({ status: 'success' as const })),
    ),
  };
}

function makeApp(deps: Partial<CaptureDeps> & { db: D1Database }) {
  const app = new Hono();
  app.post(
    '/capture',
    captureHandler({
      mono: makeMono(),
      captureToken: CAPTURE_TOKEN,
      now: () => FIXED_NOW,
      ...deps,
    } as CaptureDeps),
  );
  return app;
}

async function postCapture(app: Hono, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  return app.request('https://worker.example.com/capture', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const HOLD_ROW: InvoiceRow = { invoice_id: 'p2_hold1', amount: 42000, status: 'hold' };

describe('POST /capture — авторизація', () => {
  it('без Authorization → 401, нуль викликів db і mono', async () => {
    const db = makeDb(HOLD_ROW);
    const mono = makeMono();
    const app = makeApp({ db, mono });

    const res = await postCapture(app, { orderId: 'gid://shopify/Order/1' });

    expect(res.status).toBe(401);
    expect(db._first).not.toHaveBeenCalled();
    expect(mono.finalizeInvoice).not.toHaveBeenCalled();
  });

  it('невірний токен → 401', async () => {
    const db = makeDb(HOLD_ROW);
    const app = makeApp({ db });

    const res = await postCapture(app, { orderId: 'x' }, 'wrong-token-same-len-x');

    expect(res.status).toBe(401);
    expect(db._first).not.toHaveBeenCalled();
  });

  it('токен іншої довжини → 401', async () => {
    const db = makeDb(HOLD_ROW);
    const app = makeApp({ db });

    const res = await postCapture(app, { orderId: 'x' }, 'short');

    expect(res.status).toBe(401);
  });
});

describe('POST /capture — потік', () => {
  it('hold → finalize з invoiceId та amount із D1 → 202', async () => {
    const db = makeDb(HOLD_ROW);
    const mono = makeMono();
    const app = makeApp({ db, mono });

    const res = await postCapture(app, { orderId: 'gid://shopify/Order/1' }, CAPTURE_TOKEN);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ invoiceId: 'p2_hold1', status: 'finalize-requested' });
    expect(mono.finalizeInvoice).toHaveBeenCalledWith({ invoiceId: 'p2_hold1', amount: 42000 });
    expect(db._bind).toHaveBeenCalledWith('gid://shopify/Order/1');
  });

  it('amount integrity: клієнтський amount ігнорується, у finalize йде сума з D1', async () => {
    const db = makeDb(HOLD_ROW);
    const mono = makeMono();
    const app = makeApp({ db, mono });

    await postCapture(app, { orderId: 'gid://shopify/Order/1', amount: 1 }, CAPTURE_TOKEN);

    expect(mono.finalizeInvoice).toHaveBeenCalledWith({ invoiceId: 'p2_hold1', amount: 42000 });
  });

  it('невалідний JSON у тілі → 400', async () => {
    const db = makeDb(HOLD_ROW);
    const mono = makeMono();
    const app = makeApp({ db, mono });

    const res = await app.request('https://worker.example.com/capture', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CAPTURE_TOKEN}`,
      },
      body: 'не json',
    });

    expect(res.status).toBe(400);
    expect(mono.finalizeInvoice).not.toHaveBeenCalled();
  });

  it('тіло без orderId → 400', async () => {
    const db = makeDb(HOLD_ROW);
    const mono = makeMono();
    const app = makeApp({ db, mono });

    const res = await postCapture(app, {}, CAPTURE_TOKEN);

    expect(res.status).toBe(400);
    expect(mono.finalizeInvoice).not.toHaveBeenCalled();
  });

  it('hold-інвойс для orderId не знайдено → 404', async () => {
    const db = makeDb(null);
    const mono = makeMono();
    const app = makeApp({ db, mono });

    const res = await postCapture(app, { orderId: 'gid://shopify/Order/404' }, CAPTURE_TOKEN);

    expect(res.status).toBe(404);
    expect(mono.finalizeInvoice).not.toHaveBeenCalled();
  });

  it('вже success → 200 already-captured без виклику mono (ідемпотентність)', async () => {
    const db = makeDb({ ...HOLD_ROW, status: 'success' });
    const mono = makeMono();
    const app = makeApp({ db, mono });

    const res = await postCapture(app, { orderId: 'gid://shopify/Order/1' }, CAPTURE_TOKEN);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invoiceId: 'p2_hold1', status: 'already-captured' });
    expect(mono.finalizeInvoice).not.toHaveBeenCalled();
  });

  it('created (ще не авторизовано) → 409', async () => {
    const db = makeDb({ ...HOLD_ROW, status: 'created' });
    const mono = makeMono();
    const app = makeApp({ db, mono });

    const res = await postCapture(app, { orderId: 'gid://shopify/Order/1' }, CAPTURE_TOKEN);

    expect(res.status).toBe(409);
    expect(mono.finalizeInvoice).not.toHaveBeenCalled();
  });

  it('failure (hold неактивний) → 409', async () => {
    const db = makeDb({ ...HOLD_ROW, status: 'failure' });
    const mono = makeMono();
    const app = makeApp({ db, mono });

    const res = await postCapture(app, { orderId: 'gid://shopify/Order/1' }, CAPTURE_TOKEN);

    expect(res.status).toBe(409);
    expect(mono.finalizeInvoice).not.toHaveBeenCalled();
  });

  it('mono finalize впав (напр., протермінований hold) → 502 без деталей mono', async () => {
    const db = makeDb(HOLD_ROW);
    const mono = makeMono({ finalizeImpl: () => Promise.reject(new Error('FINALIZE_FAILED')) });
    const app = makeApp({ db, mono });

    const res = await postCapture(app, { orderId: 'gid://shopify/Order/1' }, CAPTURE_TOKEN);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('FINALIZE_FAILED');
  });
});
