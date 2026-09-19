#!/usr/bin/env node
// verify-receipt.mjs — check an AskGrokWallet receipt WITHOUT trusting AskGrokWallet.
//
//   node verify-receipt.mjs receipt.json
//
// No install, no dependencies, nothing to read but this file. The checks here are
// written from the published spec instead of importing our code, on purpose: a
// verifier that runs the issuer's code is not a verifier.
//
// The three lines it prints, and what each one actually proves:
//
//   signature  the receipt was signed by the published key, and every field it
//              claims — including where the money went — is inside that
//              signature. Fully offline: no network, no call to us.
//   chain      this receipt's signing event sits at a fixed position in a
//              published append-only log, linked hash by hash back to entry 1.
//   onchain    the head of that log was written into a public blockchain
//              transaction, IN A BLOCK, and that transaction succeeded. From
//              that block onward, not even we can rewrite the history it covers —
//              the thing you are trusting is the chain. A transaction that is
//              broadcast but not yet mined is reported as pending: until it
//              lands it can be dropped, replaced, or reorged away, so "fixed
//              onchain" would be a claim we cannot back.
//
// What it does NOT prove: that the payment was wise, that the agent should have
// been allowed to make it, or that entries belonging to OTHER receipts say what
// the log claims (the public log publishes fingerprints, not contents). It proves
// that THIS receipt is in there, unaltered, and fixed as of that block.
//
// Flags:
//   --key=<base64 spki der>  pin the signing key yourself instead of asking us
//   --api=<origin>           where the published log lives
//   --rpc=<url>              JSON-RPC endpoint for the onchain check
//   --offline                signature only; skip everything that needs network
//   --json                   machine-readable output
//   --version                print this verifier's version and the sha256 of the
//                            bytes you are running, then exit

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// The version of THIS FILE, and — computed at run time — the hash of the bytes
// you are actually holding. A verifier that can change silently under a fixed URL
// is unverifiable by construction: two people comparing notes have to know they
// ran the same thing, and "the copy from askgrokwallet.io" stops being an answer
// the moment that page is redeployed. `--version` prints both; every release
// publishes the same hash, so a mismatch is visible instead of silent.
const VERIFIER_VERSION = "1.0.1";

function selfSha256() {
  return crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
}

// ── The spec, restated. Changing any of it changes what verifies. ────────────
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
const CHAIN_VERSION = 1;
const GENESIS_PREV_HASH = "0".repeat(64);

// The production signing key, pinned in the file you are reading. Pinning matters:
// a key fetched from the same server that served the receipt proves only that the
// server is self-consistent. Fingerprint sha256(der)[:16] = 39626850145403d3.
// Override with --key= if you obtained it somewhere independent of us.
const PUBLISHED_PUBLIC_KEY = "MCowBQYDK2VwAyEAPMtfRKoPgy0UaEHA4iWsHAns7gpEepBX9NQhzyITL4w=";

const DEFAULT_API = "https://askgrokwallet.io";
// Only chains we can name a public endpoint for. Anything else needs --rpc.
// 11155111 (Ethereum Sepolia) is where we anchor today, so it has to be here:
// the onchain check is the one line that needs no trust in us, and it would be
// silently downgraded to "~" for every default run if we left it out.
const KNOWN_RPC = {
  "11155111": "https://ethereum-sepolia-rpc.publicnode.com",
  "84532": "https://sepolia.base.org",
};

function flag(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const offline = process.argv.includes("--offline");
const asJson = process.argv.includes("--json");
const api = String(flag("api", DEFAULT_API)).replace(/\/+$/, "");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));

// Answered before anything else, so it works with no receipt in hand and no
// network: "which verifier am I running" is a question about this file alone.
if (process.argv.includes("--version")) {
  console.log(`verify-receipt ${VERIFIER_VERSION}`);
  console.log(`sha256 ${selfSha256()}`);
  process.exit(0);
}

if (!file) {
  console.error("usage: node verify-receipt.mjs receipt.json [--offline] [--key=<base64>] [--api=<origin>]");
  process.exit(2);
}

// Accepts a bare receipt or anything wrapping one under .receipt / .approval.
function loadReceipt(path) {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  return parsed?.receipt ?? parsed?.approval ?? parsed;
}

// ── Canonicalization. Two receipts that mean the same thing must produce the
// same bytes, or signatures would depend on key order and whitespace. ─────────
function canonicalValue(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
}

// Version dispatch is limited to this verifier's fixed v3/v4 definitions. A
// receipt cannot supply its own field list or canonicalization.
function receiptVersion(row) {
  const version = Number(row.sigVersion);
  return Object.hasOwn(SIGNED_FIELDS, version) ? version : null;
}

function canonicalReceipt(row) {
  const version = receiptVersion(row);
  if (!version) throw new Error(`unsupported sigVersion ${row.sigVersion}`);
  const obj = {};
  for (const key of SIGNED_FIELDS[version]) obj[key] = canonicalValue(row[key]);
  return `v${version}:` + JSON.stringify(obj);
}

// Every value is length-prefixed before hashing, so free text inside a receipt
// (the summary is user-supplied) cannot imitate a field boundary.
function lengthPrefixed(value) {
  const s = String(value ?? "");
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
}

function entryHash(entry) {
  const preimage = [
    `rc${CHAIN_VERSION}`,
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

async function getJson(url, body) {
  const res = await fetch(url, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// `Number(null)` is 0, and "block 0" is a claim nobody made. Every block height
// that arrives over JSON-RPC goes through here so a missing one stays missing
// instead of turning into a plausible-looking number.
function blockHeight(value) {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

// A key you got from the same place you got the receipt proves less than a key
// you pinned yourself, so say which one is in use rather than printing the same
// tick either way. `alt` is only consulted when the primary key fails to verify:
// see checkSignature, which has to tell a rotated key apart from a forged receipt.
async function resolveKey() {
  const passed = flag("key", "");
  if (passed) return { b64: passed, origin: "pinned by you" };
  if (PUBLISHED_PUBLIC_KEY) {
    let alt = null;
    if (!offline) {
      try {
        const res = await getJson(`${api}/api/receipt-public-key`);
        if (res.publicKey && res.publicKey !== PUBLISHED_PUBLIC_KEY) alt = res.publicKey;
      } catch {
        // Unreachable issuer is not a verification failure — the pin is enough.
      }
    }
    return { b64: PUBLISHED_PUBLIC_KEY, origin: "pinned in this file", alt };
  }
  if (offline) return null;
  const res = await getJson(`${api}/api/receipt-public-key`);
  return { b64: res.publicKey, origin: "fetched from the issuer — not independently pinned" };
}

function keyFingerprint(b64) {
  return crypto.createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").slice(0, 16);
}

// ── 1. Signature. Offline. ───────────────────────────────────────────────────
function verifyWith(receipt, b64) {
  return crypto.verify(
    null,
    Buffer.from(canonicalReceipt(receipt), "utf8"),
    crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" }),
    Buffer.from(receipt.signature, "base64"),
  );
}

function checkSignature(receipt, key) {
  if (!key) return { mark: "~", note: "skipped (--offline with no --key)" };
  if (!receipt.signature) return { mark: "✗", note: "receipt carries no signature" };
  const version = receiptVersion(receipt);
  if (!version) {
    return { mark: "✗", note: `sigVersion ${receipt.sigVersion} is not supported; only v3, v4, and v5 are defined` };
  }
  let ok = false;
  try {
    ok = verifyWith(receipt, key.b64);
  } catch (error) {
    return { mark: "✗", note: `could not check: ${error.message}` };
  }
  if (ok) {
    return { mark: "✓", note: `${SIGNED_FIELDS[version].length} fields signed (v${version}) · key ${keyFingerprint(key.b64)} (${key.origin})` };
  }
  // A receipt that fails the pinned key but passes the key the issuer serves
  // today is NOT the same event as a forgery, and calling it one would cry wolf
  // at every legitimate key rotation. It is also not clean: a substituted key
  // looks identical from here. So neither ✓ nor ✗ — say precisely what happened
  // and let the reader decide whether they believe the rotation.
  if (key.alt) {
    let altOk = false;
    try {
      altOk = verifyWith(receipt, key.alt);
    } catch { /* fall through to the plain failure below */ }
    if (altOk) {
      return {
        mark: "~",
        rotated: true,
        note:
          `signed by key ${keyFingerprint(key.alt)}, which the issuer serves today, NOT by the ` +
          `key ${keyFingerprint(key.b64)} pinned in this file — either they rotated the key, or ` +
          `someone swapped it. Ask them to publish the rotation before you trust this.`,
      };
    }
  }
  return { mark: "✗", note: "signature does not match — this receipt was altered, or it is not ours" };
}

// ── 2. Chain. The published log is fingerprints only; that is enough to check
// its linkage AND to locate a receipt you already hold. What it cannot do is
// recompute OTHER entries' hashes: their `signature` and `canonical` are
// withheld on purpose (publishing them hands out an offline guessing oracle for
// low-entropy fields like the amount). So the metadata of entries belonging to
// receipts you do not hold rests on the issuer's word, not on arithmetic. The
// issuer publishes its own `intact` flag; that is a self-report, but if it ever
// says false we surface it instead of quietly printing a tick. ───────────────
function checkChain(receipt, log) {
  const entries = log.entries ?? [];
  if (!entries.length) return { mark: "✗", note: "published log is empty" };

  let prevHash = GENESIS_PREV_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    if (Number(entry.chainSeq) !== expectedSeq) {
      return { mark: "✗", note: `log jumps at ${entry.chainSeq} (expected ${expectedSeq}) — an entry was removed or reordered` };
    }
    if (entry.prevHash !== prevHash) {
      return { mark: "✗", note: `entry ${expectedSeq} does not link to the one before it` };
    }
    prevHash = entry.entryHash;
    expectedSeq += 1;
  }

  const canonical = canonicalReceipt(receipt);
  const mine = entries.filter((e) => e.receiptId === receipt.id);
  const match = mine.find((e) => entryHash({ ...e, signedAt: receipt.signedAt, signature: receipt.signature, canonical }) === e.entryHash);
  if (!match) {
    return {
      mark: "✗",
      note: mine.length
        ? `${mine.length} entr${mine.length === 1 ? "y" : "ies"} for ${receipt.id}, none matching this receipt's contents`
        : `no entry for ${receipt.id} in the published log`,
    };
  }
  return {
    mark: "✓",
    entry: match,
    headHash: prevHash,
    note:
      `entry ${match.chainSeq} of ${entries.length} (${match.event}) · links unbroken back to 1` +
      (log.intact === false
        ? " · WARNING: the issuer reports its own log as broken elsewhere — your entry checks out, but something you cannot see does not"
        : ""),
  };
}

// ── 3. Onchain. The head hash sits in the transaction's calldata, so a substring
// match is enough — no ABI, no contract call, nothing to install. ─────────────
async function checkOnchain(entry, entries, anchors) {
  if (!entry) return { mark: "~", note: "skipped (receipt not located in the log)" };
  const covering = anchors
    .filter((a) => Number(a.chainSeq) >= Number(entry.chainSeq))
    .sort((a, b) => Number(a.chainSeq) - Number(b.chainSeq))[0];
  if (!covering) {
    return { mark: "~", note: `entry ${entry.chainSeq} is not anchored yet — genuine, but we could still rewrite it` };
  }

  const anchoredEntry = entries.find((e) => Number(e.chainSeq) === Number(covering.chainSeq));
  if (!anchoredEntry || anchoredEntry.entryHash !== covering.headHash) {
    return { mark: "✗", note: `anchor claims head ${String(covering.headHash).slice(0, 12)}… which is not entry ${covering.chainSeq} of this log` };
  }

  const rpc = flag("rpc", KNOWN_RPC[String(covering.chainId)]);
  if (!rpc) return { mark: "~", note: `chain ${covering.chainId} — pass --rpc=<url> to check the transaction` };

  let tx;
  try {
    const res = await getJson(rpc, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [covering.txHash] });
    tx = res.result;
  } catch (error) {
    return { mark: "~", note: `RPC unreachable: ${error.message}` };
  }
  if (!tx) return { mark: "✗", note: `anchor tx ${String(covering.txHash).slice(0, 12)}… is not on chain ${covering.chainId}` };
  if (String(tx.to).toLowerCase() !== String(covering.contractAddress).toLowerCase()) {
    return { mark: "✗", note: `anchor tx goes to ${tx.to}, not the stated contract ${covering.contractAddress}` };
  }
  if (!String(tx.input).toLowerCase().includes(String(covering.headHash).toLowerCase())) {
    return { mark: "✗", note: "anchor tx does not contain this log head" };
  }

  // The node answered with a transaction, but "it exists" and "it is in a block"
  // are different claims, and only the second one is load-bearing. A mempool
  // transaction has no blockNumber — it can be dropped, replaced by a same-nonce
  // tx, or reorged away — so ticking it would assert the exact thing this line
  // exists to prove, before it is true. `Number(null)` is 0, which is how this
  // used to print "block 0" and read as fixed.
  if (tx.blockNumber === null || tx.blockNumber === undefined || tx.blockNumber === "") {
    return {
      mark: "~",
      pending: true,
      note:
        `anchor tx ${String(covering.txHash).slice(0, 12)}… is broadcast but not in a block yet — ` +
        `this log is NOT fixed onchain, and we could still rewrite it`,
    };
  }

  // A mined hash proves the transaction was included. It does not prove the head
  // reached the contract: a reverted anchor keeps the head in its calldata while
  // writing nothing. Only the receipt says which of those happened, so ask for it
  // and take every answer seriously — including the three answers that used to
  // read as success: a receipt that never arrives, an RPC that throws, and a
  // receipt without a status field. Each of those leaves the outcome unknown, and
  // unknown is not the same claim as "fixed onchain".
  let receipt = null;
  let receiptError = null;
  try {
    const res = await getJson(rpc, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [covering.txHash] });
    receipt = res.result;
  } catch (error) {
    receiptError = error.message;
  }
  const block = blockHeight(receipt?.blockNumber ?? tx.blockNumber);
  const where = block === null ? "in a block" : `in block ${block}`;
  if (receipt && receipt.status != null && String(receipt.status) !== "0x1") {
    return {
      mark: "~",
      reverted: true,
      note:
        `anchor tx ${String(covering.txHash).slice(0, 12)}… is ${where} but it REVERTED — ` +
        `the head sits in its calldata, not in ${covering.contractAddress}; anyone resolving anchors ` +
        `against the contract finds nothing`,
    };
  }
  if (!receipt) {
    return {
      mark: "~",
      inconclusive: true,
      note:
        `anchor tx ${String(covering.txHash).slice(0, 12)}… is ${where}, but the node ` +
        `${receiptError ? `could not answer for its receipt (${receiptError})` : "returned no receipt"} — ` +
        `whether the head reached ${covering.contractAddress} is unknown, and an unknown outcome is not proof of a fixed log`,
    };
  }
  if (receipt.status == null) {
    return {
      mark: "~",
      inconclusive: true,
      note:
        `anchor tx ${String(covering.txHash).slice(0, 12)}… is ${where}, but its receipt carries no status — ` +
        `inclusion alone does not show the head was written to ${covering.contractAddress}`,
    };
  }
  return {
    mark: "✓",
    note: `head ${covering.chainSeq} written in ${String(covering.txHash).slice(0, 12)}…${block === null ? "" : ` block ${block}`} · chain ${covering.chainId}`,
  };
}

// ── Output ───────────────────────────────────────────────────────────────────
async function main() {
  const receipt = loadReceipt(file);
  const key = await resolveKey();
  const signature = checkSignature(receipt, key);

  let chain = { mark: "~", note: "skipped (--offline)" };
  let onchain = { mark: "~", note: "skipped (--offline)" };
  if (!offline) {
    const log = await getJson(`${api}/api/receipts/chain`);
    chain = checkChain(receipt, log);
    onchain = await checkOnchain(chain.entry, log.entries ?? [], log.anchors ?? []);
  }

  // A skipped check is not a failed one. Only "✗" — something provably wrong —
  // withdraws the verdict; "~" narrows what the verdict covers and says so,
  // because a false alarm on a good receipt costs as much as a missed bad one.
  const broken = [signature, chain, onchain].some((r) => r.mark === "✗");
  const genuine = !broken && signature.mark === "✓";
  const verdict = broken
    ? { mark: "✗", note: "DO NOT TRUST THIS RECEIPT" }
    : signature.rotated
      ? { mark: "~", note: "contents intact, but signed by a key this file does not pin — confirm the rotation first" }
      : signature.mark !== "✓"
        ? { mark: "~", note: "inconclusive — nothing was checked (pass --key to check offline)" }
        : onchain.mark === "✓"
          ? { mark: "✓", note: "genuine, and fixed onchain" }
          : onchain.pending
            ? { mark: "~", note: "genuine, but its anchor is not in a block yet — not fixed onchain, and we could still rewrite the log" }
            : onchain.reverted
              ? { mark: "~", note: "genuine, but its anchor transaction reverted — the head never reached the contract, so the chain fixes nothing" }
              : onchain.inconclusive
                ? { mark: "~", note: "genuine, but the anchor's outcome could not be confirmed — whether this log is fixed onchain is unknown" }
              : chain.mark === "✓"
                ? { mark: "~", note: "genuine, but not yet fixed onchain — we could still rewrite the log" }
                : { mark: "~", note: "signature is genuine; the published log was not checked" };

  if (asJson) {
    console.log(JSON.stringify({
      verifier: { version: VERIFIER_VERSION, sha256: selfSha256() },
      receiptId: receipt.id,
      genuine,
      signature,
      chain: { ...chain, entry: undefined },
      onchain,
      verdict,
    }, null, 2));
  } else {
    const line = (label, r) => console.log(`${label.padEnd(10)} ${r.mark}  ${r.note}`);
    line("signature", signature);
    line("chain", chain);
    line("onchain", onchain);
    line("verdict", verdict);
  }
  process.exit(broken ? 1 : genuine ? 0 : 2);
}

main().catch((error) => {
  console.error(`verify-receipt: ${error.message}`);
  process.exit(2);
});
