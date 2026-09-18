#!/usr/bin/env node
// Build an audit bundle: your receipts, plus the public log evidence that they were not
// altered afterwards, sealed to an auditor's public key.
//
//   node spec/make-audit-bundle.mjs keygen --out auditor.key.json
//   node spec/make-audit-bundle.mjs export --auditor-key=<base64 spki> \
//        --receipts=receipt-1.json,receipt-2.json --out=audit-bundle.json
//   node spec/make-audit-bundle.mjs export --from-api --receipt-id=appr_… --out=…
//
// The auditor generates the key pair and sends you the PUBLIC half. You never hold their
// private half, and they never need your API token: everything the verifier needs is
// either in the bundle or checked against the chain.
//
//   auditor:  node spec/make-audit-bundle.mjs keygen --out auditor.key.json
//             …sends you the "publicKey" field…
//   you:      node spec/make-audit-bundle.mjs export --auditor-key=<that value> …
//   auditor:  node spec/verify-audit-bundle.mjs audit-bundle.json --viewing-key=auditor.key.json
//
// Zero dependencies: X25519 ECDH → HKDF-SHA256 → AES-256-GCM, all Node built-ins, same
// construction any other language can reproduce.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_API = "https://askgrokwallet.io";
const SCHEME = "X25519-HKDF-SHA256-AES-256-GCM";
const INFO = Buffer.from("askgrokwallet-audit-bundle-v1", "utf8");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
function fail(message) {
  console.error(`audit-bundle: ${message}`);
  process.exit(1);
}

function keygen() {
  const out = arg("out");
  if (!out) fail("keygen needs --out=<file>");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const file = {
    note: "Send the publicKey to whoever exports your bundles. Keep privateKey; without it nothing in a bundle can be read.",
    scheme: SCHEME,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(out, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  console.log(`wrote ${out}`);
  console.log(`public key (give this to the operator):\n${file.publicKey}`);
}

function seal(payload, auditorPublicKeyBase64) {
  const auditorPublicKey = crypto.createPublicKey({
    key: Buffer.from(auditorPublicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: auditorPublicKey });
  const salt = crypto.randomBytes(32);
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, salt, INFO, 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  return {
    format: "askgrokwallet-audit-bundle",
    version: 1,
    scheme: SCHEME,
    issuedAt: new Date().toISOString(),
    note:
      "The payload is sealed to the auditor's public key. Nothing here is readable without " +
      "the matching private key, and the seal is not a substitute for the onchain anchor — " +
      "sealing proves who could read it, anchoring proves when it existed.",
    ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function exportBundle() {
  const out = arg("out");
  if (!out) fail("export needs --out=<file>");
  const auditorKey = arg("auditor-key") || process.env.AUDITOR_PUBLIC_KEY;
  if (!auditorKey) fail("export needs --auditor-key=<base64 spki> (the auditor generates it with keygen)");
  const api = String(arg("api", DEFAULT_API)).replace(/\/+$/, "");

  // Receipts: from files, or straight from the issuer's API for a receipt you already hold.
  let receipts = [];
  const files = arg("receipts");
  if (files) {
    for (const file of files.split(",")) {
      const parsed = JSON.parse(fs.readFileSync(file.trim(), "utf8"));
      receipts.push(parsed.receipt ?? parsed.approval ?? parsed);
    }
  } else if (has("from-api")) {
    const id = arg("receipt-id");
    if (!id) fail("--from-api needs --receipt-id=appr_…");
    const row = await getJson(`${api}/api/approvals/${id}`);
    receipts.push(row.approval ?? row);
  } else {
    fail("nothing to bundle: pass --receipts=a.json,b.json or --from-api --receipt-id=appr_…");
  }

  const log = await getJson(`${api}/api/receipts/chain`);
  const key = process.env.ASKAUDIT_RECEIPT_KEY
    ? { publicKey: process.env.ASKAUDIT_RECEIPT_KEY, origin: "provided" }
    : await getJson(`${api}/api/receipt-public-key`).then((r) => ({ publicKey: r.publicKey, origin: `${api}/api/receipt-public-key` }));

  const payload = {
    bundleVersion: 1,
    createdAt: new Date().toISOString(),
    api,
    receipts,
    receiptPublicKey: key.publicKey,
    receiptPublicKeyOrigin: key.origin,
    log: {
      length: log.length,
      headHash: log.headHash,
      intact: log.intact,
      entries: log.entries ?? [],
      anchors: log.anchors ?? [],
    },
  };

  const bundle = seal(payload, auditorKey);
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n");
  const ids = receipts.map((r) => r.id).join(", ");
  console.log(`wrote ${out}`);
  console.log(`  receipts   ${receipts.length} (${ids})`);
  console.log(`  log        ${payload.log.entries.length} entries · head ${String(payload.log.headHash).slice(0, 16)}… · anchors ${payload.log.anchors.length}`);
  console.log(`  sealed to  ${auditorKey.slice(0, 24)}…`);
  console.log("\nThe auditor opens it with:\n  node spec/verify-audit-bundle.mjs " + out + " --viewing-key=<their key file>");
}

if (has("keygen") || process.argv.includes("keygen")) keygen();
else await exportBundle();
