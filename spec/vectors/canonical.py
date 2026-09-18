#!/usr/bin/env python3
"""A second implementation of the receipt format, in another language.

    python3 spec/vectors/canonical.py

If this file and the Node runner both reproduce the published bytes, then the format is
the rules and not a JavaScript artifact. Python was chosen because it is the language an
auditor is most likely to reach for; the JSON encoding below is the part that usually
bites, so it is called out explicitly:

  * no whitespace between tokens                     (separators=(",", ":"))
  * non-ASCII text is emitted as itself, not \\uXXXX  (ensure_ascii=False)
  * object keys are sorted, arrays keep their order
  * a missing field and a null field both become null

Exit 0 when every vector matches, 1 otherwise.
"""

import hashlib
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent

SIGNED_FIELDS = {
    3: [
        "id", "summary", "amountUsd", "requester", "target", "policyId", "source", "mode", "intentKind",
        "verdict", "reason", "status", "decision", "decidedBy",
        "execute", "rail", "railRef", "txHash", "executionError",
        "createdAt", "decidedAt", "settledAt",
    ],
    4: [
        "id", "summary", "amountUsd", "requester", "target", "policyId", "source", "mode", "intentKind",
        "verdict", "reason", "status", "decision", "decidedBy",
        "execute", "rail", "railRef", "txHash", "executionError",
        "createdAt", "decidedAt", "settledAt", "connector", "actionKind", "action", "proposalDigest",
        "approvedDigest", "expiresAt", "executionState", "idempotencyKey", "providerMessageId",
        "providerThreadId", "providerOutcome",
    ],
    5: [
        "id", "summary", "amountUsd", "requester", "target", "policyId", "source", "mode", "intentKind",
        "verdict", "reason", "status", "decision", "decidedBy",
        "execute", "rail", "railRef", "txHash", "executionError",
        "createdAt", "decidedAt", "settledAt", "connector", "actionKind", "action", "proposalDigest",
        "approvedDigest", "expiresAt", "executionState", "idempotencyKey", "providerMessageId",
        "providerThreadId", "providerOutcome",
        "resolutionOutcome", "resolutionNote", "resolvedAt", "resolvedBy",
    ],
}


def canonical_value(value):
    if value is None:
        return None
    if isinstance(value, list):
        return [canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical_value(value[key]) for key in sorted(value)}
    return value


def canonical_receipt(row):
    version = int(row["sigVersion"])
    fields = SIGNED_FIELDS.get(version)
    if fields is None:
        raise ValueError(f"unsupported sigVersion {row['sigVersion']}")
    obj = {key: canonical_value(row.get(key)) for key in fields}
    return "v%d:%s" % (version, json.dumps(obj, separators=(",", ":"), ensure_ascii=False))


def _prefixed(value):
    text = "" if value is None else str(value)
    return "%d:%s" % (len(text.encode("utf-8")), text)


def chain_entry_hash(entry):
    preimage = "|".join([
        "rc1",
        _prefixed(entry["prevHash"]),
        _prefixed(entry["chainSeq"]),
        _prefixed(entry["receiptId"]),
        _prefixed(entry["event"]),
        _prefixed(entry["signedAt"]),
        _prefixed(entry["signature"]),
        _prefixed(entry["canonical"]),
    ])
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()


def main():
    failures = 0
    fmt = json.loads((HERE / "format-vectors.json").read_text())
    chain = json.loads((HERE / "chain-vectors.json").read_text())

    print(f"format vectors — key {fmt['publicKeyFingerprint']}\n")
    for vector in fmt["vectors"]:
        mine = canonical_receipt(vector["receipt"])
        digest = hashlib.sha256(mine.encode("utf-8")).hexdigest()
        problems = []
        if mine != vector["canonical"]:
            problems.append("canonical bytes differ")
        if digest != vector["canonicalSha256"]:
            problems.append("canonical hash differs")
        if vector.get("equivalentReceipt"):
            other = canonical_receipt(vector["equivalentReceipt"])
            if (other == mine) != vector["equivalentCanonicalEqualsCanonical"]:
                problems.append("the 'equivalent receipt' expectation is wrong")
        if vector.get("tamperedReceipt"):
            if canonical_receipt(vector["tamperedReceipt"]) != vector["tamperedCanonical"]:
                problems.append("tampered canonical bytes differ")
        if problems:
            failures += 1
            print(f"✗ {vector['id']} — {'; '.join(problems)}")
        else:
            print(f"✓ {vector['id']}")

    print("\nchain vectors\n")
    previous = chain["genesisPrevHash"]
    for entry in chain["entries"]:
        mine = chain_entry_hash(entry)
        problems = []
        if entry["prevHash"] != previous:
            problems.append("prevHash does not match the previous entry")
        if mine != entry["entryHash"]:
            problems.append("entry hash differs")
        if problems:
            failures += 1
            print(f"✗ chain entry {entry['chainSeq']} — {'; '.join(problems)}")
        else:
            print(f"✓ chain entry {entry['chainSeq']} ({entry['event']})")
        previous = mine
    if previous == chain["headHash"]:
        print("✓ head hash is the last entry")
    else:
        failures += 1
        print("✗ head hash does not match the last entry")

    print("\nevery vector agrees with a Python implementation" if not failures
          else f"\n{failures} DISAGREEMENTS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
