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
