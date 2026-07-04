// Мапінг позицій Shopify-замовлення у формат mono basketOrder (PRD §5, §7).
// Ціни вже прийшли з Shopify конвертованими в цілі копійки (src/lib/money.ts).

import type { BasketOrderItem, PaymentType } from './mono-client';

const MADE_TO_ORDER_TAG = 'made-to-order';

export type OrderLineItem = {
  title: string;
  quantity: number;
  sku: string;
  unitPriceKopecks: number;
  imageUrl: string | null;
  productTags: string[];
};

/** `hold`, якщо хоч одна позиція товару має тег made-to-order, інакше `debit` (PRD §7). */
export function resolvePaymentType(lineItems: OrderLineItem[]): PaymentType {
  const isMadeToOrder = lineItems.some((item) =>
    item.productTags.some((tag) => tag.toLowerCase() === MADE_TO_ORDER_TAG),
  );
  return isMadeToOrder ? 'hold' : 'debit';
}

/** `code` обов'язковий для фіскалізації — якщо SKU немає, використовуємо назву товару. */
export function buildBasketOrder(lineItems: OrderLineItem[]): BasketOrderItem[] {
  return lineItems.map((item) => ({
    name: item.title,
    qty: item.quantity,
    sum: item.unitPriceKopecks,
    total: item.unitPriceKopecks * item.quantity,
    code: item.sku || item.title,
    unit: 'шт.',
    ...(item.imageUrl ? { icon: item.imageUrl } : {}),
  }));
}

export function buildDestination(orderName: string): string {
  return `Оплата за замовлення ${orderName}`;
}
