# PRD — Bbox · Прийом оплат monobank на Shopify через Cloudflare Worker

Версія: 1.0  
Дата: 2026-06-15  
Власник: Bbox (bbox.kiev.ua)  
Призначення: технічне завдання для реалізації у Claude Code.

---

## 1. Контекст і мета

Bbox — майстерня 3D-друку (літофани, світильники, запчастини для 3D-принтерів) на Shopify (тариф **non-Plus**). Shopify Payments в Україні недоступний, тому потрібен власний прийом оплат через **monobank acquiring (plata by mono)**.

Магазин технічно самостійний: власна тема (клон Fabric, синхронізація через GitHub), власні Shopify-апи (`bbox-erm`), є рахунок ФОП у monobank. Тому інтеграція будується **власноруч**, без агенції.

**Мета:** приймати онлайн-оплати через monobank з мінімальним тертям для покупця, з підтримкою `debit`/`hold`, автоматичною фіскалізацією через Вчасно.Каса, нагадуваннями про неоплачені замовлення, на безкоштовній інфраструктурі Cloudflare.

### Поза скоупом
- KeyCRM-інтеграція (свідомо виключена).
- Заміна рідного чекауту стороннім (Chekly/Walnut) — заборонено правилами Shopify.
- Мультивалютність (працюємо лише в UAH, ccy 980).
- Збереження карток / рекурентні платежі (можливо в майбутньому).

---

## 2. Критичне архітектурне рішення: Path A vs Path B

> **Це рішення визначає лише Shopify-шар. Ядро (Worker + mono + D1 + фіскалізація + cron) спільне для обох шляхів.**

**Обмеження-факт:** авто-редірект із Thank You сторінки Shopify технічно неможливий. Checkout UI Extensions обмежені набором компонентів і не дозволяють програмний редірект; максимум — видима кнопка, яку покупець натискає вручну. Additional Scripts (старий спосіб) deprecated.

| | **Path A — Thank You + ручна оплата** | **Path B — Native Payment Apps API (offsite)** |
|---|---|---|
| Дії покупця | Оформлює замовлення → **тисне кнопку «Сплатити»** на Thank You → редірект на mono | Обирає mono в чекауті → звичайна кнопка оформлення → **Shopify сам редіректить на mono** |
| Зайвих кліків | +1 | 0 |
| Апрув Shopify Payments Partner | Не потрібен | **Потрібен** |
| Замовлення-привиди (unpaid) | Так, треба чистити | Ні (замовлення лише після успіху) |
| Як Worker підтверджує оплату | Shopify Admin API (`orderMarkAsPaid` / transaction) | Payments Apps API (resolve/reject payment session) |
| Час до запуску | Швидко | Залежить від апруву |

**Рекомендація / план запуску:**
1. Будуємо спільне ядро (розділи 4–9) — воно не залежить від вибору шляху.
2. Паралельно подаємось на Shopify Payments Partner.
3. Запускаємось на **Path A** як проміжний варіант (один клік).
4. Після апруву перемикаємо тонкий Shopify-шар на **Path B** — без переписування ядра.

Обидва Shopify-шари описані в розділі 10.

---

## 3. Технологічний стек

- **Runtime:** Cloudflare Workers, Node-сумісність (`nodejs_compat` у `wrangler.toml`), фреймворк **Hono**.
- **Сховище стану:** Cloudflare **D1** (SQLite). KV не використовуємо — для hold потрібен надійний пошук `invoiceId` через дні (KV eventually consistent).
- **Розклад:** Cloudflare **Cron Triggers** (нагадування + чистка unpaid).
- **Криптографія:** вбудований **Web Crypto API** (`crypto.subtle`) для ECDSA-валідації вебхуків mono. Жодних Node-крипто залежностей.
- **Секрети:** `wrangler secret put` (не в коді, не в `wrangler.toml`).
- **Фіскалізація:** **mono-native інтеграція з Вчасно.Каса** (нуль коду на боці Worker; див. розділ 8).

### Безкоштовність
Workers (100k req/день), D1, Cron, Web Crypto — у безкоштовному тарифі. Cloudflare Queues НЕ використовуємо (вимагає платний план); ретраї робимо через Cron + D1.

---

## 4. Маршрути Worker

| Маршрут | Метод | Призначення | Path |
|---|---|---|---|
| `/create-invoice` | POST | Створити mono-інвойс для замовлення, повернути `pageUrl` | A |
| `/payment-session` | POST | Обробити payment session від Shopify (Payments Apps API) | B |
| `/mono-webhook` | POST | Прийняти статус від mono, ECDSA-валідація, оновити стан | A+B |
| `/capture` | POST | Фіналізувати (capture) hold-інвойс при готовності замовлення | A+B |
| `/cron` | (Cron) | Нагадування про unpaid + чистка протермінованих | A+B |
| `/health` | GET | Healthcheck | A+B |

> На Path B `/create-invoice` зливається з `/payment-session`, а підтвердження оплати йде через Payments Apps API замість Admin API. Логіка mono всередині — та сама.

---

## 5. Архітектура потоку (Path A, проміжний запуск)

1. Покупець оформлює замовлення з методом «monobank (ручна оплата)» → Shopify створює замовлення зі статусом `unpaid`.
2. На Thank You сторінці UI Extension отримує `orderId` (через OrderConfirmation API) і викликає `POST /create-invoice {orderId}`. Рендериться кнопка «Сплатити через monobank».
3. Worker через Shopify Admin API читає замовлення: суму, валюту, line items, теги товарів, контакт покупця.
4. Worker визначає `paymentType`: якщо є хоч одна позиція з тегом `made-to-order` → `hold`, інакше `debit`.
5. Worker викликає mono `POST /api/merchant/invoice/create` (`reference = orderId`, `webHookUrl = .../mono-webhook`, `redirectUrl = order status page`, `basketOrder` з line items).
6. Worker зберігає `invoiceId ↔ orderId` + метадані в D1, повертає `pageUrl` у extension.
7. Покупець тисне кнопку → редірект на `pageUrl` → оплачує (Apple Pay / Google Pay / картка).
8. mono надсилає вебхук на `/mono-webhook` з `X-Sign`. Worker валідує ECDSA, знаходить `orderId`, оновлює D1.
9. **debit:** Worker позначає замовлення `Paid` через Admin API.  
   **hold:** Worker позначає `Authorized`; реальний `Paid` — після capture (крок 11).
10. Фіскалізація: mono-native Вчасно автоматично видає чек (для debit — на цьому кроці; для hold — на capture; розділ 8).
11. **hold-capture:** коли деталь надрукована/готова до відправки, тригер (зміна статусу замовлення / ручний виклик) → `POST /capture {orderId}` → Worker викликає mono `finalize` → mono-вебхук підтверджує → Worker ставить `Paid` + фіскалізація.

(Path B: кроки 1–2 замінюються нативним вибором mono в чекауті; крок 9/11 — через Payments Apps API resolve.)

---

## 6. Інтеграція monobank — специфікація

Документація: `.claude/skills/monobank-acquiring/` (вендорований офіційний AI-tools skill mono, джерело — `https://api.monobank.ua/docs/acquiring.html`). **Усі поля/семантику звіряти з актуальною версією API під час реалізації** (mono версіонує API) — якщо вендорований skill розходиться з живими доксами, оновити skill, а не покладатись лише на цей PRD.

### Аутентифікація
- Заголовок `X-Token: <merchant token>` (з кабінету ФОП `web.monobank.ua`; тестовий токен з `api.monobank.ua`).

### Створення інвойсу — `POST /api/merchant/invoice/create`
Тіло (ключове):
- `amount` (integer) — сума в **мінімальних одиницях** (копійки). Обов'язкове.
- `ccy` (integer) — `980` (UAH).
- `merchantPaymInfo`:
  - `reference` — `orderId` Shopify (для зв'язку).
  - `destination` — текст призначення («Оплата за замовлення #...»).
  - `basketOrder[]` — позиції: `name`, `qty`, `sum`, `icon` (URL зображення товару), `unit`, плюс **фіскальні поля для Вчасно** (`code`/`uktzed`, ставка ПДВ, тип). Перелік фіскальних полів звірити з вимогами Вчасно + mono.
- `redirectUrl` — куди повернути покупця (order status page Shopify).
- `webHookUrl` — `https://<worker>/mono-webhook`.
- `paymentType` — `"debit"` або `"hold"`.
- `validity` (опц.) — час життя інвойсу в секундах (впливає на вікно нагадування).

Відповідь: `invoiceId`, `pageUrl`.

### Capture (фіналізація hold) — `POST /api/merchant/invoice/finalize`
- Тіло: `invoiceId`, `amount` (можна частковий capture).

### Скасування / повернення — `POST /api/merchant/invoice/cancel`
- Тіло: `invoiceId`, опц. `amount`, `items`. Для hold без capture — звільняє блокування.

### Статус — `GET /api/merchant/invoice/status?invoiceId={id}`
- Використовується Cron'ом для звірки.

### Фіскальні чеки — `GET /api/merchant/invoice/fiscal-checks?invoiceId={id}`
- Отримати дані/статус/PDF чека (потрібно лише якщо знадобиться self-контроль чеків).

### Статуси інвойсу
`created → processing → success / failure / reversed / expired`. Обробляємо ідемпотентно (вебхук може прийти кілька разів).

### Валідація вебхука (ECDSA) — критичний нюанс реалізації
1. Публічний ключ: `GET /api/merchant/pubkey` → base64 PEM (SPKI). Імпорт через `crypto.subtle.importKey('spki', der, {name:'ECDSA', namedCurve:'P-256'}, false, ['verify'])`.
2. Підпис: заголовок `X-Sign` (base64). **mono надсилає підпис у DER (ASN.1)**, а Web Crypto `verify` очікує raw r‖s (IEEE P1363, 64 байти). **Потрібна конвертація DER → P1363** перед `crypto.subtle.verify`. Це найчастіша помилка реалізації — закласти конвертер.
3. Дані для перевірки — **сирі байти тіла запиту** (не перепарсений JSON).
4. Алгоритм: `{name:'ECDSA', hash:'SHA-256'}`.
5. Кешувати pubkey (він стабільний), оновлювати при провалі валідації.

---

## 7. Логіка debit / hold

| Тип | Коли | Тригер | Фіскалізація |
|---|---|---|---|
| `debit` | Усі позиції в наявності (немає тегу `made-to-order`) | Списання одразу при оплаті | На вебхуку `success` |
| `hold` | Є хоч одна позиція з тегом `made-to-order` | Блокування → `finalize` коли деталь готова | На моменті capture |

- Тег `made-to-order` ставиться на товари в Shopify; Worker читає теги line items через Admin API.
- Для hold реальне списання й видача чека — лише при capture. **Видавати чек на авторизації hold не можна** (грошей ще немає).
- Звільнення hold (не змогли надрукувати) → mono `cancel`.
- **mono сам скасовує hold через 9 днів**, якщо його не фіналізовано (`finalize`) — це не наш ліміт, тож `/cron` не повинен винаходити власне вікно очікування для hold-інвойсів; лише слідкувати, щоб деталь встигла бути готовою, і за потреби нагадувати відповідальному про капчер до спливу цих 9 днів. Джерело: `.claude/skills/monobank-acquiring/invoice.md` → `paymentType`.

---

## 8. Фіскалізація — mono-native Вчасно.Каса

**Архітектура: нуль коду фіскалізації на боці Worker.**

- У кабінеті Вчасно.Каса створюється інтеграційний токен, вказується в кабінеті monobank (Оплата на сайті → інтеграції → налаштування пРРО → Вчасно).
- Після успішної оплати mono сам передає дані `basketOrder` у Вчасно, який автоматично відкриває/закриває касову зміну і створює фіскальний чек.
- Worker лише має передавати коректний `basketOrder` з фіскальними полями у `createInvoice`.

**Обов'язково підтвердити з підтримкою mono перед запуском:**  
> Для `hold` — у який момент mono видає чек: на `finalize` (capture) чи на авторизації?  
> - Якщо на capture → ідеально, нічого не робимо.  
> - Якщо на авторизації → вимкнути mono-native фіскалізацію для hold-замовлень і викликати **Вчасно API напряму з Worker на момент capture** (fallback-варіант; тоді знадобиться: ендпоінт видачі чека Вчасно, керування касовою зміною, поля УКТЗЕД/ПДВ/тип розрахунку).

Обмеження: Вчасно фіскалізує лише UAH (для нас не проблема).

---

## 9. Модель даних (D1)

Орієнтовна схема (уточнити при реалізації):

```sql
CREATE TABLE invoices (
  invoice_id      TEXT PRIMARY KEY,        -- mono invoiceId
  order_id        TEXT NOT NULL,           -- Shopify order id (reference)
  amount          INTEGER NOT NULL,        -- копійки
  ccy             INTEGER NOT NULL DEFAULT 980,
  payment_type    TEXT NOT NULL,           -- 'debit' | 'hold'
  status          TEXT NOT NULL,           -- created/processing/success/failure/reversed/expired
  page_url        TEXT,
  created_at      INTEGER NOT NULL,        -- unix ts
  modified_at     INTEGER,
  captured_at     INTEGER,                 -- для hold
  final_amount    INTEGER,
  approval_code   TEXT,                    -- з вебхука
  rrn             TEXT,                    -- з вебхука
  fiscal_status   TEXT,                    -- pending/issued/failed
  reminder_count  INTEGER NOT NULL DEFAULT 0,
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
```

---

## 10. Shopify-шар (два варіанти)

### Path A — Thank You + Manual Payment
- **Manual Payment Method** у налаштуваннях Shopify (назва «monobank»).
- **Checkout UI Extension** на target `purchase.thank-you`:
  - отримує `orderId` через **OrderConfirmation API** (на Thank You замовлення ще створюється, але `orderId` доступний);
  - викликає `POST /create-invoice {orderId}`;
  - рендерить кнопку «Сплатити через monobank» з посиланням на `pageUrl` (авто-редірект **неможливий** — лише кнопка).
- Підтвердження оплати: Worker → **Admin API** `orderMarkAsPaid` (debit) / transaction (hold→capture).
- **UX-нота:** зробити кнопку максимально помітною; продублювати посилання на оплату в order confirmation email і в нагадуваннях.

### Path B — Native Payment Apps API (offsite)
- **Offsite payment extension** (Partner Dashboard → App → Extensions → Offsite payment provider).
- Вимагає схвалення як **Shopify Payments Partner** (подати заявку, пройти review).
- Покупець обирає mono в чекауті → Shopify редіректить на mono `pageUrl` → повертає на рідний Thank You.
- Підтвердження оплати: Worker відповідає через **Payments Apps API** (resolve/reject payment session) замість Admin API.
- Обмеження extension: лише Payments Apps API + обов'язкові вебхуки; не запитувати network/protected-data скоупи (інакше reject на review).

---

## 11. Нагадування про неоплачені замовлення (Cron)

- Контакт покупця беремо з Shopify-замовлення (телефон/email — введені на чекауті). mono телефон не передає, і це не потрібно.
- Канали: WhatsApp Business (+380630630035), Telegram `@BboxSupportBot`, email.
- Логіка Cron (раз на годину або частіше):
  - інвойс `created/processing` старший за **30 хв** і без `success` → надіслати нагадування з посиланням на оплату (`pageUrl`, поки не протермінований; інакше створити новий інвойс), інкремент `reminder_count`.
  - інвойс без оплати старший за **24 год** → mono `cancel` + позначити замовлення скасованим/архівним у Shopify + прибрати з активних.
- Не плутати з рідним Shopify «abandoned checkout» — у нас замовлення вже створене (Path A), тому нагадування шлемо своїм каналом.

---

## 12. Безпека

- Усі секрети через `wrangler secret`: `MONO_TOKEN`, `SHOPIFY_ADMIN_TOKEN`, (Path B) `SHOPIFY_PAYMENTS_*`, канали нагадувань.
- **Завжди** валідувати `X-Sign` вебхука mono (ECDSA) перед будь-якою дією. Невалідний підпис → 400, нічого не робити.
- Суму інвойсу формувати **на сервері** з даних Shopify-замовлення (Admin API), ніколи не з клієнта.
- Ідемпотентність вебхуків: повторний вебхук того ж `invoiceId+status` не повинен дублювати дії (перевірка через `webhook_log` / поточний статус у D1).
- HTTPS-only; жодних персональних даних у query-параметрах.

---

## 13. Крайові випадки

- **Дубль вебхука** → ідемпотентна обробка за статусом у D1.
- **Вебхук прийшов раніше за збереження інвойсу** (рейс) → ретрай/черга в D1; не падати.
- **Capture протермінованого hold** → mono автоматично скасовує hold через 9 днів від авторизації, якщо не викликано `finalize`; спроба `finalize` після цього поверне помилку — обробити, повідомити відповідального, можливо пересоздати оплату.
- **Часткова невдача фіскалізації** (чек не видався при оплаченому замовленні) → `fiscal_status='failed'`, нічна звірка + ретрай; алерт.
- **Повернення коштів** → лише через кабінет monobank (Admin API Shopify не списує з mono).
- **Покупець закрив сторінку mono** → інвойс лишається `created/processing` → потрапляє в нагадування/чистку.

---

## 14. Конфігурація / середовище

`wrangler.toml` (орієнтовно):
```toml
name = "bbox-mono-payments"
main = "src/index.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "bbox-payments"
database_id = "<...>"

[triggers]
crons = ["*/15 * * * *"]
```

Секрети (через `wrangler secret put`):
- `MONO_TOKEN`
- `SHOPIFY_ADMIN_TOKEN`
- `SHOPIFY_STORE_DOMAIN`
- `TELEGRAM_BOT_TOKEN` / WhatsApp / email-провайдер
- (Path B) креденшали Payments App

---

## 15. Відкриті питання (підтвердити до/під час реалізації)

1. **Hold + фіскалізація:** у який момент mono-native Вчасно видає чек для hold (capture чи авторизація)? Від цього залежить, чи потрібен fallback з прямим викликом Вчасно API.
2. **Shopify Payments Partner:** статус/строки апруву для Path B.
3. ~~Точна семантика `basketOrder.sum`~~ — **Вирішено**: `sum` — ціна за одиницю в копійках, `total` — сума за всі одиниці. Обов'язкове фіскальне поле — `code` (код товару); `uktzed` опційне. Джерело: `.claude/skills/monobank-acquiring/SKILL.md` → `BasketOrderItem`. Ще не звірено: чи Вчасно вимагає щось понад ці поля (ставка ПДВ, тип розрахунку) — звірити при підключенні кабінету Вчасно.
4. **DER→P1363** конвертація підпису — реалізувати/протестувати на реальному вебхуку (тестовий токен).

---

## 16. Етапи для Claude Code

1. **Скелет:** Hono на Workers, `wrangler.toml`, `/health`, D1-схема + міграції.
2. **mono-клієнт:** `createInvoice`, `finalize`, `cancel`, `status`, `pubkey`; ECDSA-валідатор з DER→P1363 (юніт-тест на прикладі з докти).
3. **`/create-invoice`** (Path A): читання замовлення з Admin API, debit/hold за тегом, створення інвойсу, запис у D1, повернення `pageUrl`.
4. **`/mono-webhook`:** валідація, ідемпотентність, оновлення D1, mark Paid/Authorized через Admin API.
5. **`/capture`:** finalize hold → mark Paid.
6. **`/cron`:** нагадування + чистка unpaid.
7. **Shopify UI Extension** (Path A): Thank You кнопка + виклик `/create-invoice`.
8. **(пізніше) Path B:** offsite payment extension + Payments Apps API resolve, перемикання Shopify-шару.

---

> Реалізацію починати зі спільного ядра (етапи 1–6). Path B-шар додається без переписування ядра після апруву.
