# ERC-8196 alignment notes

Implementation summary of the AskGrokWallet onchain rail against
[ERC-8196](https://eips.ethereum.org/EIPS/eip-8196) (Final, Standards Track).

## Implemented

1. **Interface** — `IAIAgentAuthenticatedWallet` with standard events
   (`PolicyRegistered`, `ActionExecuted`, `PolicyRevoked`, `AuditEntryLogged`)
   and error codes (`PolicyExpired`, `ValueExceedsLimit`, `InvalidSignature`,
   `EntropyVerificationFailed`, `PolicyViolation`).
2. **EIP-712 signatures** — domain `AskGrokWallet` v1; `AgentAction` typed data
   binds agent, action label, target, value, calldata, nonce, policy validity,
   `policyHash` and entropy commitment to the signer. Recovery must equal the
   policy's agent; the owner's private key never leaves the owner.
3. **Policy enforcement** — `executeAction` checks, in order: policy active,
   time window, per-tx cap, ERC-8126 risk score (pluggable oracle), action
   allowlist (calldata selector registry prevents label laundering), contract
   allow/block lists, EIP-712 signature. Nonces and spend are consumed only
   after all checks pass (failed attempts are side-effect free).
4. **Hash-chained audit** — every signed action and settled receipt links to
   the previous entry; `verifyAuditChain` recomputes content hashes and detects
   tampering.
5. **Active containment** — `revokePolicy` / lease status / operator mode.
6. **Vault hard mode** — `setRequireActionProof(true)` disables unguarded
   transfers; funds move only with a consumed audit proof whose actor, action
   type and policy match the lease.

## Evidence

- `npm test`: 19 passing (contracts/test)
- Deployment: Base mainnet `deployments/base-mainnet.json`

## Not yet

- Mandatory entropy commit-reveal protocol (helper exists; protocol optional)
- Third-party ERC-8126 verification provider integration (registry is ready)
