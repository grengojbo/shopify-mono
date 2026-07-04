import { describe, expect, it } from 'vitest';

import worker, { app, type Env } from '../src/index';

describe('GET /health', () => {
  it('відповідає 200 зі статусом ok', async () => {
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('невідомий шлях відповідає 404', async () => {
    const res = await app.request('/no-such-route');

    expect(res.status).toBe(404);
  });
});

describe('scheduled', () => {
  it('заглушка завершується без помилок', async () => {
    await expect(
      worker.scheduled({} as ScheduledController, {} as Env, {} as ExecutionContext),
    ).resolves.toBeUndefined();
  });
});
