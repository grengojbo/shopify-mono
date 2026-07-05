// Отримання Admin API access token через client credentials grant.
//
// З 2026-01-01 Shopify не видає вічних shpat_-токенів для нових custom apps —
// токен запитується програмно (client_id + client_secret апа
// Bbox-Worker-Integration) і живе 24 години. Провайдер кешує токен на рівні
// ізоляту й оновлює його із 5-хвилинним запасом до протухання.

const REFRESH_MARGIN_SECONDS = 300;

type AdminTokenOptions = {
  storeDomain: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  /** Unix-час у секундах; ін'єктується для детермінованих тестів. */
  now: () => number;
};

export type AdminTokenProvider = {
  get(): Promise<string>;
};

type TokenGrant = {
  token: string;
  /** Unix-час, після якого токен вважається протухлим (з урахуванням запасу). */
  staleAt: number;
};

export function createAdminTokenProvider(options: AdminTokenOptions): AdminTokenProvider {
  const fetchImpl = options.fetch ?? fetch;
  let cached: TokenGrant | null = null;
  let inFlight: Promise<TokenGrant> | null = null;

  async function requestToken(): Promise<TokenGrant> {
    const requestedAt = options.now();
    const response = await fetchImpl(`https://${options.storeDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }).toString(),
    });

    if (!response.ok) {
      // Без client_secret у повідомленні — секрет не має текти в логи
      throw new Error(`Shopify client credentials grant failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { access_token: string; expires_in: number };
    return {
      token: payload.access_token,
      staleAt: requestedAt + payload.expires_in - REFRESH_MARGIN_SECONDS,
    };
  }

  return {
    async get() {
      if (cached && options.now() < cached.staleAt) {
        return cached.token;
      }
      if (!inFlight) {
        inFlight = requestToken().finally(() => {
          inFlight = null;
        });
      }
      cached = await inFlight;
      return cached.token;
    },
  };
}
