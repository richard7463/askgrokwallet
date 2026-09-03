# Contributing to AskGrokWallet

Thanks for helping make governed agent spending real. This repository is the
open source home of AskGrokWallet: the marketplace plugin package plus the
onchain ERC-8196 engine.

## What we accept

- Bug reports with a minimal reproduction (policy text + expected vs actual verdict)
- Feedback from actually running the skill, calling the API, or reviewing the
  contracts — use the
  [Developer feedback](https://github.com/richard7463/askgrokwallet/issues/new?template=feedback.yml)
  template
- Feature proposals that stay in scope: the **rules / approval / receipt**
  layer — not another wallet rail
- Test vectors and spec-conformance cases for ERC-8196 (coordinate first in the
  [public discussion thread](https://ethereum-magicians.org/t/erc-8196-ai-agent-authenticated-wallet/27987))
- Documentation, examples, and marketplace packaging fixes

## Repository layout

- Root: plugin package — `SKILL.md` plus `.grok-plugin/` and `.cursor-plugin/`
  manifests
- `contracts/`: Hardhat project — ERC-8196 engine (`TrustLeaseController`,
  `BoundlessVault`, `VerificationScoreRegistry`), EIP-712 signing,
  hash-chained audit trail, 19 tests
- `examples/`: sample policy + approval payloads
- `scripts/`: structure smoke tests used by CI
- `assets/`: logo and media

## Development setup

```bash
# Onchain engine + tests
cd contracts
npm ci
npm run compile
npm test

# Plugin package smoke checks (from repo root)
node scripts/smoke.mjs
```

## Before opening a PR

- [ ] `node scripts/smoke.mjs` passes
- [ ] `cd contracts && npm test` passes
- [ ] No secrets, private keys, or credentials
- [ ] No remote code execution patterns (`curl | bash`, eval of remote content)
- [ ] One logical change per PR; keep the diff minimal
- [ ] `CHANGELOG.md` updated for user-visible changes
- [ ] If you change `SKILL.md` or the plugin manifests, expect the maintainers
      to re-pin the xAI marketplace listing SHA before merge

## Standards alignment

Interface and semantics questions about ERC-8196/8126 belong in the public
discussion thread, not in code comments:

https://ethereum-magicians.org/t/erc-8196-ai-agent-authenticated-wallet/27987

Implementation issues belong here as GitHub issues.

## Code of conduct

Behave per [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Short version: be
technically direct, assume good faith, and don't make it personal.
