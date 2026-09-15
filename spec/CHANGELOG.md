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
- Signature versions **v4 and v5**, not just v3. Production signs v4 today, and a
  v4 receipt used to be rejected by this file with "v4 is not supported" — the
  verifier had fallen a version behind what the issuer was signing. Version
  dispatch is still limited to the fixed field lists baked into this file: a
  receipt can never supply its own fields or canonicalization.
- Key-rotation handling. A receipt signed by a key that is not the pinned one but
  does match the key the issuer serves today is reported as `~` — "either they
  rotated the key, or someone swapped it" — instead of being called a forgery.
  A verifier that cries wolf on every legitimate rotation trains people to
  ignore it.

### Published schemas

`receipt-v3.schema.json` and `receipt-v4.schema.json` ship with this release —
v3 because history is full of v3 rows, v4 because that is what production signs
today.

The verifier understands the **v5** field list, because that list exists in the
codebase, but no v5 schema is published here. v5 is not signing in production yet,
and a schema is a promise to outside implementers: publishing one for a version
that can still change would be a promise we could not keep. It gets a schema the
day it starts signing. Until then a v5-signed row is simply one this file can
check, not a format anyone should implement against.

### Unchanged

- Zero dependencies (Node built-ins only), one file, Node 18+.
- The production signing key stays pinned inside the file.
- `--offline` still checks the signature with no network at all.
- Only `✗` — something provably wrong — withdraws the verdict. A skipped or
  pending check narrows what the verdict covers and says so.
