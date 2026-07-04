// POST /mono-webhook (PRD §5 кроки 8–10, §6): приймає статус інвойсу від mono.
//
// Порядок критичний і навмисний:
//   сирі байти → підпис (fail-closed) → парсинг → ідемпотентність →
//   інвойс із D1 → Shopify mark-paid → атомарний batch у D1 → 200.
// Shopify ПЕРЕД записом webhook_log: якщо запис у D1 упаде, mono отримає
// не-200 і ретраїтиме; повторний mark-paid на вже оплаченому замовленні
// трактується клієнтом як успіх — цикл збігається без подвійних оплат.
// mono ретраїть до 3 разів до першого 200; фінальний backstop — cron (етап 6).

import type { Context } from 'hono';

import { verifyWebhookSignature } from '../lib/ecdsa-verify';
import type { PubkeyProvider } from '../lib/mono-pubkey';
import type { ShopifyClient } from '../lib/shopify-client';

export type MonoWebhookDeps = {
  db: D1Database;
  shopify: Pick<ShopifyClient, 'orderMarkAsPaid'>;
  pubkeys: PubkeyProvider;
  /** Unix-час у секундах; ін'єктується для детермінованих тестів. */
  now: () => number;
};

/** Термінальні статуси не можна перезаписати нетермінальними (пізні/переупорядковані ретраї). */
const TERMINAL_STATUSES = new Set(['success', 'failure', 'reversed', 'expired']);

type WebhookPayload = {
  invoiceId?: unknown;
  status?: unknown;
  finalAmount?: unknown;
  paymentInfo?: { approvalCode?: unknown; rrn?: unknown };
};

type InvoiceRow = {
  order_id: string;
  payment_type: string;
  status: string;
};

async function verifyRawBody(
  deps: MonoWebhookDeps,
  xSign: string,
  rawBody: Uint8Array,
): Promise<boolean> {
  const cachedKey = await deps.pubkeys.get();
  if (await verifyWebhookSignature(cachedKey, xSign, rawBody)) {
    return true;
  }
  // Ключ mono міг ротуватись — одна повторна спроба зі свіжим ключем
  const freshKey = await deps.pubkeys.refresh();
  return verifyWebhookSignature(freshKey, xSign, rawBody);
}

export function monoWebhookHandler(deps: MonoWebhookDeps) {
  return async (c: Context) => {
    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const xSign = c.req.header('X-Sign');
    if (!xSign) {
      return c.json({ error: 'missing signature' }, 400);
    }

    try {
      if (!(await verifyRawBody(deps, xSign, rawBody))) {
        console.error('mono webhook: невалідний підпис');
        return c.json({ error: 'invalid signature' }, 400);
      }
    } catch (err) {
      console.error('mono webhook: помилка верифікації підпису', err);
      return c.json({ error: 'invalid signature' }, 400);
    }

    const bodyText = new TextDecoder().decode(rawBody);
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(bodyText) as WebhookPayload;
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }
    const invoiceId = typeof payload.invoiceId === 'string' ? payload.invoiceId : '';
    const status = typeof payload.status === 'string' ? payload.status : '';
    if (invoiceId.length === 0 || status.length === 0) {
      return c.json({ error: 'invalid body' }, 400);
    }

    // Ідемпотентність: той самий invoiceId+status уже оброблено → 200 без дій
    const alreadyLogged = await deps.db
      .prepare('SELECT id FROM webhook_log WHERE invoice_id = ? AND status = ? LIMIT 1')
      .bind(invoiceId, status)
      .first();
    if (alreadyLogged) {
      return c.json({ ok: true });
    }

    const invoice = await deps.db
      .prepare('SELECT order_id, payment_type, status FROM invoices WHERE invoice_id = ?')
      .bind(invoiceId)
      .first<InvoiceRow>();
    if (!invoice) {
      // Рейс «вебхук раніше за INSERT інвойсу» (PRD §13): не-200 → mono ретраїть
      console.error(`mono webhook: невідомий інвойс ${invoiceId}`);
      return c.json({ error: 'unknown invoice' }, 404);
    }

    const isLateNonTerminal =
      TERMINAL_STATUSES.has(invoice.status) && !TERMINAL_STATUSES.has(status);

    if (status === 'success' && !isLateNonTerminal) {
      try {
        // order_id — з D1, не з тіла вебхука: авторитет — наша база
        await deps.shopify.orderMarkAsPaid(invoice.order_id);
      } catch (err) {
        console.error('mono webhook: orderMarkAsPaid впав — вебхук не підтверджуємо', err);
        return c.json({ error: 'shopify error' }, 500);
      }
    }

    const receivedAt = deps.now();
    const statements = [
      deps.db
        .prepare(
          'INSERT INTO webhook_log (invoice_id, status, raw_body, received_at) VALUES (?, ?, ?, ?)',
        )
        .bind(invoiceId, status, bodyText, receivedAt),
    ];
    if (!isLateNonTerminal) {
      // Для hold-інвойсу success означає capture — фіксуємо момент фіналізації
      const isCapture = invoice.payment_type === 'hold' && status === 'success';
      const updateSql = isCapture
        ? 'UPDATE invoices SET status = ?, modified_at = ?, final_amount = ?, approval_code = ?, rrn = ?, captured_at = ? WHERE invoice_id = ?'
        : 'UPDATE invoices SET status = ?, modified_at = ?, final_amount = ?, approval_code = ?, rrn = ? WHERE invoice_id = ?';
      const baseParams = [
        status,
        receivedAt,
        typeof payload.finalAmount === 'number' ? payload.finalAmount : null,
        typeof payload.paymentInfo?.approvalCode === 'string'
          ? payload.paymentInfo.approvalCode
          : null,
        typeof payload.paymentInfo?.rrn === 'string' ? payload.paymentInfo.rrn : null,
      ];
      const params = isCapture
        ? [...baseParams, receivedAt, invoiceId]
        : [...baseParams, invoiceId];
      statements.push(deps.db.prepare(updateSql).bind(...params));
    }

    try {
      await deps.db.batch(statements);
    } catch (err) {
      console.error('mono webhook: запис у D1 впав — вебхук не підтверджуємо', err);
      return c.json({ error: 'storage error' }, 500);
    }

    return c.json({ ok: true });
  };
}
