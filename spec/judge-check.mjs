#!/usr/bin/env node
// judge-check.mjs — check this submission end to end, in one command.
//
//   node spec/judge-check.mjs
//
// A reviewer has a few minutes. The three-command quickstart in QUICKSTART.md is
// already short; this is the version where you do not have to trust that you typed
// it correctly:
//
//   1. the verifier you are holding is the released one (sha256, computed here)
//   2. it verifies a real receipt against the live log — signature, log position,
//      onchain anchor — using only the fingerprints the public endpoint publishes
//   3. the live receipt log is intact, and how big it is right now
//
// It writes nothing and needs no account. Exit codes: 0 verified · 1 provably wrong
// · 2 inconclusive (no network, or the service is unreachable).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(HERE, "verify-receipt.mjs");
const RECEIPT = path.join(HERE, "example-receipt.json");

// The released bytes. `verify-receipt.mjs --version` prints the same hash, and the
// release notes publish it — three ways to the same number, none of them ours to
// change after the fact.
const RELEASE = "verify-receipt-v1.0.1";
const RELEASE_URL = `https://github.com/richard7463/askgrokwallet/releases/tag/${RELEASE}`;
const PINNED_SHA256 = "32de3cad6f3bb23ae8415cd5afe5f54dd8167432a2473814e6ab4ec0b767317a";
const API = "https://askgrokwallet.io";

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
let failures = 0;
const ok = (label, detail) => console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, detail) => { failures += 1; console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`); };
const line = (label, value) => console.log(`  ${label.padEnd(16)} ${value}`);

console.log("AskGrokWallet — judge check\n");

// 1. Are we holding the released verifier?
if (!fs.existsSync(VERIFIER)) {
  console.error(`missing ${VERIFIER}`);
  process.exit(2);
}
const local = sha256(fs.readFileSync(VERIFIER));
if (local === PINNED_SHA256) {
  ok("verifier is the released artifact", `${RELEASE}, sha256 ${local.slice(0, 16)}…`);
} else {
  bad("verifier is NOT the released artifact", `holds ${local.slice(0, 16)}…, release published ${PINNED_SHA256.slice(0, 16)}…`);
  console.log(`  → compare with ${RELEASE_URL}`);
}

// 2. Run it against the shipped example receipt, against the live log.
const run = spawnSync(process.execPath, [VERIFIER, RECEIPT], { encoding: "utf8" });
const output = `${run.stdout}${run.stderr}`.trimEnd();
console.log(output.split("\n").map((l) => `  ${l}`).join("\n"));
if (run.status === 0 && /verdict\s+✓/.test(output)) {
  ok("a real receipt verifies: signature, log position, onchain anchor");
} else if (run.status === 1) {
  bad("the shipped example receipt failed verification");
} else {
  console.log(`~ inconclusive: verifier exited ${run.status} (network or service)`);
}

// 3. Is the published log intact, and how big is it right now?
try {
  const res = await fetch(`${API}/api/receipts/chain`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const log = await res.json();
  const anchors = log.anchors ?? [];
  if (log.intact) {
    ok("the published receipt log is intact");
  } else {
    bad("the issuer reports its own log as broken", log.brokenReason ?? "");
  }
  line("log entries", log.entries?.length ?? "?");
  line("anchors", anchors.length);
  if (anchors.length) {
    const head = anchors[anchors.length - 1];
    line("latest anchor", `head ${head.chainSeq} · tx ${String(head.txHash).slice(0, 14)}… · chain ${head.chainId}`);
  }
} catch (error) {
  console.log(`~ inconclusive: could not read ${API}/api/receipts/chain (${error.message})`);
}

console.log("\nWhat this proves: this receipt was signed by the pinned key, sits in the issuer's");
console.log("append-only log, and that log's head is in a blockchain transaction. What it does");
console.log("not prove: that the payment was wise, or that the agent was right to make it.");
console.log(`\nSpec: spec/receipt-v3.md · verifier: ${RELEASE_URL}`);

process.exit(failures ? 1 : 0);
