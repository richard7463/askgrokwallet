#!/usr/bin/env node
// Check a receipt-format implementation against the published vectors.
//
//   node spec/vectors/run-vectors.mjs
//
// Two different things get checked, and they fail for different reasons:
//
//   1. The rules written down in the vector files, implemented fresh here, reproduce
//      every published canonical string, hash and signature. If this fails, the vectors
//      and the written rules disagree — and the rules are what another language would
//      implement, so that is the bug that matters.
//   2. The released verifier (spec/verify-receipt.mjs) prints what the vectors say it
//      should for each receipt. This is the link between the published expectations and
//      the artifact people actually download.
//
// No dependencies, no network. Exit 0 = everything agrees, 1 = something does not.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.resolve(HERE, "..");
const CHAIN_VERSION = 1;

let failures = 0;
const ok = (label, detail = "") => console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, detail = "") => { failures += 1; console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`); };

const format = JSON.parse(fs.readFileSync(path.join(HERE, "format-vectors.json"), "utf8"));
const chain = JSON.parse(fs.readFileSync(path.join(HERE, "chain-vectors.json"), "utf8"));

// ── The rules, implemented from the vector files' own text ───────────────────
const canonicalValue = (value) => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
};

const canonical = (row, signedFields) => {
  const obj = {};
  for (const key of signedFields) obj[key] = canonicalValue(row[key]);
  return `v${Number(row.sigVersion)}:${JSON.stringify(obj)}`;
};

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

const verifies = (row, canonicalString, signature, publicKey) => crypto.verify(
  null,
  Buffer.from(canonicalString, "utf8"),
  crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }),
  Buffer.from(signature, "base64"),
);

// ── 1. the vectors agree with the written rules ──────────────────────────────
console.log(`format vectors — key ${format.publicKeyFingerprint}\n`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agw-vectors-"));

for (const vector of format.vectors) {
  const signedFields = vector.signedFields;
  const mine = canonical(vector.receipt, signedFields);
  const hash = sha256(mine);
  const sigOk = verifies(vector.receipt, mine, vector.signature, format.publicKey);

  const problems = [];
  if (mine !== vector.canonical) problems.push("canonical bytes differ");
  if (hash !== vector.canonicalSha256) problems.push("canonical hash differs");
  if (sigOk !== vector.signatureValid) problems.push(`signature ${sigOk ? "verifies" : "fails"} but the vector says ${vector.signatureValid}`);

  if (vector.equivalentReceipt) {
    const other = canonical(vector.equivalentReceipt, signedFields);
    if ((other === mine) !== vector.equivalentCanonicalEqualsCanonical) {
      problems.push("the 'equivalent receipt' expectation is wrong");
    }
  }
  if (vector.tamperedReceipt) {
    const tampered = canonical(vector.tamperedReceipt, signedFields);
    if (tampered !== vector.tamperedCanonical) problems.push("tampered canonical bytes differ");
    const tamperedOk = verifies(vector.tamperedReceipt, tampered, vector.signature, format.publicKey);
    if (tamperedOk !== vector.tamperedSignatureValid) problems.push("tampered signature expectation is wrong");
  }

  if (problems.length) bad(vector.id, problems.join("; "));
  else ok(vector.id, vector.why.slice(0, 70) + (vector.why.length > 70 ? "…" : ""));
}

// ── 2. the released verifier agrees with the vectors ─────────────────────────
console.log("\nreleased verifier — spec/verify-receipt.mjs against the same vectors\n");

const runVerifier = (row, extraArgs = []) => {
  const file = path.join(tmp, `${row.id}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(row, null, 2));
  const run = spawnSync(process.execPath, [path.join(SPEC, "verify-receipt.mjs"), file, "--offline", `--key=${format.publicKey}`, ...extraArgs], { encoding: "utf8" });
  return `${run.stdout}${run.stderr}`;
};

for (const vector of format.vectors) {
  const output = runVerifier(vector.receipt);
  const expected = vector.signatureValid ? "✓" : "✗";
  const line = (output.split("\n").find((l) => l.startsWith("signature")) ?? "").trim();
  if (line.includes(` ${expected} `)) ok(`verifier · ${vector.id}`, line.slice(0, 70));
  else bad(`verifier · ${vector.id}`, `expected a ${expected} on the signature line, got: ${line || output.trim().slice(0, 80)}`);

  if (vector.tamperedReceipt) {
    const tampered = runVerifier({ ...vector.tamperedReceipt, id: `${vector.id}-tampered` });
    const line2 = (tampered.split("\n").find((l) => l.startsWith("signature")) ?? "").trim();
    if (line2.includes(" ✗ ")) ok(`verifier · ${vector.id} (tampered)`, line2.slice(0, 70));
    else bad(`verifier · ${vector.id} (tampered)`, `expected ✗, got: ${line2 || tampered.trim().slice(0, 80)}`);
  }
}

// ── 3. chain vectors ────────────────────────────────────────────────────────
console.log("\nchain vectors\n");

let prev = chain.genesisPrevHash;
for (const entry of chain.entries) {
  const mine = entryHash(entry);
  const problems = [];
  if (entry.prevHash !== prev) problems.push(`prevHash is ${entry.prevHash.slice(0, 12)}… but the previous entry hashes to ${prev.slice(0, 12)}…`);
  if (mine !== entry.entryHash) problems.push("entry hash differs");
  if (problems.length) bad(`chain entry ${entry.chainSeq}`, problems.join("; "));
  else ok(`chain entry ${entry.chainSeq} (${entry.event})`, mine.slice(0, 24) + "…");
  prev = mine;
}
if (prev === chain.headHash) ok("head hash is the last entry", chain.headHash.slice(0, 24) + "…");
else bad("head hash", "does not match the last entry");

const edited = chain.entries.map((e, i) => (i === 1 ? { ...e, canonical: e.canonical.replace("payment 2", "payment 9000") } : e));
if (entryHash(edited[1]) !== chain.entries[1].entryHash) {
  ok("an edited entry no longer hashes to its published value", "so every later prevHash stops matching");
} else {
  bad("an edited entry still hashes to its published value");
}

const injection = chain.negativeVectors.find((v) => v.id === "delimiter-injection");
if (injection?.hashes?.differ) {
  ok("a summary that imitates a field boundary does not collide", "length prefixes, not separators, carry the structure");
} else {
  bad("delimiter-injection expectations missing from chain-vectors.json");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} DISAGREEMENT${failures === 1 ? "" : "S"}` : "\nevery vector agrees with the rules and with the released verifier");
process.exit(failures ? 1 : 0);
