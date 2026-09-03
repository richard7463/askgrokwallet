# Changelog

All notable changes to the AskGrokWallet plugin package are documented here.

## Unreleased

### Added

- Monorepo: Boundless / ERC-8196 onchain engine moved into `contracts/`
  (Hardhat project with 19 tests + compile/test CI job, Base mainnet
  deployment record, ERC-8196 alignment notes)
- Live site: `https://askgrokwallet.io` (HTTPS, custom domain on Vercel),
  with English pitch + developer-facing pitch-v2 + interactive demo
- Deployed AskGrokWallet contracts to **Base mainnet** (chainId 8453):
  TrustLeaseController, BoundlessVault, VerificationScoreRegistry, Mock USDC
- ERC-8196 alignment of the onchain rail: `IAIAgentAuthenticatedWallet`
  (`registerPolicy` / `executeAction` / `revokePolicy` / `getPolicy`)
- EIP-712 `AgentAction` signature verification bound to `policyHash`
- Hash-chained audit trail covering signed actions and settled receipts,
  with onchain `verifyAuditChain` integrity checks
- ERC-8126 risk gating via `VerificationScoreRegistry` (EIP-712 signed
  attestations from the verification provider)
- BoundlessVault hard mode: fund movement requires a policy-compliant,
  signed action proof (`executeTransferGuarded` / `executeProtocolCallGuarded`)
- Entropy commit-reveal verification (`verifyEntropyReveal`)

## [0.1.0] - 2026-08-24

### Added

- AskGrokWallet plugin package for Grok Build + Cursor Marketplaces
  (`.grok-plugin` + `.cursor-plugin` manifests, root `SKILL.md`)
- Plain-English policy engine: `allow / ask / deny` compilation
- Human approval inbox + signed receipts flow
- Example policy and approval payloads (`examples/`)
- Structure smoke test (`scripts/smoke.mjs`)
- CI pipeline (structure, manifests, secrets scan)
