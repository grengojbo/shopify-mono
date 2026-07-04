// Конвертація грошових сум Shopify (MoneyV2.amount — десятковий рядок,
// напр. "420.00") у цілі копійки без float-математики (CLAUDE.md → Conventions).

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Конвертує десятковий рядок гривень у цілі копійки. Кидає на будь-який нестандартний формат. */
export function uahToKopecks(decimal: string): number {
  if (!DECIMAL_PATTERN.test(decimal)) {
    throw new Error(`Некоректний формат суми: "${decimal}"`);
  }

  const [whole, fraction = ''] = decimal.split('.');
  const paddedFraction = fraction.padEnd(2, '0');
  const kopecks = Number(`${whole}${paddedFraction}`);

  if (!Number.isSafeInteger(kopecks)) {
    throw new Error(`Сума поза межами безпечного цілого: "${decimal}"`);
  }

  return kopecks;
}
