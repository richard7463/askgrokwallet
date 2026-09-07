# Verify an AskGrokWallet receipt in 3 commands

No install, no dependencies, Node 18+. You verify a real receipt that was
issued on production and anchored onchain — without trusting us.

```bash
curl -O https://raw.githubusercontent.com/richard7463/askgrokwallet/main/spec/verify-receipt.mjs
curl -O https://raw.githubusercontent.com/richard7463/askgrokwallet/main/spec/example-receipt.json
node verify-receipt.mjs example-receipt.json
```

Expected output:

```
signature  ✓  22 fields signed · key 39626850145403d3 (pinned in this file)
chain      ✓  entry 11 of 12 (imported) · links unbroken back to 1
onchain    ✓  head 11 written in 0xb3d35ee618… block 11633900 · chain 11155111
verdict    ✓  genuine, and fixed onchain
```

## What each line proves

- **signature** — the receipt was signed by the published Ed25519 key
  (fingerprint `39626850145403d3`, pinned *inside the verifier you just
  downloaded*), and every field it claims — including where the money went —
  is inside that signature. Fully offline: rerun with `--offline` and pull
  your network cable if you want.
- **chain** — this receipt's signing event sits at a fixed position in a
  published append-only log, hash-linked back to entry 1.
- **onchain** — the head of that log was written into a public blockchain
  transaction (Ethereum Sepolia in this example). From that block onward,
  not even we can rewrite the history it covers.

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

## Go deeper

- Full receipt specification: [receipt-v3.md](receipt-v3.md)
- JSON Schema: [receipt-v3.schema.json](receipt-v3.schema.json)
- The verifier, line by line: [verify-receipt.mjs](verify-receipt.mjs)
  (read it before you trust it — that is the point)
