import { describe, expect, it, vi } from 'vitest';

import { resolvePaidAmount, settlePayment } from '../src/lib/mono-amount';
import type { OrderForInvoice } from '../src/lib/shopify-client';

const INVOICE = { invoiceId: 'p2_inv1', orderId: 'gid://shopify/Order/1', amount: 42000 };

function makeOrder(overrides: Partial<OrderForInvoice> = {}): OrderForInvoice {
  return {
    id: INVOICE.orderId,
    name: '#1001',
    financialStatus: 'PENDING',
    cancelledAt: null,
    statusPageUrl: null,
    totalOutstandingKopecks: 42000,
    currencyCode: 'UAH',
    paymentGatewayNames: ['monobank'],
    lineItems: [],
    ...overrides,
  };
}

function makeDeps(order: OrderForInvoice | null) {
  return {
    shopify: {
      getOrderForInvoice: vi.fn().mockResolvedValue(order),
      orderMarkAsPaid: vi.fn().mockResolvedValue(undefined),
    },
    notifier: { send: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('resolvePaidAmount', () => {
  it('бере finalAmount, без нього — amount, без обох — null', () => {
    expect(resolvePaidAmount(100, 42000)).toBe(100);
    expect(resolvePaidAmount(undefined, 42000)).toBe(42000);
    expect(resolvePaidAmount(undefined, '42000')).toBe(null);
  });
});

describe('settlePayment — оплату зафіксовано', () => {
  it('списано суму інвойсу, і вона дорівнює залишку замовлення → mark-paid, без сповіщення', async () => {
    const deps = makeDeps(makeOrder());

    expect(await settlePayment(deps, INVOICE, 42000)).toBe(null);

    expect(deps.shopify.orderMarkAsPaid).toHaveBeenCalledWith(INVOICE.orderId);
    expect(deps.notifier.send).not.toHaveBeenCalled();
  });

  it('замовлення вже PAID (ретрай після часткового збою) → нічого не робимо', async () => {
    const deps = makeDeps(makeOrder({ financialStatus: 'PAID', totalOutstandingKopecks: 0 }));

    expect(await settlePayment(deps, INVOICE, 42000)).toBe(null);

    expect(deps.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
    expect(deps.notifier.send).not.toHaveBeenCalled();
  });
});

describe('settlePayment — рішення передається оператору', () => {
  const cases: Array<[string, OrderForInvoice | null, number | null, number, string]> = [
    ['списано не суму інвойсу', makeOrder(), 100, 42000, 'списано не суму інвойсу'],
    ['суму списання не визначено', makeOrder(), null, 42000, 'невідомо'],
    [
      'замовлення відредаговано після створення інвойсу',
      makeOrder({ totalOutstandingKopecks: 50000 }),
      42000,
      50000,
      'залишок замовлення змінився',
    ],
    [
      'замовлення скасовано',
      makeOrder({ cancelledAt: '2027-01-15T10:00:00Z' }),
      42000,
      42000,
      'замовлення скасовано',
    ],
    ['замовлення зникло з Shopify', null, 42000, 42000, 'не знайдено'],
  ];

  for (const [label, order, paid, expectedOutstanding, fragment] of cases) {
    it(`${label} → без mark-paid, сповіщення, повертається залишок на момент розгляду`, async () => {
      const deps = makeDeps(order);

      expect(await settlePayment(deps, INVOICE, paid)).toBe(expectedOutstanding);

      expect(deps.shopify.orderMarkAsPaid).not.toHaveBeenCalled();
      const text = deps.notifier.send.mock.calls[0]?.[0] as string;
      expect(text).toContain(fragment);
      expect(text).toContain(INVOICE.orderId);
      expect(text).toContain(INVOICE.invoiceId);
    });
  }

  it('замовлення PAID, але списано не суму інвойсу → усе одно сповіщення', async () => {
    const deps = makeDeps(makeOrder({ financialStatus: 'PAID', totalOutstandingKopecks: 0 }));

    expect(await settlePayment(deps, INVOICE, 100)).toBe(0);

    expect(deps.notifier.send).toHaveBeenCalledTimes(1);
  });

  it('сповіщення не відправилось → виняток: викликач не має фіксувати оплату', async () => {
    const deps = makeDeps(makeOrder());
    deps.notifier.send.mockRejectedValue(new Error('telegram down'));

    await expect(settlePayment(deps, INVOICE, 100)).rejects.toThrow('telegram down');
  });

  it('Shopify недоступний → виняток, без mark-paid і без сповіщення', async () => {
    const deps = makeDeps(makeOrder());
    deps.shopify.getOrderForInvoice.mockRejectedValue(new Error('shopify down'));

    await expect(settlePayment(deps, INVOICE, 42000)).rejects.toThrow('shopify down');
    expect(deps.notifier.send).not.toHaveBeenCalled();
  });
});
