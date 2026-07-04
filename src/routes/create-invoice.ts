// POST /create-invoice (Path A, PRD §5 кроки 2–6): читає замовлення з Shopify,
// визначає debit/hold, створює mono-інвойс, записує в D1, повертає pageUrl.
//
// Сума завжди береться з живого Shopify-замовлення — клієнтське тіло запиту
// не читається на предмет суми (CLAUDE.md → Security → amount integrity).

import type { Context } from 'hono';

import { buildBasketOrder, buildDestination, resolvePaymentType } from '../lib/invoice-mapping';
import type { MonoClient } from '../lib/mono-client';
import type { ShopifyClient } from '../lib/shopify-client';

export type CreateInvoiceDeps = {
  shopify: Pick<ShopifyClient, 'getOrderForInvoice'>;
  mono: Pick<MonoClient, 'createInvoice' | 'removeInvoice'>;
  db: D1Database;
  /** Unix-час у секундах; ін'єктується для детермінованих тестів. */
  now: () => number;
};

type ExistingInvoiceRow = {
  invoice_id: string;
  page_url: string | null;
};

export function createInvoiceHandler(deps: CreateInvoiceDeps) {
  return async (c: Context) => {
    const body = await c.req.json<{ orderId?: unknown }>().catch(() => null);
    const orderId = typeof body?.orderId === 'string' ? body.orderId : '';
    if (orderId.length === 0) {
      return c.json({ error: 'orderId is required' }, 400);
    }

    const existing = await deps.db
      .prepare(
        "SELECT invoice_id, page_url FROM invoices WHERE order_id = ? AND status IN ('created', 'processing')",
      )
      .bind(orderId)
      .first<ExistingInvoiceRow>();
    if (existing) {
      return c.json({ invoiceId: existing.invoice_id, pageUrl: existing.page_url });
    }

    let order: Awaited<ReturnType<typeof deps.shopify.getOrderForInvoice>>;
    try {
      order = await deps.shopify.getOrderForInvoice(orderId);
    } catch (err) {
      console.error('shopify getOrderForInvoice failed', err);
      return c.json({ error: 'shopify error' }, 502);
    }
    if (!order) {
      return c.json({ error: 'order not found' }, 404);
    }
    if (order.financialStatus === 'PAID') {
      return c.json({ error: 'order already paid' }, 409);
    }
    if (order.currencyCode !== 'UAH') {
      return c.json({ error: 'unsupported currency' }, 422);
    }
    if (order.totalOutstandingKopecks <= 0) {
      return c.json({ error: 'nothing to pay' }, 422);
    }

    const paymentType = resolvePaymentType(order.lineItems);
    const webHookUrl = `${new URL(c.req.url).origin}/mono-webhook`;

    let invoice: { invoiceId: string; pageUrl: string };
    try {
      invoice = await deps.mono.createInvoice({
        amount: order.totalOutstandingKopecks,
        ccy: 980,
        paymentType,
        merchantPaymInfo: {
          reference: orderId,
          destination: buildDestination(order.name),
          basketOrder: buildBasketOrder(order.lineItems),
        },
        webHookUrl,
        ...(order.statusPageUrl ? { redirectUrl: order.statusPageUrl } : {}),
      });
    } catch (err) {
      console.error('mono createInvoice failed', err);
      return c.json({ error: 'payment provider error' }, 502);
    }

    try {
      await deps.db
        .prepare(
          'INSERT INTO invoices (invoice_id, order_id, amount, ccy, payment_type, status, page_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          invoice.invoiceId,
          orderId,
          order.totalOutstandingKopecks,
          980,
          paymentType,
          'created',
          invoice.pageUrl,
          deps.now(),
        )
        .run();
    } catch (err) {
      console.error('D1 insert failed after mono invoice created — invalidating invoice', err);
      try {
        await deps.mono.removeInvoice({ invoiceId: invoice.invoiceId });
      } catch (removeErr) {
        console.error('mono removeInvoice after D1 failure also failed', removeErr);
      }
      return c.json({ error: 'internal error' }, 500);
    }

    return c.json({ invoiceId: invoice.invoiceId, pageUrl: invoice.pageUrl, paymentType });
  };
}
