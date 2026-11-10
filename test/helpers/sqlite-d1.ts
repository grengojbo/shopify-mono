// D1-сумісна обгортка над справжнім SQLite у пам'яті з реальними міграціями.
// Потрібна там, де поведінку визначає сама схема (унікальні індекси, гонки) —
// мок `prepare/bind/first` таких помилок не відтворить.

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = 'migrations';

type Statement = {
  bind: (...params: unknown[]) => Statement;
  first: () => Promise<unknown>;
  run: () => Promise<{ success: true; meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[] }>;
  execSync: () => void;
};

export function makeSqliteD1() {
  const raw = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    raw.exec(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
  }

  const prepare = (sql: string): Statement => {
    let params: unknown[] = [];
    const statement: Statement = {
      bind: (...next) => {
        params = next;
        return statement;
      },
      first: async () => raw.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = raw.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      all: async () => ({ results: raw.prepare(sql).all(...params) }),
      execSync: () => {
        raw.prepare(sql).run(...params);
      },
    };
    return statement;
  };

  // D1 batch — одна транзакція: або всі оператори, або жоден
  const batch = async (statements: Statement[]) => {
    raw.exec('BEGIN');
    try {
      for (const statement of statements) {
        statement.execSync();
      }
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
    return [];
  };

  return { db: { prepare, batch } as unknown as D1Database, raw };
}
