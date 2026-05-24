# Allowance Tracker

**Live app: https://hateworth.github.io/allowance-tracker/**

A mobile-first, single-page allowance tracker for families. Parents log earnings and spending for one or more kids, manage payday and savings goals, and approve transactions the kids submit themselves. Optional cloud sync via Supabase keeps multiple phones in step using a short family code — no accounts, no email, no install.

## Features

- **Multi-kid** — each kid has their own balance, weekly amount, payday, savings goal, and PIN
- **Two roles** — parent (full admin) and child (submit-for-approval flow)
- **PIN-only auth** — 4-digit parent PIN, optional per-kid PIN, account lock
- **Quick logging** — earned / spent with categories, notes, and back-dating (parent)
- **Approval queue** — kids submit, parent approves or rejects, bulk actions when there's a backlog
- **Weekly payday** — one-tap payout that respects each kid's weekly amount and day
- **Savings goal** — per-kid goal with progress meter and ETA
- **Chore calculator** — quick math, log result as earned in one tap
- **Insights** — week / month / year view: totals, bar chart, running balance, top categories, all-time stats
- **Activity log** — audit trail of every mutation across the family
- **Cloud sync (optional)** — share a family code between phones; data round-trips through Supabase
- **Export / import** — JSON, full-family or per-kid

## How sync works

Cloud writes happen **only when you submit something** (add a transaction, edit a kid, approve, payday, etc.). When the app opens, it does a one-time pull from Supabase to load the latest state for your family code. There is no realtime subscription and no polling — to see changes another phone made, reopen the app.

If you skip sync at setup, the app runs fully local against `localStorage` and never makes network calls.

## Tech

- Vanilla HTML / CSS / JS — no build step, no framework
- [Supabase JS](https://github.com/supabase/supabase-js) loaded from CDN for optional cloud sync
- Hosted on GitHub Pages from `main`

## Local development

```bash
# any static server works
python -m http.server 8000
# then open http://localhost:8000
```

State lives in `localStorage` under the `allowance-tracker.v1` key. To wipe, clear site data in devtools.

## File layout

```
index.html   markup + Supabase config
app.js       all app logic (state, render, mutations, sync, auth)
style.css    styles
ref/         design reference images
```
