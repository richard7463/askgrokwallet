# AskGrokWallet receipt — signature version 3

A receipt is an approval row plus an Ed25519 signature over 22 of its fields. This
document is the whole specification: enough to write an independent verifier without
reading our source, which is the only kind of verifier worth having.

Three checks, each resting on something different:

| check | what it proves | what you have to trust |
|---|---|---|
| **signature** | signed by the published key; every field it claims, including where the money went, is inside the signature | that the public key is really ours |
| **chain** | this receipt's signing event sits at a fixed position in an append-only log, linked hash by hash back to entry 1 | nothing, for your own entry |
| **onchain** | the head of that log was written into a public blockchain transaction | **nothing** |

Only the third needs no trust in us at all. Before that block, we could in principle
rewrite the log; after it, we cannot.

## Quick start

```bash
curl -O https://askgrokwallet.io/verify-receipt.mjs
node verify-receipt.mjs receipt.json
```

Zero dependencies, one file, nothing to install. It re-implements the checks below
from this spec rather than importing ours — a verifier that runs the issuer's code
is not a verifier. Add `--offline` to check the signature with no network at all.

| flag | effect |
|---|---|
| `--key=<base64 spki der>` | pin the signing key yourself instead of asking us |
| `--api=<origin>` | where the published log lives |
| `--rpc=<url>` | JSON-RPC endpoint for the onchain check |
| `--offline` | signature only |
| `--json` | machine-readable output |

Machine-readable field types: [`receipt-v3.schema.json`](receipt-v3.schema.json)
(JSON Schema draft 2020-12). Passing that schema says nothing about authenticity —
a schema cannot describe a signature. Run the verifier for that.

## 1. Signature layer

### The 22 signed fields, in this fixed order

```
id, summary, amountUsd, requester, target, policyId, source, mode, intentKind,  // who wants to spend what
verdict, reason, status, decision, decidedBy,                                   // how it was ruled
execute, rail, railRef, txHash, executionError,                                 // where the money actually went
createdAt, decidedAt, settledAt                                                 // when
```

`signature` / `sigAlg` / `sigVersion` / `signedAt` are **not** signed — they are the
output of signing. Neither is `settlementClaimedAt`: the sweeper sets it to claim a
row *before* executing, so it changes after the receipt is signed. Signing it would
force a re-sign and a new chain entry for an event that moved no money.

### There is no `riskLevel` field: the risk verdict rides inside the signed `reason`

Output from the onchain risk pre-check (the erc8126scan O1 adapter) is **not** a
separate field. It goes into `reason` as text, and `reason` is one of the 22 signed
fields — so the conclusion is just as tamper-evident, it simply has no key of its own.

This is deliberate. A 23rd signed field changes the canonical string, which means
`sigVersion` 4, which means **every receipt already issued stops verifying**. Invalidating
the entire history to give a key to text that already sits in `reason` is not worth it.
So if you want to read the risk verdict programmatically, parse `reason`; do not look
for `riskLevel`.

### The canonical string

```
canonical = "v3:" + JSON.stringify(obj)
```

Four rules build `obj`, and one byte of drift breaks every signature:

1. Keys are inserted **in the order of the 22 fields above**; the top level is **not**
   sorted. That order is itself part of the spec.
2. Missing / `undefined` / `null` are all written as `null`. The key is never omitted,
   so absent and null are indistinguishable to the signature.
3. Nested objects (today only `execute`) have their keys **sorted lexicographically**,
   recursively. Two key orders of the same intent must produce the same signature,
   or reordering keys would manufacture a second valid one.
4. `execute` keeps exactly four whitelisted keys: `to` / `asset` / `chainId` /
   `amountUsd`. Anything else the caller sent is dropped **before** signing, so the
   intent means one thing. Empty string and null count as absent; if all four are
   absent the whole `execute` is `null`.

Numbers follow JS `JSON.stringify` (`80`, never `80.0`). This is the one real hazard
for a non-JavaScript implementation: keep `amountUsd` an integer or at most two
decimals, and avoid magnitudes that get written in exponential form.

### Signing and verifying

Ed25519 over the UTF-8 bytes of `canonical`; the result is base64 in `signature`.
The public key is base64 SPKI DER.

| where to get the key | how much it proves |
|---|---|
| pinned in `verify-receipt.mjs` | it was fixed before you asked for this receipt |
| `--key=` from a source independent of us | most |
| `GET /api/receipt-public-key` | only that the server is self-consistent — it served both the receipt and the key |

Production key fingerprint `sha256(der)[:16]` = `39626850145403d3`.

**Only `sigVersion === 3` verifies. There is no version branch.** v1 read its version
off the untrusted row *and* carried a hardcoded fallback secret, so anyone who set
`sigVersion` to `1` could mint receipts that verified. v2 signed 13 fields and left
the destination out, so a receipt still verified after its payee address and tx hash
were swapped. Rows older than v3 therefore read as *unverified*, which is the honest
answer rather than a comforting one.

## 2. Chain layer

### Nodes are signing *events*, not receipts

A receipt is signed at three moments: created, decided, settled. A chain built on
receipt rows would have every re-signing change that row's fingerprint and break
every node after it. So the chain is built on **signing events**: one receipt that
runs the full course is 3 nodes.

That is strictly stronger — "it was pending, this person approved it, that tx executed
it" is all locked, not just the final state.

| event | when |
|---|---|
| `created` | receipt opened (`pending`) |
| `decided` | approve / deny recorded |
| `settled` | onchain execution finished or failed |
| `imported` | the row predates v3 |

`imported` exists because those old rows only have a final state. Synthesizing
created / decided / settled signatures they never had would forge exactly what this
log is meant to prevent. So they get one node, named honestly.

### entryHash

```
preimage  = "rc1" |f(prevHash)|f(chainSeq)|f(receiptId)|f(event)|f(signedAt)|f(signature)|f(canonical)
f(v)      = <byte length of v in UTF-8> ":" <v>
entryHash = lowercase hex sha256(preimage)
```

The delimiter is `|` and every value is length-prefixed (netstring). That is not
fussiness: `summary` is attacker-supplied free text, and with a plain join a summary
containing `8:|4:oops` could forge a field boundary. Length prefixes make it impossible.

`chainSeq` starts at 1; the first entry's `prevHash` is 64 zeros. `signedAt`
participates **as the string it is stored as**, so timestamp round-tripping cannot
change a hash.

### Verifying the chain

Walk from seq 1 and check three things per entry:

1. `chainSeq` equals exactly the expected value — a gap means an entry was removed or reordered
2. `prevHash` equals the previous entry's `entryHash`
3. recompute `entryHash` — a mismatch means this entry was edited

Report the first break. The last entry's `entryHash` is the **head**.

Writes must be serialized: every mutating Postgres transaction takes
`pg_advisory_xact_lock` as its **first** statement, in a fixed order so it cannot
deadlock. Without that, concurrent writes fork the log.

## 3. Onchain anchor layer

The head is written into `TrustLeaseController.anchorReceipt`. Once it is there, that
stretch of history is beyond our reach too — so **the anchor interval is the length of
the window that still rests on our word**. You cannot encrypt that window away, only
shorten it.

Anchoring often is nearly free: the script exits without sending a transaction when
the head has not moved, and the anchor call passes `spentUsd6=0` with
`executionStatus=None`, which sidesteps the contract's
`Broadcasted && spentUsd6 > 0` budget branch. So a dense anchor schedule does not eat
the lease's daily budget — only gas.

| parameter | value |
|---|---|
| `requestId` | `receipt-chain@<chainSeq>` |
| `proofHash` | `0x` + the head (32-byte sha256) |
| `outcome` / `executionStatus` | `0` / `0` |
| `spentUsd6` | `0` |
| `txRef` | zero hash |

The last three must be zero, or hourly anchoring would exhaust the lease's daily
allowance and the anchor interval would end up dictated by the budget.

### Checking an anchor without asking us

```
eth_getTransactionByHash(txHash)
  → is tx.to  the published contract address?
  → does tx.input contain the head hash as hex?
```

A substring match on calldata is sufficient — no ABI, no contract call, nothing to
install. One anchor covers its own `chainSeq` and every node before it, so to check a
given node take the **earliest** anchor with `chainSeq >= that node`.

Two outcomes that must never be conflated:

- the anchor tx does **not** contain that head → the issuer is lying. Fatal.
- the node is **not yet covered** by any anchor → the receipt is genuine, just not
  yet frozen; we could still rewrite it.

## 4. What the public endpoint deliberately withholds

`GET /api/receipts/chain` (optionally `?receiptId=`) returns **fingerprints only**:
`chainSeq` / `receiptId` / `event` / `prevHash` / `entryHash` / `signedAt`, plus
`anchors` and an `intact` flag for the whole log.

The response is the **entire** log and `chainSeq` always starts at 1, because the
linkage walk in §2 has nowhere else to start. Paginating this endpoint would break
every verifier already published, so if a window is ever added it will be an opt-in
parameter and the default will stay whole-log. Rate limit: 60 requests per minute per
client, since every call re-hashes the chain.

**It does not return `canonical`, and it does not return `signature`.** Publishing
signatures would hand everyone an offline guessing oracle: for a low-entropy field
like the amount, you could simply try candidates against the public key until one
verifies.

The cost is that a verifier only has fingerprints. That is enough for the two things
that matter:

- **linkage** — the whole chain can be walked from fingerprints alone
- **is my receipt in there** — recompute your own entry's `entryHash` from the receipt
  in your hand and find the equal one in the list

So: **holding a receipt proves it is in the log; without a receipt, the log leaks nothing.**

### The hole this trade-off leaves, stated plainly

Recomputing an entry's `entryHash` needs its `signature` and `canonical`, and both are
withheld on purpose. So if **somebody else's** entry has its `receiptId` / `event` /
`signedAt` altered while its `entryHash` is left alone, an independent verifier cannot
detect it — it can only check that the sequence is unbroken and that `prevHash` links
up. That stretch rests on our word.

Publishing `sha256(canonical)` instead of the text does not fix it: that hash is the
same guessing oracle, since you can hash candidate canonical strings and compare.
Salting does not fix it either, because the salt would have to be published. Publishing
contents and independent verifiability genuinely conflict here; you get one.

So the endpoint also returns a **self-reported** `intact`: our own recomputation over
the complete data. That is our word, not proof. A verifier must handle it by printing
a warning on the `chain` line when `intact === false` — being told by the issuer that
its own log is broken and still printing a bare tick throws away the only clue the
reader was handed. But it must not flip the verdict: `✗` is reserved for things
provably wrong, and here we could be telling the truth or lying.

## 5. How the verdict is reached

`✗` means *provably wrong*. `~` means *not checked*. Never mix them — a false alarm on
a good receipt costs as much as a missed forgery.

| the three checks | verdict | exit |
|---|---|---|
| any `✗` | `✗` do not trust this receipt | 1 |
| signature ✓ + onchain ✓ | `✓` genuine, and fixed onchain | 0 |
| signature ✓ + chain ✓, no anchor | `~` genuine, but we could still rewrite the log | 0 |
| signature ✓, chain unchecked | `~` signature genuine; published log not checked | 0 |
| signature unchecked | `~` nothing was verified (pass `--key=` to check offline) | 2 |

Exit codes have exactly three meanings: **1 = provably false, 0 = the signature is
genuine, 2 = nothing was verified.**

Note that `~` does not mean non-zero. Anchoring is periodic, so a freshly issued
receipt is necessarily not yet anchored — if that exited non-zero, everyone would
append `|| true` and the exit code would stop meaning anything. A check that cries
wolf is not a check. `~` narrows what the verdict covers and says so; it does not
withdraw it.

### Key rotation and key substitution look identical from outside

If a receipt fails against the pinned key but verifies against the key we serve today,
that is **not** a forgery, and calling it one would cry wolf at every legitimate
rotation. It is also not clean: a substituted key looks exactly the same from where
you stand. So the verifier returns neither `✓` nor `✗` — it prints `~` with both
fingerprints named and tells you to make us publish the rotation before you trust it.

The verifier also always prints where the key came from: `pinned by you` /
`pinned in this file` / `fetched from the issuer — not independently pinned`. The last
is plainly weaker and must not get the same tick as the others.

## 6. Status — what is actually running

The sections above describe the design. Verified against live data on 2026-09-06:

- the published log has **12 entries**, `intact: true`, head `67ccbb48…`
- **one anchor**, at `chainSeq` 11: tx `0xb3d35ee6…` on Ethereum Sepolia (chain
  11155111) to controller `0x6f8a3cc2…fb70`, with the head in its calldata. An earlier
  anchor, `0x1bd82e54…` (block 11626575), is also confirmed onchain.
- **entry 12 has been unanchored since 2026-09-04.** The hourly timer is not running;
  those anchors were made by hand. Treat "hourly" in §3 as the design value, not a
  live fact — which means everything after entry 11 currently rests on our word.
- no payment has ever settled on a mainnet. The Base mainnet contracts are deployed,
  but the vault's balance is zero and its token is a mock.

## 7. Version history

| version | signed | why it was replaced |
|---|---|---|
| v1 | read its version off the untrusted row; hardcoded fallback secret | setting `sigVersion: 1` minted valid receipts |
| v2 | 13 fields, destination and tx hash outside | a receipt still verified after the payee was swapped |
| **v3** | 22 fields including `execute`, `rail`, `txHash` | current |

Older rows are not re-signed. They read as unverified.
