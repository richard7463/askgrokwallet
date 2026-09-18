# Receipt format — conformance vectors

If you are writing your own receipt verifier, signer, or a database that stores these
receipts, these vectors let you check your implementation **without reading our code**.

Two commands, no dependencies, no network:

```bash
node spec/vectors/run-vectors.mjs     # checks the rules and the released verifier
python3 spec/vectors/canonical.py     # the same vectors, implemented again in Python
```

Both exit `0` when every published byte is reproduced. Two languages, same bytes: that is
the point — the format is the rules below, not a JavaScript artifact.

## What is checked

| File | What it pins down |
| --- | --- |
| [`format-vectors.json`](format-vectors.json) | the exact canonical bytes, their sha256, and the exact Ed25519 signature for seven cases |
| [`chain-vectors.json`](chain-vectors.json) | the exact hash of three log entries, the head hash, and two negative cases |
| [`run-vectors.mjs`](run-vectors.mjs) | implements the written rules from scratch, compares against the published bytes, and then runs the released `spec/verify-receipt.mjs` against the same receipts |
| [`canonical.py`](canonical.py) | the same rules in Python, as a second implementation |
| [`generate.mjs`](generate.mjs) | regenerates the vectors deterministically (fixed test key) |

## The format, in five lines

1. `canonical = "v" + sigVersion + ":" + JSON.stringify(signedObject)`
2. `signedObject` holds exactly the signed fields for that version, **in the order listed**
   (`x-signedFields` in the JSON Schemas) — fixed order, not alphabetical.
3. A field that is absent and a field that is `null` both become `null`.
4. Nested objects have their keys sorted; arrays keep their order. No whitespace.
5. An unknown `sigVersion` has no fixed field list and must be **rejected**, never guessed.

…and the chain entry that commits to it:

```
preimage = "rc1" | len(prevHash):prevHash | len(chainSeq):chainSeq | len(receiptId):receiptId
                 | len(event):event | len(signedAt):signedAt | len(signature):signature
                 | len(canonical):canonical          (fields joined by "|")
entryHash = hex(sha256(utf8(preimage)))              len(v) = UTF-8 byte length of v
```

The length prefixes are load-bearing. A receipt summary is free text, so without them a
summary containing `8:|4:oops` could imitate a field boundary; `chain-vectors.json` carries
a negative vector that shows the two hashes differing.

## The cases worth reading first

| Vector | Why it exists |
| --- | --- |
| `v3-missing-equals-null` | two receipts that mean the same thing must produce the *same* canonical bytes, or every rewrite would break its own signature |
| `v3-nested-key-order` | the same `execute` intent written in a different key order is the same bytes |
| `v3-unicode-and-delimiters` | non-ASCII text, a colon, a pipe and a newline inside a summary survive verbatim and cannot escape their field |
| `v3-tampered-amount` | changing one signed field invalidates the signature (the published expectation is `false`) |
| `v4-connector-action` / `v5-resolution` | the two later field lists — a receipt cannot pick its own fields, so versions are dispatched against fixed lists |
| `chain-vectors.negativeVectors` | editing an entry, and the delimiter-injection case above |

## What passing does *not* mean

These vectors pin the **format**: canonicalization, hashing, signature bytes. They say
nothing about whether a policy decision was wise, whether a log is complete, or whether an
action really happened — an implementation can pass every vector and still be a dishonest
issuer. For behaviour of the released verifier (pending anchors, reverted anchors,
mismatched heads, tampering) see [`spec/test-verify-receipt.mjs`](../test-verify-receipt.mjs).

## The test key is published on purpose

`format-vectors.json` contains the base64 SPKI public key and its fingerprint, and
`generate.mjs` contains the matching private key. It signs nothing but these vectors — the
production key is different and stays pinned inside `verify-receipt.mjs`, never in a
repository. If a vector's signature verified under the production key, something would be
very wrong.

## Where this is going

A format becomes infrastructure when a second party implements it and the bytes agree.
These vectors exist so that is a ten-minute check instead of a conversation: implement the
five rules, run the two commands, and if your bytes match, your receipts are the same
object as ours. If they do not, the mismatch is a bug report we want.
