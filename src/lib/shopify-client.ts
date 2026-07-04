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
  adminToken: string;
  fetch?: typeof fetch;
};

export type ShopifyClient = {
  getOrderForInvoice(orderId: string): Promise<OrderForInvoice | null>;
};

export function createShopifyClient(options: ShopifyClientOptions): ShopifyClient {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async getOrderForInvoice(orderId) {
      const response = await fetchImpl(
        `https://${options.storeDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': options.adminToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: ORDER_FOR_INVOICE_QUERY,
            variables: { id: orderId },
          }),
        },
      );

      if (!response.ok) {
        throw new ShopifyApiError(response.status);
      }

      const payload = (await response.json()) as {
        data: { order: GraphqlOrderNode | null } | null;
        errors?: Array<{ message: string }>;
      };

      if (payload.errors && payload.errors.length > 0) {
        throw new ShopifyApiError(response.status, payload.errors[0]?.message);
      }

      const order = payload.data?.order;
      if (!order) {
        return null;
      }

      return {
        id: order.id,
        name: order.name,
        financialStatus: order.displayFinancialStatus,
        statusPageUrl: order.statusPageUrl,
        totalOutstandingKopecks: uahToKopecks(order.totalOutstandingSet.shopMoney.amount),
        currencyCode: order.totalOutstandingSet.shopMoney.currencyCode,
        lineItems: order.lineItems.edges.map((edge) => mapLineItem(edge.node)),
      };
    },
  };
}
