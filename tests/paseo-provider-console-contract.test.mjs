import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("provider management is installed as a first-class server module", async () => {
  const installer = await source("install.mjs");
  const providerConfigPath = path.join(root, "patches/server/paseo-provider-config.js");

  assert.ok(existsSync(providerConfigPath), "provider config module must exist");
  const providerConfig = await readFile(providerConfigPath, "utf8");
  assert.match(installer, /paseo-provider-config\.js/);
  assert.match(providerConfig, /export function mergeProviderOverride/);
});

test("provider API reports runtime status instead of registered ids", async () => {
  const management = await source("patches/server/paseo-management.js");

  assert.match(management, /listProviders\(\{\s*wait:\s*true\s*\}\)/);
  assert.match(management, /status:\s*entry\.status/);
  assert.match(management, /action === "provider-save"/);
  assert.doesNotMatch(
    management,
    /function listAgentProviders\(runtime\)[\s\S]*listRegisteredProviderIds\(\)/,
  );
});

test("console separates agent runtime configuration from Codex API profiles", async () => {
  const manager = await source("web/paseo-manager.js");

  assert.match(manager, /Agent 运行配置/);
  assert.match(manager, /Codex API 接口/);
  assert.match(manager, /manager\("provider-save"/);
  assert.match(manager, /item\.available/);
});
