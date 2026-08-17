import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { closeAgentCommand } from "./agent/lifecycle-command.js";
import { importProviderSession, listImportableProviderSessions } from "./agent/import-sessions.js";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const MAX_IMPORT_COUNT = 1000;
const TRANSCRIPT_PREFIX_BYTES = 512 * 1024;
const PROVIDER_SCAN_TIMEOUT_MS = 6000;
const LOCAL_TRANSCRIPT_PROVIDERS = new Set(["codex", "claude"]);

function isLoopbackRequest(req) {
    return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "");
}

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

function sendError(res, status, error) {
    res.status(status).json({ error: messageOf(error) });
}

function requireObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
    }
    return value;
}

function requireString(value, label, maximum = 8192) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} is required`);
    }
    const result = value.trim();
    if (result.length > maximum || /\0/u.test(result)) {
        throw new Error(`${label} is invalid`);
    }
    return result;
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}

async function withDeadline(promise, milliseconds, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} scan timed out`)), milliseconds);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}

async function collectJsonlFiles(root) {
    const files = [];
    const pending = [root];
    while (pending.length > 0) {
        const directory = pending.pop();
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
            }
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                files.push(entryPath);
            }
        }
    }
    return files;
}

async function readTextPrefix(filePath) {
    const handle = await fs.open(filePath, "r");
    try {
        const buffer = Buffer.allocUnsafe(TRANSCRIPT_PREFIX_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    finally {
        await handle.close();
    }
}

function normalizePromptPreview(value) {
    if (typeof value !== "string")
        return null;
    const text = value.trim().replace(/\s+/gu, " ");
    if (!text || /^<(?:environment_context|permissions|collaboration_mode|multi_agent_mode)>/iu.test(text))
        return null;
    return text.length > 160 ? text.slice(0, 160) : text;
}

function extractMessageText(value) {
    if (typeof value === "string")
        return normalizePromptPreview(value);
    if (!Array.isArray(value))
        return null;
    for (const block of value) {
        if (block && typeof block === "object") {
            const text = normalizePromptPreview(block.text ?? block.input_text ?? block.content);
            if (text)
                return text;
        }
    }
    return null;
}

async function parseCodexTranscript(filePath) {
    let content;
    let stats;
    try {
        [content, stats] = await Promise.all([readTextPrefix(filePath), fs.stat(filePath)]);
    }
    catch {
        return null;
    }
    let sessionId = null;
    let cwd = null;
    let title = null;
    for (const rawLine of content.split(/\r?\n/u)) {
        if (!rawLine.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(rawLine);
        }
        catch {
            continue;
        }
        const payload = entry?.payload;
        if (!payload || typeof payload !== "object")
            continue;
        if (entry.type === "session_meta") {
            if (!sessionId && typeof (payload.id ?? payload.session_id) === "string")
                sessionId = payload.id ?? payload.session_id;
            if (!cwd && typeof payload.cwd === "string")
                cwd = payload.cwd;
            continue;
        }
        if (!title && entry.type === "response_item" && payload.role === "user")
            title = extractMessageText(payload.content);
        if (!title && entry.type === "event_msg" && payload.type === "user_message")
            title = extractMessageText(payload.message ?? payload.content);
        if (sessionId && cwd && title)
            break;
    }
    if (!sessionId || !cwd)
        return null;
    return {
        providerId: "codex",
        providerLabel: "Codex",
        providerHandleId: sessionId,
        cwd,
        title: title || `Codex ${sessionId.slice(0, 8)}`,
        firstPromptPreview: title,
        lastPromptPreview: title,
        lastActivityAt: stats.mtime.toISOString(),
    };
}

async function parseClaudeTranscript(filePath) {
    let content;
    let stats;
    try {
        [content, stats] = await Promise.all([readTextPrefix(filePath), fs.stat(filePath)]);
    }
    catch {
        return null;
    }
    let sessionId = null;
    let cwd = null;
    let title = null;
    for (const rawLine of content.split(/\r?\n/u)) {
        if (!rawLine.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(rawLine);
        }
        catch {
            continue;
        }
        if (!entry || typeof entry !== "object" || entry.isSidechain)
            continue;
        if (!sessionId && typeof entry.sessionId === "string")
            sessionId = entry.sessionId;
        if (!cwd && typeof entry.cwd === "string")
            cwd = entry.cwd;
        if (!title && entry.type === "user")
            title = extractMessageText(entry.message?.content ?? entry.message?.text);
        if (sessionId && cwd && title)
            break;
    }
    if (!sessionId || !cwd)
        return null;
    return {
        providerId: "claude",
        providerLabel: "Claude",
        providerHandleId: sessionId,
        cwd,
        title: title || `Claude ${sessionId.slice(0, 8)}`,
        firstPromptPreview: title,
        lastPromptPreview: title,
        lastActivityAt: stats.mtime.toISOString(),
    };
}

async function readJsonOr(filePath, fallback) {
    try {
        const value = JSON.parse(await fs.readFile(filePath, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
    }
    catch {
        return fallback;
    }
}

async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temporary, filePath);
        await fs.chmod(filePath, 0o600);
    }
    finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
}

function parseSkillMetadata(text, fallbackName) {
    const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u)?.[1] ?? "";
    const readField = (field) => {
        const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "mu"));
        if (!match)
            return "";
        return match[1].trim().replace(/^(["'])([\s\S]*)\1$/u, "$2");
    };
    return {
        name: readField("name") || fallbackName,
        description: readField("description") || "",
    };
}

async function describeSkill(directory, options) {
    const skillFile = path.join(directory, "SKILL.md");
    try {
        const metadata = parseSkillMetadata(await fs.readFile(skillFile, "utf8"), path.basename(directory));
        const source = await readJsonOr(path.join(directory, ".paseo-skill.json"), {});
        return {
            id: `${options.store}:${options.enabled ? "enabled" : "disabled"}:${path.basename(directory)}`,
            folder: path.basename(directory),
            path: directory,
            skillFile,
            name: metadata.name,
            description: metadata.description,
            scope: options.scope,
            store: options.store,
            enabled: options.enabled,
            readOnly: options.readOnly,
            valid: Boolean(metadata.name),
            sourcePath: typeof source.sourcePath === "string" ? source.sourcePath : null,
            lastSyncedAt: typeof source.lastSyncedAt === "string" ? source.lastSyncedAt : null,
        };
    }
    catch {
        return null;
    }
}

async function scanSkillRoot(root, options) {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const skills = await Promise.all(entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .filter((entry) => !(options.store === "codex" && entry.name === ".system"))
        .map((entry) => describeSkill(path.join(root, entry.name), options)));
    return skills.filter(Boolean);
}

function skillRoots() {
    const home = homedir();
    return {
        agentsEnabled: path.join(home, ".agents", "skills"),
        agentsDisabled: path.join(home, ".agents", "skills-disabled"),
        codexEnabled: path.join(home, ".codex", "skills"),
        codexDisabled: path.join(home, ".codex", "skills-disabled"),
        claudeEnabled: path.join(home, ".claude", "skills"),
        claudeDisabled: path.join(home, ".claude", "skills-disabled"),
        system: path.join(home, ".codex", "skills", ".system"),
    };
}

async function listSkills() {
    const roots = skillRoots();
    const groups = await Promise.all([
        scanSkillRoot(roots.agentsEnabled, { scope: "用户", store: "agents", enabled: true, readOnly: false }),
        scanSkillRoot(roots.agentsDisabled, { scope: "用户", store: "agents", enabled: false, readOnly: false }),
        scanSkillRoot(roots.codexEnabled, { scope: "兼容目录", store: "codex", enabled: true, readOnly: false }),
        scanSkillRoot(roots.codexDisabled, { scope: "兼容目录", store: "codex", enabled: false, readOnly: false }),
        scanSkillRoot(roots.claudeEnabled, { scope: "Claude", store: "claude", enabled: true, readOnly: false }),
        scanSkillRoot(roots.claudeDisabled, { scope: "Claude", store: "claude", enabled: false, readOnly: false }),
        scanSkillRoot(roots.system, { scope: "系统内置", store: "system", enabled: true, readOnly: true }),
    ]);
    return groups.flat().sort((left, right) => Number(left.readOnly) - Number(right.readOnly) || left.name.localeCompare(right.name));
}

function resolveManagedSkill(body, skills) {
    const id = requireString(body.id, "Skill id", 300);
    const skill = skills.find((item) => item.id === id);
    if (!skill || skill.readOnly) {
        throw new Error("Skill not found or is read-only");
    }
    return skill;
}

async function moveToTrash(sourcePath, kind) {
    const trashRoot = path.join(homedir(), ".paseo", "trash");
    await fs.mkdir(trashRoot, { recursive: true, mode: 0o700 });
    const name = `${kind}-${path.basename(sourcePath)}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 6)}`;
    const target = path.join(trashRoot, name);
    await fs.rename(sourcePath, target);
    return target;
}

async function importSkill(body) {
    let source = path.resolve(requireString(body.path, "Skill path"));
    if (path.basename(source).toUpperCase() === "SKILL.MD")
        source = path.dirname(source);
    const skillFile = path.join(source, "SKILL.md");
    const metadata = parseSkillMetadata(await fs.readFile(skillFile, "utf8"), path.basename(source));
    const folder = metadata.name && SAFE_NAME.test(metadata.name) ? metadata.name : path.basename(source);
    if (!SAFE_NAME.test(folder)) {
        throw new Error("Skill name may contain only letters, numbers, dots, underscores, and dashes");
    }
    const roots = skillRoots();
    const target = body.target === "codex" ? roots.codexEnabled
        : body.target === "claude" ? roots.claudeEnabled
            : roots.agentsEnabled;
    const targetPath = path.join(target, folder);
    if (await pathExists(targetPath))
        throw new Error(`Skill already exists: ${folder}`);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.cp(source, targetPath, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    await writeJsonAtomic(path.join(targetPath, ".paseo-skill.json"), { sourcePath: source, importedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString() });
    return { imported: folder };
}

async function updateSkill(body) {
    const skill = resolveManagedSkill(body, await listSkills());
    const metadataPath = path.join(skill.path, ".paseo-skill.json");
    const metadata = await readJsonOr(metadataPath, {});
    const source = typeof metadata.sourcePath === "string" ? path.resolve(metadata.sourcePath) : "";
    if (!source || source === path.resolve(skill.path) || !(await pathExists(path.join(source, "SKILL.md")))) {
        throw new Error("这个 Skill 没有可用的上游目录");
    }
    await fs.cp(source, skill.path, { recursive: true, force: true, preserveTimestamps: true });
    await writeJsonAtomic(metadataPath, { ...metadata, sourcePath: source, lastSyncedAt: new Date().toISOString() });
    return { updated: skill.name, lastSyncedAt: new Date().toISOString() };
}

async function toggleSkill(body) {
    const skills = await listSkills();
    const skill = resolveManagedSkill(body, skills);
    const enable = body.enabled === true;
    if (skill.enabled === enable)
        return { changed: false };
    const roots = skillRoots();
    const targetRoot = skill.store === "agents"
        ? (enable ? roots.agentsEnabled : roots.agentsDisabled)
        : skill.store === "claude"
            ? (enable ? roots.claudeEnabled : roots.claudeDisabled)
            : (enable ? roots.codexEnabled : roots.codexDisabled);
    const target = path.join(targetRoot, skill.folder);
    if (await pathExists(target))
        throw new Error(`Target already exists: ${target}`);
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
    await fs.rename(skill.path, target);
    return { changed: true, enabled: enable };
}

async function deleteSkill(body) {
    const skill = resolveManagedSkill(body, await listSkills());
    return { trashedTo: await moveToTrash(skill.path, "skill") };
}

function pluginPaths() {
    const home = homedir();
    return {
        root: path.join(home, ".codex", "plugins"),
        marketplace: path.join(home, ".agents", "plugins", "marketplace.json"),
    };
}

async function readMarketplace() {
    const { marketplace } = pluginPaths();
    const value = await readJsonOr(marketplace, {});
    return {
        ...value,
        name: typeof value.name === "string" && value.name.trim() ? value.name : "paseo-personal",
        interface: value.interface && typeof value.interface === "object"
            ? value.interface
            : { displayName: "Paseo Personal Plugins" },
        plugins: Array.isArray(value.plugins) ? value.plugins : [],
    };
}

async function listPlugins() {
    const { root } = pluginPaths();
    const marketplace = await readMarketplace();
    const enabledNames = new Set(marketplace.plugins.map((item) => item?.name).filter((name) => typeof name === "string"));
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const plugins = await Promise.all(entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
        const directory = path.join(root, entry.name);
        const manifestPath = path.join(directory, ".codex-plugin", "plugin.json");
        try {
            const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
            const name = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : entry.name;
            return {
                id: entry.name,
                folder: entry.name,
                path: directory,
                manifestPath,
                name,
                version: typeof manifest.version === "string" ? manifest.version : "",
                description: typeof manifest.description === "string" ? manifest.description : "",
                enabled: enabledNames.has(name),
                valid: SAFE_NAME.test(name),
                hasSkills: typeof manifest.skills === "string",
                hasMcp: typeof manifest.mcpServers === "string" || typeof manifest.mcp === "string" || await pathExists(path.join(directory, ".mcp.json")),
            };
        }
        catch {
            return {
                id: entry.name,
                folder: entry.name,
                path: directory,
                manifestPath,
                name: entry.name,
                version: "",
                description: "缺少或无法读取 .codex-plugin/plugin.json",
                enabled: false,
                valid: false,
                hasSkills: false,
                hasMcp: false,
            };
        }
    }));
    return plugins.sort((left, right) => left.name.localeCompare(right.name));
}

async function saveMarketplace(marketplace) {
    await writeJsonAtomic(pluginPaths().marketplace, marketplace);
}

function marketplacePluginEntry(plugin) {
    return {
        name: plugin.name,
        source: { source: "local", path: `./.codex/plugins/${plugin.folder}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
    };
}

async function setPluginEnabled(plugin, enabled) {
    const marketplace = await readMarketplace();
    const others = marketplace.plugins.filter((item) => item?.name !== plugin.name);
    marketplace.plugins = enabled ? [...others, marketplacePluginEntry(plugin)] : others;
    await saveMarketplace(marketplace);
}

async function importPlugin(body) {
    let source = path.resolve(requireString(body.path, "Plugin path"));
    if (path.basename(source) === "plugin.json" && path.basename(path.dirname(source)) === ".codex-plugin")
        source = path.dirname(path.dirname(source));
    const manifest = JSON.parse(await fs.readFile(path.join(source, ".codex-plugin", "plugin.json"), "utf8"));
    const name = requireString(manifest.name, "Plugin manifest name", 100);
    if (!SAFE_NAME.test(name))
        throw new Error("Plugin name is invalid");
    const paths = pluginPaths();
    const target = path.join(paths.root, name);
    if (await pathExists(target))
        throw new Error(`Plugin already exists: ${name}`);
    await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    const plugin = { folder: name, name };
    await setPluginEnabled(plugin, true);
    return { imported: name };
}

async function resolvePlugin(body) {
    const id = requireString(body.id, "Plugin id", 120);
    const plugin = (await listPlugins()).find((item) => item.id === id);
    if (!plugin)
        throw new Error("Plugin not found");
    return plugin;
}

async function togglePlugin(body) {
    const plugin = await resolvePlugin(body);
    if (!plugin.valid)
        throw new Error("Invalid plugin manifest");
    await setPluginEnabled(plugin, body.enabled === true);
    return { changed: true, enabled: body.enabled === true };
}

async function deletePlugin(body) {
    const plugin = await resolvePlugin(body);
    await setPluginEnabled(plugin, false);
    return { trashedTo: await moveToTrash(plugin.path, "plugin") };
}

async function directoryRoots() {
    const candidates = [
        { id: "phone", label: "手机存储", path: "/storage/emulated/0" },
        { id: "download", label: "Download", path: "/storage/emulated/0/Download" },
        { id: "termux", label: "Termux", path: homedir() },
        { id: "root", label: "系统根目录", path: "/" },
    ];
    const results = [];
    for (const item of candidates) {
        if (await pathExists(item.path))
            results.push(item);
    }
    return results;
}

async function listDirectories(requestedPath) {
    const raw = requestedPath ? requireString(requestedPath, "Directory path") : "/storage/emulated/0";
    const resolved = await fs.realpath(path.resolve(raw));
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory())
        throw new Error("Path is not a directory");
    const rawEntries = await fs.readdir(resolved, { withFileTypes: true });
    const directories = [];
    for (const entry of rawEntries.slice(0, 2000)) {
        if (entry.isDirectory()) {
            directories.push({ name: entry.name, path: path.join(resolved, entry.name), symlink: false });
            continue;
        }
        if (entry.isSymbolicLink()) {
            const target = path.join(resolved, entry.name);
            const targetStats = await fs.stat(target).catch(() => null);
            if (targetStats?.isDirectory())
                directories.push({ name: entry.name, path: target, symlink: true });
        }
    }
    directories.sort((left, right) => Number(left.name.startsWith(".")) - Number(right.name.startsWith(".")) || left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
    return {
        path: resolved,
        parent: resolved === path.parse(resolved).root ? null : path.dirname(resolved),
        roots: await directoryRoots(),
        directories,
        truncated: rawEntries.length > 2000,
    };
}

async function listConversations(runtime) {
    const records = await runtime.agentStorage.list();
    return records
        .filter((record) => !record.archivedAt && !record.internal)
        .sort((left, right) => Date.parse(right.lastActivityAt ?? right.updatedAt) - Date.parse(left.lastActivityAt ?? left.updatedAt))
        .map((record) => ({
        id: record.id,
        title: record.title?.trim() || "未命名对话",
        provider: record.provider,
        cwd: record.cwd,
        updatedAt: record.lastActivityAt ?? record.updatedAt,
        status: runtime.agentManager.getAgent(record.id)?.status ?? record.lastStatus ?? "closed",
    }));
}

async function listImportable(runtime) {
    const home = homedir();
    const otherProviders = runtime.providerSnapshotManager.listRegisteredProviderIds()
        .filter((provider) => !LOCAL_TRANSCRIPT_PROVIDERS.has(provider));
    const otherProviderScans = otherProviders.map(async (provider) => {
        try {
            const result = await withDeadline(listImportableProviderSessions({
                request: { limit: MAX_IMPORT_COUNT, providers: [provider] },
                agentManager: runtime.agentManager,
                agentStorage: runtime.agentStorage,
                providerSnapshotManager: runtime.providerSnapshotManager,
            }), PROVIDER_SCAN_TIMEOUT_MS, provider);
            return result.entries;
        }
        catch (error) {
            runtime.logger?.warn?.({ err: error, provider }, "Skipping slow provider conversation scan");
            return [];
        }
    });
    const [records, codexFiles, archivedCodexFiles, claudeFiles, otherEntries] = await Promise.all([
        runtime.agentStorage.list(),
        collectJsonlFiles(path.join(home, ".codex", "sessions")),
        collectJsonlFiles(path.join(home, ".codex", "archived_sessions")),
        collectJsonlFiles(path.join(home, ".claude", "projects")),
        Promise.all(otherProviderScans),
    ]);
    const importedHandles = new Set();
    for (const record of records) {
        const persistence = record?.persistence;
        const runtimeInfo = record?.runtimeInfo;
        for (const handle of [persistence?.sessionId, persistence?.nativeHandle, runtimeInfo?.sessionId]) {
            if (typeof handle === "string" && handle)
                importedHandles.add(handle);
        }
    }
    const codexPaths = [...new Set([...codexFiles, ...archivedCodexFiles])];
    const descriptors = [...otherEntries.flat(), ...(await Promise.all([
        ...codexPaths.map(parseCodexTranscript),
        ...claudeFiles.map(parseClaudeTranscript),
    ])).filter(Boolean)];
    const unique = new Map();
    for (const entry of descriptors) {
        if (importedHandles.has(entry.providerHandleId))
            continue;
        const key = `${entry.providerId}:${entry.providerHandleId}`;
        const current = unique.get(key);
        if (!current || Date.parse(entry.lastActivityAt) > Date.parse(current.lastActivityAt))
            unique.set(key, entry);
    }
    return [...unique.values()]
        .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt))
        .slice(0, MAX_IMPORT_COUNT);
}

async function importAllConversations(runtime) {
    const entries = await listImportable(runtime);
    const imported = [];
    const failed = [];
    for (const entry of entries) {
        try {
            const result = await importProviderSession({
                request: {
                    provider: entry.providerId,
                    providerHandleId: entry.providerHandleId,
                    cwd: entry.cwd,
                },
                workspaceProvisioning: runtime.workspaceProvisioning,
                agentManager: runtime.agentManager,
                agentStorage: runtime.agentStorage,
                logger: runtime.logger,
            });
            imported.push({ id: result.snapshot.id, title: entry.title || entry.firstPromptPreview || "未命名对话" });
            await runtime.agentManager.closeAgent(result.snapshot.id).catch(() => undefined);
        }
        catch (error) {
            failed.push({ provider: entry.providerLabel || entry.providerId, title: entry.title || entry.firstPromptPreview || entry.providerHandleId, error: messageOf(error) });
        }
    }
    await runtime.agentManager.flush();
    return { total: entries.length, imported, failed };
}

async function importOneConversation(runtime, body) {
    const provider = requireString(body.providerId ?? body.provider, "Provider id", 100);
    const providerHandleId = requireString(body.providerHandleId ?? body.sessionId, "Provider session id", 300);
    const cwd = requireString(body.cwd, "Conversation cwd", 8192);
    const result = await importProviderSession({
        request: { provider, providerHandleId, cwd },
        workspaceProvisioning: runtime.workspaceProvisioning,
        agentManager: runtime.agentManager,
        agentStorage: runtime.agentStorage,
        logger: runtime.logger,
    });
    await runtime.agentManager.closeAgent(result.snapshot.id).catch(() => undefined);
    await runtime.agentManager.flush();
    return { imported: { id: result.snapshot.id, provider, providerHandleId } };
}

async function deleteConversation(runtime, body) {
    const id = requireString(body.id, "Conversation id", 200);
    const record = await runtime.agentStorage.get(id);
    if (!record)
        throw new Error("Conversation not found");
    runtime.agentStorage.beginDelete?.(id);
    await closeAgentCommand({ agentManager: runtime.agentManager }, id).catch(() => undefined);
    await runtime.agentManager.flush();
    await runtime.agentStorage.remove(id);
    await runtime.agentManager.deleteAgentState(id);
    return { deleted: id };
}

function listAgentProviders(runtime) {
    return runtime.providerSnapshotManager.listRegisteredProviderIds().map((id) => ({
        id,
        label: runtime.providerSnapshotManager.getProviderLabel(id),
    }));
}

async function listWorkspaces(runtime) {
    return (await runtime.workspaceRegistry.list())
        .filter((workspace) => !workspace.archivedAt)
        .map((workspace) => ({
        serverId: runtime.serverId,
        id: workspace.workspaceId,
        name: workspace.title || workspace.displayName,
        cwd: workspace.cwd,
        kind: workspace.kind,
    }));
}

async function addWorkspace(runtime, body) {
    const requested = path.resolve(requireString(body.path, "Workspace path"));
    const resolved = await fs.realpath(requested);
    if (!(await fs.stat(resolved)).isDirectory())
        throw new Error("Workspace path is not a directory");
    const workspace = await runtime.workspaceProvisioning.findOrCreateWorkspaceForDirectory(resolved);
    return {
        serverId: runtime.serverId,
        workspace: {
            id: workspace.workspaceId,
            name: workspace.title || workspace.displayName,
            cwd: workspace.cwd,
        },
    };
}

function requireRuntime(runtime) {
    if (!runtime)
        throw new Error("Paseo management service is still starting");
    return runtime;
}

async function handleGet(runtime, query) {
    const action = typeof query.action === "string" ? query.action : "overview";
    if (action === "overview") {
        const activeRuntime = requireRuntime(runtime);
        const [conversations, workspaces] = await Promise.all([listConversations(activeRuntime), listWorkspaces(activeRuntime)]);
        return { providers: listAgentProviders(activeRuntime), conversationCount: conversations.length, workspaceCount: workspaces.length };
    }
    if (action === "providers")
        return { providers: listAgentProviders(requireRuntime(runtime)) };
    if (action === "conversations")
        return { conversations: await listConversations(requireRuntime(runtime)) };
    if (action === "importable") {
        const entries = await listImportable(requireRuntime(runtime));
        return { count: entries.length, entries };
    }
    if (action === "workspaces")
        return { workspaces: await listWorkspaces(requireRuntime(runtime)) };
    if (action === "directories")
        return await listDirectories(typeof query.path === "string" ? query.path : undefined);
    if (action === "skills")
        return { skills: await listSkills() };
    if (action === "plugins")
        return { plugins: await listPlugins() };
    throw new Error("Unsupported management query");
}

async function handlePost(runtime, body) {
    const input = requireObject(body);
    const action = requireString(input.action, "Action", 80);
    if (action === "conversation-import-all")
        return await importAllConversations(requireRuntime(runtime));
    if (action === "conversation-import")
        return await importOneConversation(requireRuntime(runtime), input);
    if (action === "conversation-delete")
        return await deleteConversation(requireRuntime(runtime), input);
    if (action === "workspace-add")
        return await addWorkspace(requireRuntime(runtime), input);
    if (action === "skill-import")
        return { ...(await importSkill(input)), skills: await listSkills() };
    if (action === "skill-toggle")
        return { ...(await toggleSkill(input)), skills: await listSkills() };
    if (action === "skill-update")
        return { ...(await updateSkill(input)), skills: await listSkills() };
    if (action === "skill-delete")
        return { ...(await deleteSkill(input)), skills: await listSkills() };
    if (action === "plugin-import")
        return { ...(await importPlugin(input)), plugins: await listPlugins() };
    if (action === "plugin-toggle")
        return { ...(await togglePlugin(input)), plugins: await listPlugins() };
    if (action === "plugin-delete")
        return { ...(await deletePlugin(input)), plugins: await listPlugins() };
    throw new Error("Unsupported management action");
}

export function createPaseoManagementRouteHandlers(options = {}) {
    let runtime = null;
    const logger = options.logger;
    return {
        setRuntime(nextRuntime) {
            runtime = nextRuntime;
        },
        get(req, res) {
            if (!isLoopbackRequest(req))
                return sendError(res, 403, new Error("Paseo management is only available from localhost"));
            Promise.resolve(handleGet(runtime, req.query ?? {}))
                .then((payload) => res.json(payload))
                .catch((error) => {
                logger?.warn?.({ err: error, action: req.query?.action }, "Paseo management request failed");
                sendError(res, 400, error);
            });
        },
        post(req, res) {
            if (!isLoopbackRequest(req))
                return sendError(res, 403, new Error("Paseo management is only available from localhost"));
            Promise.resolve(handlePost(runtime, req.body))
                .then((payload) => res.json(payload))
                .catch((error) => {
                logger?.warn?.({ err: error, action: req.body?.action }, "Paseo management action failed");
                sendError(res, 400, error);
            });
        },
    };
}
