// Cron-прогін (PRD §11): нагадування про неоплачені інвойси (30 хв+) і
// чистка «замовлень-привидів» (24 год+). Викликається з scheduled-хендлера
// кожні 15 хв (wrangler.toml).
//
// Перед будь-якою дією — жива звірка статусу з mono (invoiceStatus): вона ж
// є backstop'ом для пропущених вебхуків (рейс «вебхук раніше за INSERT»,
// вичерпані ретраї mono) — реально оплачене замовлення ніколи не скасовується.
//
// Помилки ізольовані на рівні інвойса: одна відмова не зупиняє прогін.

import { kopecksToUahString } from './lib/money';
import type { InvoiceStatusResponse, MonoClient } from './lib/mono-client';
import type { ShopifyClient } from './lib/shopify-client';
import type { Notifier } from './lib/telegram';

const REMINDER_AGE_SECONDS = 30 * 60;
const CLEANUP_AGE_SECONDS = 24 * 60 * 60;
/** Захист CPU-лімітів Workers; хвіст добере наступний прогін через 15 хв. */
const BATCH_LIMIT = 50;

const TERMINAL_STATUSES = new Set(['success', 'failure', 'reversed', 'expired']);

export type CronDeps = {
  db: D1Database;
  mono: Pick<MonoClient, 'invoiceStatus' | 'removeInvoice'>;
  shopify: Pick<ShopifyClient, 'orderMarkAsPaid' | 'orderCancel'>;
  notifier: Notifier;
  /** Unix-час у секундах; ін'єктується для детермінованих тестів. */
  now: () => number;
};

type UnpaidInvoiceRow = {
  invoice_id: string;
  order_id: string;
  payment_type: string;
  amount: number;
  page_url: string | null;
  created_at: number;
};

export async function runCron(deps: CronDeps): Promise<void> {
  const now = deps.now();
  await remindersPass(deps, now);
  await cleanupPass(deps, now);
}

/** Пропущений вебхук: mark-paid у Shopify + фіксація success у D1 (captured_at для hold). */
async function markPaidBackstop(
  deps: CronDeps,
  row: UnpaidInvoiceRow,
  live: InvoiceStatusResponse,
  now: number,
): Promise<void> {
  await deps.shopify.orderMarkAsPaid(row.order_id);
  const isCapture = row.payment_type === 'hold';
  const sql = isCapture
    ? "UPDATE invoices SET status = 'success', modified_at = ?, final_amount = ?, captured_at = ? WHERE invoice_id = ?"
    : "UPDATE invoices SET status = 'success', modified_at = ?, final_amount = ? WHERE invoice_id = ?";
  const params = isCapture
    ? [now, live.finalAmount ?? null, now, row.invoice_id]
    : [now, live.finalAmount ?? null, row.invoice_id];
  await deps.db
    .prepare(sql)
    .bind(...params)
    .run();
}

/**
 * Жива звірка з mono. Повертає true, якщо інвойс уже в термінальному стані
 * (дії виконано або статус зафіксовано) і подальша обробка не потрібна.
 */
async function reconcileWithMono(
  deps: CronDeps,
  row: UnpaidInvoiceRow,
  now: number,
): Promise<boolean> {
  const live = await deps.mono.invoiceStatus(row.invoice_id);
  if (live.status === 'success') {
    await markPaidBackstop(deps, row, live, now);
    return true;
  }
  if (TERMINAL_STATUSES.has(live.status)) {
    await deps.db
      .prepare('UPDATE invoices SET status = ?, modified_at = ? WHERE invoice_id = ?')
      .bind(live.status, now, row.invoice_id)
      .run();
    return true;
  }
  return false;
}

async function remindersPass(deps: CronDeps, now: number): Promise<void> {
  const { results } = await deps.db
    .prepare(
      "SELECT invoice_id, order_id, payment_type, amount, page_url, created_at FROM invoices WHERE status IN ('created','processing') AND created_at <= ? AND created_at > ? AND reminder_count = 0 LIMIT ?",
    )
    .bind(now - REMINDER_AGE_SECONDS, now - CLEANUP_AGE_SECONDS, BATCH_LIMIT)
    .all<UnpaidInvoiceRow>();

  for (const row of results) {
    try {
      if (await reconcileWithMono(deps, row, now)) {
        continue;
      }

      // Claim перед відправкою: подвійного спаму не буде навіть при
      // конкурентному прогоні; втрачене нагадування при падінні send —
      // прийнятніша ціна (лог нижче)
      const claim = await deps.db
        .prepare(
          'UPDATE invoices SET reminder_count = reminder_count + 1, last_reminder_at = ? WHERE invoice_id = ? AND reminder_count = 0',
        )
        .bind(now, row.invoice_id)
        .run();
      if (claim.meta.changes !== 1) {
        continue;
      }

      const ageMinutes = Math.floor((now - row.created_at) / 60);
      await deps.notifier.send(
        `⚠️ Неоплачене замовлення ${row.order_id}\n` +
          `Сума: ${kopecksToUahString(row.amount)} грн\n` +
          `Очікує оплати: ${ageMinutes} хв\n` +
          `Посилання на оплату: ${row.page_url ?? 'недоступне'}`,
      );
    } catch (err) {
      console.error(`cron: нагадування для ${row.invoice_id} не оброблено`, err);
    }
  }
}

async function cleanupPass(deps: CronDeps, now: number): Promise<void> {
  const { results } = await deps.db
    .prepare(
      "SELECT invoice_id, order_id, payment_type, amount, page_url, created_at FROM invoices WHERE status IN ('created','processing') AND created_at <= ? LIMIT ?",
    )
    .bind(now - CLEANUP_AGE_SECONDS, BATCH_LIMIT)
    .all<UnpaidInvoiceRow>();

  for (const row of results) {
    try {
      if (await reconcileWithMono(deps, row, now)) {
        continue;
      }

      // Інвалідація інвойсу — best-effort: він міг уже протермінуватись у mono
      try {
        await deps.mono.removeInvoice({ invoiceId: row.invoice_id });
      } catch (err) {
        console.error(`cron: removeInvoice для ${row.invoice_id} не вдався (ігноруємо)`, err);
      }

      // Провал скасування → виняток → D1 не оновлюється → наступний прогін повторить
      await deps.shopify.orderCancel(row.order_id);

      await deps.db
        .prepare('UPDATE invoices SET status = ?, modified_at = ? WHERE invoice_id = ?')
        .bind('expired', now, row.invoice_id)
        .run();
    } catch (err) {
      console.error(`cron: чистка ${row.invoice_id} не завершена`, err);
    }
  }
}
