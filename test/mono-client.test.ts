import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMonoClient, MonoApiError } from '../src/lib/mono-client';

const TOKEN = 'test-mono-token-fixture'; // фікстура, не реальний секрет

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function makeClient(fetchMock: typeof fetch) {
  return createMonoClient({ token: TOKEN, fetch: fetchMock });
}

describe('createInvoice', () => {
  it('шле POST на /api/merchant/invoice/create з X-Token і цілим amount', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ invoiceId: 'p2_9ZgpZVsl3', pageUrl: 'https://pay.mbnk.biz/p2_9ZgpZVsl3' }),
      );
    const client = makeClient(fetchMock);

    const result = await client.createInvoice({
      amount: 4200,
      ccy: 980,
      paymentType: 'debit',
      merchantPaymInfo: {
        reference: 'gid://shopify/Order/1',
        destination: 'Оплата за замовлення #1001',
      },
      redirectUrl: 'https://bbox.kiev.ua/thank-you',
      webHookUrl: 'https://worker.example.com/mono-webhook',
    });

    expect(result).toEqual({
      invoiceId: 'p2_9ZgpZVsl3',
      pageUrl: 'https://pay.mbnk.biz/p2_9ZgpZVsl3',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.monobank.ua/api/merchant/invoice/create');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-Token')).toBe(TOKEN);
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');

    const sentBody = JSON.parse(init.body as string) as { amount: number; paymentType: string };
    expect(sentBody.amount).toBe(4200);
    expect(Number.isInteger(sentBody.amount)).toBe(true);
    expect(sentBody.paymentType).toBe('debit');
  });
});

describe('invoiceStatus', () => {
  it('шле GET з invoiceId у query та повертає статус як є', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ invoiceId: 'p2_9ZgpZVsl3', status: 'hold', amount: 4200, ccy: 980 }),
      );
    const client = makeClient(fetchMock);

    const status = await client.invoiceStatus('p2_9ZgpZVsl3');

    expect(status.status).toBe('hold');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.monobank.ua/api/merchant/invoice/status?invoiceId=p2_9ZgpZVsl3');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('URL-екранує invoiceId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ invoiceId: 'a b&c', status: 'created', amount: 1, ccy: 980 }),
      );
    await makeClient(fetchMock).invoiceStatus('a b&c');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(`invoiceId=${encodeURIComponent('a b&c')}`);
  });
});

describe('finalizeInvoice', () => {
  it('шле POST на finalize з invoiceId та amount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ status: 'success' }));
    const client = makeClient(fetchMock);

    const result = await client.finalizeInvoice({ invoiceId: 'p2_9ZgpZVsl3', amount: 4200 });

    expect(result).toEqual({ status: 'success' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.monobank.ua/api/merchant/invoice/finalize');
    expect(JSON.parse(init.body as string)).toEqual({ invoiceId: 'p2_9ZgpZVsl3', amount: 4200 });
  });
});

describe('cancelInvoice', () => {
  it('шле POST на cancel з extRef', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ status: 'processing', createdDate: 'x', modifiedDate: 'y' }));
    const client = makeClient(fetchMock);

    const result = await client.cancelInvoice({ invoiceId: 'p2_9ZgpZVsl3', extRef: 'ref-1' });

    expect(result.status).toBe('processing');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.monobank.ua/api/merchant/invoice/cancel');
    expect(JSON.parse(init.body as string)).toEqual({ invoiceId: 'p2_9ZgpZVsl3', extRef: 'ref-1' });
  });
});

describe('getPubkey', () => {
  it('шле GET на /api/merchant/pubkey і повертає base64-ключ', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ key: 'LS0tLS1CRUdJTg==' }));

    const key = await makeClient(fetchMock).getPubkey();

    expect(key).toBe('LS0tLS1CRUdJTg==');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.monobank.ua/api/merchant/pubkey');
  });
});

describe('без ін’єкції fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('використовує глобальний fetch', async () => {
    const globalFetchMock = vi.fn().mockResolvedValue(okResponse({ key: 'abc' }));
    vi.stubGlobal('fetch', globalFetchMock);

    const key = await createMonoClient({ token: TOKEN }).getPubkey();

    expect(key).toBe('abc');
    expect(globalFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('обробка помилок (fail-closed)', () => {
  it('не-2xx з {errCode, errText} → MonoApiError з цими полями', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(400, { errCode: 'BAD_REQUEST', errText: 'invalid amount' }));
    const client = makeClient(fetchMock);

    const error = await client.invoiceStatus('x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MonoApiError);
    const apiError = error as MonoApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.errCode).toBe('BAD_REQUEST');
    expect(apiError.errText).toBe('invalid amount');
  });

  it('не-2xx з тілом-не-JSON → MonoApiError без падіння парсера', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500, '<html>gateway error</html>'));

    const error = await makeClient(fetchMock)
      .getPubkey()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MonoApiError);
    expect((error as MonoApiError).status).toBe(500);
  });

  it('мережева помилка пробрасывається (не ковтається)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(makeClient(fetchMock).getPubkey()).rejects.toThrow('fetch failed');
  });

  it('повідомлення MonoApiError ніколи не містить токен', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(403, { errCode: 'FORBIDDEN', errText: 'forbidden' }));

    const error = await makeClient(fetchMock)
      .getPubkey()
      .catch((e: unknown) => e);

    expect((error as Error).message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
});
