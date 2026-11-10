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
  /** Перевірка Shopify session token від Checkout UI Extension. */
  verifyToken: (token: string) => Promise<boolean>;
  /** Unix-час у секундах; ін'єктується для детермінованих тестів. */
  now: () => number;
};

type ActiveInvoiceRow = {
  invoice_id: string;
  page_url: string | null;
  status: string;
  amount: number;
};

// Той самий набір, що й у частковому унікальному індексі з міграції 0002:
// поки інвойс у одному з цих статусів, новий для замовлення не створюється.
const ACTIVE_INVOICE_SQL =
  "SELECT invoice_id, page_url, status, amount FROM invoices WHERE order_id = ? AND status IN ('created', 'processing', 'hold')";

// Extension робить fetch із sandbox-origin чекауту — потрібен CORS.
// `*` безпечний: запит не credentialed, авторизація — власним Bearer-токеном.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
} as const;

// Найбільший залишок, зафіксований під час передачі оплати оператору (міграція 0003)
const REVIEW_SQL =
  'SELECT MAX(review_outstanding) AS outstanding FROM invoices WHERE order_id = ? AND review_outstanding IS NOT NULL';

export function createInvoicePreflightHandler() {
  return (c: Context) => c.body(null, 204, CORS_HEADERS);
}

export function createInvoiceHandler(deps: CreateInvoiceDeps) {
  return async (c: Context) => {
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      c.header(name, value);
    }

    const authorization = c.req.header('Authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (token.length === 0 || !(await deps.verifyToken(token))) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const body = await c.req.json<{ orderId?: unknown }>().catch(() => null);
    const rawOrderId = typeof body?.orderId === 'string' ? body.orderId : '';
    if (rawOrderId.length === 0) {
      return c.json({ error: 'orderId is required' }, 400);
    }
    // OrderConfirmation API на Thank You сторінці віддає id типу OrderIdentity
    // (той самий числовий id, що й майбутній Order) — Admin API приймає лише Order.
    const orderId = rawOrderId.replace(/^gid:\/\/shopify\/OrderIdentity\//, 'gid://shopify/Order/');

    const findActive = () =>
      deps.db.prepare(ACTIVE_INVOICE_SQL).bind(orderId).first<ActiveInvoiceRow>();
    const respondWithActive = (active: ActiveInvoiceRow) => {
      if (active.status === 'hold') {
        // Кошти вже заблоковано — платити вдруге не можна. 409 → extension ховає кнопку.
        return c.json({ error: 'payment already authorized' }, 409);
      }
      return c.json({ invoiceId: active.invoice_id, pageUrl: active.page_url });
    };

    const existing = await findActive();
    if (existing?.status === 'hold') {
      return respondWithActive(existing);
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
    if (order.cancelledAt !== null) {
      // Оплата скасованого замовлення — це списання, яке доведеться повертати.
      // Ще не розпочатий інвойс прибираємо і в mono: хтось міг зберегти пряме
      // посилання на сторінку оплати. Best-effort — відповідь однаково 409.
      if (existing?.status === 'created') {
        try {
          await deps.mono.removeInvoice({ invoiceId: existing.invoice_id });
          await deps.db
            .prepare(
              "UPDATE invoices SET status = 'expired', modified_at = ? WHERE invoice_id = ? AND status = 'created'",
            )
            .bind(deps.now(), existing.invoice_id)
            .run();
        } catch (err) {
          console.error('інвойс скасованого замовлення не інвалідовано', err);
        }
      }
      return c.json({ error: 'order cancelled' }, 409);
    }
    // Кнопка оплати — лише для замовлень з ручним методом «monobank»;
    // COD («Накладений платіж») та інші методи її не бачать (409 → extension
    // тихо ховає блок, як і для вже оплаченого замовлення)
    const isMonoOrder = order.paymentGatewayNames.some((name) =>
      name.toLowerCase().includes('monobank'),
    );
    if (!isMonoOrder) {
      return c.json({ error: 'order not payable via monobank' }, 409);
    }
    if (order.currencyCode !== 'UAH') {
      return c.json({ error: 'unsupported currency' }, 422);
    }
    if (order.totalOutstandingKopecks <= 0) {
      return c.json({ error: 'nothing to pay' }, 422);
    }

    // Гроші за це замовлення вже списано, але Worker не зміг зафіксувати оплату
    // сам і передав рішення оператору. Поки залишок у Shopify не зменшився,
    // новий інвойс означав би повторне списання поверх уже отриманих коштів.
    const review = await deps.db
      .prepare(REVIEW_SQL)
      .bind(orderId)
      .first<{ outstanding: number | null }>();
    if (
      typeof review?.outstanding === 'number' &&
      order.totalOutstandingKopecks >= review.outstanding
    ) {
      return c.json({ error: 'payment under review' }, 409);
    }

    if (existing) {
      // Наявний інвойс видається лише після перевірок замовлення вище і лише
      // якщо його сума досі дорівнює залишку: замовлення могли відредагувати.
      if (existing.amount === order.totalOutstandingKopecks) {
        return respondWithActive(existing);
      }
      if (existing.status !== 'created') {
        // processing — покупець саме платить за старою сумою; інвалідувати не можна
        return c.json({ error: 'payment in progress' }, 409);
      }
      // Спершу прибрати старий у mono: два робочі посилання на різні суми
      // гірші за помилку. Не вдалося — нового не створюємо.
      try {
        await deps.mono.removeInvoice({ invoiceId: existing.invoice_id });
      } catch (err) {
        console.error('mono removeInvoice для застарілого інвойсу впав', err);
        return c.json({ error: 'payment provider error' }, 502);
      }
      const retired = await deps.db
        .prepare(
          "UPDATE invoices SET status = 'expired', modified_at = ? WHERE invoice_id = ? AND status = 'created'",
        )
        .bind(deps.now(), existing.invoice_id)
        .run();
      if (retired.meta.changes !== 1) {
        // Статус змінився, поки ми працювали (вебхук) — нехай клієнт повторить запит
        return c.json({ error: 'payment in progress' }, 409);
      }
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
      // Найімовірніша причина — унікальний індекс: паралельний запит встиг
      // записати свій інвойс першим. Тоді віддаємо його, а не помилку.
      try {
        const winner = await findActive();
        if (winner) {
          return respondWithActive(winner);
        }
      } catch (lookupErr) {
        console.error('D1 lookup after insert failure also failed', lookupErr);
      }
      return c.json({ error: 'internal error' }, 500);
    }

    return c.json({ invoiceId: invoice.invoiceId, pageUrl: invoice.pageUrl, paymentType });
  };
}
