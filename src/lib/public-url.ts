// Публічна адреса Worker'а береться з конфігурації (wrangler.toml [vars]),
// а не з origin вхідного запиту: адреса, куди mono шле підтвердження оплати,
// не має залежати від того, яким хостом до Worker'а достукалися.

const WEBHOOK_PATH = '/mono-webhook';

/** Повертає webHookUrl для mono або null, якщо PUBLIC_BASE_URL не задано чи він не https. */
export function resolveWebHookUrl(publicBaseUrl: unknown): string | null {
  if (typeof publicBaseUrl !== 'string' || !URL.canParse(publicBaseUrl)) {
    return null;
  }
  const url = new URL(publicBaseUrl);
  if (url.protocol !== 'https:') {
    return null;
  }
  return `${url.origin}${WEBHOOK_PATH}`;
}
