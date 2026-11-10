// Обгортка над Cloudflare Rate Limiting binding (wrangler.toml [[ratelimits]]).
//
// Ліміт приблизний і рахується окремо в кожній локації Cloudflare — це захист
// від зливи запитів з однієї адреси, а не точний лічильник.

/** true — запит можна обробляти; false — ліміт для цього ключа вичерпано. */
export async function checkRateLimit(
  limiter: Pick<RateLimit, 'limit'> | undefined,
  key: string,
): Promise<boolean> {
  if (!limiter) {
    // Binding оголошено у wrangler.toml; без нього Worker працює лише в юніт-тестах
    return true;
  }
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (err) {
    // Збій лічильника не має зупиняти оплати всім покупцям: ліміт — захист від
    // зловживань, а не перевірка, від якої залежить коректність платежу
    console.error('rate limiter failed, запит пропущено', err);
    return true;
  }
}
