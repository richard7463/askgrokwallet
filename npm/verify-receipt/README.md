# @askgrokwallet/verify-receipt

Verify an AskGrokWallet receipt **without trusting AskGrokWallet**.

This package is a mirror, not the source of truth. The authoritative artifact is
the GitHub release; the tarball here is built from the same tagged bytes and ships
the same `SHA256SUMS`.

| | |
|---|---|
| canonical file | [releases/download/verify-receipt-v1.0.1/verify-receipt.mjs](https://github.com/askgrokwallet/askgrokwallet/releases/download/verify-receipt-v1.0.1/verify-receipt.mjs) |
| sha256 | `32de3cad6f3bb23ae8415cd5afe5f54dd8167432a2473814e6ab4ec0b767317a` — also in the release's `SHA256SUMS` |
| dependencies | none — Node built-ins only |
| node | >= 18 |

## Use

```bash
# verify a receipt you were handed
npx -y @askgrokwallet/verify-receipt@1.0.1 receipt.json

# signature only, no network at all
npx -y @askgrokwallet/verify-receipt@1.0.1 receipt.json --offline

# which verifier am I running?
npx -y @askgrokwallet/verify-receipt@1.0.1 --version
```

**Pin the version.** `@latest` means "whatever the registry serves today", which is
the same defect as fetching a verifier from a page that silently redeploys.

Installing it globally works too, and is the same file:

```bash
npm i -g @askgrokwallet/verify-receipt@1.0.1
verify-receipt receipt.json
```

## What the four lines mean

| line | what it proves | what you still trust |
|---|---|---|
| `signature` | the receipt was signed by the published Ed25519 key, and every field it claims — including where the money went — is inside that signature | that the key is really theirs (it is pinned inside the file) |
| `chain` | this receipt's signing event sits at a fixed position in a published append-only log, hash-linked back to entry 1 | nothing, for your own entry |
| `onchain` | the head of that log was written into a public blockchain transaction **in a block, successful** | nothing |
| `verdict` | what the three lines above add up to | — |

A broadcast-but-unmined anchor is reported as `~` pending, never as fixed: a
mempool transaction can be dropped, replaced, or reorged away. So is a reverted
anchor transaction, which carries the log head in its calldata while writing
nothing to the contract. So is an anchor whose outcome the node will not report —
no receipt, an RPC error, a receipt with no `status` field (fixed in 1.0.1; 1.0.0
printed a tick for all three). Only `✗` — something provably wrong — withdraws the
verdict.

A `✓` is a statement about **the record**, not about a payment. An approval, a
denial, and a receipt with `txHash: null` authenticate exactly as well as a
payment does; `~` means *unverified*, never *fine*. What it does **not** prove:
that money moved, that the payment was wise, or that the agent should have been
allowed to make it. "Did it settle" is answered by the transaction the receipt
names, not by these four lines.

## Flags

| flag | effect |
|---|---|
| `--key=<base64 spki der>` | pin the signing key yourself instead of using the one in the file |
| `--api=<origin>` | where the published log lives |
| `--rpc=<url>` | JSON-RPC endpoint for the onchain check |
| `--offline` | signature only; no network |
| `--json` | machine-readable output, including `verifier.version` and `verifier.sha256` |
| `--version` | print this verifier's version and the sha256 of the file |

## Why npm is the mirror and not the only door

The receipt you are checking came from us, so the verifier has to be something you
can hand to someone else and have them check without asking us anything. A file on
a URL can be checked by reading it; a package can only be checked by installing it,
which is a longer chain of things that can lie. So the release asset is the
canonical artifact, this package is convenience, and both carry the same sha256.

Publishing runs in CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
so the tarball is signed as having been built from a specific commit in
`askgrokwallet/askgrokwallet` — the provenance record is the answer to "who
published this and from what", which a local `npm publish` cannot give you.

## Schemas

The tarball ships the JSON Schemas for the signature versions that have signed in
production: `receipt-v3.schema.json` (historical) and `receipt-v4.schema.json`
(current). The verifier also understands the v5 field list, but no v5 schema is
published while v5 is not signing — a schema is a promise to implementers, and
that one would be premature.

A schema describes shape; it cannot describe authenticity. It says nothing about
whether a receipt is genuine — run the verifier for that.

## License

MIT.
