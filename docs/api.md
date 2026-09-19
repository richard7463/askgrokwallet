# AskGrokWallet API reference

Base URL: `https://askgrokwallet.io`

| Purpose | Method + URL |
| --- | --- |
| Compile + evaluate a policy | `POST /api/approvals` (include `policyText`) |
| Create an approval request | `POST /api/approvals` |
| List approvals | `GET /api/approvals?status=pending` (also `?status=approved`, `?status=denied`) |
| Decide an approval | `POST /api/approvals/{id}` with `{ "decision": "approve" \| "deny", "by": "operator@demo" }` |
| Approval inbox (UI) | `GET /approvals` |
| Public signing key | `GET /api/receipt-public-key` |
| Verify a receipt (hosted, weaker) | `POST /api/receipts/verify` |
| Public receipt log (fingerprints) | `GET /api/receipts/chain` |
| Policy presets | `GET /api/presets` |

## Auth

Write endpoints accept `"source": "demo"` as a keyless demo identity. Any other
source requires `Authorization: Bearer <token>`; unauthenticated non-demo writes
are rejected with `401` (tested 2026-09-03).

```bash
curl -s https://askgrokwallet.io/api/approvals \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{ "source": "grok", "requester": "my-bot", "summary": "pay invoice", "amountUsd": 25,
        "policyText": "payments under $50 run automatically; over $50 ask me" }'
```

## Verdicts and receipts

The policy engine returns one of three verdicts — `allow`, `ask`, `deny` — plus the
rule that fired. Every outcome is signed (Ed25519) and appended to the public
hash-chained log, which the receipt verifier then checks offline:

```bash
BASE=https://github.com/richard7463/askgrokwallet/releases/download/verify-receipt-v1.0.1
curl -LO $BASE/verify-receipt.mjs && curl -sLO $BASE/SHA256SUMS
shasum -a 256 -c SHA256SUMS   # check the bytes before running them
node verify-receipt.mjs receipt.json
```

The hosted `POST /api/receipts/verify` endpoint answers `{ "verified": true }`, but it
asks the issuer about the issuer's own receipt. Prefer the standalone verifier; it
re-implements the checks from `spec/receipt-v3.md` instead of importing our code.

## Rate limits

Public read endpoints are rate limited per client (the receipt log re-hashes the
chain on every call). `429` responses carry a `retry-after` header in seconds.
