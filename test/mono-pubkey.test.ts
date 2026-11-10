import { describe, expect, it, vi } from 'vitest';

import { createPubkeyProvider } from '../src/lib/mono-pubkey';

// Валідний ключ у форматі mono: base64(PEM(SPKI)) — генерується справжньою парою.
async function makeMonoStyleKey(): Promise<string> {
  const { publicKey } = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer);
  let binary = '';
  for (const byte of spki) {
    binary += String.fromCharCode(byte);
  }
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(binary)}\n-----END PUBLIC KEY-----\n`;
  return btoa(pem);
}

describe('createPubkeyProvider', () => {
  it('перший get завантажує ключ, другий — віддає кеш без нового fetch', async () => {
    const fetchKey = vi.fn().mockResolvedValue(await makeMonoStyleKey());
    const provider = createPubkeyProvider(fetchKey);

    const first = await provider.get();
    const second = await provider.get();

    expect(first).toBe(second);
    expect(fetchKey).toHaveBeenCalledTimes(1);
  });

  it('refresh примусово перезавантажує ключ', async () => {
    const fetchKey = vi
      .fn()
      .mockResolvedValueOnce(await makeMonoStyleKey())
      .mockResolvedValueOnce(await makeMonoStyleKey());
    const provider = createPubkeyProvider(fetchKey);

    const original = await provider.get();
    const refreshed = await provider.refresh();
    const afterRefresh = await provider.get();

    expect(refreshed).not.toBe(original);
    expect(afterRefresh).toBe(refreshed);
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it('невдалий fetch не отруює кеш — наступний get пробує знову', async () => {
    const fetchKey = vi
      .fn()
      .mockRejectedValueOnce(new Error('mono down'))
      .mockResolvedValueOnce(await makeMonoStyleKey());
    const provider = createPubkeyProvider(fetchKey);

    await expect(provider.get()).rejects.toThrow('mono down');
    await expect(provider.get()).resolves.toBeDefined();
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it('пізній reject старого завантаження не скидає новіший кеш', async () => {
    let rejectFirst: (err: Error) => void = () => {};
    const firstLoad = new Promise<string>((_, reject) => {
      rejectFirst = reject;
    });
    const fetchKey = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(firstLoad)
      .mockResolvedValueOnce(await makeMonoStyleKey());
    const provider = createPubkeyProvider(fetchKey);

    const pending = provider.get(); // висить на firstLoad
    pending.catch(() => {}); // приглушуємо очікуваний reject
    const refreshed = await provider.refresh(); // замінює кеш новим ключем
    rejectFirst(new Error('mono down')); // старе завантаження падає ПІЗНІШЕ
    await Promise.resolve(); // даємо catch-обробнику відпрацювати

    // Кеш не скинуто: get віддає новий ключ без третього fetch
    await expect(provider.get()).resolves.toBe(refreshed);
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it('повторний refresh у межах паузи не йде в mono — віддає вже завантажений ключ', async () => {
    const fetchKey = vi.fn(async () => makeMonoStyleKey());
    let nowMs = 1_000_000;
    const provider = createPubkeyProvider(fetchKey, { now: () => nowMs });
    await provider.get();

    const refreshed = await provider.refresh();
    // Шквал вебхуків із невалідним підписом: кожен просить «свіжий» ключ
    for (let i = 0; i < 20; i += 1) {
      nowMs += 1000;
      expect(await provider.refresh()).toBe(refreshed);
    }

    expect(fetchKey).toHaveBeenCalledTimes(2); // get + один refresh
  });

  it('після паузи refresh знову завантажує ключ (справжня ротація не блокується назавжди)', async () => {
    const fetchKey = vi.fn(async () => makeMonoStyleKey());
    let nowMs = 1_000_000;
    const provider = createPubkeyProvider(fetchKey, { now: () => nowMs });

    const first = await provider.refresh();
    nowMs += 60_000;
    const second = await provider.refresh();

    expect(second).not.toBe(first);
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it('refresh у межах паузи після невдалого завантаження пробує знову (кеш порожній)', async () => {
    const fetchKey = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('mono down'))
      .mockResolvedValueOnce(await makeMonoStyleKey());
    const provider = createPubkeyProvider(fetchKey, { now: () => 1_000_000 });

    await expect(provider.refresh()).rejects.toThrow('mono down');
    await expect(provider.refresh()).resolves.toBeDefined();
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it('конкурентні get роблять лише один fetch', async () => {
    const fetchKey = vi.fn().mockResolvedValue(await makeMonoStyleKey());
    const provider = createPubkeyProvider(fetchKey);

    const [a, b] = await Promise.all([provider.get(), provider.get()]);

    expect(a).toBe(b);
    expect(fetchKey).toHaveBeenCalledTimes(1);
  });
});
