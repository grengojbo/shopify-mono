import { describe, expect, it } from 'vitest';

import { uahToKopecks } from '../src/lib/money';

describe('uahToKopecks', () => {
  it('конвертує суму з двома десятковими знаками', () => {
    expect(uahToKopecks('420.00')).toBe(42000);
  });

  it('конвертує суму менше гривні', () => {
    expect(uahToKopecks('0.05')).toBe(5);
  });

  it('доповнює один десятковий знак нулем', () => {
    expect(uahToKopecks('1234.5')).toBe(123450);
  });

  it('конвертує цілу суму без крапки', () => {
    expect(uahToKopecks('0')).toBe(0);
    expect(uahToKopecks('100')).toBe(10000);
  });

  it("відхиляє від'ємну суму", () => {
    expect(() => uahToKopecks('-1')).toThrow();
    expect(() => uahToKopecks('-0.01')).toThrow();
  });

  it('відхиляє більше двох десяткових знаків', () => {
    expect(() => uahToKopecks('1.234')).toThrow();
  });

  it('відхиляє суму поза межами безпечного цілого', () => {
    expect(() => uahToKopecks('99999999999999999.00')).toThrow();
  });

  it('відхиляє нечислові значення', () => {
    expect(() => uahToKopecks('abc')).toThrow();
    expect(() => uahToKopecks('')).toThrow();
    expect(() => uahToKopecks('12.3.4')).toThrow();
    expect(() => uahToKopecks('1e10')).toThrow();
    expect(() => uahToKopecks('NaN')).toThrow();
    expect(() => uahToKopecks('Infinity')).toThrow();
  });
});
