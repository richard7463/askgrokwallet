# Security Policy

AskGrokWallet is a governance layer: it sits **in front of money movement**.
Security is the product.

## Reporting a vulnerability

Do **not** open a public issue for security problems. Report privately:

- GitHub private vulnerability reporting — use the **"Report a vulnerability"**
  button on the [Security tab](https://github.com/richard7463/askgrokwallet/security)
  of this repository.

We acknowledge reports within **48 hours** and aim to ship a fix for
high-severity issues within **7 days**. There is no paid bounty program yet;
reporters who want credit are added to this file (or stay anonymous).

## Supported versions

Only the latest commit on `main` is supported. This is experimental
infrastructure (v0.1.0) — there are no release trains yet.

## Scope

In scope:

- `contracts/` — Solidity implementation of the ERC-8196 policy-bound wallet
  engine (`TrustLeaseController`, `BoundlessVault`,
  `VerificationScoreRegistry`) and its Hardhat tests
- Root plugin package — `SKILL.md`, `.grok-plugin/`, `.cursor-plugin/`
- `scripts/` and `examples/` — smoke tests and sample payloads

Out of scope (report to the respective projects):

- The chains, wallets, exchanges, and payment rails AskGrokWallet integrates with
- The hosted demo frontend and approval API at `https://askgrokwallet.io`
  (separate workspace; not part of this repository)

## Disclosure expectations

- Do not test exploits against mainnet funds. Use a local chain or testnet.
- Include a minimal reproduction (policy text, target, calldata, tx hash).
- Give us a fix window before public disclosure.
- If a report turns out to be a design question rather than a bug, we'll say so
  and point to the public discussion thread instead of silently closing it.
