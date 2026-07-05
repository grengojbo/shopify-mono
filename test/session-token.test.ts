import { describe, expect, it } from 'vitest';

import { verifySessionToken } from '../src/lib/session-token';

// Фікстури, не реальні секрети
const SECRET = 'test-app-secret-fixture';
const CLIENT_ID = 'test-client-id';
const SHOP_DOMAIN = 'bbox-test.myshopify.com';
const NOW = 1_800_000_000;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Підписує JWT так само, як Shopify підписує session token (HS256). */
async function makeToken({
  secret = SECRET,
  claims = {},
  header = { alg: 'HS256', typ: 'JWT' },
}: {
  secret?: string;
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
} = {}): Promise<string> {
  const payload = {
    iss: `https://${SHOP_DOMAIN}/admin`,
    dest: `https://${SHOP_DOMAIN}`,
    aud: CLIENT_ID,
    exp: NOW + 60,
    nbf: NOW - 60,
    iat: NOW - 60,
    jti: 'test-jti',
    sid: 'test-sid',
    ...claims,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${base64url(signature)}`;
}

function verify(token: string): Promise<boolean> {
  return verifySessionToken({
    token,
    secret: SECRET,
    clientId: CLIENT_ID,
    shopDomain: SHOP_DOMAIN,
    now: () => NOW,
  });
}

describe('verifySessionToken', () => {
  it('приймає валідний токен', async () => {
    await expect(verify(await makeToken())).resolves.toBe(true);
  });

  it('відхиляє підпис іншим секретом', async () => {
    await expect(verify(await makeToken({ secret: 'інший-секрет' }))).resolves.toBe(false);
  });

  it('відхиляє протермінований exp', async () => {
    await expect(verify(await makeToken({ claims: { exp: NOW - 1 } }))).resolves.toBe(false);
  });

  it('відхиляє майбутній nbf', async () => {
    await expect(verify(await makeToken({ claims: { nbf: NOW + 60 } }))).resolves.toBe(false);
  });

  it('відхиляє чужий aud (інший client id)', async () => {
    await expect(verify(await makeToken({ claims: { aud: 'other-app' } }))).resolves.toBe(false);
  });

  it('відхиляє чужий dest (інший магазин)', async () => {
    await expect(
      verify(await makeToken({ claims: { dest: 'https://evil.myshopify.com' } })),
    ).resolves.toBe(false);
    await expect(verify(await makeToken({ claims: { dest: 'evil.myshopify.com' } }))).resolves.toBe(
      false,
    );
  });

  it('приймає dest як голий домен (формат checkout extension session token)', async () => {
    // Док session-token-api: "dest": "store-name.myshopify.com" — без https://
    await expect(verify(await makeToken({ claims: { dest: SHOP_DOMAIN } }))).resolves.toBe(true);
  });

  it('відхиляє alg, відмінний від HS256 (заборона alg=none)', async () => {
    await expect(verify(await makeToken({ header: { alg: 'none', typ: 'JWT' } }))).resolves.toBe(
      false,
    );
  });

  it('відхиляє токен не з трьох частин', async () => {
    await expect(verify('лише-одна-частина')).resolves.toBe(false);
    await expect(verify('a.b')).resolves.toBe(false);
  });

  it('відхиляє битий base64url у підписі', async () => {
    const token = await makeToken();
    const [h, p] = token.split('.');
    await expect(verify(`${h}.${p}.%%%невалідно%%%`)).resolves.toBe(false);
  });

  it('відхиляє payload, що не є JSON', async () => {
    const h = encodeJson({ alg: 'HS256', typ: 'JWT' });
    const notJson = base64url(new TextEncoder().encode('не json'));
    await expect(verify(`${h}.${notJson}.AAAA`)).resolves.toBe(false);
  });

  it('відхиляє відсутні числові claims (exp/nbf не числа)', async () => {
    await expect(verify(await makeToken({ claims: { exp: 'colossal' } }))).resolves.toBe(false);
  });
});
