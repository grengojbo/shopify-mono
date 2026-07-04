import { describe, expect, it, vi } from 'vitest';

import { createShopifyClient, ShopifyApiError } from '../src/lib/shopify-client';

const STORE_DOMAIN = 'bbox-test.myshopify.com';
const TOKEN = 'test-admin-token-fixture'; // фікстура, не реальний секрет

function graphqlResponse(data: unknown, errors?: unknown[]): Response {
  return new Response(JSON.stringify({ data, errors }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchMock: typeof fetch) {
  return createShopifyClient({ storeDomain: STORE_DOMAIN, adminToken: TOKEN, fetch: fetchMock });
}

function orderNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    displayFinancialStatus: 'PENDING',
    statusPageUrl: 'https://bbox-test.myshopify.com/orders/abc/status',
    totalOutstandingSet: { shopMoney: { amount: '420.00', currencyCode: 'UAH' } },
    lineItems: {
      edges: [
        {
          node: {
            title: 'Літофан "Кіт"',
            quantity: 1,
            sku: 'LITO-CAT-01',
            discountedUnitPriceSet: { shopMoney: { amount: '420.00', currencyCode: 'UAH' } },
            image: { url: 'https://cdn.shopify.com/cat.png' },
            product: { tags: [] },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('getOrderForInvoice', () => {
  it('шле POST на /admin/api/.../graphql.json з X-Shopify-Access-Token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(graphqlResponse({ order: orderNode() }));
    await makeClient(fetchMock).getOrderForInvoice('gid://shopify/Order/1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`https://${STORE_DOMAIN}/admin/api/`);
    expect(url).toContain('graphql.json');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-Shopify-Access-Token')).toBe(TOKEN);

    const body = JSON.parse(init.body as string) as { variables: { id: string } };
    expect(body.variables.id).toBe('gid://shopify/Order/1');
  });

  it('нормалізує суму та позиції у копійки', async () => {
    const fetchMock = vi.fn().mockResolvedValue(graphqlResponse({ order: orderNode() }));
    const order = await makeClient(fetchMock).getOrderForInvoice('gid://shopify/Order/1');

    expect(order?.totalOutstandingKopecks).toBe(42000);
    expect(order?.currencyCode).toBe('UAH');
    expect(order?.lineItems).toEqual([
      {
        title: 'Літофан "Кіт"',
        quantity: 1,
        sku: 'LITO-CAT-01',
        unitPriceKopecks: 42000,
        imageUrl: 'https://cdn.shopify.com/cat.png',
        productTags: [],
      },
    ]);
  });

  it('прокидає теги товару в кожну позицію', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        order: orderNode({
          lineItems: {
            edges: [
              {
                node: {
                  ...orderNode().lineItems.edges[0]?.node,
                  product: { tags: ['made-to-order', 'gift'] },
                },
              },
            ],
          },
        }),
      }),
    );
    const order = await makeClient(fetchMock).getOrderForInvoice('gid://shopify/Order/1');

    expect(order?.lineItems[0]?.productTags).toEqual(['made-to-order', 'gift']);
  });

  it('повертає null imageUrl, коли зображення відсутнє', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        order: orderNode({
          lineItems: {
            edges: [{ node: { ...orderNode().lineItems.edges[0]?.node, image: null } }],
          },
        }),
      }),
    );
    const order = await makeClient(fetchMock).getOrderForInvoice('gid://shopify/Order/1');

    expect(order?.lineItems[0]?.imageUrl).toBeNull();
  });

  it('падає назад на порожній SKU, коли Shopify повертає null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphqlResponse({
        order: orderNode({
          lineItems: {
            edges: [{ node: { ...orderNode().lineItems.edges[0]?.node, sku: null } }],
          },
        }),
      }),
    );
    const order = await makeClient(fetchMock).getOrderForInvoice('gid://shopify/Order/1');

    expect(order?.lineItems[0]?.sku).toBe('');
  });

  it('повертає null, якщо замовлення не знайдено', async () => {
    const fetchMock = vi.fn().mockResolvedValue(graphqlResponse({ order: null }));

    const order = await makeClient(fetchMock).getOrderForInvoice('gid://shopify/Order/999');

    expect(order).toBeNull();
  });

  it('кидає ShopifyApiError на errors[] у відповіді GraphQL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(graphqlResponse(null, [{ message: 'Throttled' }]));

    await expect(makeClient(fetchMock).getOrderForInvoice('gid://shopify/Order/1')).rejects.toThrow(
      ShopifyApiError,
    );
  });

  it('кидає ShopifyApiError на не-2xx HTTP-статус', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const error = await makeClient(fetchMock)
      .getOrderForInvoice('gid://shopify/Order/1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ShopifyApiError);
    expect((error as ShopifyApiError).status).toBe(401);
  });

  it('мережева помилка пробрасывається', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(makeClient(fetchMock).getOrderForInvoice('gid://shopify/Order/1')).rejects.toThrow(
      'fetch failed',
    );
  });

  it('повідомлення ShopifyApiError ніколи не містить токен', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));

    const error = await makeClient(fetchMock)
      .getOrderForInvoice('gid://shopify/Order/1')
      .catch((e: unknown) => e);

    expect((error as Error).message).not.toContain(TOKEN);
  });
});
