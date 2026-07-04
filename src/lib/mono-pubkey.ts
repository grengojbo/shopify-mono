// Кешований провайдер публічного ключа mono для верифікації вебхуків.
// Ключ стабільний — запитувати заново лише при провалі валідації
// (.claude/skills/monobank-acquiring/webhook.md), не на кожен вебхук.

import { importMonoPubkey } from './ecdsa-verify';

export type PubkeyProvider = {
  /** Кешований ключ; перший виклик завантажує, наступні — з кешу ізоляту. */
  get(): Promise<CryptoKey>;
  /** Примусово перезавантажує ключ (ротація на боці mono). */
  refresh(): Promise<CryptoKey>;
};

export function createPubkeyProvider(fetchKey: () => Promise<string>): PubkeyProvider {
  // Кешуємо проміс, а не значення: конкурентні get() чекають один fetch.
  let cached: Promise<CryptoKey> | null = null;

  function load(): Promise<CryptoKey> {
    const loading = fetchKey().then(importMonoPubkey);
    // Провал не має отруїти кеш — наступний get() спробує знову.
    loading.catch(() => {
      if (cached === loading) {
        cached = null;
      }
    });
    cached = loading;
    return loading;
  }

  return {
    get() {
      return cached ?? load();
    },
    refresh() {
      return load();
    },
  };
}
