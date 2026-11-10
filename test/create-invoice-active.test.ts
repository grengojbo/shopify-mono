// Регресії аудиту безпеки: один активний інвойс на замовлення.
// Працює на справжньому SQLite — частину гарантій дає унікальний індекс схеми.

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { OrderForInvoice } from '../src/lib/shopify-client';
import { captureHandler } from '../src/routes/capture';
import { createInvoiceHandler } from '../src/routes/create-invoice';
import { makeSqliteD1 } from './helpers/sqlite-d1';

const FIXED_NOW = 1_800_000_000;
const ORDER_ID = 'gid://shopify/Order/1';
const CAPTURE_TOKEN = 'test-capture-token-fixture'; // фікстура, не реальний секрет

function makeOrder(productTags: string[]): OrderForInvoice {
  return {
    id: ORDER_ID,
    name: '#1001',
    financialStatus: 'PENDING',
    statusPageUrl: null,
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
        productTags,
      },
    ],
  };
}

function makeWorld(productTags: string[] = []) {
  const { db, raw } = makeSqliteD1();
  let seq = 0;
  const mono = {
    createInvoice: vi.fn(async () => {
      seq += 1;
      return { invoiceId: `inv${seq}`, pageUrl: `https://pay.mbnk.biz/inv${seq}` };
    }),
    removeInvoice: vi.fn(async (_args: { invoiceId: string }) => undefined),
    finalizeInvoice: vi.fn(async () => ({ status: 'success' as const })),
  };
  const shopify = { getOrderForInvoice: vi.fn(async () => makeOrder(productTags)) };
  const now = () => FIXED_NOW;

  const app = new Hono();
  app.post(
    '/create-invoice',
    createInvoiceHandler({ shopify, mono, db, verifyToken: () => Promise.resolve(true), now }),
  );
  app.post('/capture', captureHandler({ db, mono, captureToken: CAPTURE_TOKEN, now }));

  const post = (path: string, token: string) =>
    app.request(`https://worker.example.com${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID }),
    });

  return {
    raw,
    mono,
    createInvoice: () => post('/create-invoice', 'session-token-fixture'),
    capture: () => post('/capture', CAPTURE_TOKEN),
    setStatus: (invoiceId: string, status: string) =>
      raw.prepare('UPDATE invoices SET status = ? WHERE invoice_id = ?').run(status, invoiceId),
    rows: () => raw.prepare('SELECT invoice_id, status FROM invoices ORDER BY invoice_id').all(),
  };
}

describe('POST /create-invoice — кошти вже заблоковано (hold)', () => {
  it('повторний запит → 409, другий інвойс не створюється', async () => {
    const world = makeWorld(['made-to-order']);
    await world.createInvoice();
    world.setStatus('inv1', 'hold');

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(1);
    expect(world.rows()).toEqual([{ invoice_id: 'inv1', status: 'hold' }]);
  });

  it('/capture після повторного відкриття сторінки фіналізує справжній hold', async () => {
    const world = makeWorld(['made-to-order']);
    await world.createInvoice();
    world.setStatus('inv1', 'hold');
    await world.createInvoice();

    const res = await world.capture();

    expect(res.status).toBe(202);
    expect(world.mono.finalizeInvoice).toHaveBeenCalledWith({ invoiceId: 'inv1', amount: 42000 });
  });
});

describe('POST /create-invoice — оплата з розбіжністю суми на розгляді оператора', () => {
  it('списано не ту суму → 409: новий інвойс на повну суму означав би подвійну оплату', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.raw
      .prepare(
        "UPDATE invoices SET status = 'success', final_amount = 100 WHERE invoice_id = 'inv1'",
      )
      .run();

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('звичайна успішна оплата не блокує новий інвойс (доплата після редагування замовлення)', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.raw
      .prepare(
        "UPDATE invoices SET status = 'success', final_amount = 42000 WHERE invoice_id = 'inv1'",
      )
      .run();

    const res = await world.createInvoice();

    expect(res.status).toBe(200);
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(2);
  });
});

describe('POST /create-invoice — одночасні запити для одного замовлення', () => {
  it('у D1 лишається один інвойс, зайвий mono-інвойс інвалідовано, обидві відповіді однакові', async () => {
    const world = makeWorld();

    const responses = await Promise.all([world.createInvoice(), world.createInvoice()]);

    expect(world.rows()).toHaveLength(1);
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(2);
    expect(world.mono.removeInvoice).toHaveBeenCalledTimes(1);
    const [winner] = world.rows() as Array<{ invoice_id: string }>;
    const removed = world.mono.removeInvoice.mock.calls.map(([arg]) => arg);
    expect(removed).not.toContainEqual({ invoiceId: winner?.invoice_id });
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        invoiceId: winner?.invoice_id,
        pageUrl: `https://pay.mbnk.biz/${winner?.invoice_id}`,
      });
    }
  });
});

describe('схема invoices — один активний інвойс на замовлення', () => {
  const insert = (raw: ReturnType<typeof makeSqliteD1>['raw'], id: string, status: string) =>
    raw
      .prepare(
        "INSERT INTO invoices (invoice_id, order_id, amount, payment_type, status, created_at) VALUES (?, ?, 42000, 'debit', ?, ?)",
      )
      .run(id, ORDER_ID, status, FIXED_NOW);

  for (const active of ['created', 'processing', 'hold']) {
    it(`другий інвойс поруч з активним «${active}» відхиляється`, () => {
      const { raw } = makeSqliteD1();
      insert(raw, 'inv1', active);

      expect(() => insert(raw, 'inv2', 'created')).toThrow(/UNIQUE/);
    });
  }

  for (const terminal of ['success', 'failure', 'reversed', 'expired']) {
    it(`після термінального «${terminal}» новий інвойс дозволено`, () => {
      const { raw } = makeSqliteD1();
      insert(raw, 'inv1', terminal);

      expect(() => insert(raw, 'inv2', 'created')).not.toThrow();
    });
  }
});
