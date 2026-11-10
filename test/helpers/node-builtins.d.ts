// Мінімальні оголошення Node-вбудованих модулів, потрібних лише тест-хелперам.
// @types/node навмисно не підключаємо: він додав би Node-глобали і в src/,
// де код має спиратися тільки на API Workers.

declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:sqlite' {
  export class StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
