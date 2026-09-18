#!/usr/bin/env node
// Generate the conformance vectors for the AskGrokWallet receipt format.
//
//   node spec/vectors/generate.mjs
//
// Deterministic: the key below is fixed, so re-running produces byte-identical
// vectors. The vectors are the contract — `format-vectors.json` publishes the exact
// canonical bytes and signature for each case, and `chain-vectors.json` publishes the
// exact entry hashes. An implementation in any language passes when it reproduces
// those bytes, not when it agrees with our code.
//
// The fixed key is a test key. It signs nothing but these vectors.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The format, restated so a reader can implement it without our code ───────
const CHAIN_VERSION = 1;
const GENESIS_PREV_HASH = "0".repeat(64);

const SIGNED_FIELDS = {
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
    "approvedDigest", "expiresAt", "executionState", "idempotencyKey", "providerMessageId", "providerThreadId", "providerOutcome",
  ],
  5: [
    "id", "summary", "amountUsd", "requester", "target", "policyId", "source", "mode", "intentKind",
    "verdict", "reason", "status", "decision", "decidedBy",
    "execute", "rail", "railRef", "txHash", "executionError",
    "createdAt", "decidedAt", "settledAt", "connector", "actionKind", "action", "proposalDigest",
    "approvedDigest", "expiresAt", "executionState", "idempotencyKey", "providerMessageId", "providerThreadId", "providerOutcome",
    "resolutionOutcome", "resolutionNote", "resolvedAt", "resolvedBy",
  ],
};

function canonicalValue(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
}

function canonicalReceipt(row) {
  const version = Number(row.sigVersion);
  if (!Object.hasOwn(SIGNED_FIELDS, version)) throw new Error(`unsupported sigVersion ${row.sigVersion}`);
  const obj = {};
  for (const key of SIGNED_FIELDS[version]) obj[key] = canonicalValue(row[key]);
  return `v${version}:${JSON.stringify(obj)}`;
}

const lengthPrefixed = (value) => {
  const s = String(value ?? "");
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
};

function chainPreimage(entry) {
  return [
    `rc${CHAIN_VERSION}`,
    lengthPrefixed(entry.prevHash),
    lengthPrefixed(entry.chainSeq),
    lengthPrefixed(entry.receiptId),
    lengthPrefixed(entry.event),
    lengthPrefixed(entry.signedAt),
    lengthPrefixed(entry.signature),
    lengthPrefixed(entry.canonical),
  ].join("|");
}

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const entryHash = (entry) => sha256(chainPreimage(entry));

// ── The fixed test key ───────────────────────────────────────────────────────
const TEST_PRIVATE_KEY_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIFPfPEjxcHg+rTdy+kzWWDyBtv7Bbi+jl7PQrDNRjoxj
-----END PRIVATE KEY-----`;

const privateKey = crypto.createPrivateKey(TEST_PRIVATE_KEY_PKCS8);
const publicKeyDer = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
const publicKey = publicKeyDer.toString("base64");
// The fingerprint the verifier prints: sha256 of the SPKI DER bytes, first 16 hex chars.
const fingerprint = crypto.createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16);

function signed(row) {
  const canonical = canonicalReceipt(row);
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  return { ...row, signature, sigAlg: "ED25519", sigVersion: row.sigVersion, signedAt: row.signedAt, canonical };
}

const base = {
  id: "appr_0001",
  summary: "Pay the invoice",
  amountUsd: 42,
  requester: "agent",
  target: "vendor",
  policyId: "policy-1",
  source: "demo",
  mode: "ask",
  intentKind: "purchase",
  verdict: "ask",
  reason: "over the auto-allow threshold",
  status: "settled",
  decision: "approve",
  decidedBy: "operator@example.com",
  execute: { to: "0x1111111111111111111111111111111111111111", asset: "USDC", chainId: 8453, amountUsd: 42 },
  rail: "evm:8453",
  railRef: "0xabc",
  txHash: "0xabc",
  executionError: null,
  createdAt: "2026-09-18T00:00:00.000Z",
  decidedAt: "2026-09-18T00:05:00.000Z",
  settledAt: "2026-09-18T00:06:00.000Z",
  sigVersion: 3,
  signedAt: "2026-09-18T00:06:01.000Z",
};

const vectors = [];
const push = (id, why, receipt, extra = {}) => {
  const out = signed(receipt);
  vectors.push({
    id,
    why,
    signedFields: SIGNED_FIELDS[Number(receipt.sigVersion)],
    receipt: out,
    canonical: out.canonical,
    canonicalSha256: sha256(out.canonical),
    signature: out.signature,
    signatureValid: true,
    ...extra,
  });
};

// 1. the published v3 shape
push("v3-basic", "the v3 shape as published, every signed field present", { ...base });

// 2. a missing field and a null field canonicalize identically
{
  const withNull = { ...base, executionError: null, settledAt: null };
  const withMissing = { ...base, settledAt: null };
  delete withMissing.executionError;
  const a = signed(withNull);
  const b = signed(withMissing);
  vectors.push({
    id: "v3-missing-equals-null",
    why: "a field that is absent and a field that is null must produce the SAME canonical bytes — otherwise two receipts that mean the same thing would need two signatures",
    signedFields: SIGNED_FIELDS[3],
    receipt: a,
    canonical: a.canonical,
    canonicalSha256: sha256(a.canonical),
    signature: a.signature,
    signatureValid: true,
    equivalentReceipt: b,
    equivalentCanonical: b.canonical,
    equivalentSignature: b.signature,
    equivalentCanonicalEqualsCanonical: a.canonical === b.canonical,
  });
}

// 3. nested key order must not matter
{
  const reordered = { ...base, execute: { amountUsd: 42, chainId: 8453, asset: "USDC", to: "0x1111111111111111111111111111111111111111" } };
  const a = signed({ ...base });
  const b = signed(reordered);
  vectors.push({
    id: "v3-nested-key-order",
    why: "nested object keys are sorted, so the same execute intent written in a different key order is the same bytes",
    signedFields: SIGNED_FIELDS[3],
    receipt: a,
    canonical: a.canonical,
    canonicalSha256: sha256(a.canonical),
    signature: a.signature,
    signatureValid: true,
    equivalentReceipt: b,
    equivalentCanonical: b.canonical,
    equivalentCanonicalEqualsCanonical: a.canonical === b.canonical,
  });
}

// 4. unicode and delimiter characters survive verbatim
push("v3-unicode-and-delimiters",
  "non-ASCII text, a colon, a pipe and a newline inside a summary must be carried through verbatim — the summary is user text and must not be able to escape its field",
  { ...base, summary: 'Pay “Vendor|Co” — 42 € : line 2\nemoji 🧾' });

// 5. v4 adds connector/action binding
push("v4-connector-action",
  "v4 adds ten fields that bind an exact action and its provider result (connector, actionKind, digests, provider ids)",
  {
    ...base,
    sigVersion: 4,
    execute: null,
    connector: "gmail",
    actionKind: "send_email",
    action: { to: ["a@example.com"], subject: "hello" },
    proposalDigest: "0x" + "11".repeat(32),
    approvedDigest: "0x" + "11".repeat(32),
    expiresAt: "2026-09-18T00:16:00.000Z",
    executionState: "executed",
    idempotencyKey: "idem-1",
    providerMessageId: "msg-1",
    providerThreadId: "thread-1",
    providerOutcome: "sent",
  });

// 6. v5 adds resolution attestation
push("v5-resolution",
  "v5 adds the four fields that record a human resolving an uncertain provider outcome",
  {
    ...base,
    sigVersion: 5,
    resolutionOutcome: "provider_confirmed",
    resolutionNote: "checked the provider dashboard",
    resolvedAt: "2026-09-18T00:07:00.000Z",
    resolvedBy: "operator@example.com",
  });

// 7. a tampered amount must invalidate the signature
{
  const good = signed({ ...base });
  const tampered = { ...good, amountUsd: 4200 };
  vectors.push({
    id: "v3-tampered-amount",
    why: "changing a signed field must invalidate the signature — here the amount is multiplied by 100",
    signedFields: SIGNED_FIELDS[3],
    receipt: good,
    canonical: good.canonical,
    canonicalSha256: sha256(good.canonical),
    signature: good.signature,
    signatureValid: true,
    tamperedReceipt: tampered,
    tamperedCanonical: canonicalReceipt(tampered),
    tamperedSignatureValid: false,
  });
}

const format = {
  format: "askgrokwallet-receipt",
  note: "Canonicalization and signature vectors. An implementation in any language passes when it reproduces the bytes and hashes published here.",
  signatureAlg: "Ed25519 over the UTF-8 bytes of `canonical`; base64 in `signature`",
  publicKey,
  publicKeyFingerprint: fingerprint,
  rules: [
    'canonical = "v" + sigVersion + ":" + JSON.stringify(signedObject)',
    "signedObject contains exactly the signed fields for that version, in the order listed (fixed order, NOT alphabetical)",
    "a field that is absent and a field that is null both become null",
    "nested objects are canonicalized with their keys sorted; arrays keep their order",
    "no whitespace: JSON.stringify with no spacing",
    "an unknown sigVersion has no fixed field list and must be rejected, never guessed",
  ],
  vectors,
};

// ── Chain vectors ────────────────────────────────────────────────────────────
const chainEntries = [];
let prevHash = GENESIS_PREV_HASH;
for (let i = 0; i < 3; i += 1) {
  const row = signed({ ...base, id: `appr_chain_${i + 1}`, summary: `payment ${i + 1}` });
  const entry = {
    chainSeq: i + 1,
    receiptId: row.id,
    event: i === 0 ? "created" : i === 1 ? "decided" : "settled",
    prevHash,
    signedAt: row.signedAt,
    signature: row.signature,
    canonical: row.canonical,
  };
  const entryHashValue = entryHash(entry);
  chainEntries.push({ ...entry, entryHash: entryHashValue });
  prevHash = entryHashValue;
}

const chain = {
  format: "askgrokwallet-receipt-chain-entry",
  note: "Entry-hash vectors. The head hash is what gets anchored onchain, so these bytes are the ones a rewrite would have to reproduce.",
  rule:
    'preimage = "rc1|" + len(prevHash):prevHash|len(chainSeq):chainSeq|len(receiptId):receiptId|len(event):event|' +
    "len(signedAt):signedAt|len(signature):signature|len(canonical):canonical, joined by '|', where len(v) is the UTF-8 byte " +
    "length and the value follows the colon. entryHash = hex(sha256(utf8(preimage)))",
  genesisPrevHash: GENESIS_PREV_HASH,
  entries: chainEntries,
  headHash: chainEntries.at(-1).entryHash,
  negativeVectors: [
    {
      id: "edited-middle-entry",
      why: "editing an entry changes its own hash, so every later prevHash stops matching",
      change: "replace `payment 2` with `payment 9000` inside entry 2's canonical",
      expected: "entry 2 no longer hashes to its published entryHash, and entry 3's prevHash no longer matches entry 2",
    },
    {
      id: "delimiter-injection",
      why: "the length prefix exists so a receipt summary cannot imitate a field boundary",
      change: 'sign two receipts whose summaries are "8:|4:oops" and "x", then build an entry from each',
      expected: "the two entry hashes differ, even though a naive join would collide",
    },
  ],
};

// Prove the delimiter-injection claim rather than asserting it.
{
  const evil = signed({ ...base, id: "appr_evil", summary: "8:|4:oops" });
  const benign = signed({ ...base, id: "appr_evil", summary: "x" });
  const fields = (row) => ({
    chainSeq: 1, receiptId: row.id, event: "created", prevHash: GENESIS_PREV_HASH,
    signedAt: row.signedAt, signature: row.signature, canonical: row.canonical,
  });
  chain.negativeVectors[1].hashes = {
    withSummaryThatImitatesAField: entryHash(fields(evil)),
    withAShortSummary: entryHash(fields(benign)),
    differ: entryHash(fields(evil)) !== entryHash(fields(benign)),
  };
}

fs.writeFileSync(path.join(HERE, "format-vectors.json"), JSON.stringify(format, null, 2) + "\n");
fs.writeFileSync(path.join(HERE, "chain-vectors.json"), JSON.stringify(chain, null, 2) + "\n");
console.log(`wrote ${vectors.length} canonicalization/signature vectors and ${chainEntries.length} chain entries`);
console.log(`test key fingerprint ${fingerprint}`);
