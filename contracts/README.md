# Boundless Contracts — ERC-8196 governed agent wallet engine

The onchain engine behind [AskGrokWallet](https://askgrokwallet.io): a policy-bound
execution layer for AI agents, aligned with
[ERC-8196 — AI Agent Authenticated Wallet](https://eips.ethereum.org/EIPS/eip-8196)
(Ethereum Final standard).

## What this is

Agents should never hold the keys to a wallet they spend from. This repo contains
the contracts that enforce *bounded autonomy* instead:

| Contract | Role |
| --- | --- |
| `TrustLeaseController` | Implements `IAIAgentAuthenticatedWallet` (ERC-8196): policy registry, EIP-712 signed `executeAction`, revocation, hash-chained audit trail, ERC-8126 risk gate hook |
| `BoundlessVault` | Onchain vault that holds funds; leases grant bounded authority; hard mode requires a signed, policy-compliant action proof before money moves |
| `VerificationScoreRegistry` | ERC-8126-style onchain risk registry (EIP-712 attestations from a verification provider; unknown agents default to max risk) |
| `IAIAgentAuthenticatedWallet` | The ERC-8196 interface: `registerPolicy` / `executeAction` / `revokePolicy` / `getPolicy` + standard events and error codes |
| Mocks | `MockERC20`, `MockProtocolTarget`, `MockRiskOracle` (test fixtures) |

## Trust stack

```text
ERC-8004  identity   -> who is this agent?
ERC-8126  verify     -> how risky is it right now?  (getLatestRiskScore)
ERC-8196  execute    -> is this action authorized under this policy?
```

Every signed action and every settled receipt is appended to a hash-chained
audit trail; `verifyAuditChain(entryIds)` detects any tampering.

## Deployed (Base mainnet, chainId 8453)

See [`deployments/base-mainnet.json`](deployments/base-mainnet.json):

- TrustLeaseController: `0x4ACcB1df8cc625AC05743888158CC3B866aC9833`
- BoundlessVault: `0xd9526Eb615f5e252341b5a83b3c26eCca4f1284e`
- VerificationScoreRegistry: `0x89c8B3d053a79A0bd5A47597aaF97729f504d359`

## Test

```bash
npm ci
npm test
```

19 tests cover: policy registration, EIP-712 signature verification (wrong
signer / replay / over-limit / expired / revoked), action + contract
allowlists, daily spend caps, audit-chain integrity (tamper detection),
ERC-8126 risk gating, entropy commit-reveal, vault hard mode, and receipt
anchoring.

## Scope (honest boundaries)

- Entropy is exposed as `verifyEntropyReveal` + commitments in signatures/audit;
  the full commit-reveal protocol is not yet mandatory.
- The risk oracle is pluggable; no third-party ERC-8126 provider is wired yet
  (unknown agents = max risk).
- MIT licensed; contracts are unaudited experimental code — review before use
  with real funds.

See [`docs/erc8196-alignment.md`](docs/erc8196-alignment.md) for the full
implementation notes.
