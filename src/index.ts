import { Hono } from 'hono';

export type Env = {
  DB: D1Database;
};

export const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

// Наповнюється на етапі 6 (нагадування + чистка unpaid, PRD §11).
async function scheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {}

export default {
  fetch: app.fetch,
  scheduled,
};
