import { describe, expect, it, vi } from 'vitest';

import { type CronDeps, runCron } from '../src/cron';
import type { InvoiceStatusResponse } from '../src/lib/mono-client';

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

function makeDb(options: { reminderRows?: Row[]; cleanupRows?: Row[]; claimChanges?: number }) {
  const calls: DbCall[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return statement;
        },
        all: vi.fn(() => {
          const isReminderSelect = sql.includes('reminder_count = 0');
          return Promise.resolve({
            results: isReminderSelect ? (options.reminderRows ?? []) : (options.cleanupRows ?? []),
          });
        }),
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
  claimChanges?: number;
  invoiceStatusImpl?: (invoiceId: string) => Promise<InvoiceStatusResponse>;
  removeImpl?: () => Promise<void>;
  cancelImpl?: () => Promise<void>;
  sendImpl?: () => Promise<void>;
}) {
  const { db, calls } = makeDb(options);
  const mono = {
    invoiceStatus: vi.fn(
      options.invoiceStatusImpl ?? (() => Promise.resolve(liveStatus('created'))),
    ),
    removeInvoice: vi.fn(options.removeImpl ?? (() => Promise.resolve())),
  };
  const shopify = {
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
      invoiceStatusImpl: () => Promise.resolve(liveStatus('success')),
    });

    await runCron(f.deps);

    const update = f.calls.find((c) => c.sql.includes("status = 'success'"));
    expect(update?.sql).toContain('captured_at');
    expect(update?.params).toEqual([FIXED_NOW, null, FIXED_NOW, 'p2_old1']);
  });

  it('hold + success із finalAmount → сума потрапляє в UPDATE', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow({ payment_type: 'hold' })],
      invoiceStatusImpl: () => Promise.resolve(liveStatus('success', { finalAmount: 14000 })),
    });

    await runCron(f.deps);

    const update = f.calls.find((c) => c.sql.includes("status = 'success'"));
    expect(update?.params).toEqual([FIXED_NOW, 14000, FIXED_NOW, 'p2_old1']);
  });

  it('mono каже created → removeInvoice + orderCancel + UPDATE expired', async () => {
    const f = makeDeps({ cleanupRows: [cleanupRow()] });

    await runCron(f.deps);

    expect(f.mono.removeInvoice).toHaveBeenCalledWith({ invoiceId: 'p2_old1' });
    expect(f.shopify.orderCancel).toHaveBeenCalledWith('gid://shopify/Order/2');
    const update = f.calls.find((c) => c.sql.includes('SET status = ?'));
    expect(update?.params).toEqual(['expired', FIXED_NOW, 'p2_old1']);
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

  it('removeInvoice впав → cancel і UPDATE все одно виконуються', async () => {
    const f = makeDeps({
      cleanupRows: [cleanupRow()],
      removeImpl: () => Promise.reject(new Error('already expired')),
    });

    await runCron(f.deps);

    expect(f.shopify.orderCancel).toHaveBeenCalledTimes(1);
    const update = f.calls.find((c) => c.sql.includes('SET status = ?'));
    expect(update?.params[0]).toBe('expired');
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
