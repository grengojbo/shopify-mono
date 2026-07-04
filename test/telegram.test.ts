import { describe, expect, it, vi } from 'vitest';

import { createTelegramNotifier } from '../src/lib/telegram';

const BOT_TOKEN = 'test-telegram-bot-token-fixture'; // фікстура, не реальний секрет
const CHAT_ID = '123456789';

function makeNotifier(fetchMock: typeof fetch) {
  return createTelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetch: fetchMock });
}

describe('createTelegramNotifier', () => {
  it('шле POST на sendMessage з chat_id і текстом', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await makeNotifier(fetchMock).send('Тестове нагадування');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: CHAT_ID,
      text: 'Тестове нагадування',
    });
  });

  it('не-2xx → помилка без токена в message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{"ok":false,"description":"chat not found"}', { status: 400 }),
      );

    const error = await makeNotifier(fetchMock)
      .send('x')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(BOT_TOKEN);
  });

  it('мережевий reject пробрасывається', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(makeNotifier(fetchMock).send('x')).rejects.toThrow('fetch failed');
  });
});
