# Audit bundles — the public sees nothing, your auditor sees everything

A receipt system has a tension built into it: **verification wants disclosure, business
wants secrecy.** An operator cannot publish their vendor list and spend levels, and a
compliance function cannot approve a system it cannot inspect. Publishing everything, or
publishing nothing, both fail. This is the third option.

## The flow, in three commands

```bash
# the auditor, once
node spec/make-audit-bundle.mjs keygen --out auditor.key.json     # sends the public half to you

# the operator, per period
node spec/make-audit-bundle.mjs export --auditor-key=<their public key> \
     --receipts=receipt-1.json,receipt-2.json --out=audit-bundle.json
#   …or for a receipt you already hold an id for: --from-api --receipt-id=appr_…

# the auditor
node spec/verify-audit-bundle.mjs audit-bundle.json --viewing-key=auditor.key.json [--rpc=<url>]
```

## What is in the file

One JSON file: a sealed payload plus the material needed to open it.

| Field | Meaning |
| --- | --- |
| `scheme` | `X25519-HKDF-SHA256-AES-256-GCM` — Node built-ins, no dependency, reproducible in any language |
| `ephemeralPublicKey`, `salt`, `iv`, `tag`, `ciphertext` | a standard hybrid box: ECDH → HKDF → AES-GCM |
| payload → `receipts` | the full receipts, exactly as signed |
| payload → `log` | the public log's fingerprints (entries and anchors) **as of export** |
| payload → `receiptPublicKey` | the key that signed the receipts, so the auditor can spot a rotation instead of trusting one |

The seal proves **who could read it** and that the file was not altered. It proves nothing
about *when* the contents existed — that is what the anchor is for, and the verifier checks
it against the chain.

## What the verifier checks, and against what

| Check | Recomputed from | Not taken on trust |
| --- | --- | --- |
| the seal opens | the auditor's private key | the file has not been altered since sealing |
| each receipt's signature | the receipt itself, with the published field list | the receipt is unaltered and is theirs |
| the receipt is in the log | the receipt's own canonical bytes + the entry metadata | the operator cannot show a receipt that was never logged |
| the log links back to entry 1 | every entry's hash and `prevHash` | no entry was removed, reordered or edited |
| the covering anchor | the anchor's head hash vs the entry at that `chainSeq` | the log is committed in the chain |
| the anchor transaction | `eth_getTransactionByHash` + the receipt, with `--rpc` | in a block, successful, calldata carries the head |

An anchor that is only broadcast reads as **not fixed**; a reverted one reads as reverted.
The rules are the same ones the standalone verifier uses, so a bundle cannot be stronger
than the receipt format it carries.

## The limit, stated where the auditor will read it

**This cannot prove that the log contains every action the operator's agents took.** The
chain rules out alteration and removal of what is in it; omission is a different problem.
Closing it needs the *enforcement point* to refuse an unlogged action — in `guarded` mode
the vault, and for a wallet rail the signing gate — so that "no receipt" implies "no
action". Until then, an audit bundle is a statement about what was recorded, and the
verifier prints that sentence in its own output rather than burying it here.

Two smaller limits worth knowing: the log snapshot is a point-in-time view (an auditor
comparing two bundles can see growth), and the bundle reveals everything to the holder of
the viewing key — this is selective disclosure, not partial disclosure. The partial version
(prove a field without revealing it) is
[`vectors/`](vectors/README.md)-style work on commitments, not something the current format
supports.

## Try it without a network

```bash
node spec/audit-bundle.test.mjs
```

Eleven assertions: an honest bundle verifies, and four kinds of lying are caught — a
receipt edited after signing, a receipt the operator invented, a log with an entry removed,
and an anchor that does not match the log head — plus the two seal failures (wrong key,
altered file). The log in that test is built from the shipped example receipt, so it runs
anywhere.
