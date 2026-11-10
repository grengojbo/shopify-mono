-- Один активний інвойс на замовлення. Перевірка «чи вже є інвойс» у
-- /create-invoice не атомарна щодо INSERT, тож два одночасні запити давали два
-- робочі посилання на оплату. Індекс робить другий INSERT помилкою.
--
-- `hold` теж активний: кошти вже заблоковано, новий інвойс означав би друге
-- блокування тієї самої суми.

CREATE UNIQUE INDEX idx_invoices_one_active_per_order
  ON invoices(order_id)
  WHERE status IN ('created', 'processing', 'hold');
