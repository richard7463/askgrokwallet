#!/usr/bin/env node
// Hermetic test for the audit bundle: seal, open, verify — and four ways an operator
// could lie, each of which the verifier must refuse.
//
//   node spec/audit-bundle.test.mjs
//
// No network: the "log" is built here from the shipped example receipt using the same
// rules the published chain follows, so this runs anywhere and fails loudly if either
// side of the format drifts.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = HERE; // this file lives in spec/ alongside the verifier it tests
const INFO = Buffer.from("askgrokwallet-audit-bundle-v1", "utf8");
const GENESIS = "0".repeat(64);

let failures = 0;
const t = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `\n     ${detail.trim().replace(/\n/g, "\n     ")}` : ""}`);
};

// ── the rules, restated ─────────────────────────────────────────────────────
const canonicalValue = (value) => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
};
const SIGNED_FIELDS_V3 = [
  "id", "summary", "amountUsd", "requester", "target", "policyId", "source", "mode", "intentKind",
  "verdict", "reason", "status", "decision", "decidedBy",
  "execute", "rail", "railRef", "txHash", "executionError",
  "createdAt", "decidedAt", "settledAt",
];
const canonical = (row) => {
  const obj = {};
  for (const key of SIGNED_FIELDS_V3) obj[key] = canonicalValue(row[key]);
  return `v3:${JSON.stringify(obj)}`;
};
const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const prefixed = (value) => {
  const s = String(value ?? "");
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
};
const entryHash = (entry) => sha256(["rc1",
  prefixed(entry.prevHash), prefixed(entry.chainSeq), prefixed(entry.receiptId), prefixed(entry.event),
  prefixed(entry.signedAt), prefixed(entry.signature), prefixed(entry.canonical),
].join("|"));

// ── a fixture: the shipped example receipt, placed in a one-entry log ────────
const receipt = JSON.parse(fs.readFileSync(path.join(SPEC, "example-receipt.json"), "utf8"));
const entry = {
  chainSeq: 1,
  receiptId: receipt.id,
  event: "imported",
  prevHash: GENESIS,
  signedAt: receipt.signedAt,
  signature: receipt.signature,
  canonical: canonical(receipt),
};
const headHash = entryHash(entry);
const publicEntry = { ...entry, entryHash: headHash };
delete publicEntry.canonical;
delete publicEntry.signature;
const anchor = {
  chainSeq: 1, headHash, txHash: `0x${"ab".repeat(32)}`, chainId: "11155111",
  contractAddress: `0x${"cd".repeat(20)}`, anchoredAt: "2026-09-18T00:00:00.000Z",
};
const publicKey = JSON.parse(
  fs.readFileSync(path.join(SPEC, "vectors", "format-vectors.json"), "utf8"),
).publicKey;
const receiptPublicKey = "MCowBQYDK2VwAyEAPMtfRKoPgy0UaEHA4iWsHAns7gpEepBX9NQhzyITL4w="; // the production key that signed the example

const basePayload = {
  bundleVersion: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  api: "https://askgrokwallet.io",
  receipts: [receipt],
  receiptPublicKey,
  receiptPublicKeyOrigin: "fixture",
  log: { length: 1, headHash, intact: true, entries: [publicEntry], anchors: [anchor] },
};

// ── sealing, as the operator side does it ───────────────────────────────────
const auditor = crypto.generateKeyPairSync("x25519");
const auditorPublic = auditor.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const auditorPrivate = auditor.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

function seal(payload, publicKeyBase64 = auditorPublic) {
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: crypto.createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" }),
  });
  const salt = crypto.randomBytes(32);
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, salt, INFO, 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  return {
    format: "askgrokwallet-audit-bundle", version: 1, scheme: "X25519-HKDF-SHA256-AES-256-GCM",
    issuedAt: "2026-09-18T00:00:00.000Z",
    ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    salt: salt.toString("base64"), iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agw-audit-"));
const keyFile = path.join(tmp, "auditor.key.json");
fs.writeFileSync(keyFile, JSON.stringify({ privateKey: auditorPrivate, publicKey: auditorPublic }));

const verify = (bundle) => {
  const file = path.join(tmp, `bundle-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2));
  const run = spawnSync(process.execPath, [path.join(SPEC, "verify-audit-bundle.mjs"), file, `--viewing-key=${keyFile}`], { encoding: "utf8" });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
};
const caughtBy = (out, needle) => out.split("\n").find((l) => l.startsWith("✗") && l.includes(needle)) ?? "";

// ── the honest bundle ───────────────────────────────────────────────────────
const good = verify(seal(basePayload));
t("an honest bundle verifies", good.code === 0, good.out);
t("the seal opens", /✓ the seal opens with this viewing key/.test(good.out), good.out);
t("the receipt is located in the log", /in the log — entry 1 of 1/.test(good.out), good.out);
t("the anchor is checked against the log head", /anchored —/.test(good.out), good.out);
t("the omission limit is stated in the output", /does NOT prove: that the log contains every action/.test(good.out), good.out);

// ── the four ways an operator could lie ─────────────────────────────────────

const edited = verify(seal({ ...basePayload, receipts: [{ ...receipt, amountUsd: Number(receipt.amountUsd) * 100 }] }));
t("a receipt edited after signing is caught", edited.code === 1 && caughtBy(edited.out, "signature") !== "", edited.out);

const inventedId = verify(seal({ ...basePayload, receipts: [{ ...receipt, id: "appr_invented" }] }));
t("a receipt the operator invented is caught", inventedId.code === 1 && caughtBy(inventedId.out, "signature") !== "", inventedId.out);

const truncated = verify(seal({
  ...basePayload,
  log: { ...basePayload.log, length: 0, headHash: GENESIS, entries: [], anchors: [] },
}));
t("a log with the receipt's entry removed is caught", truncated.code === 1 && caughtBy(truncated.out, "no entry for") !== "", truncated.out);

const badAnchor = verify(seal({
  ...basePayload,
  log: { ...basePayload.log, anchors: [{ ...anchor, headHash: "f".repeat(64) }] },
}));
t("an anchor that does not match the log head is caught", badAnchor.code === 1 && caughtBy(badAnchor.out, "anchor claims head") !== "", badAnchor.out);

// ── the seal itself ─────────────────────────────────────────────────────────
const otherKey = crypto.generateKeyPairSync("x25519");
const wrongKeyFile = path.join(tmp, "wrong.key.json");
fs.writeFileSync(wrongKeyFile, JSON.stringify({
  privateKey: otherKey.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  publicKey: otherKey.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
}));
{
  const file = path.join(tmp, "sealed.json");
  fs.writeFileSync(file, JSON.stringify(seal(basePayload), null, 2));
  const run = spawnSync(process.execPath, [path.join(SPEC, "verify-audit-bundle.mjs"), file, `--viewing-key=${wrongKeyFile}`], { encoding: "utf8" });
  t("a bundle does not open with the wrong viewing key", run.status === 1 && /does not open/.test(run.stdout + run.stderr), run.stdout + run.stderr);
}
{
  const bundle = seal(basePayload);
  const bytes = Buffer.from(bundle.ciphertext, "base64");
  bytes[0] ^= 0x01;
  const run = verify({ ...bundle, ciphertext: bytes.toString("base64") });
  t("a bundle altered after sealing does not open", run.code === 1 && /does not open/.test(run.out), run.out);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
