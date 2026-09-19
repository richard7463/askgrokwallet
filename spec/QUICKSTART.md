# Verify an AskGrokWallet receipt in 3 commands

No install, no dependencies, Node 18+. You verify a real receipt that was
issued on production and anchored onchain — without trusting us.

```bash
curl -O https://github.com/askgrokwallet/askgrokwallet/releases/download/verify-receipt-v1.0.1/verify-receipt.mjs
curl -O https://raw.githubusercontent.com/askgrokwallet/askgrokwallet/verify-receipt-v1.0.1/spec/example-receipt.json
node verify-receipt.mjs --version          # optional: version + sha256 of the file
node verify-receipt.mjs example-receipt.json
```

Both URLs are pinned to the `verify-receipt-v1.0.1` tag, so the file cannot change
under you. Compare the sha256 of the bytes you are running with the published
[SHA256SUMS](https://github.com/askgrokwallet/askgrokwallet/releases/download/verify-receipt-v1.0.1/SHA256SUMS)
**before** running the file — `--version` reports the hash after the code has already
executed, which is a claim by the thing you are checking, not a gate on it.

Expected output (verifier 1.0.1):

```
signature  ✓  22 fields signed (v3) · key 39626850145403d3 (pinned in this file)
chain      ✓  entry 11 of 48 (imported) · links unbroken back to 1
onchain    ✓  head 11 written in 0xb3d35ee618… block 11633900 · chain 11155111
verdict    ✓  genuine, and fixed onchain
```

`entry 11 of 48` is this receipt's fixed position in the log — entry 11 never
changes, the total grows as the log grows, so yours will be larger.

### Or let the repository do it in one command

`spec/judge-check.mjs` runs the same check and adds two things: it asserts that the
verifier you are holding is byte-for-byte the released one, and it reports the size
and integrity of the live log. Useful when you are reviewing rather than reading:

```bash
node spec/judge-check.mjs
```

Exit codes: `0` verified · `1` something provably wrong · `2` inconclusive (no
network, or the service is unreachable).

## What each line proves

- **signature** — the receipt was signed by the published Ed25519 key
  (fingerprint `39626850145403d3`, pinned *inside the verifier you just
  downloaded*), and every field it claims — including where the money went —
  is inside that signature. Fully offline: rerun with `--offline` and pull
  your network cable if you want.
- **chain** — this receipt's signing event sits at a fixed position in a
  published append-only log, hash-linked back to entry 1.
- **onchain** — the head of that log was written into a public blockchain
  transaction **that is in a block and succeeded** (Ethereum Sepolia in this
  example). From that block onward, not even we can rewrite the history it covers.
  A transaction that is still in the mempool is reported as `~` pending, never as
  fixed: until it lands it can be dropped, replaced at the same nonce, or reorged
  away. A reverted anchor is reported the same way, with the reason — it carries
  the log head in its calldata while writing nothing to the contract.

What it does **not** prove: that the payment was wise, or that the agent
should have been allowed to make it. It proves this receipt is genuine,
unaltered, and fixed onchain.

The example receipt is a `demo`-source approval that was actually executed
onchain (`txHash 0x3c1e6c90…`). Production currently settles on Ethereum
Sepolia with a mock USDC; see [Status & roadmap](../README.md#status--roadmap)
for what is live versus testnet.

## Verify a receipt you were handed

```bash
node verify-receipt.mjs your-receipt.json
```

Or POST it to the independent check endpoint (reports `signatureValid` and
`onRecord` separately — a valid signature alone only says "signed by the
receipt key", not "this actually happened"):

```bash
curl -s -X POST https://askgrokwallet.io/api/receipts/verify \
  -H 'content-type: application/json' -d @your-receipt.json
```

## Pin the key yourself

The verifier ships with our production key pinned. If you obtained the key
through a channel independent of us, verify against yours:

```bash
node verify-receipt.mjs --key=<base64-spki-der> example-receipt.json
```

## Check the verifier itself

The verifier ships with a behaviour test that needs nothing but Node. It starts a
stub node and a stub log inside its own process, signs a throwaway receipt, and
reads what the verifier prints for each shape a node can answer with — including
the regression that came from an outside review: a transaction that is broadcast
but not yet mined must never read as "fixed onchain". Keep both files in the same
directory:

```bash
curl -O https://raw.githubusercontent.com/askgrokwallet/askgrokwallet/verify-receipt-v1.0.0/spec/test-verify-receipt.mjs
node test-verify-receipt.mjs
```

The same file is mirrored at `https://askgrokwallet.io/verify-receipt.mjs`. The
tagged release is the artifact of record: a mirror can lag a deploy, so if the two
disagree, compare `--version` against the release notes before believing either.
Note that our own instructions used to point at the *mutable* `main` URL — which is
how a copy silently stayed a week old. The tag exists so that cannot happen again.

## Go deeper

- Full receipt specification: [receipt-v3.md](receipt-v3.md)
- JSON Schemas: [v3](receipt-v3.schema.json) · [v4](receipt-v4.schema.json) — the
  versions that have signed in production. The verifier also understands the v5
  field list, but v5 does not sign in production yet, so its schema is deliberately
  not published: a schema is a promise to implementers, and this one would be
  premature.
- Changelog, version by version: [CHANGELOG.md](CHANGELOG.md)
- The verifier, line by line: [verify-receipt.mjs](verify-receipt.mjs)
  (read it before you trust it — that is the point)
