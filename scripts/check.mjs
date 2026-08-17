import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const filePath = path.join(directory, name);
    return statSync(filePath).isDirectory() ? walk(filePath) : [filePath];
  });
}

for (const filePath of walk(root).filter((name) => name.endsWith(".js") || name.endsWith(".mjs"))) {
  execFileSync(process.execPath, ["--check", filePath], { stdio: "inherit" });
}
console.log("JavaScript syntax checks passed.");

