// Гарантії, які дає сама схема D1 (а не код) — на справжньому SQLite з міграціями.

import { describe, expect, it } from 'vitest';

import { makeSqliteD1 } from './helpers/sqlite-d1';

describe('схема webhook_log — один запис на invoiceId+status', () => {
  const insert = (raw: ReturnType<typeof makeSqliteD1>['raw'], invoiceId: string, status: string) =>
    raw
      .prepare(
        "INSERT INTO webhook_log (invoice_id, status, raw_body, received_at) VALUES (?, ?, '{}', 1)",
      )
      .run(invoiceId, status);

  it('дубль того самого invoiceId+status відхиляється', () => {
    const { raw } = makeSqliteD1();
    insert(raw, 'inv1', 'success');

    expect(() => insert(raw, 'inv1', 'success')).toThrow(/UNIQUE/);
  });

  it('інший статус того самого інвойсу і той самий статус іншого інвойсу — дозволено', () => {
    const { raw } = makeSqliteD1();
    insert(raw, 'inv1', 'processing');

    expect(() => insert(raw, 'inv1', 'success')).not.toThrow();
    expect(() => insert(raw, 'inv2', 'processing')).not.toThrow();
  });
});
