import { describe, expect, it, vi } from 'vitest';

import { type CronDeps, runCron } from '../src/cron';
import type { InvoiceStatusResponse } from '../src/lib/mono-client';
import type { OrderForInvoice } from '../src/lib/shopify-client';

const FIXED_NOW = 1_800_000_000;

type Row = {
  invoice_id: string;
  order_id: string;
  payment_type: string;
  amount: number;
  page_url: string | null;
  created_at: number;
};

function reminderRow(overrides: Partial<Row> = {}): Row {
  return {
    invoice_id: 'p2_rem1',
    order_id: 'gid://shopify/Order/1',
    payment_type: 'debit',
    amount: 42000,
    page_url: 'https://pay.mbnk.biz/p2_rem1',
    created_at: FIXED_NOW - 3600, // 1 година тому
    ...overrides,
  };
}

function cleanupRow(overrides: Partial<Row> = {}): Row {
  return {
    invoice_id: 'p2_old1',
    order_id: 'gid://shopify/Order/2',
    payment_type: 'debit',
    amount: 15000,
    page_url: 'https://pay.mbnk.biz/p2_old1',
    created_at: FIXED_NOW - 100_000, // >24 год тому
    ...overrides,
  };
}

type DbCall = { sql: string; params: unknown[] };

function makeDb(options: {
  reminderRows?: Row[];
  cleanupRows?: Row[];
  /** Інвойси, що померли самі (failure/expired) і ще не пройшли чистку. */
  deadRows?: Row[];
  /** Чи є в замовлення інший інвойс, через який його не можна скасовувати. */
  hasOtherLiveInvoice?: boolean;
  claimChanges?: number;
}) {
  const calls: DbCall[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return statement;
        },
        all: vi.fn(() => {
          let results = options.cleanupRows ?? [];
          if (sql.includes('reminder_count = 0')) {
            results = options.reminderRows ?? [];
          } else if (sql.includes('cleanup_done_at IS NULL')) {
            results = options.deadRows ?? [];
          }
          return Promise.resolve({ results });
        }),
        first: vi.fn(() =>
          Promise.resolve(options.hasOtherLiveInvoice ? { invoice_id: 'x' } : null),
        ),
        run: vi.fn(() =>
          Promise.resolve({
            success: true,
            meta: { changes: sql.includes('reminder_count + 1') ? (options.claimChanges ?? 1) : 1 },
          }),
        ),
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function liveStatus(status: string, extra: Partial<InvoiceStatusResponse> = {}) {
  return { invoiceId: 'x', status, amount: 42000, ccy: 980, ...extra } as InvoiceStatusResponse;
}

function makeDeps(options: {
  reminderRows?: Row[];
  cleanupRows?: Row[];
  deadRows?: Row[];
  hasOtherLiveInvoice?: boolean;
  claimChanges?: number;
  invoiceStatusImpl?: (invoiceId: string) => Promise<InvoiceStatusResponse>;
  removeImpl?: () => Promise<void>;
  cancelImpl?: () => Promise<void>;
  sendImpl?: () => Promise<void>;
  orderImpl?: (orderId: string) => Promise<OrderForInvoice | null>;
}) {
  const { db, calls } = makeDb(options);
  const mono = {
    invoiceStatus: vi.fn(
      options.invoiceStatusImpl ?? (() => Promise.resolve(liveStatus('created'))),
    ),
    removeInvoice: vi.fn(options.removeImpl ?? (() => Promise.resolve())),
  };
  // Залишок замовлення в Shopify дорівнює сумі його інвойсу з вибірки —
  // якщо тест не задає іншого через orderImpl
  const amountByOrder = new Map(
    [
      ...(options.reminderRows ?? []),
      ...(options.cleanupRows ?? []),
      ...(options.deadRows ?? []),
    ].map((row) => [row.order_id, row.amount]),
  );
  const shopify = {
    getOrderForInvoice: vi.fn(
      options.orderImpl ??
        ((orderId: string) =>
          Promise.resolve({
            id: orderId,
            name: '#1001',
            financialStatus: 'PENDING',
            cancelledAt: null,
            confirmationNumber: 'XPAV284CT',
            statusPageUrl: null,
            totalOutstandingKopecks: amountByOrder.get(orderId) ?? 0,
            currencyCode: 'UAH',
            paymentGatewayNames: ['monobank'],
            lineItems: [],
          })),
    ),
    orderMarkAsPaid: vi.fn().mockResolvedValue(undefined),
    orderCancel: vi.fn(options.cancelImpl ?? (() => Promise.resolve())),
  };
  const notifier = { send: vi.fn(options.sendImpl ?? (() => Promise.resolve())) };
  const deps: CronDeps = { db, mono, shopify, notifier, now: () => FIXED_NOW };
  return { deps, db, calls, mono, shopify, notifier };
}

describe('runCron — нагадування', () => {
  it('шле нагадування з pageUrl і сумою в грн, claim перед відправкою', async () => {
    const f = makeDeps({ reminderRows: [reminderRow()] });

    await runCron(f.deps);

    const claim = f.calls.find((c) => c.sql.includes('reminder_count + 1'));
    expect(claim).toBeDefined();
    expect(claim?.params).toEqual([FIXED_NOW, 'p2_rem1']);
    expect(f.notifier.send).toHaveBeenCalledTimes(1);
    const text = (f.notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(text).toContain('https://pay.mbnk.biz/p2_rem1');
    expect(text).toContain('420.00');
    expect(text).toContain('gid://shopify/Order/1');
  });

  it('звірка перед нагадуванням: mono каже success → mark-paid, send НЕ викликано', async () => {
    const f = makeDeps({
      reminderRows: [reminderRow()],
      // без finalAmount — покриває null-гілку для debit
      invoiceStatusImpl: () => Promise.resolve(liveStatus('success')),
    });

    await runCron(f.deps);

    expect(f.shopify.orderMarkAsPaid).toHaveBeenCalledWith('gid://shopify/Order/1');
    expect(f.notifier.send).not.toHaveBeenCalled();
    const update = f.calls.find((c) => c.sql.includes("status = 'success'"));
    expect(update).toBeDefined();
  });

  it('звірка: mono каже expired → лише UPDATE статусу, без send і mark-paid', async () => {
    const f = makeDeps({
      reminderRows: [reminderRow()],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('expired')),
    });

    await runCron(f.deps);

    expect(f.notifier.send).not.toHaveBeenCalled();
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    const update = f.calls.find((c) => c.sql.includes('SET status = ?'));
    expect(update?.params[0]).toBe('expired');
  });

  it('звірка: mono каже processing (оплата триває) → без нагадування і без змін у D1', async () => {
    const f = makeDeps({
      reminderRows: [reminderRow()],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('processing')),
    });

    await runCron(f.deps);

    expect(f.notifier.send).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('звірка: mono каже hold (пропущений вебхук) → D1 отримує hold, нагадування немає', async () => {
    const f = makeDeps({
      reminderRows: [reminderRow({ payment_type: 'hold' })],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('hold')),
    });

    await runCron(f.deps);

    expect(f.notifier.send).not.toHaveBeenCalled();
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    const update = f.calls.find((c) => c.sql.includes("SET status = 'hold'"));
    expect(update?.sql).toContain("status IN ('created','processing')");
    expect(update?.params).toEqual([FIXED_NOW, 'p2_rem1']);
  });

  it('page_url відсутній → у тексті «недоступне»', async () => {
    const f = makeDeps({ reminderRows: [reminderRow({ page_url: null })] });

    await runCron(f.deps);

    const text = (f.notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(text).toContain('недоступне');
  });

  it('claim-гонка (changes=0) → send не викликано', async () => {
    const f = makeDeps({ reminderRows: [reminderRow()], claimChanges: 0 });

    await runCron(f.deps);

    expect(f.notifier.send).not.toHaveBeenCalled();
  });

  it('send впав → решта інвойсів оброблена', async () => {
    const rows = [
      reminderRow(),
      reminderRow({ invoice_id: 'p2_rem2', order_id: 'gid://shopify/Order/9' }),
    ];
    let call = 0;
    const f = makeDeps({
      reminderRows: rows,
      sendImpl: () => {
        call += 1;
        return call === 1 ? Promise.reject(new Error('telegram down')) : Promise.resolve();
      },
    });

    await runCron(f.deps);

    expect(f.notifier.send).toHaveBeenCalledTimes(2);
  });

  it('invoiceStatus впав → пропуск без падіння прогону', async () => {
    const f = makeDeps({
      reminderRows: [reminderRow()],
      invoiceStatusImpl: () => Promise.reject(new Error('mono down')),
    });

    await expect(runCron(f.deps)).resolves.toBeUndefined();
    expect(f.notifier.send).not.toHaveBeenCalled();
  });
});

describe('runCron — чистка 24h+', () => {
  it('mono каже success (пропущений вебхук) → mark-paid + UPDATE, без скасування', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow()],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('success', { finalAmount: 15000 })),
    });

    await runCron(f.deps);

    expect(f.shopify.orderMarkAsPaid).toHaveBeenCalledWith('gid://shopify/Order/2');
    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    expect(f.mono.removeInvoice).not.toHaveBeenCalled();
    const update = f.calls.find((c) => c.sql.includes("status = 'success'"));
    expect(update?.sql).not.toContain('captured_at'); // debit
  });

  it('hold + success → UPDATE містить captured_at', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow({ payment_type: 'hold' })],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('success', { amount: 15000 })),
    });

    await runCron(f.deps);

    const update = f.calls.find((c) => c.sql.includes("status = 'success'"));
    expect(update?.sql).toContain('captured_at');
    expect(update?.params).toEqual([FIXED_NOW, null, FIXED_NOW, 'p2_old1']);
  });

  it('hold + success із finalAmount → сума потрапляє в UPDATE', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow({ payment_type: 'hold' })],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('success', { finalAmount: 15000 })),
    });

    await runCron(f.deps);

    const update = f.calls.find((c) => c.sql.includes("status = 'success'"));
    expect(update?.params).toEqual([FIXED_NOW, 15000, FIXED_NOW, 'p2_old1']);
  });

  it('success, але списано не ту суму → без mark-paid, сповіщення, сума фіксується в D1', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow({ payment_type: 'hold' })],
      invoiceStatusImpl: () =>
        Promise.resolve(liveStatus('success', { amount: 15000, finalAmount: 100 })),
    });

    await runCron(f.deps);

    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    const text = (f.notifier.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(text).toContain('gid://shopify/Order/2');
    expect(text).toContain('150.00');
    expect(text).toContain('1.00');
    const update = f.calls.find((c) => c.sql.includes("status = 'success'"));
    expect(update?.params).toEqual([FIXED_NOW, 100, FIXED_NOW, 'p2_old1']);
    const review = f.calls.find((c) => c.sql.includes('review_outstanding'));
    expect(review?.params).toEqual([15000, 'p2_old1']);
  });

  it('success, але замовлення не знайдено в Shopify → без mark-paid, сповіщення оператору', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow()],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('success', { amount: 15000 })),
      orderImpl: () => Promise.resolve(null),
    });

    await runCron(f.deps);

    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.notifier.send).toHaveBeenCalledTimes(1);
    const review = f.calls.find((c) => c.sql.includes('review_outstanding'));
    expect(review?.params).toEqual([15000, 'p2_old1']);
  });

  it('розбіжність суми, сповіщення не відправилось → D1 не змінено, наступний прогін повторить', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow()],
      invoiceStatusImpl: () =>
        Promise.resolve(liveStatus('success', { amount: 15000, finalAmount: 100 })),
      sendImpl: () => Promise.reject(new Error('telegram down')),
    });

    await runCron(f.deps);

    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('mono каже created → removeInvoice + orderCancel + UPDATE expired', async () => {
    const f = makeDeps({ cleanupRows: [cleanupRow()] });

    await runCron(f.deps);

    expect(f.mono.removeInvoice).toHaveBeenCalledWith({ invoiceId: 'p2_old1' });
    expect(f.shopify.orderCancel).toHaveBeenCalledWith('gid://shopify/Order/2');
    const update = f.calls.find((c) => c.sql.includes('SET status = ?'));
    expect(update?.params).toEqual(['expired', FIXED_NOW, FIXED_NOW, 'p2_old1']);
  });

  it('orderCancel впав → D1 НЕ оновлено (наступний прогін повторить)', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow()],
      cancelImpl: () => Promise.reject(new Error('shopify down')),
    });

    await runCron(f.deps);

    const update = f.calls.find((c) => c.sql.includes('SET status = ?'));
    expect(update).toBeUndefined();
  });

  it('removeInvoice впав → інвойс ще може бути оплачений, тож замовлення НЕ скасовується', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow()],
      removeImpl: () => Promise.reject(new Error('invoice in processing')),
    });

    await runCron(f.deps);

    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('mono каже processing (оплата триває) → нічого не інвалідуємо й не скасовуємо', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow()],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('processing')),
    });

    await runCron(f.deps);

    expect(f.mono.removeInvoice).not.toHaveBeenCalled();
    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('mono каже hold (кошти заблоковано) → D1 отримує hold, замовлення НЕ скасовується', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow({ payment_type: 'hold' })],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('hold')),
    });

    await runCron(f.deps);

    expect(f.mono.removeInvoice).not.toHaveBeenCalled();
    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    const update = f.calls.find((c) => c.sql.includes("SET status = 'hold'"));
    expect(update?.params).toEqual([FIXED_NOW, 'p2_old1']);
  });

  it('невідомий статус від mono → fail-closed: без скасування і без змін у D1', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow()],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('some-future-status')),
    });

    await runCron(f.deps);

    expect(f.mono.removeInvoice).not.toHaveBeenCalled();
    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('помилка на одному інвойсі не зупиняє решту', async () => {
    const rows = [
      cleanupRow(),
      cleanupRow({ invoice_id: 'p2_old2', order_id: 'gid://shopify/Order/3' }),
    ];
    let call = 0;
    const f = makeDeps({
      cleanupRows: rows,
      invoiceStatusImpl: () => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error('mono down'))
          : Promise.resolve(liveStatus('created'));
      },
    });

    await runCron(f.deps);

    expect(f.shopify.orderCancel).toHaveBeenCalledTimes(1);
    expect(f.shopify.orderCancel).toHaveBeenCalledWith('gid://shopify/Order/3');
  });
});

describe('runCron — чистка після інвойсу, що помер сам (failure/expired)', () => {
  const shopifyOrder = (overrides: Partial<OrderForInvoice>) => () =>
    Promise.resolve({
      id: 'gid://shopify/Order/2',
      name: '#1002',
      financialStatus: 'PENDING',
      cancelledAt: null,
      confirmationNumber: 'XPAV284CT',
      statusPageUrl: null,
      totalOutstandingKopecks: 15000,
      currencyCode: 'UAH',
      paymentGatewayNames: ['monobank'],
      lineItems: [],
      ...overrides,
    });
  const marked = (f: ReturnType<typeof makeDeps>) =>
    f.calls.find((c) => c.sql.includes('SET cleanup_done_at'));

  it('замовлення досі неоплачене → скасовується, інвойс позначається перевіреним', async () => {
    const f = makeDeps({ deadRows: [cleanupRow()] });

    await runCron(f.deps);

    expect(f.shopify.orderCancel).toHaveBeenCalledWith('gid://shopify/Order/2');
    expect(marked(f)?.params).toEqual([FIXED_NOW, 'p2_old1']);
    // mono не питаємо: інвойс уже термінальний, оплатити його неможливо
    expect(f.mono.invoiceStatus).not.toHaveBeenCalled();
    expect(f.mono.removeInvoice).not.toHaveBeenCalled();
  });

  it('у замовлення є інший живий або оплачений інвойс → не скасовуємо, але позначаємо перевіреним', async () => {
    const f = makeDeps({ deadRows: [cleanupRow()], hasOtherLiveInvoice: true });

    await runCron(f.deps);

    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    expect(f.shopify.getOrderForInvoice).not.toHaveBeenCalled();
    expect(marked(f)).toBeDefined();
  });

  const untouchable: Array<[string, Partial<OrderForInvoice>]> = [
    ['оплачене іншим способом (PAID)', { financialStatus: 'PAID' }],
    ['частково оплачене', { financialStatus: 'PARTIALLY_PAID' }],
    ['уже скасоване', { cancelledAt: '2027-01-15T10:00:00Z' }],
  ];
  for (const [label, overrides] of untouchable) {
    it(`замовлення ${label} → не скасовуємо, позначаємо перевіреним`, async () => {
      const f = makeDeps({ deadRows: [cleanupRow()], orderImpl: shopifyOrder(overrides) });

      await runCron(f.deps);

      expect(f.shopify.orderCancel).not.toHaveBeenCalled();
      expect(marked(f)).toBeDefined();
    });
  }

  it('замовлення не знайдено в Shopify → не скасовуємо, позначаємо перевіреним', async () => {
    const f = makeDeps({ deadRows: [cleanupRow()], orderImpl: () => Promise.resolve(null) });

    await runCron(f.deps);

    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    expect(marked(f)).toBeDefined();
  });

  it('orderCancel впав → не позначено перевіреним, наступний прогін повторить', async () => {
    const f = makeDeps({
      deadRows: [cleanupRow()],
      cancelImpl: () => Promise.reject(new Error('shopify down')),
    });

    await runCron(f.deps);

    expect(marked(f)).toBeUndefined();
  });

  it('помилка на одному інвойсі не зупиняє решту', async () => {
    const f = makeDeps({
      deadRows: [
        cleanupRow(),
        cleanupRow({ invoice_id: 'p2_old2', order_id: 'gid://shopify/Order/3' }),
      ],
    });
    f.shopify.getOrderForInvoice.mockRejectedValueOnce(new Error('shopify down'));

    await runCron(f.deps);

    expect(f.shopify.orderCancel).toHaveBeenCalledTimes(1);
    expect(f.shopify.orderCancel).toHaveBeenCalledWith('gid://shopify/Order/3');
  });
});

describe('runCron — чистка активного інвойсу: замовлення не завжди можна скасувати', () => {
  it('mono каже created, але в замовлення є оплачений інвойс → інвойс інвалідовано, замовлення НЕ скасовано', async () => {
    const f = makeDeps({ cleanupRows: [cleanupRow()], hasOtherLiveInvoice: true });

    await runCron(f.deps);

    expect(f.mono.removeInvoice).toHaveBeenCalledWith({ invoiceId: 'p2_old1' });
    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    const update = f.calls.find((c) => c.sql.includes('SET status = ?'));
    expect(update?.params).toEqual(['expired', FIXED_NOW, FIXED_NOW, 'p2_old1']);
  });
});

describe('runCron — порожні вибірки', () => {
  it('нуль викликів mono/shopify/notifier', async () => {
    const f = makeDeps({});

    await runCron(f.deps);

    expect(f.mono.invoiceStatus).not.toHaveBeenCalled();
    expect(f.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(f.shopify.orderCancel).not.toHaveBeenCalled();
    expect(f.notifier.send).not.toHaveBeenCalled();
  });
});
