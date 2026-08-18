import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("installer discovers a hoisted Paseo server inside the app-owned prefix", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(
    installer,
    /process\.env\.PREFIX[\s\S]*"lib", "node_modules", "@getpaseo", "server"/,
  );
  assert.match(
    installer,
    /globalRoot && path\.join\(globalRoot, "@getpaseo", "server"\)/,
  );
});

test("Android installer trusts build-time syntax checks instead of spawning Node per patch", async () => {
  const installer = await readFile(new URL("../install.mjs", import.meta.url), "utf8");

  assert.match(installer, /if \(process\.platform === "android"\) return;/);
  assert.match(installer, /function validateServerPatchSyntax/);
});
