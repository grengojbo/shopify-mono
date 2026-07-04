import { describe, expect, it } from 'vitest';

import { derToP1363, importMonoPubkey, verifyWebhookSignature } from '../src/lib/ecdsa-verify';

// ---------------------------------------------------------------------------
// Тест-хелпери: генерують крипто-валідні фікстури в тому ж форматі, у якому
// mono віддає ключ (base64-обгорнутий PEM з GET /api/merchant/pubkey) та
// підпис (DER у заголовку X-Sign). Зворотний конвертер p1363→DER тут — це
// незалежна реалізація, якою валідується derToP1363.
// ---------------------------------------------------------------------------

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

// Тіло вебхука за структурою InvoiceStatusResponse
// (.claude/skills/monobank-acquiring/invoice.md)
const WEBHOOK_BODY = JSON.stringify({
  invoiceId: 'p2_9ZgpZVsl3',
  status: 'success',
  amount: 4200,
  ccy: 980,
  finalAmount: 4200,
  createdDate: '2026-07-04T00:00:00Z',
  modifiedDate: '2026-07-04T00:01:00Z',
  reference: 'gid://shopify/Order/1234567890',
  destination: 'Оплата за замовлення #1001',
});

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Кодує одну DER INTEGER-компоненту з 32-байтової P1363-половинки. */
function encodeDerInteger(half: Uint8Array): Uint8Array {
  let start = 0;
  while (start < half.length - 1 && half[start] === 0) {
    start += 1;
  }
  const trimmed = half.slice(start);
  const needsPad = (trimmed[0] ?? 0) >= 0x80;
  const content = needsPad ? new Uint8Array([0, ...trimmed]) : trimmed;
  return new Uint8Array([0x02, content.length, ...content]);
}

/** Незалежна (тестова) реалізація P1363 → DER. */
function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const r = encodeDerInteger(p1363.slice(0, 32));
  const s = encodeDerInteger(p1363.slice(32, 64));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function makeKeyPair(): Promise<CryptoKeyPair> {
  // У @cloudflare/workers-types generateKey повертає об'єднання без
  // перевантажень — для EC-алгоритму це завжди пара, тож кастимо.
  return (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
}

/** Експортує публічний ключ у формат mono: base64(PEM(SPKI)). */
async function exportMonoStyleKey(publicKey: CryptoKey): Promise<string> {
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer);
  const pem = `-----BEGIN PUBLIC KEY-----\n${toBase64(spki)}\n-----END PUBLIC KEY-----\n`;
  return toBase64(toBytes(pem));
}

/** Підписує тіло та повертає X-Sign так, як його формує mono (base64 від DER). */
async function signAsMono(privateKey: CryptoKey, body: Uint8Array): Promise<string> {
  const p1363 = new Uint8Array(
    await crypto.subtle.sign(SIGN_ALG, privateKey, body as BufferSource),
  );
  return toBase64(p1363ToDer(p1363));
}

// ---------------------------------------------------------------------------
// derToP1363 — чиста функція, тестуємо конвертацію та fail-closed поведінку
// ---------------------------------------------------------------------------

describe('derToP1363', () => {
  it('конвертує DER з повними 32-байтовими r/s', () => {
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const der = p1363ToDer(new Uint8Array([...r, ...s]));

    expect(derToP1363(der)).toEqual(new Uint8Array([...r, ...s]));
  });

  it('знімає доповнення знаку 0x00 для r/s зі встановленим старшим бітом', () => {
    const r = new Uint8Array(32).fill(0xff);
    const s = new Uint8Array(32).fill(0x80);
    const der = p1363ToDer(new Uint8Array([...r, ...s]));

    // DER для таких значень містить префікс 0x00 (33 байти на integer):
    // [0x30, seqLen, 0x02, 0x21, 0x00, ...r]
    expect(der[3]).toBe(0x21);
    expect(der[4]).toBe(0x00);
    expect(derToP1363(der)).toEqual(new Uint8Array([...r, ...s]));
  });

  it('доповнює нулями зліва r/s, коротші за 32 байти', () => {
    const r = new Uint8Array(32);
    r[31] = 0x05; // r = 5 → у DER лише 1 байт
    const s = new Uint8Array(32);
    s[30] = 0x01; // s = 256+... → у DER 2 байти
    s[31] = 0x02;
    const der = p1363ToDer(new Uint8Array([...r, ...s]));

    expect(derToP1363(der)).toEqual(new Uint8Array([...r, ...s]));
  });

  it('відхиляє неправильний тег INTEGER всередині SEQUENCE', () => {
    const valid = p1363ToDer(new Uint8Array(64).fill(0x11));
    const broken = new Uint8Array(valid);
    broken[2] = 0x03; // перший INTEGER має тег BIT STRING

    expect(() => derToP1363(broken)).toThrow();
  });

  it('відхиляє integer довжиною 33 без доповнення знаку 0x00', () => {
    const content = new Uint8Array(33).fill(0x7f); // 33 байти, старший біт НЕ встановлений
    const rBad = new Uint8Array([0x02, content.length, ...content]);
    const s = new Uint8Array([0x02, 0x01, 0x01]);
    const der = new Uint8Array([0x30, rBad.length + s.length, ...rBad, ...s]);

    expect(() => derToP1363(der)).toThrow();
  });

  it('відхиляє INTEGER, чий вміст обрізано при коректній довжині SEQUENCE', () => {
    // s заявляє 5 байтів вмісту, але в буфері їх лише 2;
    // довжина SEQUENCE підігнана під фактичний розмір, щоб пройти першу перевірку
    const r = new Uint8Array([0x02, 0x01, 0x11]);
    const sTruncated = new Uint8Array([0x02, 0x05, 0x01, 0x02]);
    const der = new Uint8Array([0x30, r.length + sTruncated.length, ...r, ...sTruncated]);

    expect(() => derToP1363(der)).toThrow();
  });

  it('відхиляє неправильний тег SEQUENCE', () => {
    const valid = p1363ToDer(new Uint8Array(64).fill(0x11));
    const broken = new Uint8Array(valid);
    broken[0] = 0x31;

    expect(() => derToP1363(broken)).toThrow();
  });

  it('відхиляє обрізаний DER', () => {
    const valid = p1363ToDer(new Uint8Array(64).fill(0x11));

    expect(() => derToP1363(valid.slice(0, valid.length - 3))).toThrow();
  });

  it('відхиляє integer, довший за 33 байти (не P-256)', () => {
    const content = new Uint8Array(40).fill(0x7f);
    const rTooLong = new Uint8Array([0x02, content.length, ...content]);
    const s = new Uint8Array([0x02, 0x01, 0x01]);
    const der = new Uint8Array([0x30, rTooLong.length + s.length, ...rTooLong, ...s]);

    expect(() => derToP1363(der)).toThrow();
  });

  it('відхиляє сміття після другого integer', () => {
    const valid = p1363ToDer(new Uint8Array(64).fill(0x11));
    const withTrailing = new Uint8Array([
      ...valid.slice(0, 1),
      valid[1] as number,
      ...valid.slice(2),
      0x00,
    ]);
    withTrailing[1] = (withTrailing[1] as number) + 1;

    expect(() => derToP1363(withTrailing)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// importMonoPubkey + verifyWebhookSignature — повний цикл, як у вебхук-роуті
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature', () => {
  it('приймає валідний підпис (формат mono: base64 PEM ключ, DER X-Sign)', async () => {
    const { publicKey, privateKey } = await makeKeyPair();
    const pubkey = await importMonoPubkey(await exportMonoStyleKey(publicKey));
    const body = toBytes(WEBHOOK_BODY);
    const xSign = await signAsMono(privateKey, body);

    await expect(verifyWebhookSignature(pubkey, xSign, body)).resolves.toBe(true);
  });

  it('відхиляє тіло, змінене на 1 байт', async () => {
    const { publicKey, privateKey } = await makeKeyPair();
    const pubkey = await importMonoPubkey(await exportMonoStyleKey(publicKey));
    const body = toBytes(WEBHOOK_BODY);
    const xSign = await signAsMono(privateKey, body);

    const tampered = new Uint8Array(body);
    tampered[10] = (tampered[10] as number) ^ 0xff;

    await expect(verifyWebhookSignature(pubkey, xSign, tampered)).resolves.toBe(false);
  });

  it('відхиляє підпис іншим ключем', async () => {
    const { publicKey } = await makeKeyPair();
    const attacker = await makeKeyPair();
    const pubkey = await importMonoPubkey(await exportMonoStyleKey(publicKey));
    const body = toBytes(WEBHOOK_BODY);
    const forgedSign = await signAsMono(attacker.privateKey, body);

    await expect(verifyWebhookSignature(pubkey, forgedSign, body)).resolves.toBe(false);
  });

  it('відхиляє пересеріалізований JSON (інший порядок ключів, ті самі дані)', async () => {
    const { publicKey, privateKey } = await makeKeyPair();
    const pubkey = await importMonoPubkey(await exportMonoStyleKey(publicKey));
    const body = toBytes(WEBHOOK_BODY);
    const xSign = await signAsMono(privateKey, body);

    const parsed = JSON.parse(WEBHOOK_BODY) as Record<string, unknown>;
    const reordered = toBytes(JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())));

    await expect(verifyWebhookSignature(pubkey, xSign, reordered)).resolves.toBe(false);
  });

  it('кидає помилку на битому base64 у X-Sign', async () => {
    const { publicKey } = await makeKeyPair();
    const pubkey = await importMonoPubkey(await exportMonoStyleKey(publicKey));

    await expect(
      verifyWebhookSignature(pubkey, '!!!не-base64!!!', toBytes(WEBHOOK_BODY)),
    ).rejects.toThrow();
  });

  it('кидає помилку на X-Sign з валідним base64, але битим DER', async () => {
    const { publicKey } = await makeKeyPair();
    const pubkey = await importMonoPubkey(await exportMonoStyleKey(publicKey));
    const notDer = toBase64(new Uint8Array([1, 2, 3, 4]));

    await expect(verifyWebhookSignature(pubkey, notDer, toBytes(WEBHOOK_BODY))).rejects.toThrow();
  });
});

describe('importMonoPubkey', () => {
  it('кидає помилку, якщо всередині base64 немає PEM-рамок', async () => {
    await expect(importMonoPubkey(toBase64(toBytes('не PEM')))).rejects.toThrow();
  });

  it('кидає помилку на биту base64-обгортку', async () => {
    await expect(importMonoPubkey('%%%')).rejects.toThrow();
  });
});
