import { describe, expect, it, vi } from 'vitest';

import { createAdminTokenProvider } from '../src/lib/shopify-admin-token';

// Фікстури, не реальні секрети
const STORE_DOMAIN = 'bbox-test.myshopify.com';
const CLIENT_ID = 'admin-client-id';
const CLIENT_SECRET = 'admin-client-secret-fixture';
const NOW = 1_800_000_000;

function tokenResponse(token: string, expiresIn = 86399): Response {
  return new Response(
    JSON.stringify({
      access_token: token,
      scope: 'read_orders,write_orders',
      expires_in: expiresIn,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeProvider(fetchMock: typeof fetch, nowRef: { value: number }) {
  return createAdminTokenProvider({
    storeDomain: STORE_DOMAIN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetch: fetchMock,
    now: () => nowRef.value,
  });
}

describe('createAdminTokenProvider', () => {
  it('перший get робить POST правильної форми (client credentials grant)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    const provider = makeProvider(fetchMock, { value: NOW });

    await expect(provider.get()).resolves.toBe('tok-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${STORE_DOMAIN}/admin/oauth/access_token`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
  });

  it('другий get до протухання повертає кешований токен без нових запитів', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    const provider = makeProvider(fetchMock, { value: NOW });

    await provider.get();
    await expect(provider.get()).resolves.toBe('tok-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('після наближення до expires_in (мінус 5 хв запасу) робить новий запит', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('tok-1', 86399))
      .mockResolvedValueOnce(tokenResponse('tok-2', 86399));
    const nowRef = { value: NOW };
    const provider = makeProvider(fetchMock, nowRef);

    await provider.get();
    nowRef.value = NOW + 86399 - 299; // за 4:59 до кінця — вже всередині 5-хв запасу

    await expect(provider.get()).resolves.toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('конкурентні get роблять лише один запит', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    const provider = makeProvider(fetchMock, { value: NOW });

    const [a, b] = await Promise.all([provider.get(), provider.get()]);

    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('не-2xx → помилка без client_secret у повідомленні', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('invalid client', { status: 401 }));
    const provider = makeProvider(fetchMock, { value: NOW });

    const error = await provider.get().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(CLIENT_SECRET);
  });

  it('без ін’єкції fetch використовує глобальний fetch', async () => {
    const globalFetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-global'));
    vi.stubGlobal('fetch', globalFetchMock);

    const provider = createAdminTokenProvider({
      storeDomain: STORE_DOMAIN,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      now: () => NOW,
    });

    await expect(provider.get()).resolves.toBe('tok-global');
    expect(globalFetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('провал не отруює кеш — наступний get пробує знову', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(tokenResponse('tok-1'));
    const provider = makeProvider(fetchMock, { value: NOW });

    await expect(provider.get()).rejects.toThrow('fetch failed');
    await expect(provider.get()).resolves.toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
