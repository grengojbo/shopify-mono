# shopify-mono
Інтеграція Shopify з MonoBank

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
