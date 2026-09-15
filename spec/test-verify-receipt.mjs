#!/usr/bin/env node
// Behaviour test for spec/verify-receipt.mjs. No dependencies, no network, no
// fixtures to install:
//
//   node spec/test-verify-receipt.mjs
//
// It builds a receipt signed by a throwaway key, publishes a one-entry log and an
// anchor record on a local stub server, then runs the verifier as a separate
// process against that stub and reads what it printed. The point is behaviour:
// what the released file says for each shape a node can answer with.
//
// The second case is the one that matters most. A node answers
// eth_getTransactionByHash for a transaction that is still in the mempool with
// `blockNumber: null`, and `Number(null)` is 0 — so an earlier build printed
// "block 0" and read as "genuine, and fixed onchain". That was a real bug,
// reported from outside against the demo, and this file is the repro kept as a
// test: a broadcast anchor must never be called fixed.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(HERE, "verify-receipt.mjs");
const GENESIS_PREV_HASH = "0".repeat(64);
const CONTRACT = "0x00000000000000000000000000000000000000ff";
const ANCHOR_TX = "0xfeed000000000000000000000000000000000000000000000000000000000002";
const CHAIN_ID = "84532";

let failures = 0;
function t(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `\n     ${detail.trim().replace(/\n/g, "\n     ")}` : ""}`);
}

// ── Receipt canonicalization, restated from the spec (v3: 22 fields) ─────────
const SIGNED_FIELDS_V3 = [
  "id", "summary", "amountUsd", "requester", "target", "policyId", "source", "mode", "intentKind",
  "verdict", "reason", "status", "decision", "decidedBy",
  "execute", "rail", "railRef", "txHash", "executionError",
  "createdAt", "decidedAt", "settledAt",
];

function canonicalValue(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
}

function canonicalReceipt(row) {
  const obj = {};
  for (const key of SIGNED_FIELDS_V3) obj[key] = canonicalValue(row[key]);
  return `v3:${JSON.stringify(obj)}`;
}

function lengthPrefixed(value) {
  const s = String(value ?? "");
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
}

function chainEntryHash(entry) {
  const preimage = [
    "rc1",
    lengthPrefixed(entry.prevHash),
    lengthPrefixed(entry.chainSeq),
    lengthPrefixed(entry.receiptId),
    lengthPrefixed(entry.event),
    lengthPrefixed(entry.signedAt),
    lengthPrefixed(entry.signature),
    lengthPrefixed(entry.canonical),
  ].join("|");
  return crypto.createHash("sha256").update(preimage, "utf8").digest("hex");
}

// ── A receipt, signed by a key that exists only for this run ─────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

const signedAt = new Date("2026-09-15T00:00:00.000Z").toISOString();
const receipt = {
  id: "appr_repro_001",
  summary: "Pay the invoice from the repro",
  amountUsd: 42,
  requester: "agent",
  target: "vendor",
  policyId: "policy-1",
  source: "demo",
  mode: "ask",
  intentKind: "payment",
  verdict: "ask",
  reason: "over the auto-allow threshold",
  status: "settled",
  decision: "approve",
  decidedBy: "operator@example.com",
  execute: { to: CONTRACT, asset: "USDC", chainId: Number(CHAIN_ID), amountUsd: 42 },
  rail: `evm:${CHAIN_ID}`,
  railRef: ANCHOR_TX,
  txHash: ANCHOR_TX,
  executionError: null,
  createdAt: signedAt,
  decidedAt: signedAt,
  settledAt: signedAt,
  sigAlg: "ED25519",
  sigVersion: 3,
  signedAt,
};
receipt.signature = crypto.sign(null, Buffer.from(canonicalReceipt(receipt), "utf8"), privateKey).toString("base64");

// The published entry for that receipt: fingerprints plus the head hash the
// anchor below commits to.
const entry = {
  chainSeq: 1,
  receiptId: receipt.id,
  event: "created",
  prevHash: GENESIS_PREV_HASH,
  signedAt,
  signature: receipt.signature,
  canonical: canonicalReceipt(receipt),
};
const headHash = chainEntryHash(entry);
const publishedEntry = { ...entry, entryHash: headHash };
delete publishedEntry.canonical;
delete publishedEntry.signature;

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-receipt-test-"));
const receiptPath = path.join(workdir, "receipt.json");
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

// ── Stub node + stub log. `anchorBlock: null` is the mempool shape. ──────────
let anchorBlock = "0xb1600f";
let anchorStatus = "0x1";
let calldataHead = headHash;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  const json = (obj) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith("/api/receipts/chain")) {
    return json({
      ok: true,
      length: 1,
      headHash,
      intact: true,
      anchors: [{
        chainSeq: 1,
        headHash,
        txHash: ANCHOR_TX,
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        anchoredAt: signedAt,
      }],
      entries: [publishedEntry],
    });
  }
  if (req.url.startsWith("/rpc") && body?.method === "eth_getTransactionByHash") {
    return json({ jsonrpc: "2.0", id: body.id, result: { to: CONTRACT, input: `0xdeadbeef${calldataHead}`, blockNumber: anchorBlock } });
  }
  if (req.url.startsWith("/rpc") && body?.method === "eth_getTransactionReceipt") {
    return json({ jsonrpc: "2.0", id: body.id, result: anchorBlock ? { blockNumber: anchorBlock, status: anchorStatus } : null });
  }
  res.writeHead(404);
  res.end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// The stub lives in this process, so the verifier has to run as a child; a
// blocking spawnSync here would deadlock waiting for a server that cannot answer.
function verify(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VERIFIER, receiptPath, ...args], { encoding: "utf8" });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

const online = [`--api=${origin}`, `--rpc=${origin}/rpc`, `--key=${publicKeyB64}`];

// ── 1. The happy path, so a failure below means the case is wrong, not the setup.
const mined = await verify(online);
t("a mined, successful anchor reads as fixed onchain", /onchain\s+✓/.test(mined.out) && /verdict\s+✓/.test(mined.out), mined.out);

// ── 2. The reported bug: broadcast but not in a block yet.
anchorBlock = null;
const pending = await verify(online);
t("a broadcast anchor is not called fixed onchain", /onchain\s+~/.test(pending.out), pending.out);
t("a broadcast anchor does not print block 0", !/block 0\b/.test(pending.out), pending.out);
t("a broadcast anchor does not get the genuine-and-fixed verdict", !/verdict\s+✓/.test(pending.out), pending.out);
anchorBlock = "0xb1600f";

// ── 3. Mined, but the anchor transaction reverted: the head is in calldata and
// nothing is in the contract.
anchorStatus = "0x0";
const reverted = await verify(online);
t("a reverted anchor is not called fixed onchain", /onchain\s+~/.test(reverted.out) && !/verdict\s+✓/.test(reverted.out), reverted.out);
t("a reverted anchor says it reverted", /REVERTED/i.test(reverted.out), reverted.out);
anchorStatus = "0x1";

// ── 4. An anchor whose calldata does not contain the head is a different claim
// entirely — that is the issuer lying, and it stays fatal.
calldataHead = "f".repeat(64);
const wrongHead = await verify(online);
t("an anchor missing the head is still called wrong", /onchain\s+✗/.test(wrongHead.out) && wrongHead.code === 1, wrongHead.out);
calldataHead = headHash;

// ── 5. Tampering is caught offline, with no server involved at all.
const tamperedPath = path.join(workdir, "tampered.json");
fs.writeFileSync(tamperedPath, JSON.stringify({ ...receipt, amountUsd: 4200, signature: receipt.signature }, null, 2));
const tampered = await new Promise((resolve) => {
  const child = spawn(process.execPath, [VERIFIER, tamperedPath, "--offline", `--key=${publicKeyB64}`]);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => resolve({ code, out }));
});
t("an edited amount fails the signature", /signature\s+✗/.test(tampered.out) && tampered.code === 1, tampered.out);

// ── 6. The offline path must not need the network even when it is offered one.
const offline = await verify(["--offline", `--key=${publicKeyB64}`]);
t("--offline checks the signature and skips the rest", /signature\s+✓/.test(offline.out) && /skipped \(--offline\)/.test(offline.out), offline.out);

// ── 7. Version and self-hash, which is how two people compare notes.
const version = await new Promise((resolve) => {
  const child = spawn(process.execPath, [VERIFIER, "--version"]);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.on("close", () => resolve(out));
});
const reportedHash = (version.match(/sha256 ([0-9a-f]{64})/) ?? [])[1];
const actualHash = crypto.createHash("sha256").update(fs.readFileSync(VERIFIER)).digest("hex");
t("--version reports the sha256 of this file", reportedHash === actualHash, `${version}actual ${actualHash}`);

server.close();
fs.rmSync(workdir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
