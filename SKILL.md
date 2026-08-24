---
name: agent-gate
description: >
  Governed spending and actions for AI agents. Enforce budgets, allowlists,
  operator modes, and human approval before money or consequential actions
  move. Use when an agent wants to pay, trade, refund, or execute and a
  human-defined policy must decide allow / ask / deny.
version: 0.1.0
homepage: https://github.com/richard7463/agent-gate
metadata:
  emoji: 🔐
  category: governance
  tagline: "agents run. humans rule. proof settles."
requires:
  bins: ["curl"]
---

# AgentGate — governed actions for AI agents

Agents can think, trade, and pay. AgentGate decides what they are allowed to
do — inside human-defined rules, with a verifiable receipt for every outcome.

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
   - `autoBelowUsd`, `askAboveUsd`, `dailyBudgetUsd`, `denyKeywords`, `allowKeywords`
3. Every request is evaluated: `allow` / `ask` / `deny`.

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

## Rules

- Never invent policy, budgets, or allowlists — ask the operator.
- Never execute a blocked action. A blocked action returns a reason.
- Default posture is `ask` when no rule matches.
- Keep secrets out of requests; approvals never carry credentials.

## Reference endpoints

| Purpose | Method + URL |
| --- | --- |
| Compile + evaluate policy | `POST /api/approvals` (with `policyText`) |
| Create approval request | `POST /api/approvals` |
| List approvals | `GET /api/approvals?status=pending` |
| Decide approval | `POST /api/approvals/{id}` |
| Approval inbox | `GET /approvals` (UI) |
