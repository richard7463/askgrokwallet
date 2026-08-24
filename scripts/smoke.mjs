#!/usr/bin/env node
// AskGrokWallet plugin — local structure validation
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error("SMOKE FAILED:", msg);
  process.exit(1);
}

const skill = join(ROOT, "SKILL.md");
if (!existsSync(skill)) fail("SKILL.md missing");
const skillText = readFileSync(skill, "utf8");
if (!skillText.includes("name: askgrokwallet")) fail("SKILL.md missing frontmatter name");

const manifestPath = join(ROOT, ".grok-plugin", "plugin.json");
if (!existsSync(manifestPath)) fail(".grok-plugin/plugin.json missing");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.name !== "askgrokwallet") fail("plugin.json name mismatch");
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name)) fail("name must be kebab-case");

const cursorManifestPath = join(ROOT, ".cursor-plugin", "plugin.json");
if (!existsSync(cursorManifestPath)) fail(".cursor-plugin/plugin.json missing");
const cursorManifest = JSON.parse(readFileSync(cursorManifestPath, "utf8"));
if (cursorManifest.name !== "askgrokwallet") fail("cursor plugin.json name mismatch");

const example = JSON.parse(readFileSync(join(ROOT, "examples", "approval-request.json"), "utf8"));
if (!example.summary || !example.policyText) fail("approval-request.json incomplete");

const policy = readFileSync(join(ROOT, "examples", "policy-example.txt"), "utf8").trim();
if (!policy.includes("$")) fail("policy-example.txt looks wrong");

console.log("SMOKE OK: SKILL.md, grok+cursor manifests, examples valid.");
