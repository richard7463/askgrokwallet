#!/usr/bin/env node
// Build a verifiable package: a folder a third party can check without trusting you and
// without asking you anything.
//
//   node spec/make-verifiable-package.mjs --receipts=a.json,b.json --out=package/
//   node spec/make-verifiable-package.mjs --from-api --receipt-id=appr_… --out=package/
//
// This is the audit bundle's sibling, and the difference matters:
//
//   audit bundle   → sealed to ONE auditor's key. The public sees nothing, that auditor
//                    sees everything. Use it for a private review.
//   this package   → readable by whoever you hand it to (finance, a client, a funder),
//                    and every line in it can be checked against the receipts inside it.
//                    Use it for a reimbursement or a monthly statement.
//
// What it contains
//   entries.csv        one line per receipt: id, date, amount, currency, payee, agent, settled
//   receipts/*.json    the receipts themselves, unmodified
//   verify-receipt.mjs the released verifier, plus its sha256
//   README.md          how to check it, in plain language, including what it does NOT prove
//   SHA256SUMS         every file above, so tampering is visible before anything runs
//   MANIFEST.json      what this package is, and a hash over the whole thing
//
// Zero dependencies, Node 18+.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_API = "https://askgrokwallet.io";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
function fail(message) {
  console.error(`verifiable-package: ${message}`);
  process.exit(1);
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

// CSV, done properly: quote anything containing a comma, quote or newline, and double
// the quotes inside. A receipt summary with a comma in it must not shift a column.
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const csvRow = (cells) => cells.map(csvCell).join(",");

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const settled = (r) => Boolean(r.settledAt) || Boolean(r.txHash) || ["executed", "settled"].includes(String(r.status || ""));

async function main() {
  const out = arg("out");
  if (!out) fail("needs --out=<directory>");
  const api = String(arg("api", DEFAULT_API)).replace(/\/+$/, "");

  // Receipts: from files, or from the issuer for one you already hold.
  const receipts = [];
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
    fail("nothing to package: pass --receipts=a.json,b.json or --from-api --receipt-id=appr_…");
  }
  if (!receipts.length) fail("no receipts parsed");

  fs.mkdirSync(path.join(out, "receipts"), { recursive: true });

  // The receipts, byte-for-byte as we hold them.
  const receiptNames = [];
  for (const receipt of receipts) {
    const name = `receipts/${String(receipt.id || "receipt").replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
    fs.writeFileSync(path.join(out, name), JSON.stringify(receipt, null, 2) + "\n");
    receiptNames.push(name);
  }

  // The ledger view: enough for finance to read, with a pointer back to the receipt.
  const header = ["receipt_id", "occurred_at", "amount", "currency", "payee", "agent", "settled", "signature_alg", "sig_version", "receipt_file"];
  const lines = [csvRow(header)];
  receipts.forEach((receipt, index) => {
    lines.push(csvRow([
      receipt.id,
      receipt.settledAt || receipt.decidedAt || receipt.createdAt || "",
      receipt.amountUsd ?? 0,
      "USD",
      receipt.target ?? "",
      receipt.requester ?? receipt.source ?? "unknown",
      settled(receipt) ? "yes" : "no",
      receipt.sigAlg ?? "",
      receipt.sigVersion ?? "",
      receiptNames[index],
    ]));
  });
  fs.writeFileSync(path.join(out, "entries.csv"), lines.join("\n") + "\n");

  // The verifier, copied from this repository so the package carries its own tool.
  const verifierSource = path.join(HERE, "verify-receipt.mjs");
  const verifierBytes = fs.readFileSync(verifierSource);
  fs.writeFileSync(path.join(out, "verify-receipt.mjs"), verifierBytes);
  const verifierHash = sha256(verifierBytes);

  fs.writeFileSync(path.join(out, "README.md"), explainer({
    count: receipts.length,
    settledCount: receipts.filter(settled).length,
    verifierHash,
    receiptNames,
    generatedAt: new Date().toISOString(),
  }));

  // Hashes over everything a reader is being asked to trust.
  const hashed = ["entries.csv", "README.md", "verify-receipt.mjs", ...receiptNames];
  const sha256sums = hashed
    .map((name) => `${sha256(fs.readFileSync(path.join(out, name)))}  ${name}`)
    .join("\n") + "\n";
  fs.writeFileSync(path.join(out, "SHA256SUMS"), sha256sums);

  // One hash over the whole thing, so a package can be referred to by value.
  const bundleHash = sha256(sha256sums);
  fs.writeFileSync(path.join(out, "MANIFEST.json"), JSON.stringify({
    kind: "askgrokwallet-verifiable-package",
    version: 1,
    createdAt: new Date().toISOString(),
    receipts: receipts.length,
    settledReceipts: receipts.filter(settled).length,
    currencies: ["USD"],
    verifier: { file: "verify-receipt.mjs", sha256: verifierHash },
    bundleSha256: bundleHash,
    note: "bundleSha256 is sha256 of SHA256SUMS. Verify the files first (shasum -a 256 -c SHA256SUMS), then the receipts.",
  }, null, 2) + "\n");

  console.log(`verifiable-package: ${receipts.length} receipt(s), ${hashed.length} files → ${out}`);
  console.log(`verifiable-package: verifier sha256 ${verifierHash.slice(0, 16)}…`);
  console.log(`verifiable-package: bundle sha256   ${bundleHash.slice(0, 16)}…`);
  console.log("");
  console.log("The reader does this, with no network:");
  console.log(`  cd ${out}`);
  console.log("  shasum -a 256 -c SHA256SUMS");
  console.log("  node verify-receipt.mjs receipts/<id>.json --offline");
}

function explainer({ count, settledCount, verifierHash, receiptNames, generatedAt }) {
  return `# Verifiable receipt package

${count} receipt(s), ${settledCount} of which say they settled. Generated ${generatedAt}.

## Check it yourself — five minutes, no network needed

\`\`\`bash
shasum -a 256 -c SHA256SUMS              # every file matches what was sealed
node verify-receipt.mjs receipts/<id>.json --offline   # signature, and the fields it covers
\`\`\`

Drop \`--offline\` to also check the receipt's position in the issuer's log and its onchain
anchor. That needs network access and asks the issuer nothing beyond a public JSON file.

The verifier is the released artifact. Its sha256 is pinned in \`MANIFEST.json\` and repeated
here, so you can compare it against the release notes before running anything:

    verify-receipt.mjs  sha256 ${verifierHash}

## What the four lines mean

| mark | meaning |
| --- | --- |
| \`✓\` | proven: these exact fields were signed by the pinned key |
| \`✗\` | provably wrong: do not trust this receipt, or anything derived from it |
| \`~\` | **not checked** — never read this as "fine" |

## What this package proves, and what it does not

**Proves.** Each receipt in \`receipts/\` was signed by the issuer's pinned key over the
fields listed in \`entries.csv\`; on the online check, that the receipt sits at a fixed
position in an append-only log whose head is inside a blockchain transaction.

**Does not prove:**

- that money moved. A receipt with \`settled: no\` — or one that only records an approval or
  a refusal — is a genuine record of a decision, not of a payment. Read the transaction it
  names if you need that, and remember a screenshot of the explorer is not the same claim.
- that nothing is missing. Only receipts that were handed over are in here. Proving that no
  action went unrecorded needs an enforcement point that refuses to execute an unrecorded
  action; the issuer states separately whether that is in place.
- that the payee, the price, or the decision was a good one. This is a record, not an opinion.

## Files

| file | what |
| --- | --- |
| \`entries.csv\` | one line per receipt: id, date, amount, currency, payee, agent, settled |
| \`receipts/\` | ${receiptNames.length} receipt file(s), unmodified |
| \`verify-receipt.mjs\` | the released verifier (zero dependencies, Node 18+) |
| \`SHA256SUMS\` | hashes of every file above |
| \`MANIFEST.json\` | counts, verifier hash, and the hash of the whole package |

If you want a package that the public cannot read, ask for an **audit bundle** instead: same
evidence, sealed to your key.
`;
}

main().catch((error) => {
  console.error(`verifiable-package: ${error.message}`);
  process.exit(1);
});
