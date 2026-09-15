# verify-receipt changelog

Every release publishes the file, its sha256, and the same schemas that were
reviewed. `verify-receipt.mjs` prints both the version and the hash of the bytes
you are holding:

```bash
node verify-receipt.mjs --version
```

If that hash is not the one in the release you meant to fetch, you are not running
what was reviewed — which is the only reason a verifier is allowed to live at a
URL at all.

## 1.0.0 — 2026-09-15

First tagged release. Same four lines of output as the untagged `main` copy of the
same day, except where noted below.

### Fixed

- **A broadcast-but-unmined anchor is no longer reported as fixed onchain.** A
  node answers `eth_getTransactionByHash` for a transaction still in the mempool
  with `blockNumber: null`, and `Number(null)` is `0`: the check printed
  `block 0` and the verdict said "genuine, and fixed onchain". A pending
  transaction can be dropped, replaced at the same nonce, or reorged away, so it
  is now reported as pending (`onchain ~`, "broadcast but not in a block yet")
  and the verdict drops to "genuine, but its anchor is not in a block yet".
  Reported by an outside reviewer against the demo build.
- **A reverted anchor is no longer reported as fixed onchain.** A mined hash only
  proves the transaction was included, not what it did: a reverted `anchorReceipt`
  keeps the log head in its calldata while writing nothing to the contract. The
  verifier now reads the transaction receipt and reports that case separately
  from both pending and confirmed.
- Every block height that arrives over JSON-RPC now passes through one helper
  that keeps a missing height missing, so `0` cannot be invented again.

### Added

- `--version`: prints the version and the sha256 of this file.
- `--json` output now includes `verifier: { version, sha256 }`.
- Signature versions **v4 and v5**, not just v3. A current receipt used to be
  rejected with "sigVersion 5 is not supported" even though that is the version
  we sign today. Version dispatch is still limited to the fixed field lists baked
  into this file: a receipt can never supply its own fields or canonicalization.
- Key-rotation handling. A receipt signed by a key that is not the pinned one but
  does match the key the issuer serves today is reported as `~` — "either they
  rotated the key, or someone swapped it" — instead of being called a forgery.
  A verifier that cries wolf on every legitimate rotation trains people to
  ignore it.

### Unchanged

- Zero dependencies (Node built-ins only), one file, Node 18+.
- The production signing key stays pinned inside the file.
- `--offline` still checks the signature with no network at all.
- Only `✗` — something provably wrong — withdraws the verdict. A skipped or
  pending check narrows what the verdict covers and says so.
