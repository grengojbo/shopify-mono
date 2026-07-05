#!/usr/bin/env bash
# Ручна перевірка ключових маршрутів (README.md → «Ручне тестування маршрутів»,
# «Доступ до Admin API»). Значення бере з .dev.vars — секрети в аргументи
# командного рядка не потрапляють.
#
# Використання:
#   ./test.sh                              # усі перевірки, WORKER_URL=http://localhost:8787
#   WORKER_URL=https://<...>.workers.dev ./test.sh
#   ORDER_ID=gid://shopify/Order/123 SESSION_TOKEN=<jwt> ./test.sh

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .dev.vars ]; then
  echo "Помилка: .dev.vars не знайдено в корені репозиторію." >&2
  echo "Створіть його за прикладом з README.md (розділ «Змінні середовища та секрети»)." >&2
  exit 1
fi

set -a
# .dev.vars — простий формат KEY=VALUE, валідний для source
# shellcheck disable=SC1091
source .dev.vars
set +a

WORKER_URL="${WORKER_URL:-http://localhost:8787}"
ORDER_ID="${ORDER_ID:-gid://shopify/Order/1}"

pass=0
fail=0

section() {
  echo
  echo "── $1 ──"
}

expect_status() {
  local label="$1" expected="$2" actual="$3" body="$4"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $label → $actual"
    pass=$((pass + 1))
  else
    echo "  ✗ $label → очікував $expected, отримав $actual"
    echo "    тіло: $body"
    fail=$((fail + 1))
  fi
}

section "Admin API: client credentials grant (SHOPIFY_ADMIN_CLIENT_ID/SECRET)"
if [ -z "${SHOPIFY_STORE_DOMAIN:-}" ] || [ -z "${SHOPIFY_ADMIN_CLIENT_ID:-}" ] || [ -z "${SHOPIFY_ADMIN_CLIENT_SECRET:-}" ]; then
  echo "  пропущено: у .dev.vars немає SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_CLIENT_ID / SHOPIFY_ADMIN_CLIENT_SECRET"
else
  admin_response=$(curl -sS -o /tmp/admin_token_response.json -w "%{http_code}" \
    -X POST "https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials" \
    -d "client_id=${SHOPIFY_ADMIN_CLIENT_ID}" \
    -d "client_secret=${SHOPIFY_ADMIN_CLIENT_SECRET}")
  admin_body=$(cat /tmp/admin_token_response.json)
  if [ "$admin_response" = "200" ] && echo "$admin_body" | grep -q '"access_token"'; then
    echo "  ✓ отримано access_token (expires_in: $(echo "$admin_body" | grep -o '"expires_in":[0-9]*'))"
    pass=$((pass + 1))
  else
    echo "  ✗ HTTP $admin_response — $admin_body"
    fail=$((fail + 1))
  fi
  rm -f /tmp/admin_token_response.json
fi

section "GET /health"
status=$(curl -sS -o /tmp/health_response.json -w "%{http_code}" "${WORKER_URL}/health")
expect_status "health" "200" "$status" "$(cat /tmp/health_response.json)"
rm -f /tmp/health_response.json

section "POST /create-invoice"
if [ -n "${SESSION_TOKEN:-}" ]; then
  status=$(curl -sS -o /tmp/create_invoice_response.json -w "%{http_code}" \
    -X POST "${WORKER_URL}/create-invoice" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${SESSION_TOKEN}" \
    -d "{\"orderId\":\"${ORDER_ID}\"}")
  expect_status "create-invoice (з session token)" "200" "$status" "$(cat /tmp/create_invoice_response.json)"
  rm -f /tmp/create_invoice_response.json
else
  echo "  пропущено: SESSION_TOKEN не задано (справжній видає лише Checkout UI Extension, shopify.sessionToken.get())"
  status=$(curl -sS -o /tmp/create_invoice_response.json -w "%{http_code}" \
    -X POST "${WORKER_URL}/create-invoice" \
    -H "Content-Type: application/json" \
    -d "{\"orderId\":\"${ORDER_ID}\"}")
  expect_status "create-invoice без токена (очікується fail-closed 401)" "401" "$status" "$(cat /tmp/create_invoice_response.json)"
  rm -f /tmp/create_invoice_response.json
fi

section "POST /capture"
if [ -z "${CAPTURE_TOKEN:-}" ]; then
  echo "  пропущено: CAPTURE_TOKEN не заданий у .dev.vars"
else
  status=$(curl -sS -o /tmp/capture_response.json -w "%{http_code}" \
    -X POST "${WORKER_URL}/capture" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${CAPTURE_TOKEN}" \
    -d "{\"orderId\":\"${ORDER_ID}\"}")
  body=$(cat /tmp/capture_response.json)
  echo "  → HTTP $status: $body"
  echo "  (200/202/404/409 — усе очікувані відповіді залежно від стану інвойсу в D1; 401 означає невірний CAPTURE_TOKEN)"
  rm -f /tmp/capture_response.json
fi

section "Ручний тригер /cron"
status=$(curl -sS -o /tmp/cron_response.json -w "%{http_code}" "${WORKER_URL}/cdn-cgi/handler/scheduled")
expect_status "scheduled" "200" "$status" "$(cat /tmp/cron_response.json)"
rm -f /tmp/cron_response.json

echo
echo "Підсумок: ${pass} пройдено, ${fail} не пройдено (не рахуючи пропущених)."
[ "$fail" -eq 0 ]
