import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const paseoHome = path.resolve(option("--paseo-home") || process.env.PASEO_HOME || path.join(homedir(), ".paseo"));
const latestPath = path.join(paseoHome, "paseo-enhanced-backups", "latest.json");
if (!existsSync(latestPath)) throw new Error("找不到 Paseo Enhanced 安装备份。");
const manifest = JSON.parse(readFileSync(latestPath, "utf8"));

for (const entry of [...manifest.backupEntries].reverse()) {
  if (entry.existed) {
    copyFileSync(entry.backupPath, entry.target);
  } else if (existsSync(entry.target)) {
    rmSync(entry.target, { force: true });
  }
}

if (manifest.createdWebDir) {
  const expectedWebDir = path.join(path.resolve(manifest.paseoHome), "web-ui-custom");
  if (expectedWebDir === path.join(paseoHome, "web-ui-custom") && existsSync(expectedWebDir)) {
    rmSync(expectedWebDir, { recursive: true, force: true });
  }
}

rmSync(latestPath, { force: true });
console.log(`已恢复安装前文件，备份仍保留在：${manifest.backupRoot}`);
console.log("回滚脚本没有重启 Paseo。请在合适时按原方式正常重启 Daemon。");

