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
const CONFIRMATION_NUMBER = 'XPAV284CT';
const CAPTURE_TOKEN = 'test-capture-token-fixture'; // фікстура, не реальний секрет

function makeOrder(productTags: string[]): OrderForInvoice {
  return {
    id: ORDER_ID,
    name: '#1001',
    financialStatus: 'PENDING',
    cancelledAt: null,
    confirmationNumber: 'XPAV284CT',
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

function makeWorld(productTags: string[] = [], enforceOrderBinding = true) {
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
  // Замовлення можна змінити між запитами — як це робить продавець в адмінці
  const order = makeOrder(productTags);
  const shopify = { getOrderForInvoice: vi.fn(async () => ({ ...order })) };
  const now = () => FIXED_NOW;

  const app = new Hono();
  app.post(
    '/create-invoice',
    createInvoiceHandler({
      shopify,
      mono,
      db,
      verifyToken: () => Promise.resolve(true),
      enforceOrderBinding,
      now,
    }),
  );
  app.post('/capture', captureHandler({ db, mono, captureToken: CAPTURE_TOKEN, now }));

  const post = (path: string, token: string, extra: Record<string, unknown> = {}) =>
    app.request(`https://worker.example.com${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER_ID, ...extra }),
    });

  return {
    raw,
    mono,
    order,
    /** За замовчуванням — як справжній покупець: з номером підтвердження свого замовлення. */
    // rest-параметр, а не значення за замовчуванням: явний undefined має
    // означати «номер не передано», а не підставляти правильний
    createInvoice: (...override: [unknown?]) =>
      post('/create-invoice', 'session-token-fixture', {
        confirmationNumber: override.length > 0 ? override[0] : CONFIRMATION_NUMBER,
      }),
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

describe("POST /create-invoice — прив'язка до замовлення", () => {
  // Session token доводить лише «це покупець нашого магазину». Номер підтвердження
  // знає тільки той, хто бачив Thank You сторінку саме цього замовлення.

  it('свій номер підтвердження → інвойс створюється', async () => {
    const world = makeWorld();

    const res = await world.createInvoice();

    expect(res.status).toBe(200);
  });

  const foreign: Array<[string, unknown]> = [
    ['чужий номер', 'ZZZZ00000'],
    ['номер не передано', undefined],
    ['номер не рядок', 12345],
    ['порожній номер', ''],
  ];
  for (const [label, value] of foreign) {
    it(`${label} → 404 як для неіснуючого замовлення, без інвойсу`, async () => {
      const world = makeWorld();

      const res = await world.createInvoice(value);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'order not found' });
      expect(world.mono.createInvoice).not.toHaveBeenCalled();
      expect(world.rows()).toEqual([]);
    });
  }

  it('у замовлення в Shopify немає номера → 404 (fail-closed), навіть із порожнім номером у запиті', async () => {
    const world = makeWorld();
    world.order.confirmationNumber = null;

    expect((await world.createInvoice('')).status).toBe(404);
    expect((await world.createInvoice(null)).status).toBe(404);
  });

  it('чужий номер не розкриває стан замовлення: hold теж дає 404, а не 409', async () => {
    const world = makeWorld(['made-to-order']);
    await world.createInvoice();
    world.setStatus('inv1', 'hold');

    const res = await world.createInvoice('ZZZZ00000');

    expect(res.status).toBe(404);
  });

  it('чужий номер не видає посилання на наявний інвойс', async () => {
    const world = makeWorld();
    await world.createInvoice();

    const res = await world.createInvoice('ZZZZ00000');

    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty('pageUrl');
  });

  it('режим спостереження (enforceOrderBinding=false) → запит проходить, розбіжність пишеться в лог без самих номерів', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const world = makeWorld([], false);

    const res = await world.createInvoice('ZZZZ00000');

    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain('ZZZZ00000');
    expect(logged).not.toContain(CONFIRMATION_NUMBER);
    warn.mockRestore();
  });
});

describe('POST /create-invoice — оплата на розгляді оператора', () => {
  const sendToReview = (world: ReturnType<typeof makeWorld>, outstanding: number) =>
    world.raw
      .prepare(
        "UPDATE invoices SET status = 'success', review_outstanding = ? WHERE invoice_id = 'inv1'",
      )
      .run(outstanding);

  it('залишок замовлення не змінився → 409: новий інвойс означав би повторне списання', async () => {
    const world = makeWorld();
    await world.createInvoice();
    sendToReview(world, 42000);

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'payment under review' });
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('оператор зафіксував часткову оплату в Shopify → новий інвойс на залишок', async () => {
    const world = makeWorld();
    await world.createInvoice();
    sendToReview(world, 42000);
    world.order.totalOutstandingKopecks = 41900;

    const res = await world.createInvoice();

    expect(res.status).toBe(200);
    expect(world.mono.createInvoice).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: 41900 }),
    );
  });

  it('звичайна успішна оплата не блокує новий інвойс (доплата після редагування замовлення)', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.setStatus('inv1', 'success');

    const res = await world.createInvoice();

    expect(res.status).toBe(200);
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(2);
  });
});

describe('POST /create-invoice — наявний інвойс і поточний стан замовлення', () => {
  it('сума не змінилась → повертається той самий інвойс, mono не викликається', async () => {
    const world = makeWorld();
    await world.createInvoice();

    const res = await world.createInvoice();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invoiceId: 'inv1', pageUrl: 'https://pay.mbnk.biz/inv1' });
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(1);
    expect(world.mono.removeInvoice).not.toHaveBeenCalled();
  });

  it('замовлення відредаговано → старий інвойс інвалідовано, новий — на актуальну суму', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.order.totalOutstandingKopecks = 50000;

    const res = await world.createInvoice();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ invoiceId: 'inv2' });
    expect(world.mono.removeInvoice).toHaveBeenCalledWith({ invoiceId: 'inv1' });
    expect(world.mono.createInvoice).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: 50000 }),
    );
    expect(world.rows()).toEqual([
      { invoice_id: 'inv1', status: 'expired' },
      { invoice_id: 'inv2', status: 'created' },
    ]);
  });

  it('застарілий інвойс не вдалося інвалідувати → 502, нового немає: два платні посилання гірші за помилку', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.order.totalOutstandingKopecks = 50000;
    world.mono.removeInvoice.mockRejectedValueOnce(new Error('mono down'));

    const res = await world.createInvoice();

    expect(res.status).toBe(502);
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(1);
    expect(world.rows()).toEqual([{ invoice_id: 'inv1', status: 'created' }]);
  });

  it('статус застарілого інвойсу змінився під час інвалідації → 409, нового немає', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.order.totalOutstandingKopecks = 50000;
    // Вебхук встиг перевести інвойс у hold, поки ми зверталися до mono
    world.mono.removeInvoice.mockImplementationOnce(async () => {
      world.setStatus('inv1', 'hold');
      return undefined;
    });

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(1);
    expect(world.rows()).toEqual([{ invoice_id: 'inv1', status: 'hold' }]);
  });

  it('застарілий інвойс уже оплачують (processing) → 409, нічого не інвалідуємо', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.setStatus('inv1', 'processing');
    world.order.totalOutstandingKopecks = 50000;

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(world.mono.removeInvoice).not.toHaveBeenCalled();
    expect(world.mono.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('замовлення скасовано → 409, посилання на наявний інвойс більше не видається', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.order.cancelledAt = '2027-01-15T10:00:00Z';

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'order cancelled' });
    // Пряме посилання на сторінку mono теж має перестати працювати
    expect(world.mono.removeInvoice).toHaveBeenCalledWith({ invoiceId: 'inv1' });
    expect(world.rows()).toEqual([{ invoice_id: 'inv1', status: 'expired' }]);
  });

  it('скасовано, але mono відмовив в інвалідації → усе одно 409, інвойс лишається як був', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.order.cancelledAt = '2027-01-15T10:00:00Z';
    world.mono.removeInvoice.mockRejectedValueOnce(new Error('mono down'));

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(world.rows()).toEqual([{ invoice_id: 'inv1', status: 'created' }]);
  });

  it('скасовано, а інвойс уже оплачують (processing) → 409 без інвалідації', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.setStatus('inv1', 'processing');
    world.order.cancelledAt = '2027-01-15T10:00:00Z';

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(world.mono.removeInvoice).not.toHaveBeenCalled();
  });

  it('скасоване замовлення без інвойсу → 409, інвойс не створюється', async () => {
    const world = makeWorld();
    world.order.cancelledAt = '2027-01-15T10:00:00Z';

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
    expect(world.mono.createInvoice).not.toHaveBeenCalled();
    expect(world.rows()).toEqual([]);
  });

  it('замовлення вже PAID → 409, навіть якщо в D1 лишився активний інвойс', async () => {
    const world = makeWorld();
    await world.createInvoice();
    world.order.financialStatus = 'PAID';

    const res = await world.createInvoice();

    expect(res.status).toBe(409);
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
