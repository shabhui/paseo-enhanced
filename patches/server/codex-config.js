import {
    chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const WIRE_APIS = new Set(["responses", "chat"]);
const PASEO_CODEX_PROXY_BASE_URL = "http://127.0.0.1:6768/v1";
const PERMISSIONS = {
    readonly: { sandboxMode: "read-only", approvalPolicy: "on-request" },
    workspace: { sandboxMode: "workspace-write", approvalPolicy: "on-request" },
    autonomous: { sandboxMode: "workspace-write", approvalPolicy: "never" },
    full: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
};

function resolvePaths() {
    const configured = process.env.CODEX_HOME?.trim();
    const codexHome = !configured ? path.join(homedir(), ".codex")
        : configured === "~" ? homedir()
            : configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : path.resolve(configured);
    return {
        configPath: path.join(codexHome, "config.toml"),
        authPath: path.join(codexHome, "auth.json"),
        profilesPath: path.join(homedir(), ".paseo", "codex-provider-profiles.json"),
    };
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function parseTomlString(line, key) {
    const match = line.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(?:\"((?:\\\\.|[^\"])*)\"|'([^']*)')\\s*(?:#.*)?$`));
    if (!match) return null;
    if (match[1] !== undefined) {
        try { return JSON.parse(`\"${match[1]}\"`); } catch { return match[1]; }
    }
    return match[2] ?? null;
}

function getSectionRange(lines, provider) {
    const header = new RegExp(`^\\s*\\[model_providers\\.${escapeRegExp(provider)}\\]\\s*(?:#.*)?$`);
    const start = lines.findIndex((line) => header.test(line));
    if (start < 0) return null;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
        if (/^\s*\[/.test(lines[index])) { end = index; break; }
    }
    return { start, end };
}

function readTopLevelString(lines, key) {
    for (const line of lines) {
        if (/^\s*\[/.test(line)) break;
        const value = parseTomlString(line, key);
        if (value !== null) return value;
    }
    return null;
}

function readSectionString(lines, range, key) {
    if (!range) return null;
    for (let index = range.start + 1; index < range.end; index += 1) {
        const value = parseTomlString(lines[index], key);
        if (value !== null) return value;
    }
    return null;
}

function readJsonObject(filePath) {
    if (!existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path.basename(filePath)} must contain a JSON object`);
    return parsed;
}

function readJsonObjectOrEmpty(filePath) {
    try { return readJsonObject(filePath); } catch { return {}; }
}

function writePrivateFileAtomic(filePath, content) {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(tempPath, filePath);
        chmodSync(filePath, 0o600);
    } finally { if (existsSync(tempPath)) unlinkSync(tempPath); }
}

function normalizeBaseUrl(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Base URL is required");
    const trimmed = value.trim().replace(/\/+$/, "");
    let parsed;
    try { parsed = new URL(trimmed); } catch { throw new Error("Base URL must be a valid URL"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Base URL must use http or https");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Base URL must not contain credentials, query, or fragment");
    return trimmed;
}

function setTopLevelString(configText, key, value) {
    const newline = configText.includes("\r\n") ? "\r\n" : "\n";
    const lines = configText.replace(/\r\n/g, "\n").split("\n");
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
    const limit = firstSection < 0 ? lines.length : firstSection;
    for (let index = 0; index < limit; index += 1) {
        if (pattern.test(lines[index])) { lines[index] = `${key} = ${JSON.stringify(value)}`; return lines.join(newline); }
    }
    lines.unshift(`${key} = ${JSON.stringify(value)}`);
    return lines.join(newline);
}

function removeTopLevelKey(configText, key) {
    const newline = configText.includes("\r\n") ? "\r\n" : "\n";
    const lines = configText.replace(/\r\n/g, "\n").split("\n");
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
    const limit = firstSection < 0 ? lines.length : firstSection;
    return lines.filter((line, index) => index >= limit || !pattern.test(line)).join(newline);
}

function setSectionBoolean(configText, section, key, value) {
    const newline = configText.includes("\r\n") ? "\r\n" : "\n";
    const lines = configText.replace(/\r\n/g, "\n").split("\n");
    const dottedPattern = new RegExp(`^\\s*${escapeRegExp(section)}\\.${escapeRegExp(key)}\\s*=`);
    const dottedIndex = lines.findIndex((line) => dottedPattern.test(line));
    if (dottedIndex >= 0) {
        lines[dottedIndex] = `${section}.${key} = ${value ? "true" : "false"}`;
        return lines.join(newline);
    }
    const headerPattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*(?:#.*)?$`);
    const start = lines.findIndex((line) => headerPattern.test(line));
    if (start >= 0) {
        let end = lines.length;
        for (let index = start + 1; index < lines.length; index += 1) {
            if (/^\s*\[/.test(lines[index])) { end = index; break; }
        }
        const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
        const existing = lines.findIndex((line, index) => index > start && index < end && keyPattern.test(line));
        if (existing >= 0) lines[existing] = `${key} = ${value ? "true" : "false"}`;
        else lines.splice(start + 1, 0, `${key} = ${value ? "true" : "false"}`);
        return lines.join(newline);
    }
    while (lines.at(-1) === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(`[${section}]`, `${key} = ${value ? "true" : "false"}`, "");
    return lines.join(newline);
}

export function updateProviderConfig(configText, provider, profile) {
    if (!PROVIDER_NAME_PATTERN.test(provider)) throw new Error("Unsupported Codex model provider name");
    const newline = configText.includes("\r\n") ? "\r\n" : "\n";
    const lines = configText.replace(/\r\n/g, "\n").split("\n");
    const range = getSectionRange(lines, provider);
    if (!range) {
        while (lines.at(-1) === "") lines.pop();
        if (lines.length) lines.push("");
        lines.push(`[model_providers.${provider}]`, `name = ${JSON.stringify(profile.name)}`, `base_url = ${JSON.stringify(PASEO_CODEX_PROXY_BASE_URL)}`, 'wire_api = "responses"', 'env_key = "OPENAI_API_KEY"', "requires_openai_auth = false", "");
        return lines.join(newline);
    }
    const values = {
        name: profile.name,
        base_url: PASEO_CODEX_PROXY_BASE_URL,
        wire_api: "responses",
        env_key: "OPENAI_API_KEY",
    };
    for (const [key, value] of Object.entries(values)) {
        const item = lines.findIndex((line, index) => index > range.start && index < range.end && new RegExp(`^\\s*${key}\\s*=`).test(line));
        if (item >= 0) lines[item] = `${key} = ${JSON.stringify(value)}`;
        else lines.splice(range.start + 1, 0, `${key} = ${JSON.stringify(value)}`), range.end += 1;
    }
    const authIndex = lines.findIndex((line, index) => index > range.start && index < range.end && /^\s*requires_openai_auth\s*=/.test(line));
    if (authIndex >= 0) lines[authIndex] = "requires_openai_auth = false";
    else lines.splice(range.start + 1, 0, "requires_openai_auth = false");
    return lines.join(newline);
}

function inferPermission(lines) {
    const sandboxMode = readTopLevelString(lines, "sandbox_mode") ?? "workspace-write";
    const approvalPolicy = readTopLevelString(lines, "approval_policy") ?? "on-request";
    return Object.entries(PERMISSIONS).find(([, item]) => item.sandboxMode === sandboxMode && item.approvalPolicy === approvalPolicy)?.[0] ?? "workspace";
}

function profileView(profile, activeId) {
    const key = typeof profile.apiKey === "string" ? profile.apiKey : "";
    return {
        id: profile.id, name: profile.name, baseUrl: profile.baseUrl,
        reasoningEffort: profile.reasoningEffort, permission: profile.permission,
        wireApi: profile.wireApi === "chat" ? "chat" : "responses",
        model: typeof profile.model === "string" ? profile.model : "",
        models: Array.isArray(profile.models) ? profile.models : [],
        busyRetryEnabled: profile.busyRetryEnabled === true,
        busyRetryAttempts: [3, 6, 10, 20].includes(profile.busyRetryAttempts) ? profile.busyRetryAttempts : 6,
        active: profile.id === activeId, apiKeyConfigured: Boolean(key),
        apiKeyPreview: key ? `****${key.slice(-4)}` : null,
    };
}

function loadState() {
    const paths = resolvePaths();
    const configText = existsSync(paths.configPath) ? readFileSync(paths.configPath, "utf8") : "";
    const auth = readJsonObjectOrEmpty(paths.authPath);
    const lines = configText.replace(/\r\n/g, "\n").split("\n");
    const activeProvider = readTopLevelString(lines, "model_provider") ?? "OpenAI";
    const baseUrl = readSectionString(lines, getSectionRange(lines, activeProvider), "base_url") ?? "https://api.openai.com/v1";
    const existing = readJsonObject(paths.profilesPath);
    let profiles = Array.isArray(existing.profiles) ? existing.profiles.filter((item) => item && typeof item.id === "string") : [];
    let activeId = typeof existing.activeId === "string" ? existing.activeId : null;
    if (!profiles.length) {
        const id = `provider_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        profiles = [{ id, name: activeProvider, baseUrl, apiKey: typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "", reasoningEffort: readTopLevelString(lines, "model_reasoning_effort") ?? "medium", permission: inferPermission(lines), wireApi: "responses", model: readTopLevelString(lines, "model") ?? "", models: [] }];
        activeId = id;
        writePrivateFileAtomic(paths.profilesPath, `${JSON.stringify({ version: 1, activeId, profiles }, null, 2)}\n`);
    }
    if (!profiles.some((item) => item.id === activeId)) activeId = profiles[0].id;
    return { paths, configText, auth, profiles, activeId };
}

function publicState(state) {
    return { activeId: state.activeId, profiles: state.profiles.map((item) => profileView(item, state.activeId)), reasoningEfforts: [...REASONING_EFFORTS], permissions: Object.keys(PERMISSIONS), wireApis: [...WIRE_APIS] };
}

function validateProfileInput(input, existing) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 60) throw new Error("Provider name is required and must be at most 60 characters");
    const reasoningEffort = input.reasoningEffort;
    if (!REASONING_EFFORTS.has(reasoningEffort)) throw new Error("Unsupported reasoning effort");
    const permission = input.permission;
    if (!PERMISSIONS[permission]) throw new Error("Unsupported permission preset");
    let apiKey = existing?.apiKey ?? "";
    if (input.clearApiKey === true) apiKey = "";
    else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
        apiKey = input.apiKey.trim();
        if (apiKey.length > 65536 || /[\r\n]/.test(apiKey)) throw new Error("API key contains invalid characters");
    }
    const wireApi = WIRE_APIS.has(input.wireApi) ? input.wireApi : "responses";
    const model = typeof input.model === "string" ? input.model.trim().slice(0, 200) : (existing?.model ?? "");
    const models = Array.isArray(existing?.models) ? existing.models : [];
    const busyRetryEnabled = input.busyRetryEnabled === true ||
        (input.busyRetryEnabled === undefined && existing?.busyRetryEnabled === true);
    const requestedAttempts = Number(input.busyRetryAttempts ?? existing?.busyRetryAttempts ?? 6);
    const busyRetryAttempts = [3, 6, 10, 20].includes(requestedAttempts) ? requestedAttempts : 6;
    return { name, baseUrl: normalizeBaseUrl(input.baseUrl), reasoningEffort, permission, apiKey, wireApi, model, models, busyRetryEnabled, busyRetryAttempts };
}

function syncProfileToCodexFiles(state, profile) {
    let config = updateProviderConfig(state.configText, profile.id, profile);
    config = setTopLevelString(config, "model_provider", profile.id);
    config = setTopLevelString(config, "model_reasoning_effort", profile.reasoningEffort);
    if (profile.model) config = setTopLevelString(config, "model", profile.model);
    else config = removeTopLevelKey(config, "model");
    config = setTopLevelString(config, "sandbox_mode", PERMISSIONS[profile.permission].sandboxMode);
    config = setTopLevelString(config, "approval_policy", PERMISSIONS[profile.permission].approvalPolicy);
    config = setSectionBoolean(config, "features", "remote_compaction_v2", false);
    writePrivateFileAtomic(state.paths.configPath, config);
    const auth = { ...state.auth };
    if (profile.apiKey) auth.OPENAI_API_KEY = profile.apiKey; else delete auth.OPENAI_API_KEY;
    writePrivateFileAtomic(state.paths.authPath, `${JSON.stringify(auth, null, 2)}\n`);
}

function saveProfiles(state) {
    writePrivateFileAtomic(state.paths.profilesPath, `${JSON.stringify({ version: 1, activeId: state.activeId, profiles: state.profiles }, null, 2)}\n`);
}

function normalizeModelsEndpoint(baseUrl) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    for (const suffix of ["/responses/compact", "/chat/completions", "/responses", "/models"]) {
        if (normalized.endsWith(suffix)) {
            return `${normalized.slice(0, -suffix.length)}/models`;
        }
    }
    return `${normalized}/models`;
}

export function extractModelIds(payload) {
    const items = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
            ? payload.models
            : Array.isArray(payload?.data?.models)
                ? payload.data.models
                : Array.isArray(payload)
                    ? payload
                    : [];
    return [...new Set(items
        .map((item) => typeof item === "string" ? item : item?.id ?? item?.model ?? item?.name)
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim()))].sort();
}

async function fetchProfileModels(profile) {
    const endpoint = normalizeModelsEndpoint(profile.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
        const headers = { Accept: "application/json" };
        if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
        const response = await fetch(endpoint, { headers, signal: controller.signal });
        const text = await response.text();
        let payload;
        try { payload = text ? JSON.parse(text) : null; }
        catch {
            const contentType = String(response.headers.get("content-type") || "").toLowerCase();
            if (contentType.includes("text/html") || /^\s*</u.test(text)) {
                throw new Error("模型接口返回了网页，请检查 Base URL 是否为 API 地址，或手动填写模型 ID");
            }
            throw new Error(`模型接口没有返回有效 JSON（HTTP ${response.status}）`);
        }
        if (!response.ok) {
            const message = payload?.error?.message || payload?.message;
            throw new Error(message ? `获取模型失败：${message}` : `获取模型失败（HTTP ${response.status}）`);
        }
        const models = extractModelIds(payload);
        if (!models.length) throw new Error("接口没有返回可用模型");
        return models;
    } finally { clearTimeout(timer); }
}

async function handleAction(body) {
    const state = loadState();
    if (body.action === "select-model") {
        const profile = state.profiles.find((item) => item.id === body.id);
        if (!profile) throw new Error("Provider profile not found");
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error("A valid model ID is required");
        profile.model = model;
        state.activeId = profile.id;
        saveProfiles(state);
        return publicState(state);
    }
    if (body.action === "select-permission") {
        const profile = state.profiles.find((item) => item.id === body.id);
        if (!profile) throw new Error("Provider profile not found");
        if (!PERMISSIONS[body.permission]) throw new Error("Unsupported permission preset");
        profile.permission = body.permission;
        state.activeId = profile.id;
        saveProfiles(state);
        return publicState(state);
    }
    if (body.action === "busy-retry-toggle") {
        const profile = state.profiles.find((item) => item.id === body.id) ?? state.profiles.find((item) => item.id === state.activeId);
        if (!profile) throw new Error("Provider profile not found");
        profile.busyRetryEnabled = body.enabled === true;
        state.activeId = profile.id;
        saveProfiles(state);
        return publicState(state);
    }
    if (body.action === "models") {
        const existing = state.profiles.find((item) => item.id === body.id);
        const profile = validateProfileInput(body, existing);
        profile.models = await fetchProfileModels(profile);
        if (existing) {
            existing.models = profile.models;
            saveProfiles(state);
        }
        return { ...publicState(state), fetchedModels: profile.models };
    }
    if (body.action === "delete") {
        if (state.profiles.length <= 1) throw new Error("At least one provider profile is required");
        state.profiles = state.profiles.filter((item) => item.id !== body.id);
        if (state.activeId === body.id) state.activeId = state.profiles[0].id;
        saveProfiles(state);
        return publicState(state);
    }
    if (body.action === "activate") {
        const profile = state.profiles.find((item) => item.id === body.id);
        if (!profile) throw new Error("Provider profile not found");
        state.activeId = profile.id;
        saveProfiles(state);
        return publicState(state);
    }
    if (body.action === "sync-cli") {
        const profile = state.profiles.find((item) => item.id === body.id);
        if (!profile) throw new Error("Provider profile not found");
        state.activeId = profile.id;
        syncProfileToCodexFiles(state, profile);
        saveProfiles(state);
        return { ...publicState(state), cliSynced: true };
    }
    if (body.action !== "save") throw new Error("Unsupported action");
    const existing = state.profiles.find((item) => item.id === body.id);
    const values = validateProfileInput(body, existing);
    let profile;
    if (existing) Object.assign(existing, values), profile = existing;
    else {
        profile = { id: `provider_${randomUUID().replace(/-/g, "").slice(0, 12)}`, ...values };
        state.profiles.push(profile);
    }
    state.activeId = profile.id;
    saveProfiles(state);
    return publicState(state);
}

function isLoopbackRequest(req) { return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? ""); }
function sendError(res, status, error) { res.status(status).json({ error: error instanceof Error ? error.message : String(error) }); }

export function createCodexConfigRouteHandlers() {
    return {
        get(req, res) {
            if (!isLoopbackRequest(req)) return sendError(res, 403, new Error("Codex settings are only available from localhost"));
            try { res.json(publicState(loadState())); } catch (error) { sendError(res, 500, error); }
        },
        post(req, res) {
            if (!isLoopbackRequest(req)) return sendError(res, 403, new Error("Codex settings are only available from localhost"));
            if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return sendError(res, 400, new Error("Expected a JSON object"));
            Promise.resolve(handleAction(req.body)).then((result) => res.json({ ...result, saved: true })).catch((error) => sendError(res, 400, error));
        },
    };
}
