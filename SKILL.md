---
name: askgrokwallet
description: >
  A governed wallet for Grok agents (and any AI agent). Enforce budgets,
  allowlists, operator modes, and human approval before money or
  consequential actions move. Use when an agent wants to pay, trade, refund,
  or execute and a human-defined policy must decide allow / ask / deny.
version: 0.1.0
homepage: https://github.com/richard7463/askgrokwallet
metadata:
  emoji: 🔐
  category: governance
  tagline: "agents run. humans rule. proof settles."
requires:
  bins: ["curl"]
---

# AskGrokWallet — a governed wallet for Grok agents

Agents can think, trade, and pay. AskGrokWallet decides what they are allowed
to do — inside human-defined rules, with a verifiable receipt for every
outcome.

```text
agent request -> policy (allow / ask / deny) -> execute or approve -> proof
```

## When to use

- An agent wants to pay, refund, trade, or move funds
- An agent wants to delete, send, or change something consequential
- The caller has a budget, allowlist, or approval policy
- The team needs an auditable record of every agent action

## Setup

1. Define a policy in plain English:

   ```text
   payments under $50 run automatically; over $50 ask me;
   never pay blacklisted merchants; daily budget $200
   ```

2. The policy engine compiles this to structured rules:
   - `autoBelowUsd`, `askAboveUsd`, `dailyBudgetUsd`, `denyKeywords`,
     `allowKeywords`, plus trading stops `maxDrawdownUsd` and
     `maxDailyLossUsd`
3. Every request is evaluated: `allow` / `ask` / `deny`.

Trading-desk example (see `examples/policy-trading.txt`):

```text
small trades under $10 run automatically; over $10 ask me;
never trade pump-dump tokens or honeypots;
max drawdown $50; daily loss limit $20
```

Once drawdown or the daily loss limit is hit, **nothing auto-runs** — the
operator decides, and every outcome still receipts.

## Hosted API base URL

The public demo host is **https://askgrokwallet.io**. If you run your own
AskGrokWallet API, set `ASKWALLET_BASE_URL` (e.g. `http://localhost:3000`)
and use it in place of the host below. The `/api/approvals` write endpoints
need a bearer token when the host has one configured — the keyless `demo`
rows are the only exception (`"source":"demo"`).

## Flow

1. **Evaluate**: submit `{ amountUsd, target, summary, policyText? }` to the
   policy engine.
2. **Ask**: if the verdict is `ask`, create an approval request:

   ```text
   POST /api/approvals
   { summary, amountUsd, requester, target, policyText }
   ```

3. **Decide**: the operator approves or denies from the Approval Inbox
   (`/approvals`) or any connected channel.

   ```text
   POST /api/approvals/{id}
   { decision: "approve" | "deny", by: "operator" }
   ```

4. **Prove**: approved and blocked outcomes both produce a receipt (who, what,
   how much, verdict, decision, timestamps).

## Quickstart (curl, copy-paste)

Evaluate a trading policy and create an approval the operator can decide:

```bash
curl -s https://askgrokwallet.io/api/approvals \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "demo",
    "requester": "trader-bot",
    "summary": "swap 25 USDC for ETH on Uniswap",
    "amountUsd": 25,
    "target": "uniswap",
    "policyText": "small trades under $10 run automatically; over $10 ask me; max drawdown $50; daily loss limit $20",
    "drawdownUsd": 8,
    "lossTodayUsd": 3
  }'
```

An `ask` verdict returns the created approval with an `id`; approve it from
the operator side (demo rows are keyless):

```bash
curl -s https://askgrokwallet.io/api/approvals/REPLACE_WITH_ID \
  -X POST -H 'Content-Type: application/json' \
  -d '{ "decision": "approve", "by": "operator" }'
```

To see the stop fire, resubmit the first curl with `"drawdownUsd": 60` — the
verdict flips to `ask` with reason "auto-trading paused", even though $25 is
over the ask threshold anyway; use `"amountUsd": 5` to prove a **small** trade
is also paused once the stop is breached.

## Rules

- Never invent policy, budgets, or allowlists — ask the operator.
- Never execute a blocked action. A blocked action returns a reason.
- Default posture is `ask` when no rule matches.
- Keep secrets out of requests; approvals never carry credentials.

## Reference endpoints

| Purpose | Method + URL |
| --- | --- |
| Compile + evaluate policy | `POST https://askgrokwallet.io/api/approvals` (with `policyText`) |
| Create approval request | `POST https://askgrokwallet.io/api/approvals` |
| List approvals | `GET https://askgrokwallet.io/api/approvals?status=pending` |
| Decide approval | `POST https://askgrokwallet.io/api/approvals/{id}` |
| Approval inbox | `GET https://askgrokwallet.io/approvals` (UI) |
