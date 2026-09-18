#!/usr/bin/env node
// Audit an AskGrokWallet audit bundle. You are the auditor: you hold the private half of
// the viewing key, you get one file, and you decide.
//
//   node spec/verify-audit-bundle.mjs audit-bundle.json --viewing-key=auditor.key.json
//   node spec/verify-audit-bundle.mjs audit-bundle.json --viewing-key=… --rpc=<url>
//
// What it proves, in order:
//   1. the seal opens with YOUR key — nothing here was readable by anyone else, and the
//      file has not been altered since it was sealed
//   2. every receipt's signature verifies against the key that signed it
//   3. every receipt is an entry in the bundled log — recomputed from the receipt itself,
//      not taken on trust — and the entries link to each other back to entry 1
//   4. the head of that log is anchored in a blockchain transaction (in a block, and
//      successful — a broadcast-only or reverted anchor reads as inconclusive, never as
//      fixed)
//
// What it does NOT prove, and this file says so out loud at the end: that the log contains
// every action the operator's agents took. The chain proves nothing in it was altered or
// removed; omission is a different problem, and it needs the enforcement point to refuse an
// action that was never logged.
//
// Zero dependencies, Node 18+.

import crypto from "node:crypto";
import fs from "node:fs";

const INFO = Buffer.from("askgrokwallet-audit-bundle-v1", "utf8");
const GENESIS_PREV_HASH = "0".repeat(64);
const CHAIN_VERSION = 1;
const PINNED_PRODUCTION_KEY = "MCowBQYDK2VwAyEAPMtfRKoPgy0UaEHA4iWsHAns7gpEepBX9NQhzyITL4w=";

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

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}

let failures = 0;
const ok = (label, detail = "") => console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, detail = "") => { failures += 1; console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`); };
const notChecked = (label, detail = "") => console.log(`~ ${label}${detail ? ` — ${detail}` : ""}`);

// ── canonicalization and hashing, restated from the spec ─────────────────────
const canonicalValue = (value) => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
};

function canonicalReceipt(row) {
  const version = Number(row.sigVersion);
  const fields = SIGNED_FIELDS[version];
  if (!fields) throw new Error(`unsupported sigVersion ${row.sigVersion}`);
  const obj = {};
  for (const key of fields) obj[key] = canonicalValue(row[key]);
  return `v${version}:${JSON.stringify(obj)}`;
}

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const lengthPrefixed = (value) => {
  const s = String(value ?? "");
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
};
const entryHash = (entry) => sha256(["rc1",
  lengthPrefixed(entry.prevHash), lengthPrefixed(entry.chainSeq), lengthPrefixed(entry.receiptId),
  lengthPrefixed(entry.event), lengthPrefixed(entry.signedAt), lengthPrefixed(entry.signature),
  lengthPrefixed(entry.canonical),
].join("|"));

const fingerprint = (b64) => sha256(Buffer.from(b64, "base64").toString("binary")).slice(0, 16);
const fingerprintHex = (b64) => crypto.createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").slice(0, 16);
const short = (value) => `${String(value).slice(0, 12)}…`;

// ── 1. open the seal ─────────────────────────────────────────────────────────
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const keyFile = arg("viewing-key");
const rpc = arg("rpc");
if (!file) {
  console.error("usage: node verify-audit-bundle.mjs audit-bundle.json --viewing-key=auditor.key.json [--rpc=<url>]");
  process.exit(2);
}
if (!keyFile) {
  console.error("verify-audit-bundle: --viewing-key=<file from keygen> is required; the seal is not readable without it");
  process.exit(2);
}

const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
if (bundle.format !== "askgrokwallet-audit-bundle") {
  console.error(`verify-audit-bundle: ${file} is not an audit bundle (format=${bundle.format})`);
  process.exit(2);
}
const viewing = JSON.parse(fs.readFileSync(keyFile, "utf8"));

let payload;
try {
  const ephemeralPublic = crypto.createPublicKey({ key: Buffer.from(bundle.ephemeralPublicKey, "base64"), format: "der", type: "spki" });
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(viewing.privateKey, "base64"), format: "der", type: "pkcs8" });
  const shared = crypto.diffieHellman({ privateKey, publicKey: ephemeralPublic });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(bundle.salt, "base64"), INFO, 32));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(bundle.iv, "base64"));
  decipher.setAuthTag(Buffer.from(bundle.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(bundle.ciphertext, "base64")), decipher.final()]);
  payload = JSON.parse(plaintext.toString("utf8"));
  ok("the seal opens with this viewing key", `${bundle.scheme} · sealed ${bundle.issuedAt}`);
} catch (error) {
  bad("the seal does not open with this viewing key", `${error.message} — wrong key, or the file was altered after it was sealed`);
  console.log("\nNothing further can be checked: every check below needs the contents.");
  process.exit(1);
}

// ── 2. the bundled log ───────────────────────────────────────────────────────
const entries = payload.log?.entries ?? [];
const anchors = payload.log?.anchors ?? [];
console.log(`\nbundle: ${payload.receipts.length} receipt(s) · log ${entries.length} entries · ${anchors.length} anchor(s) · issued by ${payload.api}\n`);

if (!entries.length) {
  bad("the bundled log is empty");
} else {
  let prev = GENESIS_PREV_HASH;
  let linked = true;
  for (const [index, entry] of entries.entries()) {
    if (Number(entry.chainSeq) !== index + 1 || entry.prevHash !== prev) { linked = false; break; }
    prev = entry.entryHash;
  }
  if (linked && prev === payload.log.headHash && entries.at(-1).entryHash === payload.log.headHash) {
    ok("the bundled log links back to entry 1", `head ${short(payload.log.headHash)}`);
  } else {
    bad("the bundled log does not link back to entry 1", "an entry was removed, reordered or edited");
  }
  if (payload.log.intact === false) {
    notChecked("the issuer reports its own log as broken", "their self-report, not your arithmetic");
  }
}

// ── 3. each receipt: signature, membership, anchoring ────────────────────────
const receiptKey = payload.receiptPublicKey;
if (receiptKey && fingerprintHex(receiptKey) !== fingerprintHex(PINNED_PRODUCTION_KEY)) {
  notChecked("the bundled receipts were signed by a key this file does not pin",
    `bundle key ${fingerprintHex(receiptKey)}, pinned ${fingerprintHex(PINNED_PRODUCTION_KEY)} — confirm the rotation before trusting the signatures`);
}

const anchoredHeads = new Set(anchors.map((a) => a.headHash));
const coveringAnchor = (seq) => anchors
  .filter((a) => Number(a.chainSeq) >= Number(seq))
  .sort((a, b) => Number(a.chainSeq) - Number(b.chainSeq))[0];

const checkAnchorOnchain = async (anchor, entry) => {
  if (!rpc) return { mark: "~", note: "pass --rpc=<url> to check the anchor transaction" };
  try {
    const call = async (method, params) => {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return (await res.json()).result;
    };
    const tx = await call("eth_getTransactionByHash", [anchor.txHash]);
    if (!tx) return { mark: "✗", note: `anchor tx ${short(anchor.txHash)} is not on chain ${anchor.chainId}` };
    if (String(tx.to).toLowerCase() !== String(anchor.contractAddress).toLowerCase()) {
      return { mark: "✗", note: `anchor tx goes to ${tx.to}, not the stated contract` };
    }
    if (!String(tx.input).toLowerCase().includes(String(entry.entryHash).toLowerCase())) {
      return { mark: "✗", note: "anchor tx does not contain this log head" };
    }
    if (tx.blockNumber === null || tx.blockNumber === undefined || tx.blockNumber === "") {
      return { mark: "~", pending: true, note: "the anchor is broadcast but not in a block yet — not fixed" };
    }
    const receipt = await call("eth_getTransactionReceipt", [anchor.txHash]);
    if (receipt && receipt.status != null && String(receipt.status) !== "0x1") {
      return { mark: "~", reverted: true, note: `anchor tx is in block ${Number(tx.blockNumber)} but it reverted` };
    }
    return { mark: "✓", note: `block ${Number(receipt?.blockNumber ?? tx.blockNumber)} · chain ${anchor.chainId}` };
  } catch (error) {
    return { mark: "~", note: `RPC unreachable: ${error.message}` };
  }
};

for (const receipt of payload.receipts) {
  const label = `${receipt.id} (${receipt.status ?? "?"}${receipt.amountUsd != null ? ` · $${receipt.amountUsd}` : ""})`;
  let canonical;
  try {
    canonical = canonicalReceipt(receipt);
  } catch (error) {
    bad(`${label} · unsupported`, error.message);
    continue;
  }

  // signature
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      null,
      Buffer.from(canonical, "utf8"),
      crypto.createPublicKey({ key: Buffer.from(receiptKey, "base64"), format: "der", type: "spki" }),
      Buffer.from(receipt.signature, "base64"),
    );
  } catch { /* reported below */ }
  if (!signatureOk) {
    bad(`${label} · signature`, "does not verify — this receipt was altered, or it is not theirs");
    continue;
  }
  ok(`${label} · signature`, `key ${fingerprintHex(receiptKey)}`);

  // membership: recompute the entry hash from the receipt itself
  const mine = entries
    .filter((e) => e.receiptId === receipt.id)
    .map((e) => ({ entry: e, hash: entryHash({ ...e, signedAt: receipt.signedAt, signature: receipt.signature, canonical }) }))
    .filter(({ entry, hash }) => hash === entry.entryHash);
  if (!mine.length) {
    const candidates = entries.filter((e) => e.receiptId === receipt.id).length;
    bad(`${label} · in the log`, candidates
      ? `${candidates} entr${candidates === 1 ? "y" : "ies"} for this id, none matching the receipt's contents`
      : "no entry for this receipt in the bundled log");
    continue;
  }
  const latest = mine.at(-1);
  ok(`${label} · in the log`, `entry ${latest.entry.chainSeq} of ${entries.length} (${latest.entry.event})`);

  // anchoring
  const anchor = coveringAnchor(latest.entry.chainSeq);
  if (!anchor) {
    notChecked(`${label} · anchored`, "no anchor covers this entry yet");
    continue;
  }
  const anchoredEntry = entries.find((e) => Number(e.chainSeq) === Number(anchor.chainSeq));
  if (!anchoredEntry || anchoredEntry.entryHash !== anchor.headHash) {
    bad(`${label} · anchored`, `the anchor claims head ${short(anchor.headHash)}, which is not entry ${anchor.chainSeq}`);
    continue;
  }
  const onchain = await checkAnchorOnchain(anchor, anchoredEntry);
  if (onchain.mark === "✓") ok(`${label} · anchored`, onchain.note);
  else if (onchain.mark === "✗") bad(`${label} · anchored`, onchain.note);
  else notChecked(`${label} · anchored`, onchain.note);
}

if (anchors.length && !anchoredHeads.size) {
  bad("anchors present but none has a head hash");
}

// ── 4. the part every audit report should end with ───────────────────────────
console.log([
  "",
  "What this proves: these receipts are unaltered, they sit in the log the operator published,",
  "and that log's head is anchored in a blockchain transaction — all recomputed here, not taken",
  "on trust.",
  "",
  "What it does NOT prove: that the log contains every action the operator's agents took.",
  "The chain rules out alteration and removal of what is in it; it cannot rule out omission.",
  "That needs the enforcement point to refuse an action that was never logged.",
].join("\n"));

process.exit(failures ? 1 : 0);
