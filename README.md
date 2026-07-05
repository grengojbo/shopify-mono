# Інтеграція Shopify з monobank (shopify-mono)

Привіт! Це основний репозиторій для інтеграції нашого магазину Shopify (працює на non-Plus тарифі) з еквайрингом monobank (plata by mono). Цей сервіс автоматизує виставлення рахунків покупцям та оновлює статус оплати замовлень у Shopify.

Я детально розписав архітектуру, налаштування та процес локального запуску. Якщо виникнуть питання — сміливо звертайся, але спочатку обов'язково прочитай цю інструкцію до кінця!

---

## 🛠️ Як влаштована архітектура (коротко)

Інтеграція складається з двох основних частин:

1. **Cloudflare Worker (ядро)** (знаходиться в папці `src/`): написаний на Hono (TypeScript), використовує базу даних D1 для збереження рахунків та черг, приймає вебхуки від monobank та оновлює статуси замовлень через Shopify Admin API.
2. **Checkout UI Extension (фронтенд)** (знаходиться в папці `app/`): кастомний застосунок Shopify, який додає кнопку «Сплатити через monobank» на сторінці подяки (Thank You page) замовника.

Зараз реалізовано **Path A** (проміжний запуск), і він працює у **два кроки**:

1. **На чекауті** покупець обирає спеціальний ручний спосіб оплати **«monobank»** (Settings → Payments → «Способи оплати вручну» — він додається *поруч* із твоїм наявним «Накладеним платежем», нічого не замінюючи). Shopify створює замовлення зі статусом `unpaid` — так само, як і для накладеного платежу.
2. **На сторінці подяки** наш extension показує кнопку «Сплатити через monobank», яка веде на платіжну сторінку mono.

> [!IMPORTANT]
> Кнопка з'являється **лише** для замовлень, оформлених методом «monobank». Замовлення з «Накладеним платежем (COD)» кнопку не бачать — Worker перевіряє метод оплати замовлення (`paymentGatewayNames`) і відповідає 409, а extension у цьому випадку тихо ховає блок. Покупець із післяплатою не отримає недоречної пропозиції заплатити наперед.

Детальний опис бізнес-вимог читай у нашому [PRD.md](PRD.md).

---

## 💻 Локальний запуск для тестування

Для локальної роботи нам знадобиться Node.js (рекомендовано версію 22 або новішу) та встановлені залежності.

1. **Встанови залежності:**

   ```bash
   npm install
   ```
2. **Застосуй міграції бази даних D1 локально:**
   Ми використовуємо D1 (SQLite) для зберігання статусів платежів.

   ```bash
   npx wrangler d1 migrations apply bbox-payments --local
   ```
3. **Запусти юніт-тести:**
   Тести запускаються в ізольованому середовищі, тому реальні секрети чи доступ до мережі не потрібні (все покрите моками):

   ```bash
   npm test
   ```
4. **Запусти локальний сервер розробки:**
   Це запустить локальну копію Worker'а за допомогою Wrangler:

   ```bash
   npm run dev
   ```

   Сервер буде доступний за адресою `http://localhost:8787`.

---

## 🔑 Змінні середовища та секрети

Для локальної розробки Wrangler зчитує секрети з файлу `.dev.vars`, який має лежати в корені репозиторію.

> [!IMPORTANT]
> **Увага!** Ніколи не додавай секрети безпосередньо у `wrangler.toml` або в код і не коміть файл `.dev.vars` у Git (він уже доданий до `.gitignore`). Для продакшену секрети встановлюються виключно через команду `wrangler secret put <NAME>`.

Створи файл `.dev.vars` у корені проекту та заповни його такими значеннями:

```bash
MONO_TOKEN=<тестовий токен з https://api.monobank.ua/>
SHOPIFY_ADMIN_CLIENT_ID=<ИД клиента апа Bbox-Worker-Integration>
SHOPIFY_ADMIN_CLIENT_SECRET=<Секрет апа Bbox-Worker-Integration>
SHOPIFY_STORE_DOMAIN=<your-dev-store>.myshopify.com
CAPTURE_TOKEN=<будь-який довгий випадковий рядок>
SHOPIFY_APP_SECRET=<client secret custom app, після створення додатку>
SHOPIFY_APP_CLIENT_ID=<client id custom app, після створення додатку>

# Опційні змінні — без них сповіщення будуть просто виводитися у консоль Worker'а
TELEGRAM_BOT_TOKEN=<токен бота від @BotFather>
TELEGRAM_CHAT_ID=<chat id оператора чи групи>
```

### Детальний опис змінних (рантайм-секретів)

| Назва змінної       | Обов'язкова | Опис та призначення                                                                                                                                                                                                                                              |
| ------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONO_TOKEN`                  | Так                | `X-Token` для monobank acquiring API. Для тестів бери на `api.monobank.ua`, для бойового режиму — на `web.monobank.ua`.                                                                                                               |
| `SHOPIFY_ADMIN_CLIENT_ID`     | Так                | «ИД клиента» апа**Bbox-Worker-Integration** (Dev Dashboard) — Worker сам отримує через них 24-годинний Admin-токен (client credentials grant) для читання замовлень, `orderMarkAsPaid`, `orderCancel`. |
| `SHOPIFY_ADMIN_CLIENT_SECRET` | Так                | «Секрет» того ж апа Bbox-Worker-Integration — друга половина client credentials grant.                                                                                                                                                              |
| `SHOPIFY_STORE_DOMAIN`        | Так                | Домен твого магазину у форматі`<store>.myshopify.com` для валідації запитів.                                                                                                                                                       |
| `CAPTURE_TOKEN`               | Так                | Bearer-токен для безпечного виклику`POST /capture` (для списання раніше заблокованих коштів при `hold`-оплатах).                                                                                        |
| `SHOPIFY_APP_SECRET`          | Так                | Client secret нашого кастомного додатку Shopify. Використовується для перевірки підпису сесійного токена (JWT HS256) від Checkout UI Extension.                                                       |
| `SHOPIFY_APP_CLIENT_ID`       | Так                | Client ID нашого кастомного додатку Shopify. Використовується для перевірки отримувача (claim`aud` у JWT).                                                                                                        |
| `TELEGRAM_BOT_TOKEN`          | Ні                  | Токен Telegram-бота для надсилання сповіщень про неоплачені замовлення.                                                                                                                                                     |
| `TELEGRAM_CHAT_ID`            | Ні                  | Ідентифікатор чату або групи в Telegram, куди надсилатимуться сповіщення.                                                                                                                                                  |

```bash
wrangler secret put MONO_TOKEN
```
```bash
wrangler secret put SHOPIFY_STORE_DOMAIN
```
```bash
wrangler secret put CAPTURE_TOKEN
```

### Доступ до Admin API: app `Bbox-Worker-Integration` + client credentials

> [!IMPORTANT]
> **Вічного `shpat_`-токена більше не існує.** З 1 січня 2026 Shopify прибрав створення custom apps в адмінці магазину (Settings → Develop apps) — нові апи створюються лише в [Dev Dashboard](https://dev.shopify.com/dashboard/), а Admin-токен для них отримується програмно через **client credentials grant** і живе **24 години**. Worker робить це сам: модуль `src/lib/shopify-admin-token.ts` запитує токен за `client_id`+`client_secret` і кешує його, оновлюючи із запасом. Тобі потрібно лише дати йому креденшали апа.

Щоб не плутатись — у проєкті **два апи** з різними ролями (плюс один CI-токен):

| Що                                                                                                  | Звідки                                                                        | Куди йде                                               | Для чого                                                         |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| «ИД клиента» / «Секрет» апа**Bbox-Worker-Integration**                    | Dev Dashboard → app → Настройки → Реквизиты для входа  | `SHOPIFY_ADMIN_CLIENT_ID` / `SHOPIFY_ADMIN_CLIENT_SECRET` | Admin API (читання замовлень, mark-paid, cancel)        |
| «ИД клиента» / «Секрет» апа**Bbox MonoBank Payments** (тека `app/`) | Dev Dashboard → app → Настройки                                          | `SHOPIFY_APP_CLIENT_ID` / `SHOPIFY_APP_SECRET`            | Верифікація session token від кнопки на Thank You |
| «Токен автоматизации» (`atkn_...`) будь-якого з апів              | Dev Dashboard → app → Настройки → Токен автоматизации | GitHub-секрет`SHOPIFY_APP_AUTOMATION_TOKEN`           | **Лише CI-деплой апа**. Це НЕ Admin-токен   |

Кроки для `Bbox-Worker-Integration` (він у тебе вже створений):

1. У конфігурації апа в Dev Dashboard задай **Admin API scopes**: `read_orders, write_orders` (розділ Access/доступи у налаштуваннях версії апа).
2. **Встанови app на магазин** (custom distribution → install link → інсталяція). Без інсталяції client credentials grant не видасть токен для магазину.
3. Скопіюй «ИД клиента» і «Секрет» зі сторінки апа та збережи як секрети Worker'а:

   ```bash
   wrangler secret put SHOPIFY_ADMIN_CLIENT_ID
   ```

   ```bash
   wrangler secret put SHOPIFY_ADMIN_CLIENT_SECRET
   ```
4. Перевірити руками, що креденшали робочі, можна одним curl-запитом (поверне `access_token` з `expires_in: 86399`):

   ```bash
   curl -X POST "https://<store>.myshopify.com/admin/oauth/access_token" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=client_credentials" \
     -d "client_id=<ИД клиента>" \
     -d "client_secret=<Секрет>"
   ```

---

## 🤖 Налаштування Telegram-бота для сповіщень

У нас є фоновий процес (запускається по `/cron`), який періодично перевіряє неоплачені замовлення та надсилає нагадування оператору в Telegram (оскільки сам бот не може написати клієнту першим).

### Як налаштувати бота:

1. **Створи бота через BotFather**:
   Знайди в Telegram [@BotFather](https://t.me/BotFather), відправ йому команду `/newbot` та дотримуйся інструкцій. Після створення ти отримаєш токен (наприклад, `123456789:AAH...`). Це твій `TELEGRAM_BOT_TOKEN`.
2. **Отримай `chat_id`**:

   - **Для особистого чату**: почни діалог з ботом (обов'язково натисни `/start`), надішли будь-яке повідомлення. Потім перейди за посиланням `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates` у браузері та знайди `"chat":{"id": ...}`.
   - **Для групи**: якщо ти хочеш додати бота в робочу групу (наприклад, туди, де вже працює бот KeyCRM), додай його туди як учасника та надішли в групу повідомлення-команду (наприклад, `/get_id` або `/test`), або просто тегни бота у повідомленні. Це необхідно, оскільки через стандартний режим приватності (Privacy Mode) боти в групах ігнорують звичайний текст і не відображають його в `getUpdates`. Запит поверне від'ємне число — це і є `chat_id` групи.
   - **Якщо виникає конфлікт webhook**: якщо бот уже підключено до іншого сервісу і `getUpdates` повертає помилку `409 Conflict`, просто надішли будь-яке повідомлення з потрібного чату боту [@getmyid_bot](https://t.me/getmyid_bot) — він миттєво покаже `chat_id`.
3. **Збережи секрети**:
   Для продакшену виконай:

   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   ```

   ```bash
   wrangler secret put TELEGRAM_CHAT_ID
   ```

   Якщо їх не налаштувати, сервіс не впаде — просто повідомлення виводитимуться в логи консолі (див. код у `src/index.ts` → `buildNotifier`).

---

## 🧪 Ручне тестування маршрутів (API endpoints)

Усі перевірки нижче зібрані в один скрипт [`test.sh`](test.sh) — він сам читає значення з `.dev.vars` (запусти `npm run dev` в іншому терміналі перед цим):

```bash
./test.sh                                        # проти http://localhost:8787
WORKER_URL=https://<...>.workers.dev ./test.sh   # проти задеплоєного Worker'а
ORDER_ID=gid://shopify/Order/123 ./test.sh       # з реальним замовленням для /capture
SESSION_TOKEN=<jwt> ./test.sh                    # якщо є справжній session token для /create-invoice
```

Без `SESSION_TOKEN` перевірка `/create-invoice` очікує 401 (fail-closed) — це нормально, справжній токен видає лише Checkout UI Extension.

Нижче — ті самі перевірки вручну, `curl`-ами по одній:

- **Healthcheck (перевірка працездатності):**

  ```bash
  curl http://localhost:8787/health
  ```
- **Створення рахунку (вимагає сесійний токен Shopify):**

  ```bash
  curl -X POST http://localhost:8787/create-invoice \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <session token>" \
    -d '{"orderId":"gid://shopify/Order/1"}'
  ```

  *(Без валідного JWT-токена сервер відповість кодом 401)*
- **Підтвердження списання коштів (hold-capture):**

  ```bash
  curl -X POST http://localhost:8787/capture \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $CAPTURE_TOKEN" \
    -d '{"orderId":"gid://shopify/Order/1"}'
  ```
- **Ручний запуск cron-завдання в локальному середовищі:**

  ```bash
  curl http://localhost:8787/cdn-cgi/handler/scheduled
  ```

> [!NOTE]
> Справжній сесійний токен можна отримати тільки всередині Checkout UI Extension, який викликає `shopify.sessionToken.get()`. Вебхук від monobank (`/mono-webhook`) вимагає валідного підпису в заголовку `X-Sign`, тому його простіше тестувати за допомогою автоматичних тестів у [test/webhook-route.test.ts](test/webhook-route.test.ts), які генерують правильні підписи.

---

## 💳 Спосіб оплати вручну «monobank» у Shopify

Щоб покупець міг обрати оплату через mono на чекауті, додай новий ручний спосіб оплати (твій наявний «Накладений платіж» лишається без змін):

1. Перейди в **Settings → Payments** → секція **«Способи оплати вручну»** (Manual payment methods) → **«Спосіб оплати вручну»** → **Create custom payment method**.
2. **Назва методу обов'язково має містити слово `monobank`** (наприклад, «Оплата карткою (monobank)») — саме за цим словом Worker відрізняє mono-замовлення від накладеного платежу. Без нього кнопка оплати не з'явиться.
3. У полі **Additional details** (видно на чекауті під назвою методу) напиши покупцю, чого очікувати, наприклад: *«Після оформлення замовлення на наступній сторінці з'явиться кнопка оплати — картка, Apple Pay або Google Pay»*.
4. Збережи. Тепер на чекауті буде два способи: «Накладений платіж» і «Оплата карткою (monobank)» — покупець обирає сам.

---

## 🛠️ Налаштування Shopify App та Checkout UI Extension (Path A)

Кастомний додаток Shopify знаходиться в папці `app/` і містить розширення `mono-pay-button` (цільова точка рендерингу — `purchase.thank-you.block.render`). Воно виводить кнопку оплати на сторінці успішного оформлення замовлення.

### Інструкція з першого запуску:

1. **Створити custom app**: [Partner Dashboard](https://partners.shopify.com) → Apps → Create app → Create app manually **`Bbox MonoBank Payments.`**
2. **Встанови залежності додатку та зв'яжи його з Shopify Partner Account:**
   Далі в папці `app/`:

   ```bash
   cd app && npm install
   npm run link
   ```

   Під час виконання `npm run link` утиліта автоматично створить або вибере додаток у кабінеті партнера та запише `client_id` у файл `app/shopify.app.toml`. Не забудь закомітити цей файл.
3. **Передай ідентифікатори додатку у секрети Worker'а:**
   Отримай Client ID та Client Secret додатку з Partner Dashboard та збережи їх у Worker'і:

   ```bash
   wrangler secret put SHOPIFY_APP_CLIENT_ID
   ```

   ```bash
   wrangler secret put SHOPIFY_APP_SECRET
   ```
4. **Локальне тестування інтерфейсу:**
   Запусти локальний сервер додатку:

   ```bash
   npm run dev
   ```

   Shopify надасть тимчасовий тунель. Зроби тестове замовлення в розробницькому магазині та перевір, чи з'явилася кнопка оплати.
5. **Реліз додатку (deploy):**

   ```bash
   npm run deploy
   ```

   Після деплою перейди в налаштування оформлення замовлення у Shopify (Settings → Checkout → Customize), знайди блок розширення «Оплата monobank», перетягни його на сторінку Thank You та в налаштуваннях вкажи URL нашого Cloudflare Worker.

   > [!TIP]
   > **Де взяти цей URL:**
   > - **Для локального тестування (розробка):** вкажи локальну адресу `http://localhost:8787` (твій браузер під час тестів зможе робити запити безпосередньо на твій локальний Worker, запущений через `npm run dev` у корені).
   > - **Для продакшену (після деплою в хмару):** вкажи адресу задеплоєного Worker'а, яку ти отримав наприкінці виконання команди `npx wrangler deploy` (Крок 4 розділу «Перший деплой Cloudflare Worker»), наприклад: `https://bbox-mono-payments.<subdomain>.workers.dev`. Також цю адресу завжди можна підглянути в кабінеті Cloudflare Dashboard (розділ Workers & Pages → `bbox-mono-payments`).

### Автоматичний деплой додатку з GitHub Actions

Коли ти робиш коміт у гілку `main`, зміни в папці `app/` автоматично деплояться на Shopify через воркфлоу [deploy-app.yml](.github/workflows/deploy-app.yml).
Для цього ми налаштували секрет `SHOPIFY_APP_AUTOMATION_TOKEN` у репозиторії GitHub:

1. Переконайся, що `app/shopify.app.toml` із правильним `client_id` закомічений у Git.
2. Скопіюй **App Automation Token** (Токен автоматизации приложения) у кабінеті розробника: твій додаток у Dev Dashboard (в нашому випадку це `Bbox MonoBank Payments`) → розділ **Settings** (Настройки) в лівому меню → прокрути в самий низ до секції **App automation token**. Тобі потрібен токен, який починається на `atkn_` (наприклад, `atkn_e1b...`, він зазвичай має обмежений термін дії, що є абсолютно нормальним для токенів автоматизації).
3. Збережи його у секретах репозиторію GitHub під назвою `SHOPIFY_APP_AUTOMATION_TOKEN`:
   ```bash
   gh secret set SHOPIFY_APP_AUTOMATION_TOKEN --body "<токен>"
   ```
---

## 🚀 Перший деплой Cloudflare Worker (з нуля)

Щоб усе запрацювало в хмарі Cloudflare, важливо виконати кроки саме в такому порядку (база даних → секрети → код).

### Крок 0. Підготовка

- Переконайся, що у тебе є акаунт Cloudflare (безкоштовного ліміту нам вистачить з головою).
- Авторизуйся у Wrangler локально:
  ```bash
  npx wrangler login
  ```
- Перевір статус авторизації:
  ```bash
  npx wrangler whoami
  ```

### Крок 1. Створення бази даних D1

У нашому `wrangler.toml` поле `database_id` спочатку містить плейсхолдер `00000000-...`. Нам потрібно створити реальну базу даних у твоєму акаунті:

```bash
npx wrangler d1 create bbox-payments
```

Команда поверне конфігурацію бази та її унікальний `database_id` (UUID). **Скопіюй його, заміни плейсхолдер у `wrangler.toml` та закоміть зміни.**

### Крок 2. Накочування міграцій бази даних на хмару

Створи таблиці `invoices` та `webhook_log` на продовій базі Cloudflare D1:

```bash
npx wrangler d1 migrations apply bbox-payments --remote
```

### Крок 3. Налаштування секретів у Cloudflare

Запиши всі необхідні секрети в хмару (команда запитає значення інтерактивно, тому вони не збережуться в історії термінала):

```bash
npx wrangler secret put MONO_TOKEN
npx wrangler secret put SHOPIFY_ADMIN_CLIENT_ID
npx wrangler secret put SHOPIFY_ADMIN_CLIENT_SECRET
npx wrangler secret put SHOPIFY_STORE_DOMAIN
npx wrangler secret put CAPTURE_TOKEN
npx wrangler secret put SHOPIFY_APP_CLIENT_ID
npx wrangler secret put SHOPIFY_APP_SECRET

# Опційні Telegram-секрети
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### Крок 4. Деплой коду

Тепер запускаємо деплой самого коду Worker'а:

```bash
npx wrangler deploy
```

Наприкінці команда виведе публічний URL сервісу (наприклад, `https://bbox-mono-payments.<subdomain>.workers.dev`). Збережи його — це `worker_url`, який ти вкажеш у налаштуваннях Checkout UI розширення.

### Крок 5. (Опційно) Власний домен замість `*.workers.dev`

Якщо потрібна «брендована» адреса (наприклад, для акуратного вебхук-URL у кабінеті monobank) — і домен уже додано в цей самий Cloudflare-акаунт як zone, достатньо секції `[[routes]]` у [wrangler.toml](wrangler.toml):

```toml
[[routes]]
pattern = "pay.bbox.kiev.ua"
custom_domain = true
```

`custom_domain = true` означає, що `wrangler deploy` сам створить потрібний DNS-запис у зоні — нічого руками в Cloudflare Dashboard додавати не треба. Для проду `bbox-mono-payments` це вже налаштовано: Worker обслуговує запити на **`https://pay.bbox.kiev.ua`**.

Важливо: щойно з'являється явний `route`, wrangler за замовчуванням **вимикає** `workers_dev`/`preview_urls` для цього деплою (навіть без явного запису в `wrangler.toml`) — стара адреса `*.workers.dev` перестає відповідати. Після переходу на власний домен онови:

- `worker_url` у налаштуваннях Checkout UI розширення (Shopify admin → Checkout → редактор → блок «Оплата monobank»),
- webhook URL у кабінеті monobank (`.../mono-webhook`), якщо він уже був там прописаний на старий `workers.dev`-домен.

---

## 🔄 Наступні оновлення та CI/CD

Після першого ручного деплою тобі більше не потрібно деплоїти Worker локально. Кожен пуш у гілку `main`, який торкається папок `src/`, `migrations/` чи конфігу `wrangler.toml`, активує воркфлоу [deploy-worker.yml](file:///Users/jbo/src/grengojbo/shopify-mono/.github/workflows/deploy-worker.yml).

Воркфлоу автоматично:

1. Запускає тести (`npm test`).
2. Накочує нові міграції бази даних на хмару (`wrangler d1 migrations apply --remote`).
3. Робить деплой нової версії коду.

Для роботи CI/CD ми налаштували секрет `CLOUDFLARE_API_TOKEN` у нашому GitHub-репозиторії. Токен створено в Cloudflare Dashboard (My Profile → API Tokens → Create Token за шаблоном **Edit Cloudflare Workers** з правами на Workers Scripts та D1).
