// Верифікація Shopify session token (JWT HS256) від Checkout UI Extension —
// авторизація /create-invoice (PRD §10 Path A). Підпис перевіряється через
// crypto.subtle по сирих байтах `header.payload`; будь-який дефект структури
// чи claims → false (fail-closed), жодних винятків назовні.

type SessionTokenParams = {
  token: string;
  /** Client secret custom app (SHOPIFY_APP_SECRET). */
  secret: string;
  /** Client ID апа — звіряється з claim `aud`. */
  clientId: string;
  /** Домен магазину — звіряється з claim `dest`. */
  shopDomain: string;
  /** Unix-час у секундах. */
  now: () => number;
};

function base64urlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

type TokenClaims = {
  dest?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
};

export async function verifySessionToken(params: SessionTokenParams): Promise<boolean> {
  const parts = params.token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: unknown };
  let claims: TokenClaims;
  let signature: Uint8Array;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    header = JSON.parse(decoder.decode(base64urlToBytes(headerB64))) as { alg?: unknown };
    claims = JSON.parse(decoder.decode(base64urlToBytes(payloadB64))) as TokenClaims;
    signature = base64urlToBytes(signatureB64);
  } catch {
    return false;
  }

  // Лише HS256 — захист від alg=none та підміни алгоритму
  if (header.alg !== 'HS256') {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(params.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // crypto.subtle.verify виконує порівняння сталого часу
  const signatureValid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`) as BufferSource,
  );
  if (!signatureValid) {
    return false;
  }

  const now = params.now();
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    return false;
  }
  if (typeof claims.nbf !== 'number' || claims.nbf > now) {
    return false;
  }
  if (claims.aud !== params.clientId) {
    return false;
  }
  // Embedded apps отримують dest з https://, checkout extensions — голий домен
  if (claims.dest !== params.shopDomain && claims.dest !== `https://${params.shopDomain}`) {
    return false;
  }

  return true;
}
