# shopify-mono
Інтеграція Shopify з MonoBank

## Локальний запуск для тестування

```bash
npm install
npx wrangler d1 migrations apply bbox-payments --local   # застосувати схему D1 локально
npm test                                                  # юніт-тести (моки, секрети не потрібні)
npm run dev                                               # wrangler dev на localhost:8787
```

`wrangler dev` читає локальні секрети з файлу `.dev.vars` у корені репозиторію (стандартний механізм wrangler; **не** плутати з `wrangler secret put`, який пише в Cloudflare — `.dev.vars` лишається лише на диску й ігнорується git). Створіть `.dev.vars`:

```bash
MONO_TOKEN=<тестовий токен з https://api.monobank.ua/>
SHOPIFY_ADMIN_TOKEN=<Admin API токен dev-магазину>
SHOPIFY_STORE_DOMAIN=<your-dev-store>.myshopify.com
CAPTURE_TOKEN=<будь-який довгий випадковий рядок>
SHOPIFY_APP_SECRET=<client secret custom app, після кроку нижче>
SHOPIFY_APP_CLIENT_ID=<client id custom app, після кроку нижче>

# опційно — без них нагадування лише логуються в консоль (див. src/index.ts)
TELEGRAM_BOT_TOKEN=<токен бота від @BotFather>
TELEGRAM_CHAT_ID=<chat id оператора>
```

### Змінні середовища (усі — секрети Worker'а)

| Змінна | Обов'язкова | Призначення |
|---|---|---|
| `MONO_TOKEN` | так | `X-Token` для monobank acquiring API — тестовий токен з `api.monobank.ua`, бойовий з `web.monobank.ua` |
| `SHOPIFY_ADMIN_TOKEN` | так | Admin API токен для читання замовлень (`/create-invoice`) і мутацій (`orderMarkAsPaid`, `orderCancel`) |
| `SHOPIFY_STORE_DOMAIN` | так | `<store>.myshopify.com`, звіряється з claim `dest` session token |
| `CAPTURE_TOKEN` | так | Bearer-токен для `POST /capture` (списує заблоковані hold-кошти — маршрут захищений) |
| `SHOPIFY_APP_SECRET` | так | Client secret custom app — верифікація session token (JWT HS256) від Checkout UI Extension у `/create-invoice` |
| `SHOPIFY_APP_CLIENT_ID` | так | Client ID того ж custom app — звіряється з claim `aud` |
| `TELEGRAM_BOT_TOKEN` | ні | Нагадування оператору про неоплачені замовлення (`/cron`); без нього — лише лог у консоль |
| `TELEGRAM_CHAT_ID` | ні | Chat id оператора для тих самих нагадувань |

У продакшені кожна змінна встановлюється через `wrangler secret put <NAME>` — ніколи не в `wrangler.toml` і не в код (security-правило репозиторію).

### Налаштування Telegram-бота для нагадувань

`/cron` шле нагадування про неоплачені замовлення оператору в Telegram (MVP-канал — сам бот не може написати покупцю першим, PRD §11).

**Чи можна слати через уже наявний бот KeyCRM?** Технічно — так: бот для KeyCRM створюється вами самими через BotFather, і його токен зберігається у вас (див. документацію KeyCRM: [створення бота](https://help.keycrm.app/uk/communication-channels/creation-of-telegram-bot), [підключення до KeyCRM](https://help.keycrm.app/uk/communication-channels/connecting-a-telegram-bot)). Worker робить лише вихідний `sendMessage`, який не конфліктує з тим, що KeyCRM забрала собі вхідний потік бота (webhook). Але є два підводні камені:

- `getUpdates` для такого бота поверне `409 Conflict` (webhook KeyCRM активний) — `chat_id` доведеться дізнаватись через сторонній бот на кшталт [@getmyid_bot](https://t.me/getmyid_bot);
- особистий чат оператора з ботом KeyCRM з'явиться в самій KeyCRM як «клієнтський чат» — нагадування Worker'а змішаються з листуванням клієнтів у стрічці CRM.

Тому **рекомендований шлях — окремий власний бот** (безкоштовно, кілька хвилин), доданий **у ту саму Telegram-групу**, де вже шле повідомлення бот KeyCRM: оператор бачить обидва потоки в одному місці, а стрічка KeyCRM лишається чистою.

1. **Створити бота**: у Telegram написати [@BotFather](https://t.me/BotFather) → `/newbot` → задати ім'я та унікальний `@username` (має закінчуватись на `bot`). BotFather поверне токен виду `123456789:AAH...` — це і є `TELEGRAM_BOT_TOKEN`.
2. **Отримати `chat_id`**:
   - **Особистий чат з оператором**: написати боту будь-яке повідомлення (спершу треба самому написати першим — бот не може почати діалог), потім відкрити `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates` у браузері й знайти `"chat":{"id": ...}` у відповіді.
   - **Групa (щоб бачити поруч з KeyCRM)**: додати бота учасником у ту саму групу, де вже є бот KeyCRM → написати в групі будь-яке повідомлення → той самий `getUpdates`-запит поверне `chat_id` групи (від'ємне число для груп).
   - Якщо `getUpdates` повертає `409 Conflict` (бот уже зайнятий webhook-ом іншого сервісу, напр. KeyCRM) — перешліть будь-яке повідомлення з потрібного чату боту [@getmyid_bot](https://t.me/getmyid_bot) або додайте його в групу: він покаже `chat_id`.
3. Записати обидва значення в секрети:
   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put TELEGRAM_CHAT_ID
   ```
   Без них `/cron` не падає — нагадування просто логуються в консоль Worker'а (`src/index.ts` → `buildNotifier`).
4. Перевірити вручну: `curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d "chat_id=$TELEGRAM_CHAT_ID&text=тест"` — має прийти повідомлення в чат/групу.

### Ручне тестування маршрутів

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/create-invoice \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session token>" \
  -d '{"orderId":"gid://shopify/Order/1"}'
# без валідного session token — очікувано 401 (fail-closed)

curl -X POST http://localhost:8787/capture \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CAPTURE_TOKEN" \
  -d '{"orderId":"gid://shopify/Order/1"}'

curl http://localhost:8787/cdn-cgi/handler/scheduled   # ручний тригер /cron у dev
```

Живий `session token` для `/create-invoice` можна отримати лише з реального Checkout UI Extension (`shopify.sessionToken.get()`) — див. розділ нижче про `app/`. Для `/mono-webhook` потрібен справжній підпис mono (`X-Sign`), тому маршрут перевіряється насамперед юніт-тестами (`test/webhook-route.test.ts`) з крипто-валідними згенерованими фікстурами, а не ручним curl.

## Налаштування CI: секрет `CLOUDFLARE_API_TOKEN`

`ci.yml` виконує `wrangler deploy --dry-run` для перевірки конфігурації Worker'а — цьому кроку потрібен токен Cloudflare API у секретах репозиторію.

1. Створити токен у Cloudflare Dashboard → **My Profile → API Tokens → Create Token** за шаблоном **Edit Cloudflare Workers** (він включає права на Workers Scripts та D1, потрібні для `wrangler deploy --dry-run`). Обмежити токен конкретним акаунтом.
2. Додати токен як секрет репозиторію:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --body "<токен>"
   ```
   або вручну: GitHub → **Settings → Secrets and variables → Actions → New repository secret** з назвою `CLOUDFLARE_API_TOKEN`.
3. Токен ніколи не комітиться в код і не потрапляє у `wrangler.toml` — лише через секрети GitHub Actions (CI) та `wrangler secret put` (рантайм-секрети Worker'а).

## Checkout UI Extension: кнопка «Сплатити через monobank» (Path A)

Тека [`app/`](app/) — custom Shopify app з extension `mono-pay-button` (target `purchase.thank-you.block.render`). Extension отримує `orderId` з Order API, викликає `POST /create-invoice` Worker'а з session token (Bearer JWT) і рендерить кнопку-посилання на сторінку оплати mono. Тема магазину не змінюється.

Кроки активації (одноразово):

1. **Створити custom app**: [Partner Dashboard](https://partners.shopify.com) → Apps → Create app → Create app manually. Далі в теці `app/`:
   ```bash
   cd app && npm install
   npm run link        # shopify app config link — заповнить client_id у shopify.app.toml
   ```
2. **Секрети Worker'а** (Client ID та Client secret — з налаштувань апа в Partner Dashboard):
   ```bash
   wrangler secret put SHOPIFY_APP_CLIENT_ID
   wrangler secret put SHOPIFY_APP_SECRET
   ```
   Без них `/create-invoice` відповідає 401 на всі запити (fail-closed).
3. **Жива перевірка**: `npm run dev` (у теці `app/`) → відкрити чекаут dev-магазину, оформити тестове замовлення, переконатися, що кнопка з'являється на Thank You і веде на mono.
4. **Деплой**: `npm run deploy` → встановити app на магазин → у **checkout-редакторі** (Settings → Checkout → Customize) додати блок «Оплата monobank» на сторінку Thank You і в налаштуваннях блока вказати `worker_url` (URL Worker'а).

### Автоматичний деплой апа з CI

Після одноразової активації вище подальші деплої extension'а автоматизовані: воркфлоу [`.github/workflows/deploy-app.yml`](.github/workflows/deploy-app.yml) запускає `shopify app deploy` на кожен push у `main` зі змінами в `app/**`. Інтерактивний логін не потрібен — CLI автентифікується токеном. Одноразове налаштування:

1. Переконатися, що `app/shopify.app.toml` із заповненим `client_id` (результат `npm run link`) **закомічений** — CI деплоїть саме цю конфігурацію.
2. Створити **App Automation Token**: [Dev Dashboard](https://dev.shopify.com/dashboard/) → ваш app → **Settings** → секція **App Automation Token** → згенерувати.
3. Додати його секретом репозиторію:
   ```bash
   gh secret set SHOPIFY_APP_AUTOMATION_TOKEN --body "<токен>"
   ```

Прапорець `--allow-updates` дозволяє оновлення компонентів; видалення extension'ів (`--allow-deletes`) свідомо не увімкнене — це роблять вручну. Кожна версія апа лінкується на коміт через `--source-control-url`.
