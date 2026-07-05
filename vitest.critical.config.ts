// Окремий прогін для security-критичних модулів (CLAUDE.md → Security):
// mono-клієнт, ECDSA-верифікатор, обробник вебхука, capture (рухає гроші).
import { defineConfig } from 'vitest/config';

const CRITICAL_SOURCES = [
  'src/lib/mono-*.ts',
  'src/lib/ecdsa-*.ts',
  'src/lib/session-token.ts',
  'src/routes/mono-webhook.ts',
  'src/routes/capture.ts',
  'src/cron.ts',
];

export default defineConfig({
  test: {
    include: [
      'test/mono-*.test.ts',
      'test/ecdsa-*.test.ts',
      'test/session-token*.test.ts',
      'test/webhook-*.test.ts',
      'test/capture-*.test.ts',
      'test/cron*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: CRITICAL_SOURCES,
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
