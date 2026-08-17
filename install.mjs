import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const SUPPORTED_SERVER_VERSION = "0.3.1";
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function findServerRoot(explicit) {
  const globalRoot = npmGlobalRoot();
  const candidates = [
    explicit,
    process.env.PASEO_SERVER_ROOT,
    globalRoot && path.join(globalRoot, "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
    path.join(homedir(), ".npm-global", "lib", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!found) {
    throw new Error("找不到 @getpaseo/server，请使用 --server-root 指定其目录。");
  }
  return path.resolve(found);
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.paseo-enhanced-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
}

const serverRoot = findServerRoot(option("--server-root"));
const paseoHome = path.resolve(option("--paseo-home") || process.env.PASEO_HOME || path.join(homedir(), ".paseo"));
const serverVersion = readJson(path.join(serverRoot, "package.json")).version;
if (serverVersion !== SUPPORTED_SERVER_VERSION && !args.includes("--force")) {
  throw new Error(`仅支持 @getpaseo/server@${SUPPORTED_SERVER_VERSION}，当前为 ${serverVersion || "未知"}。`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(paseoHome, "paseo-enhanced-backups", stamp);
const backupEntries = [];
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });

function backup(target, key) {
  const existed = existsSync(target);
  const backupPath = path.join(backupRoot, key);
  if (existed) {
    mkdirSync(path.dirname(backupPath), { recursive: true });
    copyFileSync(target, backupPath);
  }
  backupEntries.push({ target, backupPath, existed });
}

const serverFiles = [
  ["bootstrap.js", "bootstrap.js"],
  ["session.js", "session.js"],
  ["codex-config.js", "codex-config.js"],
  ["codex-chat-proxy.js", "codex-chat-proxy.js"],
  ["paseo-management.js", "paseo-management.js"],
  ["agent-providers-codex-app-server-agent.js", path.join("agent", "providers", "codex-app-server-agent.js")],
];

for (const [sourceName] of serverFiles) {
  execFileSync(process.execPath, ["--check", path.join(projectRoot, "patches", "server", sourceName)], { stdio: "inherit" });
}

const serverCodeRoot = path.join(serverRoot, "dist", "server", "server");
for (const [sourceName, relativeTarget] of serverFiles) {
  const source = path.join(projectRoot, "patches", "server", sourceName);
  const target = path.join(serverCodeRoot, relativeTarget);
  backup(target, path.join("server", relativeTarget));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

const configPath = path.join(paseoHome, "config.json");
backup(configPath, path.join("paseo-home", "config.json"));
const config = readJson(configPath);
config.version = config.version || 1;
config.features = config.features && typeof config.features === "object" ? config.features : {};
config.features.webUi = config.features.webUi && typeof config.features.webUi === "object" ? config.features.webUi : {};
config.features.webUi.enabled = true;
config.features.webUi.distDir = "web-ui-custom";
writeJsonAtomic(configPath, config);

const webDir = path.join(paseoHome, "web-ui-custom");
const createdWebDir = !existsSync(webDir);
if (createdWebDir) {
  const bundledWeb = path.join(serverRoot, "dist", "server", "web-ui");
  if (!existsSync(path.join(bundledWeb, "index.html"))) {
    throw new Error(`找不到 Paseo 内置 Web UI：${bundledWeb}`);
  }
  cpSync(bundledWeb, webDir, { recursive: true });
}

for (const fileName of ["index.html", "index.html.gz", "index.html.br", "paseo-browser-bootstrap.js", "paseo-manager.js"]) {
  const target = path.join(webDir, fileName);
  if (!createdWebDir) backup(target, path.join("web", fileName));
}

copyFileSync(path.join(projectRoot, "web", "paseo-browser-bootstrap.js"), path.join(webDir, "paseo-browser-bootstrap.js"));
copyFileSync(path.join(projectRoot, "web", "paseo-manager.js"), path.join(webDir, "paseo-manager.js"));

const indexPath = path.join(webDir, "index.html");
let html = readFileSync(indexPath, "utf8");
html = html
  .replace(/^\s*<script[^>]+src=["']\/paseo-browser-bootstrap\.js[^>]*><\/script>\s*$/gmu, "")
  .replace(/^\s*<script[^>]+src=["']\/paseo-codex-settings\.js[^>]*><\/script>\s*$/gmu, "")
  .replace(/^\s*<script[^>]+src=["']\/paseo-manager\.js[^>]*><\/script>\s*$/gmu, "");
const injection = [
  '  <script src="/paseo-browser-bootstrap.js?v=enhanced-1" defer></script>',
  '  <script src="/paseo-manager.js?v=enhanced-1" defer></script>',
].join("\n");
if (!html.includes("</body>")) throw new Error("Web UI index.html 缺少 </body>。");
html = html.replace(/<html\s+lang=["'][^"']+["']/i, '<html lang="zh-CN"');
if (!html.includes('id="paseo-viewport-fix"')) {
  const viewportStyle = '<style id="paseo-viewport-fix">html,body,#root{height:var(--paseo-viewport-height,100dvh)!important;min-height:0!important}#root{max-height:var(--paseo-viewport-height,100dvh)}</style>';
  html = html.replace("</head>", `${viewportStyle}\n</head>`);
}
html = html.replace("</body>", `${injection}\n</body>`);
writeFileSync(indexPath, html);
writeFileSync(`${indexPath}.gz`, gzipSync(Buffer.from(html), { level: 9 }));
writeFileSync(`${indexPath}.br`, brotliCompressSync(Buffer.from(html), {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
}));

const installManifest = {
  installedAt: new Date().toISOString(),
  serverRoot,
  serverVersion,
  paseoHome,
  backupRoot,
  createdWebDir,
  backupEntries,
};
writeJsonAtomic(path.join(backupRoot, "manifest.json"), installManifest);
writeJsonAtomic(path.join(paseoHome, "paseo-enhanced-backups", "latest.json"), installManifest);

console.log(`Paseo Enhanced 已安装，备份位于：${backupRoot}`);
console.log("安装器没有重启 Paseo。请结束当前任务后按原方式正常重启 Daemon。");
