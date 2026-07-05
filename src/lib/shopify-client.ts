// Клієнт Shopify Admin API (GraphQL) — читання замовлення перед створенням
// mono-інвойсу (PRD §5). Поля звірені через shopify-plugin:shopify-admin
// (Admin API 2025-10): Order.totalOutstandingSet, Order.displayFinancialStatus,
// Order.statusPageUrl (nullable, опційні аргументи).
//
// Сума й ціни позицій нормалізуються тут-таки у цілі копійки (money.ts) —
// решта коду більше не бачить десяткових рядків Shopify.

import type { OrderLineItem } from './invoice-mapping';
import { uahToKopecks } from './money';

const ADMIN_API_VERSION = '2025-10';

const ORDER_FOR_INVOICE_QUERY = `
  query OrderForInvoice($id: ID!) {
    order(id: $id) {
      id
      name
      displayFinancialStatus
      statusPageUrl
      paymentGatewayNames
      totalOutstandingSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      lineItems(first: 250) {
        edges {
          node {
            title
            quantity
            sku
            discountedUnitPriceSet {
              shopMoney {
                amount
              }
            }
            image {
              url
            }
            product {
              tags
            }
          }
        }
      }
    }
  }
`;

export type OrderForInvoice = {
  id: string;
  name: string;
  financialStatus: string;
  statusPageUrl: string | null;
  /** Назви методів оплати замовлення; для ручних методів — їхня назва з налаштувань. */
  paymentGatewayNames: string[];
  totalOutstandingKopecks: number;
  currencyCode: string;
  lineItems: OrderLineItem[];
};

export class ShopifyApiError extends Error {
  readonly status: number;

  constructor(status: number, detail?: string) {
    super(`Shopify Admin API ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'ShopifyApiError';
    this.status = status;
  }
}

type GraphqlLineItemNode = {
  title: string;
  quantity: number;
  sku: string | null;
  discountedUnitPriceSet: { shopMoney: { amount: string } };
  image: { url: string } | null;
  product: { tags: string[] } | null;
};

type GraphqlOrderNode = {
  id: string;
  name: string;
  displayFinancialStatus: string;
  statusPageUrl: string | null;
  paymentGatewayNames: string[];
  totalOutstandingSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { edges: Array<{ node: GraphqlLineItemNode }> };
};

function mapLineItem(node: GraphqlLineItemNode): OrderLineItem {
  return {
    title: node.title,
    quantity: node.quantity,
    sku: node.sku ?? '',
    unitPriceKopecks: uahToKopecks(node.discountedUnitPriceSet.shopMoney.amount),
    imageUrl: node.image?.url ?? null,
    productTags: node.product?.tags ?? [],
  };
}

export type ShopifyClientOptions = {
  storeDomain: string;
  /** Постачальник Admin-токена (client credentials grant, кешується провайдером). */
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
};

export type ShopifyClient = {
  getOrderForInvoice(orderId: string): Promise<OrderForInvoice | null>;
  /**
   * Позначає замовлення оплаченим (Path A). Вже оплачене замовлення
   * (userError + displayFinancialStatus=PAID) трактується як успіх —
   * це потрібно для збіжності ретраїв вебхука після часткового провалу.
   */
  orderMarkAsPaid(orderId: string): Promise<void>;
  /**
   * Скасовує неоплачене замовлення-привид (чистка cron, PRD §11): без
   * рефанду, з поверненням товару на склад, без нотифікації покупця.
   * «Вже скасовано» трактується як успіх (збіжність повторних прогонів).
   */
  orderCancel(orderId: string): Promise<void>;
};

const ORDER_MARK_AS_PAID_MUTATION = `
  mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      userErrors {
        field
        message
      }
      order {
        id
        displayFinancialStatus
      }
    }
  }
`;

type OrderMarkAsPaidPayload = {
  orderMarkAsPaid: {
    userErrors: Array<{ field: string[] | null; message: string }>;
    order: { id: string; displayFinancialStatus: string } | null;
  } | null;
};

const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel($orderId: ID!, $refundMethod: OrderCancelRefundMethodInput!, $restock: Boolean!, $reason: OrderCancelReason!, $notifyCustomer: Boolean, $staffNote: String) {
    orderCancel(orderId: $orderId, refundMethod: $refundMethod, restock: $restock, reason: $reason, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      job {
        id
        done
      }
      orderCancelUserErrors {
        field
        message
        code
      }
    }
  }
`;

type OrderCancelPayload = {
  orderCancel: {
    job: { id: string; done: boolean } | null;
    orderCancelUserErrors: Array<{ field: string[] | null; message: string; code: string }>;
  } | null;
};

export function createShopifyClient(options: ShopifyClientOptions): ShopifyClient {
  const fetchImpl = options.fetch ?? fetch;

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const accessToken = await options.getAccessToken();
    const response = await fetchImpl(
      `https://${options.storeDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    if (!response.ok) {
      throw new ShopifyApiError(response.status);
    }

    const payload = (await response.json()) as {
      data: T | null;
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new ShopifyApiError(response.status, payload.errors[0]?.message);
    }
    if (payload.data === null || payload.data === undefined) {
      throw new ShopifyApiError(response.status, 'порожня відповідь GraphQL');
    }

    return payload.data;
  }

  return {
    async getOrderForInvoice(orderId) {
      const data = await graphql<{ order: GraphqlOrderNode | null }>(ORDER_FOR_INVOICE_QUERY, {
        id: orderId,
      });

      const order = data.order;
      if (!order) {
        return null;
      }

      return {
        id: order.id,
        name: order.name,
        financialStatus: order.displayFinancialStatus,
        statusPageUrl: order.statusPageUrl,
        paymentGatewayNames: order.paymentGatewayNames,
        totalOutstandingKopecks: uahToKopecks(order.totalOutstandingSet.shopMoney.amount),
        currencyCode: order.totalOutstandingSet.shopMoney.currencyCode,
        lineItems: order.lineItems.edges.map((edge) => mapLineItem(edge.node)),
      };
    },

    async orderMarkAsPaid(orderId) {
      const data = await graphql<OrderMarkAsPaidPayload>(ORDER_MARK_AS_PAID_MUTATION, {
        input: { id: orderId },
      });

      const result = data.orderMarkAsPaid;
      const userErrors = result?.userErrors ?? [];
      if (userErrors.length === 0) {
        return;
      }
      // Замовлення вже PAID — mark-paid уже спрацював у попередній спробі
      if (result?.order?.displayFinancialStatus === 'PAID') {
        return;
      }
      throw new ShopifyApiError(200, userErrors[0]?.message);
    },

    async orderCancel(orderId) {
      const data = await graphql<OrderCancelPayload>(ORDER_CANCEL_MUTATION, {
        orderId,
        refundMethod: { originalPaymentMethodsRefund: false },
        restock: true,
        reason: 'OTHER',
        notifyCustomer: false,
        staffNote: 'Не оплачено вчасно — автоматичне скасування (bbox-mono-payments)',
      });

      const cancelErrors = data.orderCancel?.orderCancelUserErrors ?? [];
      if (cancelErrors.length === 0) {
        return;
      }
      // Повторний прогін чистки після часткового провалу — замовлення вже скасоване
      if (cancelErrors.some((e) => e.message.toLowerCase().includes('already been cancelled'))) {
        return;
      }
      throw new ShopifyApiError(200, cancelErrors[0]?.message);
    },
  };
}
