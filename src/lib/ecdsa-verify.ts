// Валідація ECDSA-підпису вебхуків mono (PRD §6).
//
// mono надсилає X-Sign у DER (ASN.1), а crypto.subtle.verify приймає лише
// raw r‖s (IEEE P1363, 64 байти для P-256) — тому конвертація обов'язкова.
// Перевірка завжди йде по сирих байтах тіла запиту, не по перепарсеному JSON.
// Будь-який дефект структури — виняток (fail-closed), а не false-позитив.

const P1363_HALF_LENGTH = 32;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Читає одну INTEGER-компоненту DER-підпису й нормалізує її до 32 байтів:
 * знімає доповнення знаку 0x00, доповнює нулями зліва короткі значення.
 * Повертає нову позицію курсора.
 */
function readDerInteger(der: Uint8Array, offset: number, out: Uint8Array): number {
  if (der[offset] !== 0x02) {
    throw new Error('Некоректний DER: очікувався тег INTEGER');
  }
  const length = der[offset + 1];
  if (length === undefined || length === 0 || length > P1363_HALF_LENGTH + 1) {
    throw new Error('Некоректний DER: довжина INTEGER поза межами P-256');
  }
  let start = offset + 2;
  let contentLength = length;
  if (der[start] === 0x00) {
    // Доповнення знаку — допустиме лише перед значенням зі старшим бітом
    start += 1;
    contentLength -= 1;
  }
  if (contentLength > P1363_HALF_LENGTH) {
    throw new Error('Некоректний DER: значення INTEGER довше за 32 байти');
  }
  const value = der.slice(start, start + contentLength);
  if (value.length !== contentLength) {
    throw new Error('Некоректний DER: INTEGER обрізано');
  }
  out.set(value, P1363_HALF_LENGTH - contentLength);
  return offset + 2 + length;
}

/** Конвертує DER-кодований ECDSA-підпис у raw r‖s (IEEE P1363, 64 байти). */
export function derToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) {
    throw new Error('Некоректний DER: очікувався тег SEQUENCE');
  }
  const sequenceLength = der[1];
  if (sequenceLength === undefined || sequenceLength + 2 !== der.length) {
    throw new Error('Некоректний DER: довжина SEQUENCE не збігається з розміром підпису');
  }
  const p1363 = new Uint8Array(P1363_HALF_LENGTH * 2);
  const afterR = readDerInteger(der, 2, p1363.subarray(0, P1363_HALF_LENGTH));
  const afterS = readDerInteger(der, afterR, p1363.subarray(P1363_HALF_LENGTH));
  if (afterS !== der.length) {
    throw new Error('Некоректний DER: зайві байти після INTEGER s');
  }
  return p1363;
}

/**
 * Імпортує публічний ключ mono з формату GET /api/merchant/pubkey:
 * base64-обгорнутий PEM (SPKI). Ключ стабільний — кешувати на боці виклику,
 * оновлювати лише при провалі валідації.
 */
export async function importMonoPubkey(keyBase64: string): Promise<CryptoKey> {
  const pem = new TextDecoder().decode(base64ToBytes(keyBase64));
  const pemBody = pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '');
  if (pemBody === pem.replace(/\s/g, '') || pemBody.length === 0) {
    throw new Error('Ключ mono не містить PEM-рамок PUBLIC KEY');
  }
  const spki = base64ToBytes(pemBody);
  return crypto.subtle.importKey(
    'spki',
    spki as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

/**
 * Перевіряє підпис X-Sign по сирих байтах тіла вебхука.
 * false — підпис не збігається; виняток — X-Sign структурно битий.
 */
export async function verifyWebhookSignature(
  pubkey: CryptoKey,
  xSignBase64: string,
  rawBody: Uint8Array,
): Promise<boolean> {
  const signature = derToP1363(base64ToBytes(xSignBase64));
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pubkey,
    signature as BufferSource,
    rawBody as BufferSource,
  );
}
