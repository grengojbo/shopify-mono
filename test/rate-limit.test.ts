import { describe, expect, it, vi } from 'vitest';

import { checkRateLimit } from '../src/lib/rate-limit';

describe('checkRateLimit', () => {
  it('пропускає запит, поки ліміт не вичерпано, і передає ключ у binding', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };

    expect(await checkRateLimit(limiter, '203.0.113.7')).toBe(true);
    expect(limiter.limit).toHaveBeenCalledWith({ key: '203.0.113.7' });
  });

  it('відхиляє запит, коли binding повідомляє про перевищення', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };

    expect(await checkRateLimit(limiter, '203.0.113.7')).toBe(false);
  });

  it('без binding пропускає запит', async () => {
    expect(await checkRateLimit(undefined, '203.0.113.7')).toBe(true);
  });

  it('збій binding логується і не блокує запит', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const limiter = { limit: vi.fn().mockRejectedValue(new Error('boom')) };

    expect(await checkRateLimit(limiter, '203.0.113.7')).toBe(true);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
