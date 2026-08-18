import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProviderOverridesToRuntime,
  mergeProviderOverrides,
  providerViewFromSnapshot,
} from "../patches/server/paseo-provider-config.js";

test("saving Claude runtime settings leaves Codex byte-for-byte unchanged", () => {
  const originalCodex = {
    enabled: true,
    command: ["/data/user/0/com.paseoe/files/usr/bin/codex"],
    env: { OPENAI_API_KEY: "codex-secret" },
  };
  const existing = {
    codex: originalCodex,
    claude: { enabled: false, env: { ANTHROPIC_API_KEY: "old-secret" } },
  };

  const updated = mergeProviderOverrides(existing, "claude", {
    enabled: true,
    command: ["/data/user/0/com.paseoe/files/usr/bin/claude"],
    env: { ANTHROPIC_API_KEY: "new-secret" },
  });

  assert.deepEqual(updated.codex, originalCodex);
  assert.notStrictEqual(updated.codex, originalCodex);
  assert.deepEqual(updated.claude, {
    enabled: true,
    command: ["/data/user/0/com.paseoe/files/usr/bin/claude"],
    env: { ANTHROPIC_API_KEY: "new-secret" },
  });
});

test("provider view exposes status and environment keys without secret values", () => {
  const view = providerViewFromSnapshot(
    {
      provider: "opencode",
      label: "OpenCode",
      description: "OpenCode agent",
      status: "unavailable",
      enabled: true,
      error: "opencode binary not found",
    },
    {
      command: ["/data/user/0/com.paseoe/files/usr/bin/opencode"],
      env: { OPENCODE_API_KEY: "do-not-return", BASE_URL: "https://example.test" },
    },
  );

  assert.equal(view.available, false);
  assert.equal(view.status, "unavailable");
  assert.deepEqual(view.config.envKeys, ["BASE_URL", "OPENCODE_API_KEY"]);
  assert.equal(JSON.stringify(view).includes("do-not-return"), false);
});

test("empty command and environment values remove only those selected-provider overrides", () => {
  const updated = mergeProviderOverrides(
    {
      codex: { enabled: true },
      pi: {
        enabled: true,
        command: ["pi"],
        env: { PI_API_KEY: "secret" },
        params: { theme: "dark" },
      },
    },
    "pi",
    { enabled: false, command: null, env: null },
  );

  assert.deepEqual(updated.codex, { enabled: true });
  assert.deepEqual(updated.pi, { enabled: false, params: { theme: "dark" } });
});

test("runtime synchronization preserves provider commands across later daemon changes", () => {
  const applied = [];
  const runtime = {
    daemonConfigStore: {
      current: {
        relay: { enabled: true },
        providers: { claude: { enabled: false } },
      },
      get() {
        return this.current;
      },
    },
    providerSnapshotManager: {
      baseProviderOverrides: {
        claude: { enabled: false, command: ["old-claude"] },
      },
      applyMutableProviderConfig(mutableProviders) {
        const merged = structuredClone(this.baseProviderOverrides ?? {});
        for (const [providerId, mutable] of Object.entries(mutableProviders ?? {})) {
          merged[providerId] = { ...merged[providerId], ...structuredClone(mutable) };
        }
        applied.push(merged);
        return { providerDefinitions: merged, clients: {} };
      },
    },
    agentManager: {
      updateProviderRegistry(state) {
        this.state = state;
      },
    },
  };
  const saved = {
    codex: { enabled: true, command: ["codex"] },
    claude: {
      enabled: true,
      command: ["/data/user/0/com.paseoe/files/usr/bin/claude"],
      env: { ANTHROPIC_API_KEY: "secret" },
    },
  };

  applyProviderOverridesToRuntime(runtime, saved);
  runtime.providerSnapshotManager.applyMutableProviderConfig(
    runtime.daemonConfigStore.get().providers,
  );

  assert.deepEqual(runtime.daemonConfigStore.get().providers, {
    codex: { enabled: true },
    claude: { enabled: true },
  });
  assert.deepEqual(applied.at(-1).claude, saved.claude);
  assert.equal(
    JSON.stringify(runtime.daemonConfigStore.get()).includes("secret"),
    false,
    "daemon mutable state must not duplicate provider secrets",
  );
});
