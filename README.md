# AgentGate — governed actions for AI agents

Agents can think, trade, and pay. AgentGate decides what they are allowed to
do — inside human-defined rules, with a verifiable receipt for every outcome.

```text
agent request -> policy (allow / ask / deny) -> execute or approve -> proof
```

This repository is the **plugin package** for AgentGate (project codename:
`grokbotwallet`). The app itself (policy engine, approval inbox, vault
contracts) lives in the project repo; this package is what agents install.

## Install

```bash
# From GitHub (recommended — pinned SHA)
grok plugin install richard7463/agent-gate --trust

# Or from a local path during development
grok plugin install ./integrations/grokbotwallet --trust
```

After install, the `agent-gate` skill appears in `/skills`. Enable it for a
Bot via Settings → Plugins where needed.

## What the skill does

1. Compiles plain-English policy ("payments under $50 run automatically; over
   $50 ask me; never pay blacklisted merchants; daily budget $200").
2. Evaluates every request: `allow` / `ask` / `deny`.
3. `ask` requests land in the AgentGate approval inbox; the operator
   approves or denies from any device.
4. Approved and blocked outcomes both produce a receipt.

## Files

| Path | Purpose |
| --- | --- |
| `SKILL.md` | The skill (canonical, mirrors the app's skill). |
| `.grok-plugin/plugin.json` | Plugin manifest. |
| `examples/approval-request.json` | Sample approval request payload. |
| `examples/policy-example.txt` | Sample plain-English policy. |
| `scripts/smoke.mjs` | Local structure validation. |

## Security

- The plugin never asks for private keys, passwords, or credentials.
- Policy, budgets, and allowlists are operator-defined; the skill never
  invents them.
- Blocked actions return a reason and are never executed.
- Receipts record who, what, how much, verdict, decision, and timestamps.

## Submit

AgentGate is listed for both major marketplaces:

- **xAI Grok Build marketplace** (via pinned-SHA catalog PR)
- **Cursor Marketplace** (= Grok Bot app-in-marketplace; publish form:
  https://cursor.com/marketplace/publish)

Both use this open-source repo; the plugin never asks for credentials or
private keys.

## License

MIT.
