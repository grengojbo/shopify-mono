// POST /capture (PRD §5 крок 11, §7): фіналізація hold-інвойсу, коли
// made-to-order деталь готова до відправки.
//
// Маршрут списує заблоковані гроші клієнта, тому захищений секретом
// CAPTURE_TOKEN (Authorization: Bearer, порівняння сталого часу).
//
// У D1 маршрут НЕ пише: єдине джерело правди для статусу — вебхук mono
// (він же ставить Paid у Shopify та captured_at). Тут лише перевірки
// стану і виклик finalize; сума — завжди з D1, не з тіла запиту.

import type { Context } from 'hono';

import type { MonoClient } from '../lib/mono-client';

export type CaptureDeps = {
  db: D1Database;
  mono: Pick<MonoClient, 'finalizeInvoice'>;
  captureToken: string;
  /** Unix-час у секундах; ін'єктується для детермінованих тестів. */
  now: () => number;
};

type HoldInvoiceRow = {
  invoice_id: string;
  amount: number;
  status: string;
};

/** Порівняння сталого часу: довжини звіряються окремо, далі XOR-акумулятор. */
function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bytesA.length; i += 1) {
    diff |= (bytesA[i] as number) ^ (bytesB[i] as number);
  }
  return diff === 0;
}

export function captureHandler(deps: CaptureDeps) {
  return async (c: Context) => {
    const authorization = c.req.header('Authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (!timingSafeEqual(token, deps.captureToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const body = await c.req.json<{ orderId?: unknown }>().catch(() => null);
    const orderId = typeof body?.orderId === 'string' ? body.orderId : '';
    if (orderId.length === 0) {
      return c.json({ error: 'orderId is required' }, 400);
    }

    const invoice = await deps.db
      .prepare(
        "SELECT invoice_id, amount, status FROM invoices WHERE order_id = ? AND payment_type = 'hold' ORDER BY created_at DESC LIMIT 1",
      )
      .bind(orderId)
      .first<HoldInvoiceRow>();
    if (!invoice) {
      return c.json({ error: 'hold invoice not found' }, 404);
    }

    if (invoice.status === 'success') {
      // Уже сфіналізовано (вебхук встиг) — ідемпотентна відповідь для ретраїв
      return c.json({ invoiceId: invoice.invoice_id, status: 'already-captured' });
    }
    if (invoice.status !== 'hold') {
      // created/processing — гроші ще не заблоковано; failure/reversed/expired — hold неактивний
      return c.json({ error: `invoice is not capturable (status: ${invoice.status})` }, 409);
    }

    try {
      await deps.mono.finalizeInvoice({ invoiceId: invoice.invoice_id, amount: invoice.amount });
    } catch (err) {
      console.error('mono finalizeInvoice впав', err);
      return c.json({ error: 'payment provider error' }, 502);
    }

    // Статус success і Paid у Shopify поставить вебхук mono за кілька секунд
    return c.json({ invoiceId: invoice.invoice_id, status: 'finalize-requested' }, 202);
  };
}
