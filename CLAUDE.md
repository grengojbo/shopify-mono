# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Cloudflare Worker** that lets the Shopify store **Bbox** (non-Plus, Shopify Payments unavailable in Ukraine) accept online payments via **monobank acquiring (plata by mono)**, with automatic fiscalization through **Вчасно.Каса** and reminders for unpaid orders. Full requirements live in [PRD.md](PRD.md) — read it before making architectural decisions; this file is a working-agreement summary, not a replacement.

The project is greenfield: no `src/` yet. Follow PRD.md §16 ("Етапи для Claude Code") for build order — shared core first (Hono skeleton → mono client → `/create-invoice` → `/mono-webhook` → `/capture` → `/cron`), Shopify UI Extension after, Path B last.

## Language

`CLAUDE.md` and `PRD.md` are the only English-first documents. Everything else produced in this repo — chat responses, commit messages, PR titles/bodies, code comments — must be in **Ukrainian**.

## Core Principles

- **Simplicity first** — make each change as small as possible; touch only what is necessary.
- **No laziness** — find root causes, not temporary patches. Hold to senior-developer standards.
- **Minimal impact** — keep diffs focused and avoid introducing regressions.
- **Free tier only** — no Cloudflare Queues, no paid add-ons. Retries go through Cron + D1, not a queue.

## Tech stack

- **Runtime:** Cloudflare Workers (`nodejs_compat`), **Hono** framework.
- **State:** Cloudflare **D1** (SQLite) — not KV; hold-flow invoice lookups must stay strongly consistent over multi-day windows.
- **Schedule:** Cloudflare **Cron Triggers** for reminders and unpaid-order cleanup.
- **Crypto:** Web Crypto API (`crypto.subtle`) only — no Node crypto deps. ECDSA (P-256/SHA-256) webhook validation.
- **Secrets:** `wrangler secret put` — never in code or `wrangler.toml`.
- **Fiscalization:** mono-native integration with Вчасно.Каса — zero fiscalization code in the Worker unless PRD.md §8's open question resolves to "authorization issues the receipt," in which case a direct Вчасно API fallback is needed for `hold` capture.

## Architecture

**Two Shopify-layer paths, one shared core** (PRD.md §2). The core — Worker routes, mono client, D1 schema, fiscalization, cron — never changes between paths; only how payment confirmation reaches Shopify differs.

| | Path A (launch first) | Path B (after Payments Partner approval) |
|---|---|---|
| Customer flow | Thank You page → manual "Сплатити" button → redirect to mono | Picks mono in checkout → Shopify auto-redirects |
| Confirms payment via | Admin API (`orderMarkAsPaid` / transaction) | Payments Apps API (resolve/reject payment session) |
| Ghost unpaid orders | Yes — needs cleanup | No |

Do not attempt to auto-redirect from the Thank You page on Path A — Checkout UI Extensions cannot do this; a visible button the customer clicks is the ceiling.

**Routes** (PRD.md §4): `/create-invoice` (A), `/payment-session` (B), `/mono-webhook` (A+B), `/capture` (A+B), `/cron`, `/health`.

**debit vs hold** (PRD.md §7): line items tagged `made-to-order` force `hold` (capture on readiness); everything else is `debit` (charged immediately). Never issue a fiscal receipt on hold *authorization* — only on capture/debit-success.

**ECDSA webhook validation is the highest-risk implementation detail** (PRD.md §6): mono signs with DER-encoded ECDSA, but `crypto.subtle.verify` expects raw r‖s (IEEE P1363). A DER→P1363 converter is mandatory before verification, and it must run against the **raw request body bytes**, not re-serialized JSON. Write a unit test against a real sample webhook before wiring this into the route.

**D1 schema** — see PRD.md §9 for the reference `invoices` / `webhook_log` tables. `webhook_log` exists specifically for idempotency (mono may deliver the same status more than once) and audit.

## Conventions

- Amounts are **integers in kopecks**, always `ccy=980` (UAH only) — no float money math.
- Compute invoice amounts **server-side from the Shopify order** (Admin API); never trust a client-supplied amount.
- Every mono webhook handler must be idempotent against `invoice_id + status`, checked via `webhook_log`/current D1 status before acting.
- Any new secret goes through `wrangler secret put` and gets documented in PRD.md §14 — never inline it in a commit.
- When PRD.md's open questions (§15) get resolved during implementation (mono support confirms hold-receipt timing, exact `basketOrder.sum` semantics, etc.), update PRD.md itself, not just code comments.

## Documentation & tooling

- **monobank acquiring docs** (`api.monobank.ua/docs/acquiring.html`) are versioned upstream — re-check field names/semantics against the live docs during implementation rather than trusting PRD.md's snapshot.
- **context7** — fetch current Hono / Cloudflare Workers / D1 API docs instead of relying on training data.
- **Shopify MCP connector / `shopify-plugin:*` skills** — use for Admin API calls (order tagging, `orderMarkAsPaid`, transactions) and for the Checkout UI Extension (Path A) / Offsite Payment Extension (Path B) scaffolding.

## Git & PR rules

**Commits**

- Never create commits automatically — commit only when the user explicitly asks.
- Never push, force-push, or run destructive git commands without explicit approval.
- Show `git diff` / `git status` and let the user review before committing.
- Write clear messages in Ukrainian: imperative mood, explaining *why*, not just *what*.

**Branching**

- Never commit directly to `main`.
- Use short-lived, focused branches: `feature-<slug>`, `fix-<slug>`, `chore-<slug>`.

**Pull requests**

- Create PRs with `gh pr create`, focused on *what* changed and *why*, in Ukrainian.
- Do not mention AI tools in the title/body, and do not add AI co-author or generated-by trailers to commits.
- Do not include change statistics or test-plan checklists.
