#!/usr/bin/env node
// Runs on `npm pack` and `npm publish`.
//
// The tarball on npm has to be the same bytes as the tagged file in this repo, so
// nothing here is hand-copied: the verifier, the schemas, the licence and the
// changelog are pulled from the repo at pack time, and then three things are
// asserted rather than hoped for:
//
//   1. the version inside verify-receipt.mjs matches this package's version
//   2. the file imports nothing but Node built-ins (the "no dependencies" promise
//      is the whole sales pitch, and a stray import silently breaks offline use)
//   3. the file, when actually executed, reports its own sha256 — and it equals
//      the hash of the bytes we are about to publish
//
// A failure here fails the publish, which is the only place it can still be
// caught cheaply.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const repo = path.resolve(pkgDir, "..", "..");
const specDir = path.join(repo, "spec");

const SCHEMAS = ["receipt-v3.schema.json", "receipt-v4.schema.json", "receipt-v5.schema.json"];
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fail = (message) => {
  console.error(`prepack: ${message}`);
  process.exit(1);
};

const source = path.join(specDir, "verify-receipt.mjs");
if (!fs.existsSync(source)) fail(`missing ${source}`);

// 1. Copy the canonical artifacts in.
fs.copyFileSync(source, path.join(pkgDir, "verify-receipt.mjs"));
for (const schema of SCHEMAS) {
  fs.copyFileSync(path.join(specDir, schema), path.join(pkgDir, schema));
}
fs.copyFileSync(path.join(repo, "LICENSE"), path.join(pkgDir, "LICENSE"));
fs.copyFileSync(path.join(specDir, "CHANGELOG.md"), path.join(pkgDir, "CHANGELOG.md"));

// 2. The version in the file and the version being published must agree, or the
//    package would answer "which verifier is this?" with two different answers.
const declared = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
const text = fs.readFileSync(source, "utf8");
const inFile = text.match(/const VERIFIER_VERSION = "([^"]+)"/)?.[1];
if (!inFile) fail("spec/verify-receipt.mjs has no VERIFIER_VERSION constant");
if (inFile !== declared) fail(`spec/verify-receipt.mjs says ${inFile}, package.json says ${declared}`);

// 3. No dependencies, so no import may reach outside Node.
const imports = [...text.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]);
const external = imports.filter((specifier) => !specifier.startsWith("node:"));
if (external.length) fail(`verify-receipt.mjs must import only node: built-ins, found: ${external.join(", ")}`);

// 4. The file must agree with itself: run it against the bytes we are packing.
const packed = path.join(pkgDir, "verify-receipt.mjs");
const packedHash = sha256(packed);
const run = spawnSync(process.execPath, [packed, "--version"], { encoding: "utf8" });
if (run.status !== 0) fail(`verify-receipt.mjs --version exited ${run.status}: ${run.stderr.trim()}`);
const reported = (run.stdout.match(/sha256 ([0-9a-f]{64})/) ?? [])[1];
if (reported !== packedHash) fail(`self-reported hash ${reported} does not match ${packedHash}`);

// 5. Publish the hashes next to the bytes, so a reader can check a download
//    without running a command that fetches anything.
const names = ["verify-receipt.mjs", ...SCHEMAS];
fs.writeFileSync(
  path.join(pkgDir, "SHA256SUMS"),
  names.map((name) => `${sha256(path.join(pkgDir, name))}  ${name}`).join("\n") + "\n",
);

console.log(`prepack: verify-receipt ${inFile} · sha256 ${packedHash}`);
console.log(`prepack: packed ${names.length} files, 0 dependencies, Node ${process.version}`);
