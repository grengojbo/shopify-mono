import { describe, expect, it } from 'vitest';

import {
  buildBasketOrder,
  buildDestination,
  type OrderLineItem,
  resolvePaymentType,
} from '../src/lib/invoice-mapping';

function lineItem(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    title: 'Літофан "Кіт"',
    quantity: 1,
    sku: 'LITO-CAT-01',
    unitPriceKopecks: 42000,
    imageUrl: 'https://cdn.shopify.com/cat.png',
    productTags: [],
    ...overrides,
  };
}

describe('resolvePaymentType', () => {
  it('повертає debit, якщо жоден товар не позначений made-to-order', () => {
    const items = [lineItem({ productTags: ['gift'] }), lineItem({ productTags: [] })];

    expect(resolvePaymentType(items)).toBe('debit');
  });

  it('повертає hold, якщо хоч одна позиція має тег made-to-order', () => {
    const items = [
      lineItem({ productTags: ['gift'] }),
      lineItem({ productTags: ['made-to-order'] }),
    ];

    expect(resolvePaymentType(items)).toBe('hold');
  });

  it('порівнює тег нечутливо до регістру', () => {
    const items = [lineItem({ productTags: ['Made-To-Order'] })];

    expect(resolvePaymentType(items)).toBe('hold');
  });

  it('повертає debit для порожнього списку позицій', () => {
    expect(resolvePaymentType([])).toBe('debit');
  });
});

describe('buildBasketOrder', () => {
  it("мапить обов'язкові поля basketOrder", () => {
    const [item] = buildBasketOrder([lineItem({ quantity: 2, unitPriceKopecks: 15000 })]);

    expect(item).toMatchObject({
      name: 'Літофан "Кіт"',
      qty: 2,
      sum: 15000,
      total: 30000,
      code: 'LITO-CAT-01',
      icon: 'https://cdn.shopify.com/cat.png',
      unit: 'шт.',
    });
  });

  it('використовує назву товару як code, якщо SKU порожній (фіскалізація вимагає code)', () => {
    const [item] = buildBasketOrder([lineItem({ sku: '', title: 'Позиція без SKU' })]);

    expect(item?.code).toBe('Позиція без SKU');
  });

  it('не додає icon, якщо зображення відсутнє', () => {
    const [item] = buildBasketOrder([lineItem({ imageUrl: null })]);

    expect(item?.icon).toBeUndefined();
  });

  it('мапить кілька позицій у тому ж порядку', () => {
    const items = buildBasketOrder([lineItem({ title: 'A' }), lineItem({ title: 'B' })]);

    expect(items.map((i) => i.name)).toEqual(['A', 'B']);
  });
});

describe('buildDestination', () => {
  it('формує текст призначення платежу з номера замовлення', () => {
    expect(buildDestination('#1001')).toBe('Оплата за замовлення #1001');
  });
});
