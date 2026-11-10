import { describe, expect, it } from 'vitest';

import { resolveWebHookUrl } from '../src/lib/public-url';

describe('resolveWebHookUrl', () => {
  it('будує адресу вебхука з https-origin', () => {
    expect(resolveWebHookUrl('https://pay.example.com')).toBe(
      'https://pay.example.com/mono-webhook',
    );
  });

  it('відкидає шлях і завершальний слеш — береться лише origin', () => {
    expect(resolveWebHookUrl('https://pay.example.com/some/path/')).toBe(
      'https://pay.example.com/mono-webhook',
    );
  });

  it.each([
    ['не задано', undefined],
    ['порожній рядок', ''],
    ['не рядок', 42],
    ['не URL', 'pay.example.com'],
    ['http замість https', 'http://pay.example.com'],
  ])('повертає null, якщо значення %s', (_name, value) => {
    expect(resolveWebHookUrl(value)).toBeNull();
  });
});
