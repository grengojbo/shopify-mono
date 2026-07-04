// Окремий прогін для security-критичних модулів (CLAUDE.md → Security):
// mono-клієнт, ECDSA-верифікатор, обробник вебхука. Поки модулів немає,
// `--passWithNoTests` тримає CI зеленим; пороги набудуть чинності разом
// із появою файлів на етапах 2 і 4 (PRD §16).
import { defineConfig } from 'vitest/config';

const CRITICAL_SOURCES = ['src/lib/mono-*.ts', 'src/lib/ecdsa-*.ts', 'src/routes/mono-webhook.ts'];

export default defineConfig({
  test: {
    include: ['test/mono-*.test.ts', 'test/ecdsa-*.test.ts', 'test/webhook-*.test.ts'],
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
