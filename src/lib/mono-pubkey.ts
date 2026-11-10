// Кешований провайдер публічного ключа mono для верифікації вебхуків.
// Ключ стабільний — запитувати заново лише при провалі валідації
// (.claude/skills/monobank-acquiring/webhook.md), не на кожен вебхук.

import { importMonoPubkey } from './ecdsa-verify';

export type PubkeyProvider = {
  /** Кешований ключ; перший виклик завантажує, наступні — з кешу ізоляту. */
  get(): Promise<CryptoKey>;
  /** Перезавантажує ключ (ротація на боці mono), але не частіше ніж раз на хвилину. */
  refresh(): Promise<CryptoKey>;
};

/**
 * Мінімальна пауза між примусовими перезавантаженнями. /mono-webhook просить
 * свіжий ключ на кожен невалідний підпис, а надіслати такий вебхук може будь-хто
 * без автентифікації — без паузи це безкоштовний спосіб смикати API mono нашим
 * токеном і впертися в його ліміти. Справжня ротація ключа — рідкість; у гіршому
 * разі легітимний вебхук отримає 400 і mono його повторить.
 */
const REFRESH_COOLDOWN_MS = 60_000;

export type PubkeyProviderOptions = {
  /** Час у мілісекундах; ін'єктується для детермінованих тестів. */
  now?: () => number;
};

export function createPubkeyProvider(
  fetchKey: () => Promise<string>,
  options: PubkeyProviderOptions = {},
): PubkeyProvider {
  const now = options.now ?? Date.now;
  // Кешуємо проміс, а не значення: конкурентні get() чекають один fetch.
  let cached: Promise<CryptoKey> | null = null;
  let lastRefreshAt: number | null = null;

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
      const current = now();
      // cached === null означає, що останнє завантаження впало, — тоді пробуємо знову
      if (cached && lastRefreshAt !== null && current - lastRefreshAt < REFRESH_COOLDOWN_MS) {
        return cached;
      }
      lastRefreshAt = current;
      return load();
    },
  };
}
