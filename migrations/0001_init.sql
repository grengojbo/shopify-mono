-- Початкова схема (PRD §9): інвойси mono та журнал вебхуків.

CREATE TABLE invoices (
  invoice_id       TEXT PRIMARY KEY,        -- mono invoiceId
  order_id         TEXT NOT NULL,           -- Shopify order id (reference)
  amount           INTEGER NOT NULL,        -- копійки
  ccy              INTEGER NOT NULL DEFAULT 980,
  payment_type     TEXT NOT NULL,           -- 'debit' | 'hold'
  status           TEXT NOT NULL,           -- created/processing/success/failure/reversed/expired
  page_url         TEXT,
  created_at       INTEGER NOT NULL,        -- unix ts
  modified_at      INTEGER,
  captured_at      INTEGER,                 -- для hold
  final_amount     INTEGER,
  approval_code    TEXT,                    -- з вебхука
  rrn              TEXT,                    -- з вебхука
  fiscal_status    TEXT,                    -- pending/issued/failed
  reminder_count   INTEGER NOT NULL DEFAULT 0,
  last_reminder_at INTEGER
);

CREATE INDEX idx_invoices_order  ON invoices(order_id);
CREATE INDEX idx_invoices_status ON invoices(status);

CREATE TABLE webhook_log (        -- ідемпотентність + аудит
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  TEXT NOT NULL,
  status      TEXT NOT NULL,
  raw_body    TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
