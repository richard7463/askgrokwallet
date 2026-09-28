#!/usr/bin/env node
// Acceptance test for make-verifiable-package.mjs. No network, no fixtures to install:
//
//   node spec/verifiable-package.test.mjs
//
// It builds a real package from the shipped example receipt (a genuinely signed one),
// checks the sealed hashes the way a reader would, runs the packaged verifier in offline
// mode against every receipt, and then tampers with a copy to prove the check can fail.
//
// The two acceptance criteria from the plan this implements:
//   [ ] export a package and verify every receipt with the verifier inside it, offline
//   [ ] tamper with one receipt in the package and have the verifier say so

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PACKER = path.join(HERE, "make-verifiable-package.mjs");
const EXAMPLE = path.join(HERE, "example-receipt.json");

let failures = 0;
const t = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`);
};
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "vp-test-"));
const out = path.join(workdir, "package");

// ── build ───────────────────────────────────────────────────────────────────
const built = spawnSync(process.execPath, [PACKER, `--receipts=${EXAMPLE}`, `--out=${out}`], { encoding: "utf8" });
t("the packer runs", built.status === 0, built.stderr || built.stdout);
for (const file of ["entries.csv", "README.md", "verify-receipt.mjs", "SHA256SUMS", "MANIFEST.json"]) {
  t(`package contains ${file}`, fs.existsSync(path.join(out, file)));
}
const receipts = fs.readdirSync(path.join(out, "receipts"));
t("the receipt is inside the package", receipts.length === 1, receipts.join(", "));

// ── the sealed hashes, checked the way a reader checks them ─────────────────
const sums = fs.readFileSync(path.join(out, "SHA256SUMS"), "utf8").trim().split("\n");
// Content files only. MANIFEST.json cannot list its own hash — it carries the hash of
// this list instead, which is what makes the whole package referable by one value.
t("SHA256SUMS covers the content files", sums.length === 4, sums.map((l) => l.split("  ")[1]).join(", "));
t("...and MANIFEST.json is deliberately not in that list", !sums.some((l) => l.endsWith("MANIFEST.json")));
let mismatched = 0;
for (const line of sums) {
  const [expected, name] = line.split("  ");
  const actual = sha256(fs.readFileSync(path.join(out, name)));
  if (actual !== expected) { mismatched += 1; console.log(`     ${name}: ${actual} != ${expected}`); }
}
t("every sealed file matches its hash", mismatched === 0);

const manifest = JSON.parse(fs.readFileSync(path.join(out, "MANIFEST.json"), "utf8"));
t("the manifest is covered the other way round, by its bundle hash",
  manifest.bundleSha256 === sha256(fs.readFileSync(path.join(out, "SHA256SUMS"))));
t("the manifest's bundle hash is the hash of SHA256SUMS",
  manifest.bundleSha256 === sha256(fs.readFileSync(path.join(out, "SHA256SUMS"))));
t("the manifest pins the verifier it shipped",
  manifest.verifier.sha256 === sha256(fs.readFileSync(path.join(out, "verify-receipt.mjs"))));
t("the manifest counts what is in the package", manifest.receipts === 1);

// ── the packaged verifier, offline, on every receipt ────────────────────────
const packagedVerifier = path.join(out, "verify-receipt.mjs");
for (const name of receipts) {
  const run = spawnSync(process.execPath, [packagedVerifier, path.join(out, "receipts", name), "--offline"], { encoding: "utf8" });
  t(`the packaged verifier accepts ${name} offline`, /signature\s+✓/.test(run.stdout), run.stdout || run.stderr);
  t(`...and never needs the network in that mode`, /skipped \(--offline\)/.test(run.stdout));
}

// ── tamper: change the amount, keep everything else ─────────────────────────
const target = path.join(out, "receipts", receipts[0]);
const original = JSON.parse(fs.readFileSync(target, "utf8"));
const tampered = { ...original, amountUsd: Number(original.amountUsd ?? 0) + 1 };
const tamperedPath = path.join(workdir, "tampered.json");
fs.writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2));
const tamperedRun = spawnSync(process.execPath, [packagedVerifier, tamperedPath, "--offline"], { encoding: "utf8" });
t("a tampered receipt is rejected", /signature\s+✗/.test(tamperedRun.stdout), tamperedRun.stdout);
t("...with a non-zero exit code", tamperedRun.status === 1, String(tamperedRun.status));

// And the tamper is detectable from the sealed hashes alone, before anything runs.
const after = sha256(fs.readFileSync(target));
const sealed = sums.find((l) => l.endsWith(path.relative(out, target).split(path.sep).join("/")))?.split("  ")[0];
t("the sealed hash matches the untouched receipt", after === sealed);
fs.writeFileSync(target, JSON.stringify(tampered, null, 2));
t("...and stops matching the moment the file changes", sha256(fs.readFileSync(target)) !== sealed);

fs.rmSync(workdir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
