// Фіксація успішної оплати в Shopify — зі звіркою сум перед mark-paid.
//
// `orderMarkAsPaid` позначає оплаченим увесь залишок замовлення, хоч би скільки
// насправді списано і хоч би що сталося із замовленням після створення інвойсу.
// Тому mark-paid викликається лише коли все сходиться; будь-яка розбіжність —
// рішення людини, а не Worker'а.

import { kopecksToUahString } from './money';
import type { OrderForInvoice, ShopifyClient } from './shopify-client';
import type { Notifier } from './telegram';

/**
 * Фактично списана сума з відповіді mono. `finalAmount` необов'язковий у схемі
 * mono — тоді беремо `amount`. null означає, що суму визначити не вдалося;
 * це трактується як розбіжність (fail-closed).
 */
export function resolvePaidAmount(finalAmount: unknown, amount: unknown): number | null {
  if (typeof finalAmount === 'number') {
    return finalAmount;
  }
  return typeof amount === 'number' ? amount : null;
}

export type SettleDeps = {
  shopify: Pick<ShopifyClient, 'getOrderForInvoice' | 'orderMarkAsPaid'>;
  notifier: Notifier;
};

export type SettledInvoice = {
  invoiceId: string;
  orderId: string;
  /** Сума інвойсу з D1, копійки. */
  amount: number;
};

function reviewReason(
  order: OrderForInvoice | null,
  invoice: SettledInvoice,
  paidAmount: number | null,
): string | null {
  if (!order) {
    return 'замовлення не знайдено в Shopify';
  }
  if (order.cancelledAt !== null) {
    return 'замовлення скасовано, а оплата пройшла';
  }
  if (paidAmount !== invoice.amount) {
    return 'списано не суму інвойсу';
  }
  if (order.totalOutstandingKopecks !== paidAmount) {
    return 'залишок замовлення змінився після створення інвойсу';
  }
  return null;
}

const formatUah = (kopecks: number | null) =>
  kopecks === null ? 'невідомо' : `${kopecksToUahString(kopecks)} грн`;

/**
 * Позначає замовлення оплаченим, якщо списано рівно суму інвойсу і вона досі
 * дорівнює залишку чинного замовлення.
 *
 * Повертає null, коли оплату зафіксовано (або замовлення вже PAID — ретрай).
 * Інакше шле сповіщення оператору й повертає залишок замовлення на цей момент:
 * викликач зберігає його в `invoices.review_outstanding`, і /create-invoice не
 * видає нових інвойсів, поки оператор не зменшить залишок вручну.
 *
 * Будь-який виняток (Shopify, сповіщення) означає «нічого не зафіксовано» —
 * викликач не має підтверджувати вебхук чи оновлювати D1.
 */
export async function settlePayment(
  deps: SettleDeps,
  invoice: SettledInvoice,
  paidAmount: number | null,
): Promise<number | null> {
  const order = await deps.shopify.getOrderForInvoice(invoice.orderId);

  // Ретрай після часткового збою: mark-paid уже спрацював минулого разу
  if (
    order &&
    order.cancelledAt === null &&
    order.financialStatus === 'PAID' &&
    paidAmount === invoice.amount
  ) {
    return null;
  }

  const reason = reviewReason(order, invoice, paidAmount);
  if (reason === null) {
    await deps.shopify.orderMarkAsPaid(invoice.orderId);
    return null;
  }

  const outstanding = order ? order.totalOutstandingKopecks : invoice.amount;
  await deps.notifier.send(
    `🚨 Оплата потребує ручної перевірки — замовлення ${invoice.orderId} НЕ позначено оплаченим\n` +
      `Причина: ${reason}\n` +
      `Інвойс: ${invoice.invoiceId}\n` +
      `Сума інвойсу: ${formatUah(invoice.amount)}\n` +
      `Списано: ${formatUah(paidAmount)}\n` +
      `Залишок замовлення: ${formatUah(order ? order.totalOutstandingKopecks : null)}\n` +
      'Перевірте платіж у кабінеті mono і зафіксуйте оплату або повернення вручну.',
  );
  return outstanding;
}
