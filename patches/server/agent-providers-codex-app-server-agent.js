import { getAgentStreamEventTurnId, } from "../agent-sdk-types.js";
import { importSessionFromPersistence } from "../provider-session-import.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { composeSystemPromptParts } from "../system-prompt.js";
import { curateAgentActivity } from "../activity-curator.js";
import { mapCodexToolCallEnvelope, mapCodexToolCallFromThreadItem, splitCodexMcpToolResultImages, } from "./codex/tool-call-mapper.js";
import { checkProviderLaunchAvailable, createProviderEnv, resolveProviderLaunch, } from "../provider-launch-config.js";
import { findExecutable, probeExecutable, } from "../../../executable-resolution/executable-resolution.js";
import { createPathEquivalenceMatcher } from "../../../utils/path.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { extractCodexTerminalSessionId, nonEmptyString } from "./tool-call-mapper-utils.js";
import { buildCodexFeatures, codexModelSupportsFastMode } from "./codex-feature-definitions.js";
import { CodexAppServerClient, parseCodexThreadForkResponse, parseCodexThreadRollbackResponse, } from "./codex/app-server-transport.js";
import { revertCodexConversation } from "./codex/rewind.js";
import { materializeProviderImage, renderProviderImageOutputAsAssistantMarkdown, } from "./provider-image-output.js";
import { normalizeProviderReplayTimestamp } from "../provider-history-timestamps.js";
import { formatProviderDiagnostic, formatProviderDiagnosticError, buildBinaryDiagnosticRows, buildCommandResolutionDiagnosticRows, resolveBinaryVersion, } from "./diagnostic-utils.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "./provider-runner.js";
import { MODE_APPLIES_NEXT_TURN_NOTICE, THINKING_APPLIES_NEXT_TURN_NOTICE, } from "../provider-notices.js";
import { applyCodexToolPolicy, CodexProviderOptionsSchema, } from "./codex/options.js";
function assertChildWithPipes(child) {
    if (!child.stdin || !child.stdout || !child.stderr) {
        throw new Error("Child process did not expose stdio pipes");
    }
}
function isRecord(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}
function isArchivedCodexThreadResumeError(error, threadId) {
    if (!(error instanceof Error))
        return false;
    const expectedMessage = `session ${threadId} is archived. ` +
        `Run \`codex unarchive ${threadId}\` to unarchive it first.`;
    return error.message === expectedMessage;
}
function isCodexAlreadyUnarchivedError(error, threadId) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(`no archived rollout found for thread id ${threadId}`);
}
const TURN_START_TIMEOUT_MS = 90 * 1000;
const INTERRUPT_TIMEOUT_MS = 2000;
const CODEX_PROVIDER = "codex";
// Codex treats most app-server client names as the model-request originator.
// This reserved Codex name is non-originating, so requests keep Codex's default
// CLI identity instead of showing up as Paseo in provider usage logs.
const CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_INFO = {
    name: "codex_app_server_daemon",
    title: "Codex App Server Daemon",
    version: "0.0.0",
};
const ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN = "\n\n---\n\n";
const MAX_PENDING_SUB_AGENT_THREADS = 32;
const MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD = 128;
// COMPAT(codexLegacyCollabAgentToolCall): Codex <0.143 emits this shape. Added in
// Paseo v0.1.105; remove after 2027-01-09 once the supported Codex floor is >=0.143.
const CODEX_TOOL_THREAD_ITEM_TYPES = new Set([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "webSearch",
    "collabAgentToolCall",
    "subAgentActivity",
]);
const CODEX_CONTEXT_COMPACTION_TYPE = "contextCompaction";
const CODEX_PLAN_IMPLEMENTATION_PROMPT_PREFIX = "The user approved the plan. Implement it now. Do not restate or revise the plan unless blocked.";
// Codex's experimental `goals` feature ships in 0.128.0+. Older binaries reject
// `--enable goals` at launch, so we gate by version and silently skip the flag
// (and the /goal slash command) when the binary is too old.
const CODEX_GOALS_MIN_VERSION = [0, 128, 0];
const CODEX_AUTO_REVIEW_MIN_VERSION = [0, 115, 0];
function parseCodexVersion(versionOutput) {
    const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match)
        return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function codexVersionAtLeast(versionOutput, min) {
    const parsed = parseCodexVersion(versionOutput);
    if (!parsed)
        return false;
    for (let i = 0; i < 3; i += 1) {
        if (parsed[i] > min[i])
            return true;
        if (parsed[i] < min[i])
            return false;
    }
    return true;
}
function parseGoalSubcommand(args) {
    const trimmed = (args ?? "").trim();
    if (!trimmed)
        return { kind: "usage" };
    const lower = trimmed.toLowerCase();
    if (lower === "pause")
        return { kind: "pause" };
    if (lower === "resume")
        return { kind: "resume" };
    if (lower === "clear")
        return { kind: "clear" };
    return { kind: "set", objective: trimmed };
}
function formatOutOfBandStatusMessage(text) {
    return `${text.replace(/\n+$/u, "")}\n\n`;
}
const CODEX_APP_SERVER_CAPABILITIES = {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsSessionListing: true,
    supportsDynamicModes: false,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
    supportsRewindConversation: true,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
};
const CODEX_MODES = [
    {
        id: "auto",
        label: "Default Permissions",
        description: "Edit files and run commands with Codex's default approval flow.",
    },
    {
        id: "auto-review",
        label: "Auto-review",
        description: "Same workspace-write permissions as Default, but eligible `on-request` approvals are routed through the auto-reviewer subagent.",
    },
    {
        id: "full-access",
        label: "Full Access",
        description: "Edit files, run commands, and access the network without additional prompts.",
    },
];
const DEFAULT_CODEX_MODE_ID = "auto";
const MODE_PRESETS = {
    "read-only": {
        approvalPolicy: "on-request",
        sandbox: "read-only",
    },
    auto: {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
    },
    "auto-review": {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
    },
    "full-access": {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
    },
};
const PASEO_PERMISSION_PRESETS = {
    readonly: { approvalPolicy: "on-request", sandbox: "read-only" },
    workspace: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    autonomous: { approvalPolicy: "never", sandbox: "workspace-write" },
    full: { approvalPolicy: "never", sandbox: "danger-full-access" },
};
const PASEO_ACTIVE_PROVIDER_ID = "paseo_active";
const PASEO_CODEX_PROXY_BASE_URL = "http://127.0.0.1:6768/v1";
function readPaseoActiveCodexProfile() {
    try {
        const filePath = path.join(os.homedir(), ".paseo", "codex-provider-profiles.json");
        const saved = JSON.parse(readFileSync(filePath, "utf8"));
        if (!Array.isArray(saved?.profiles)) {
            return null;
        }
        const profile = saved.profiles.find((item) => item?.id === saved.activeId);
        if (!profile || typeof profile.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(profile.id)) {
            return null;
        }
        return profile;
    }
    catch {
        return null;
    }
}
function parsePaseoProviderPermission(value) {
    return typeof value === "string" ? (PASEO_PERMISSION_PRESETS[value] ?? null) : null;
}
function isPaseoManagedCustomProvider(runtimeSettings, customProvider) {
    if (customProvider?.extends !== CODEX_PROVIDER) {
        return false;
    }
    const providerId = typeof customProvider.id === "string" ? customProvider.id : "";
    return runtimeSettings?.env?.PASEO_CODEX_PROFILE_MANAGED === "1" ||
        typeof runtimeSettings?.env?.PASEO_CODEX_WIRE_API === "string" ||
        /^codex-provider-[A-Za-z0-9_-]+$/.test(providerId);
}
function readSavedProviderPermission() {
    return parsePaseoProviderPermission(readPaseoActiveCodexProfile()?.permission);
}
function isAutoReviewReviewer(value) {
    return value === "auto_review" || value === "guardian_subagent";
}
function applyApprovalsReviewerParam(params, preset) {
    if (preset.approvalsReviewer) {
        params.approvalsReviewer = preset.approvalsReviewer;
    }
}
function shouldPromoteThreadResponseToAutoReview(params) {
    return (isAutoReviewReviewer(params.approvalsReviewer) &&
        params.approvalPolicy === "on-request" &&
        params.sandbox === "workspace-write");
}
function validateCodexMode(modeId) {
    if (!(modeId in MODE_PRESETS)) {
        const validModes = Object.keys(MODE_PRESETS).join(", ");
        throw new Error(`Invalid Codex mode "${modeId}". Valid modes are: ${validModes}`);
    }
}
function normalizeCodexThinkingOptionId(thinkingOptionId) {
    if (typeof thinkingOptionId !== "string") {
        return undefined;
    }
    const normalized = thinkingOptionId.trim();
    if (!normalized || normalized === "default") {
        return undefined;
    }
    return normalized;
}
function normalizeCodexModelId(modelId) {
    if (typeof modelId !== "string") {
        return undefined;
    }
    const normalized = modelId.trim();
    if (!normalized) {
        return undefined;
    }
    return normalized;
}
function normalizeCodexModelLabel(displayName) {
    return displayName.replace(/\bgpt\b/gi, "GPT");
}
function isSchemaRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isObjectSchemaNode(schema) {
    const type = schema.type;
    return (isSchemaRecord(schema.properties) ||
        type === "object" ||
        (Array.isArray(type) && type.includes("object")));
}
function normalizeCodexOutputSchemaNode(schema, schemaPath) {
    if (Array.isArray(schema)) {
        return schema.map((entry, index) => normalizeCodexOutputSchemaNode(entry, `${schemaPath}[${index}]`));
    }
    if (!isSchemaRecord(schema)) {
        return schema;
    }
    const normalized = {};
    for (const [key, value] of Object.entries(schema)) {
        normalized[key] = normalizeCodexOutputSchemaNode(value, `${schemaPath}.${key}`);
    }
    if (!isObjectSchemaNode(normalized)) {
        return normalized;
    }
    if (normalized.additionalProperties === undefined) {
        normalized.additionalProperties = false;
    }
    else if (normalized.additionalProperties !== false) {
        throw new Error(`Codex structured outputs require ${schemaPath} to set additionalProperties to false for object schemas.`);
    }
    const properties = isSchemaRecord(normalized.properties) ? normalized.properties : null;
    if (!properties) {
        return normalized;
    }
    const propertyKeys = Object.keys(properties);
    const existingRequired = Array.isArray(normalized.required)
        ? normalized.required.filter((entry) => typeof entry === "string")
        : [];
    normalized.required = Array.from(new Set([...existingRequired, ...propertyKeys]));
    return normalized;
}
export function normalizeCodexOutputSchema(schema) {
    if (!isSchemaRecord(schema)) {
        throw new Error("Codex structured outputs require a JSON object schema.");
    }
    const normalized = normalizeCodexOutputSchemaNode(schema, "$");
    if (!isSchemaRecord(normalized) || !isObjectSchemaNode(normalized)) {
        throw new Error("Codex structured outputs require a root object schema.");
    }
    return normalized;
}
function mergeCodexConfiguredDefaults(primary, fallback) {
    return {
        model: primary.model ?? fallback.model,
        thinkingOptionId: primary.thinkingOptionId ?? fallback.thinkingOptionId,
    };
}
function codexMicrosoftStorePackageRoot() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
        return null;
    }
    return path.join(localAppData, "Packages");
}
export async function findCodexMicrosoftStoreBinary() {
    if (process.platform !== "win32") {
        return null;
    }
    const packageRoot = codexMicrosoftStorePackageRoot();
    if (!packageRoot) {
        return null;
    }
    let entries;
    try {
        entries = await fs.readdir(packageRoot, { withFileTypes: true });
    }
    catch {
        return null;
    }
    const codexPackages = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"))
        .map((entry) => entry.name)
        .sort();
    for (const packageName of codexPackages) {
        const candidate = path.join(packageRoot, packageName, "LocalCache", "Local", "OpenAI", "Codex", "bin", "codex.exe");
        if (await probeExecutable(candidate)) {
            return candidate;
        }
    }
    return null;
}
export async function findDefaultCodexBinary() {
    return (await findExecutable("codex")) ?? (await findCodexMicrosoftStoreBinary());
}
async function resolveCodexLaunchPrefix(runtimeSettings) {
    const launch = await resolveCodexLaunch(runtimeSettings);
    const availability = await checkCodexLaunchAvailable(launch);
    if (!availability.available) {
        throw new Error("Codex binary not found. Install the Codex CLI (https://github.com/openai/codex) and ensure it is available in your shell PATH.");
    }
    return {
        command: launch.source === "override" ? launch.command : (availability.resolvedPath ?? launch.command),
        args: launch.args,
    };
}
async function resolveCodexLaunch(runtimeSettings) {
    return resolveProviderLaunch({
        commandConfig: runtimeSettings?.command,
        defaultBinary: {
            command: "codex",
            resolvePath: findDefaultCodexBinary,
        },
    });
}
async function checkCodexLaunchAvailable(launch) {
    return checkProviderLaunchAvailable(launch, {
        command: "codex",
        resolvePath: findDefaultCodexBinary,
    });
}
function resolveCodexHomeDir() {
    return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}
function decodeEscapedChar(next) {
    if (next === "n")
        return "\n";
    if (next === "t")
        return "\t";
    return next;
}
function resolvePermissionDecision(response) {
    if (response.behavior === "allow")
        return "accept";
    if (response.interrupt)
        return "cancel";
    return "decline";
}
function firstPositiveFiniteNumber(primary, secondary) {
    if (typeof primary === "number" && Number.isFinite(primary) && primary > 0) {
        return primary;
    }
    if (typeof secondary === "number" && Number.isFinite(secondary) && secondary > 0) {
        return secondary;
    }
    return undefined;
}
function tokenizeCommandArgs(args) {
    const tokens = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < args.length; i += 1) {
        const ch = args[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
                continue;
            }
            if (ch === "\\" && i + 1 < args.length) {
                const next = args[i + 1];
                if (next === quote || next === "\\" || next === "n" || next === "t") {
                    i += 1;
                    current += decodeEscapedChar(next);
                    continue;
                }
            }
            current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += ch;
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}
function parseFrontMatter(markdown) {
    const lines = markdown.split("\n");
    if (lines[0]?.trim() !== "---") {
        return { frontMatter: {}, body: markdown };
    }
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
        if (lines[i]?.trim() === "---") {
            end = i;
            break;
        }
    }
    if (end === -1) {
        return { frontMatter: {}, body: markdown };
    }
    const metaLines = lines.slice(1, end);
    const body = lines.slice(end + 1).join("\n");
    const frontMatter = {};
    for (const line of metaLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const idx = trimmed.indexOf(":");
        if (idx <= 0) {
            continue;
        }
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        value = value.replace(/^['"]/, "").replace(/['"]$/, "");
        if (key && value) {
            frontMatter[key] = value;
        }
    }
    return { frontMatter, body };
}
async function listCodexCustomPrompts() {
    const codexHome = resolveCodexHomeDir();
    const promptsDir = path.join(codexHome, "prompts");
    let entries;
    try {
        entries = await fs.readdir(promptsDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const mdEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.slice(0, -".md".length));
    const parsedCommands = await Promise.all(mdEntries.map(async (entry) => {
        const name = entry.name.slice(0, -".md".length);
        const fullPath = path.join(promptsDir, entry.name);
        let content;
        try {
            content = await fs.readFile(fullPath, "utf8");
        }
        catch {
            return null;
        }
        const parsed = parseFrontMatter(content);
        const description = parsed.frontMatter["description"] ?? "Custom prompt";
        const argumentHint = parsed.frontMatter["argument-hint"] ?? parsed.frontMatter["argument_hint"] ?? "";
        return {
            name: `prompts:${name}`,
            description,
            argumentHint,
            kind: "command",
        };
    }));
    const commands = parsedCommands.filter((cmd) => cmd !== null);
    return commands.sort((a, b) => a.name.localeCompare(b.name));
}
export async function listCodexSkills(cwd, workspaceGitService) {
    const candidates = [];
    candidates.push(path.join(cwd, ".codex", "skills"));
    const repoRoot = workspaceGitService
        ? await workspaceGitService.resolveRepoRoot(cwd).catch(() => null)
        : null;
    if (repoRoot) {
        candidates.push(path.join(path.dirname(cwd), ".codex", "skills"));
        candidates.push(path.join(repoRoot, ".codex", "skills"));
    }
    candidates.push(path.join(resolveCodexHomeDir(), "skills"));
    const candidateReads = await Promise.all(candidates.map(async (dir) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const dirEntries = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
        const skillContents = await Promise.all(dirEntries.map(async (entry) => {
            const skillDir = path.join(dir, entry.name);
            const skillPath = path.join(skillDir, "SKILL.md");
            try {
                return await fs.readFile(skillPath, "utf8");
            }
            catch {
                return null;
            }
        }));
        return skillContents.filter((content) => content !== null);
    }));
    const commandsByName = new Map();
    for (const skillContents of candidateReads) {
        for (const content of skillContents) {
            const { frontMatter } = parseFrontMatter(content);
            const name = frontMatter["name"];
            const description = frontMatter["description"];
            if (!name || !description) {
                continue;
            }
            if (!commandsByName.has(name)) {
                commandsByName.set(name, {
                    name,
                    description,
                    argumentHint: "",
                    kind: "skill",
                });
            }
        }
    }
    return Array.from(commandsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function expandCodexCustomPrompt(template, args) {
    const trimmedArgs = args ? args.trim() : "";
    const tokens = trimmedArgs ? tokenizeCommandArgs(trimmedArgs) : [];
    const named = {};
    const positional = [];
    for (const token of tokens) {
        const idx = token.indexOf("=");
        if (idx > 0) {
            const key = token.slice(0, idx);
            const value = token.slice(idx + 1);
            if (key) {
                named[key] = value;
                continue;
            }
        }
        positional.push(token);
    }
    const dollarPlaceholder = "__CODEX_DOLLAR_PLACEHOLDER__";
    let out = template.split("$$").join(dollarPlaceholder);
    out = out.split("$ARGUMENTS").join(trimmedArgs);
    for (let i = 1; i <= 9; i += 1) {
        const value = positional[i - 1] ?? "";
        out = out.split(`$${i}`).join(value);
    }
    const namedKeys = Object.keys(named).sort((a, b) => b.length - a.length);
    for (const key of namedKeys) {
        const value = named[key] ?? "";
        const re = new RegExp(`\\$${escapeRegExp(key)}\\b`, "g");
        out = out.replace(re, value);
    }
    out = out.split(dollarPlaceholder).join("$");
    return out;
}
function toCodexMcpConfig(config) {
    switch (config.type) {
        case "stdio":
            return {
                command: config.command,
                args: config.args,
                env: config.env,
            };
        case "http":
            return {
                url: config.url,
                http_headers: config.headers,
            };
        case "sse":
            return {
                url: config.url,
                http_headers: config.headers,
            };
        default: {
            const _exhaustive = config;
            throw new Error(`Unsupported MCP config type: ${String(_exhaustive.type)}`);
        }
    }
}
function toObjectRecord(value) {
    return isRecord(value) ? value : undefined;
}
const CodexModelListResponseSchema = z.object({
    data: z
        .array(z.object({
        id: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        isDefault: z.boolean().optional(),
        model: z.string().optional(),
        defaultReasoningEffort: z.string().optional(),
        supportedReasoningEfforts: z
            .array(z.object({
            reasoningEffort: z.string().optional(),
            description: z.string().optional(),
        }))
            .optional(),
    }))
        .optional(),
});
function filterCodexThreadsByCwd(threads, cwd) {
    if (!cwd) {
        return threads;
    }
    // thread/list rows carry an optional cwd. The descriptor builder later
    // falls back to process.cwd() if the field is missing, so we only match
    // here when the row genuinely carries a cwd string — otherwise threads
    // with no cwd would falsely match the daemon's own cwd.
    const matchesCwd = createPathEquivalenceMatcher(cwd);
    return threads.filter((thread) => typeof thread.cwd === "string" && matchesCwd(thread.cwd));
}
export function toAgentUsage(tokenUsage) {
    const usage = toObjectRecord(tokenUsage);
    if (!usage)
        return undefined;
    const last = toObjectRecord(usage.last);
    const contextWindowMaxTokens = firstPositiveFiniteNumber(usage.model_context_window, usage.modelContextWindow);
    const contextWindowUsedTokens = firstPositiveFiniteNumber(last?.total_tokens, last?.totalTokens);
    return {
        inputTokens: typeof last?.inputTokens === "number" ? last.inputTokens : undefined,
        cachedInputTokens: typeof last?.cachedInputTokens === "number" ? last.cachedInputTokens : undefined,
        outputTokens: typeof last?.outputTokens === "number" ? last.outputTokens : undefined,
        ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
        ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
    };
}
function extractUserText(content) {
    if (!Array.isArray(content))
        return null;
    const parts = [];
    for (const item of content) {
        const record = toObjectRecord(item);
        if (!record) {
            continue;
        }
        if (record.type === "text" && typeof record.text === "string") {
            parts.push(record.text);
        }
    }
    return parts.length > 0 ? parts.join("\n") : null;
}
function normalizePlanMarkdown(text) {
    return text
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .join("\n")
        .trim();
}
export function planStepsToMarkdown(steps) {
    const lines = steps
        .map((entry) => entry.step.trim())
        .filter((step) => step.length > 0)
        .map((step) => {
        if (/^(#{1,6}\s|[-*+]\s|\d+\.\s)/.test(step)) {
            return step;
        }
        return `- ${step}`;
    });
    return normalizePlanMarkdown(lines.join("\n"));
}
export function mapCodexPlanToToolCall(params) {
    const text = normalizePlanMarkdown(params.text);
    if (!text) {
        return null;
    }
    return {
        type: "tool_call",
        callId: params.callId,
        name: "plan",
        status: "completed",
        error: null,
        detail: {
            type: "plan",
            text,
        },
    };
}
function buildPlanPermissionActions(options) {
    const actions = [
        {
            id: "dismiss",
            label: "Dismiss",
            behavior: "deny",
            variant: "danger",
            intent: "dismiss",
        },
        {
            id: "implement",
            label: "Implement",
            behavior: "allow",
            variant: "primary",
            intent: "implement",
        },
    ];
    if (options?.includeResumeAction && options.resumeLabel) {
        actions.push({
            id: "implement_resume",
            label: options.resumeLabel,
            behavior: "allow",
            variant: "secondary",
            intent: "implement_resume",
        });
    }
    return actions;
}
function buildCodexPlanImplementationPrompt(planText) {
    const normalizedPlan = normalizePlanMarkdown(planText);
    if (!normalizedPlan) {
        return `${CODEX_PLAN_IMPLEMENTATION_PROMPT_PREFIX} Make the required code changes and verify them.`;
    }
    return [
        CODEX_PLAN_IMPLEMENTATION_PROMPT_PREFIX,
        "Approved plan:",
        normalizedPlan,
        "Carry out the work, make the necessary code changes, and verify the result.",
    ].join("\n\n");
}
export function normalizeCodexQuestionPrompts(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const questions = [];
    for (const item of raw) {
        const record = toObjectRecord(item);
        if (!record) {
            continue;
        }
        const id = nonEmptyString(record.id);
        const header = nonEmptyString(record.header);
        const question = nonEmptyString(record.question);
        if (!id || !header || !question) {
            continue;
        }
        const options = Array.isArray(record.options)
            ? record.options.flatMap((option) => {
                const optionRecord = toObjectRecord(option);
                if (!optionRecord) {
                    return [];
                }
                const label = nonEmptyString(optionRecord.label);
                if (!label) {
                    return [];
                }
                return [
                    {
                        label,
                        ...(typeof optionRecord.description === "string" &&
                            optionRecord.description.trim().length > 0
                            ? { description: optionRecord.description }
                            : {}),
                    },
                ];
            })
            : [];
        questions.push({
            id,
            header,
            question,
            options,
            ...(record.multiSelect === true ? { multiSelect: true } : {}),
            ...(record.isOther === true ? { isOther: true } : {}),
            ...(record.isSecret === true ? { isSecret: true } : {}),
        });
    }
    return questions;
}
export function formatCodexQuestionPrompts(questions) {
    return questions
        .map((question) => {
        const lines = [`${question.header}: ${question.question}`];
        if (question.options.length > 0) {
            lines.push(`Options: ${question.options.map((option) => option.label).join(", ")}`);
        }
        return lines.join("\n");
    })
        .join("\n\n")
        .trim();
}
export function mapCodexQuestionRequestToToolCall(params) {
    const formattedQuestions = formatCodexQuestionPrompts(params.questions);
    const formattedAnswers = params.answers && Object.keys(params.answers).length > 0
        ? Object.entries(params.answers)
            .map(([id, values]) => `${id}: ${values.join(", ")}`)
            .join("\n")
        : null;
    const detailText = params.status === "completed" && formattedAnswers
        ? [formattedQuestions, "Answers:", formattedAnswers].filter(Boolean).join("\n\n")
        : formattedQuestions;
    const base = {
        type: "tool_call",
        callId: params.callId,
        name: "request_user_input",
        detail: {
            type: "plain_text",
            text: detailText,
            icon: "brain",
        },
        metadata: {
            questions: params.questions,
            ...(params.answers ? { answers: params.answers } : {}),
        },
    };
    if (params.status === "failed") {
        return {
            ...base,
            status: "failed",
            error: params.error ?? { message: "Question dismissed" },
        };
    }
    if (params.status === "canceled") {
        return {
            ...base,
            status: "canceled",
            error: null,
        };
    }
    if (params.status === "running") {
        return {
            ...base,
            status: "running",
            error: null,
        };
    }
    return {
        ...base,
        status: "completed",
        error: null,
    };
}
function mapCodexQuestionResponseByHeader(params) {
    if (params.response.behavior !== "allow") {
        return null;
    }
    const updatedInputRecord = toObjectRecord(params.response.updatedInput);
    const answersRecord = toObjectRecord(updatedInputRecord?.answers);
    if (!answersRecord) {
        return null;
    }
    const answers = {};
    for (const question of params.questions) {
        const rawAnswer = answersRecord[question.header];
        if (typeof rawAnswer !== "string") {
            continue;
        }
        const normalizedAnswer = rawAnswer.trim();
        if (!normalizedAnswer) {
            continue;
        }
        const values = question.multiSelect
            ? normalizedAnswer
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
            : [normalizedAnswer];
        if (values.length > 0) {
            answers[question.id] = { answers: values };
        }
    }
    return Object.keys(answers).length > 0 ? answers : null;
}
function extractPatchLikeText(value) {
    const record = toObjectRecord(value);
    if (!record) {
        return undefined;
    }
    const candidates = [
        record.diff,
        record.patch,
        record.unified_diff,
        record.unifiedDiff,
        record.content,
        record.newString,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0) {
            return candidate;
        }
    }
    return undefined;
}
function normalizeCodexThreadItemType(rawType) {
    if (!rawType) {
        return rawType;
    }
    switch (rawType) {
        case "UserMessage":
            return "userMessage";
        case "AgentMessage":
            return "agentMessage";
        case "Reasoning":
            return "reasoning";
        case "Plan":
            return "plan";
        case "CommandExecution":
            return "commandExecution";
        case "FileChange":
            return "fileChange";
        case "McpToolCall":
            return "mcpToolCall";
        case "WebSearch":
            return "webSearch";
        case "CollabAgentToolCall":
            return "collabAgentToolCall";
        case "SubAgentActivity":
            return "subAgentActivity";
        case "ImageView":
            return "imageView";
        case "ImageGeneration":
            return "imageGeneration";
        default:
            return rawType;
    }
}
function normalizeCodexCommandValue(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed.length) {
            return null;
        }
        const wrapperMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/);
        if (!wrapperMatch) {
            return trimmed;
        }
        const candidate = wrapperMatch[1]?.trim() ?? "";
        if (!candidate.length) {
            return trimmed;
        }
        if ((candidate.startsWith('"') && candidate.endsWith('"')) ||
            (candidate.startsWith("'") && candidate.endsWith("'"))) {
            return candidate.slice(1, -1);
        }
        return candidate;
    }
    if (!Array.isArray(value)) {
        return null;
    }
    const parts = value
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (parts.length === 0) {
        return null;
    }
    if (parts.length >= 3 && (parts[1] === "-lc" || parts[1] === "-c")) {
        return parts[2] ?? parts;
    }
    return parts;
}
function parseCodexPatchChanges(changes) {
    const resolvePathFromRecord = (record) => {
        const directPath = (typeof record.path === "string" && record.path.trim().length > 0
            ? record.path.trim()
            : "") ||
            (typeof record.file_path === "string" && record.file_path.trim().length > 0
                ? record.file_path.trim()
                : "") ||
            (typeof record.filePath === "string" && record.filePath.trim().length > 0
                ? record.filePath.trim()
                : "");
        return directPath;
    };
    if (!changes || typeof changes !== "object") {
        return [];
    }
    if (Array.isArray(changes)) {
        return changes
            .map((entry) => {
            const record = toObjectRecord(entry);
            if (!record) {
                return null;
            }
            const pathValue = resolvePathFromRecord(record);
            if (!pathValue) {
                return null;
            }
            return {
                path: pathValue,
                kind: (typeof record.kind === "string" && record.kind) ||
                    (typeof record.type === "string" && record.type) ||
                    undefined,
                content: extractPatchLikeText(record),
            };
        })
            .filter((entry) => entry !== null);
    }
    const recordChanges = toObjectRecord(changes);
    if (!recordChanges) {
        return [];
    }
    const directPathValue = resolvePathFromRecord(recordChanges);
    if (directPathValue) {
        return [
            {
                path: directPathValue,
                kind: (typeof recordChanges.kind === "string" && recordChanges.kind) ||
                    (typeof recordChanges.type === "string" && recordChanges.type) ||
                    undefined,
                content: extractPatchLikeText(recordChanges),
            },
        ];
    }
    return Object.entries(recordChanges)
        .map(([entryPath, value]) => {
        const normalizedPath = entryPath.trim();
        if (!normalizedPath) {
            return null;
        }
        return {
            path: normalizedPath,
            kind: value &&
                typeof value === "object" &&
                typeof value.type === "string"
                ? (value.type ?? undefined)
                : undefined,
            content: extractPatchLikeText(value),
        };
    })
        .filter((entry) => entry !== null);
}
function codexPatchTextFields(text) {
    if (typeof text !== "string") {
        return {};
    }
    const normalized = text.trimStart();
    const looksLikeUnifiedDiff = normalized.startsWith("diff --git") ||
        normalized.startsWith("@@") ||
        normalized.startsWith("--- ") ||
        normalized.startsWith("+++ ");
    return looksLikeUnifiedDiff ? { patch: text } : { content: text };
}
function toRunningToolCall(item) {
    return {
        ...item,
        status: "running",
        error: null,
    };
}
function isEditToolCallWithoutContent(item) {
    if (item.type !== "tool_call") {
        return false;
    }
    if (item.detail.type !== "edit") {
        return false;
    }
    const hasDiff = typeof item.detail.unifiedDiff === "string" && item.detail.unifiedDiff.trim().length > 0;
    const hasNewString = typeof item.detail.newString === "string" && item.detail.newString.trim().length > 0;
    return !hasDiff && !hasNewString;
}
function decodeCodexOutputDeltaChunk(chunk) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) {
        return chunk;
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(trimmed) || trimmed.length % 4 !== 0) {
        return chunk;
    }
    try {
        const decoded = Buffer.from(trimmed, "base64").toString("utf8");
        if (decoded.length === 0) {
            return chunk;
        }
        const normalizedInput = trimmed.replace(/=+$/, "");
        const normalizedRoundTrip = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "");
        return normalizedRoundTrip === normalizedInput ? decoded : chunk;
    }
    catch {
        return chunk;
    }
}
function mapCodexExecNotificationToToolCall(params) {
    const command = normalizeCodexCommandValue(params.command);
    if (!command) {
        return null;
    }
    const isFailure = params.running
        ? false
        : params.success === false || (typeof params.exitCode === "number" && params.exitCode !== 0);
    const output = params.running
        ? null
        : {
            command,
            ...(params.output !== null && params.output !== undefined ? { output: params.output } : {}),
            ...(params.exitCode !== null && params.exitCode !== undefined
                ? { exitCode: params.exitCode }
                : {}),
        };
    const mapped = mapCodexToolCallEnvelope({
        callId: params.callId ?? null,
        name: "shell",
        input: {
            command,
            ...(params.cwd ? { cwd: params.cwd } : {}),
        },
        output,
        error: isFailure ? { message: params.stderr?.trim() || "Command failed" } : null,
        cwd: params.cwd ?? null,
    });
    if (!mapped) {
        return null;
    }
    return params.running ? toRunningToolCall(mapped) : mapped;
}
export function mapCodexPatchNotificationToToolCall(params) {
    const files = parseCodexPatchChanges(params.changes);
    const firstPath = files[0]?.path;
    const firstPatchText = files
        .map((file) => file.content?.trim())
        .find((value) => typeof value === "string" && value.length > 0);
    const patchText = firstPatchText;
    const patchFields = codexPatchTextFields(patchText);
    const mapped = mapCodexToolCallEnvelope({
        callId: params.callId ?? null,
        name: "apply_patch",
        input: firstPath
            ? {
                path: firstPath,
                ...patchFields,
                files: files.map((file) => ({ path: file.path, kind: file.kind })),
            }
            : {
                changes: params.changes ?? null,
                ...patchFields,
            },
        output: params.running
            ? null
            : {
                ...(files.length > 0
                    ? {
                        files: files.map((file) => Object.assign({ path: file.path }, file.kind ? { kind: file.kind } : {}, codexPatchTextFields(file.content ?? patchText))),
                    }
                    : {}),
                ...(params.stdout ? { stdout: params.stdout } : {}),
                ...(params.stderr ? { stderr: params.stderr } : {}),
                ...(params.success !== null && params.success !== undefined
                    ? { success: params.success }
                    : {}),
            },
        error: params.running || params.success !== false
            ? null
            : { message: params.stderr?.trim() || "Patch apply failed" },
        cwd: params.cwd ?? null,
    });
    if (!mapped) {
        return null;
    }
    return params.running ? toRunningToolCall(mapped) : mapped;
}
function mapCodexTerminalInteractionToToolCall(params) {
    const processId = nonEmptyString(params.processId ?? undefined);
    const label = nonEmptyString(params.command ?? undefined);
    return {
        type: "tool_call",
        callId: params.callId,
        name: "terminal",
        status: "completed",
        error: null,
        detail: {
            type: "plain_text",
            ...(label ? { label } : {}),
            ...(params.stdin !== null && params.stdin !== undefined ? { text: params.stdin } : {}),
            icon: "square_terminal",
        },
        ...(processId ? { metadata: { processId } } : {}),
    };
}
function mapCodexThreadPlanItem(normalizedItem) {
    const callId = nonEmptyString(normalizedItem.id ?? normalizedItem.itemId ?? undefined) ??
        `plan:${normalizePlanMarkdown(typeof normalizedItem.text === "string" ? normalizedItem.text : "")}`;
    return mapCodexPlanToToolCall({
        callId,
        text: typeof normalizedItem.text === "string" ? normalizedItem.text : "",
    });
}
function mapCodexThreadReasoningItem(normalizedItem) {
    const summary = Array.isArray(normalizedItem.summary) ? normalizedItem.summary.join("\n") : "";
    const content = Array.isArray(normalizedItem.content) ? normalizedItem.content.join("\n") : "";
    const text = summary || content;
    return text ? { type: "reasoning", text } : null;
}
function mapCodexThreadUserMessageItem(normalizedItem, includeUserMessage) {
    if (!includeUserMessage) {
        return null;
    }
    const text = extractUserText(normalizedItem.content) ?? "";
    const messageId = nonEmptyString(normalizedItem.id);
    return {
        type: "user_message",
        text,
        ...(messageId ? { messageId } : {}),
    };
}
function firstStringField(record, fields) {
    for (const field of fields) {
        const value = record[field];
        if (typeof value === "string") {
            return value;
        }
    }
    return null;
}
function readCodexHistoryTimestamp(item) {
    const record = toObjectRecord(item);
    if (!record) {
        return null;
    }
    return (normalizeProviderReplayTimestamp(record.timestamp) ??
        normalizeProviderReplayTimestamp(record.createdAt) ??
        normalizeProviderReplayTimestamp(record.created_at));
}
function readCodexTurnHistoryTimestamp(turn, timelineItem) {
    const record = toObjectRecord(turn);
    if (!record) {
        return null;
    }
    const startedAt = normalizeProviderReplayTimestamp(record.startedAt) ??
        normalizeProviderReplayTimestamp(record.started_at);
    const completedAt = normalizeProviderReplayTimestamp(record.completedAt) ??
        normalizeProviderReplayTimestamp(record.completed_at);
    if (timelineItem.type === "user_message") {
        return startedAt ?? completedAt;
    }
    return completedAt ?? startedAt;
}
function readCodexSubAgentActivity(item) {
    const record = toObjectRecord(item);
    if (!record) {
        return null;
    }
    const normalizedType = normalizeCodexThreadItemType(typeof record.type === "string" ? record.type : undefined);
    if (normalizedType !== "subAgentActivity" ||
        typeof record.agentThreadId !== "string" ||
        (record.kind !== "started" && record.kind !== "interacted" && record.kind !== "interrupted")) {
        return null;
    }
    return {
        id: nonEmptyString(record.id) ?? null,
        agentThreadId: record.agentThreadId,
        kind: record.kind,
    };
}
function shouldIgnoreMirroredLifecycleItem(source, item) {
    return source === "codex_event" && !readCodexSubAgentActivity(item);
}
function settleHistoricalSubAgentActivity(item, kind) {
    // thread/read returns completed parent items, not a live child snapshot.
    // Only an explicit interruption remains non-completed when replayed.
    return {
        ...item,
        status: kind === "interrupted" ? "canceled" : "completed",
        error: null,
    };
}
function updateHistoricalSubAgentActivity(timeline, index, kind, subAgentType) {
    const existing = timeline[index];
    if (existing?.item.type !== "tool_call") {
        return;
    }
    const settledItem = settleHistoricalSubAgentActivity(existing.item, kind);
    timeline[index] = {
        ...existing,
        item: subAgentType && settledItem.detail.type === "sub_agent"
            ? {
                ...settledItem,
                detail: { ...settledItem.detail, subAgentType },
            }
            : settledItem,
    };
}
function readCodexHistoricalSubAgentThreadIds(item) {
    const activity = readCodexSubAgentActivity(item);
    if (activity) {
        return [activity.agentThreadId];
    }
    const record = toObjectRecord(item);
    const normalizedType = normalizeCodexThreadItemType(typeof record?.type === "string" ? record.type : undefined);
    if (normalizedType !== "collabAgentToolCall" || !Array.isArray(record?.receiverThreadIds)) {
        return [];
    }
    return record.receiverThreadIds.filter((threadId) => typeof threadId === "string" && threadId.length > 0);
}
function codexImageOutputFromResult(result) {
    if (typeof result === "string") {
        const trimmed = result.trim();
        if (trimmed.toLowerCase().startsWith("data:image/") ||
            (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length > 64)) {
            return { data: trimmed };
        }
        return { url: trimmed };
    }
    const resultRecord = toObjectRecord(result);
    if (!resultRecord) {
        return null;
    }
    return {
        path: firstStringField(resultRecord, ["path", "savedPath", "saved_path"]),
        url: firstStringField(resultRecord, ["url"]),
        data: firstStringField(resultRecord, ["data"]),
        mimeType: firstStringField(resultRecord, ["mimeType", "mime_type"]),
    };
}
function mapCodexThreadImageItem(normalizedType, normalizedItem) {
    if (normalizedType === "imageView") {
        return renderProviderImageOutputAsAssistantMarkdown({
            path: firstStringField(normalizedItem, ["path"]),
        });
    }
    const savedPath = firstStringField(normalizedItem, ["savedPath", "saved_path"]);
    const result = codexImageOutputFromResult(normalizedItem.result);
    return renderProviderImageOutputAsAssistantMarkdown({
        path: savedPath ?? result?.path ?? null,
        url: result?.url ?? null,
        data: result?.data ?? null,
        mimeType: result?.mimeType ?? null,
    }, { materialize: materializeProviderImage });
}
export function threadItemToTimeline(item, options) {
    const itemRecord = toObjectRecord(item);
    if (!itemRecord)
        return null;
    const includeUserMessage = options?.includeUserMessage ?? true;
    const cwd = options?.cwd ?? null;
    const normalizedType = normalizeCodexThreadItemType(typeof itemRecord.type === "string" ? itemRecord.type : undefined);
    const normalizedItem = normalizedType && normalizedType !== itemRecord.type
        ? { ...itemRecord, type: normalizedType }
        : itemRecord;
    if (normalizedType === "imageView" || normalizedType === "imageGeneration") {
        return mapCodexThreadImageItem(normalizedType, normalizedItem);
    }
    if (normalizedType && CODEX_TOOL_THREAD_ITEM_TYPES.has(normalizedType)) {
        return mapCodexToolCallFromThreadItem(normalizedItem, { cwd });
    }
    switch (normalizedType) {
        case "userMessage":
            return mapCodexThreadUserMessageItem(normalizedItem, includeUserMessage);
        case "agentMessage": {
            const messageId = nonEmptyString(normalizedItem.id);
            return {
                type: "assistant_message",
                text: typeof normalizedItem.text === "string" ? normalizedItem.text : "",
                ...(messageId ? { messageId } : {}),
            };
        }
        case "plan":
            return mapCodexThreadPlanItem(normalizedItem);
        case "reasoning":
            return mapCodexThreadReasoningItem(normalizedItem);
        case CODEX_CONTEXT_COMPACTION_TYPE:
            return {
                type: "compaction",
                status: "completed",
            };
        default:
            return null;
    }
}
function mcpToolResultImagesToTimeline(item) {
    const itemRecord = toObjectRecord(item);
    if (!itemRecord) {
        return [];
    }
    const normalizedType = normalizeCodexThreadItemType(typeof itemRecord.type === "string" ? itemRecord.type : undefined);
    if (normalizedType !== "mcpToolCall") {
        return [];
    }
    const { images } = splitCodexMcpToolResultImages(itemRecord.result);
    return images
        .map((image) => renderProviderImageOutputAsAssistantMarkdown(image, {
        materialize: materializeProviderImage,
    }))
        .filter((timelineItem) => timelineItem !== null);
}
function threadItemToTimelineEntries(item, options) {
    const timelineItem = threadItemToTimeline(item, options);
    if (!timelineItem) {
        return [];
    }
    return [timelineItem, ...mcpToolResultImagesToTimeline(item)];
}
const CodexThreadReadResponseSchema = z
    .object({
    thread: z
        .object({
        turns: z
            .array(z
            .object({
            items: z.array(z.unknown()).default([]),
        })
            .passthrough())
            .default([]),
    })
        .passthrough()
        .default({ turns: [] }),
})
    .passthrough();
async function requestCodexThreadHistory(requestThread, threadId) {
    const response = await requestThread(threadId);
    return CodexThreadReadResponseSchema.parse(response);
}
async function loadCodexThreadHistoryTimeline(params) {
    const response = await requestCodexThreadHistory(params.requestThread, params.threadId);
    const timeline = [];
    const subAgentTimelineIndexByThreadId = new Map();
    for (const turn of response.thread.turns) {
        for (const item of turn.items) {
            const historicalSubAgentActivity = readCodexSubAgentActivity(item);
            if (historicalSubAgentActivity) {
                const existingIndex = subAgentTimelineIndexByThreadId.get(historicalSubAgentActivity.agentThreadId);
                if (existingIndex !== undefined) {
                    const activityTimelineItem = threadItemToTimeline(item, { cwd: params.cwd });
                    updateHistoricalSubAgentActivity(timeline, existingIndex, historicalSubAgentActivity.kind, activityTimelineItem?.type === "tool_call" &&
                        activityTimelineItem.detail.type === "sub_agent"
                        ? activityTimelineItem.detail.subAgentType
                        : undefined);
                    continue;
                }
            }
            for (const timelineItem of threadItemToTimelineEntries(item, { cwd: params.cwd })) {
                const timestamp = readCodexHistoryTimestamp(item) ?? readCodexTurnHistoryTimestamp(turn, timelineItem);
                const settledTimelineItem = historicalSubAgentActivity && timelineItem.type === "tool_call"
                    ? settleHistoricalSubAgentActivity(timelineItem, historicalSubAgentActivity.kind)
                    : timelineItem;
                timeline.push({
                    item: settledTimelineItem,
                    timestamp: timestamp ?? undefined,
                });
                for (const childThreadId of readCodexHistoricalSubAgentThreadIds(item)) {
                    subAgentTimelineIndexByThreadId.set(childThreadId, timeline.length - 1);
                }
            }
        }
    }
    const subAgentRoutes = Array.from(subAgentTimelineIndexByThreadId.entries()).flatMap(([childThreadId, timelineIndex]) => {
        const item = timeline[timelineIndex]?.item;
        return item?.type === "tool_call" && item.detail.type === "sub_agent"
            ? [{ childThreadId, toolCall: item }]
            : [];
    });
    return { timeline, subAgentRoutes };
}
function readCodexThread(client, threadId) {
    return client.request("thread/read", {
        threadId,
        includeTurns: true,
    });
}
export async function forkCodexThread(client, params) {
    if (client.forkThread) {
        return client.forkThread(params);
    }
    return parseCodexThreadForkResponse(await client.request("thread/fork", params));
}
export async function rollbackCodexThread(client, params) {
    if (client.rollbackThread) {
        return client.rollbackThread(params);
    }
    return parseCodexThreadRollbackResponse(await client.request("thread/rollback", params));
}
function toSandboxPolicy(type, workspaceWrite) {
    switch (type) {
        case "read-only":
            return { type: "readOnly" };
        case "workspace-write":
            return {
                type: "workspaceWrite",
                networkAccess: workspaceWrite?.network_access ?? false,
                writableRoots: workspaceWrite?.writable_roots ?? [],
                excludeSlashTmp: workspaceWrite?.exclude_slash_tmp ?? false,
                excludeTmpdirEnvVar: workspaceWrite?.exclude_tmpdir_env_var ?? false,
            };
        case "danger-full-access":
            return { type: "dangerFullAccess" };
        default:
            return { type: "workspaceWrite", networkAccess: false, writableRoots: [] };
    }
}
function readSandboxWorkspaceWrite(value) {
    const record = toObjectRecord(value);
    if (!record)
        return null;
    const workspaceWrite = {};
    const writableRoots = record.writable_roots ?? record.writableRoots;
    if (Array.isArray(writableRoots)) {
        workspaceWrite.writable_roots = writableRoots.filter((root) => typeof root === "string");
    }
    const networkAccess = record.network_access ?? record.networkAccess;
    if (typeof networkAccess === "boolean")
        workspaceWrite.network_access = networkAccess;
    const excludeSlashTmp = record.exclude_slash_tmp ?? record.excludeSlashTmp;
    if (typeof excludeSlashTmp === "boolean")
        workspaceWrite.exclude_slash_tmp = excludeSlashTmp;
    const excludeTmpdirEnvVar = record.exclude_tmpdir_env_var ?? record.excludeTmpdirEnvVar;
    if (typeof excludeTmpdirEnvVar === "boolean") {
        workspaceWrite.exclude_tmpdir_env_var = excludeTmpdirEnvVar;
    }
    return workspaceWrite;
}
function toCodexSandboxPolicyType(type) {
    switch (type) {
        case "workspace-write":
            return "workspaceWrite";
        case "read-only":
            return "readOnly";
        default:
            return "dangerFullAccess";
    }
}
const ThreadStartedNotificationSchema = z
    .object({
    thread: z.object({ id: z.string() }).passthrough(),
})
    .passthrough();
const TurnStartedNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    turn: z.object({ id: z.string() }).passthrough(),
})
    .passthrough();
const TurnCompletedNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    turn: z
        .object({
        id: z.string().optional(),
        status: z.string(),
        error: z
            .object({
            message: z.string().optional(),
        })
            .passthrough()
            .nullable()
            .optional(),
    })
        .passthrough(),
})
    .passthrough();
const TurnPlanUpdatedNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    plan: z.array(z
        .object({
        step: z.string().optional(),
        status: z.string().optional(),
    })
        .passthrough()),
})
    .passthrough();
const TurnDiffUpdatedNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    diff: z.string(),
})
    .passthrough();
const ThreadTokenUsageUpdatedNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    tokenUsage: z.unknown(),
})
    .passthrough();
const ItemTextDeltaNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    itemId: z.string(),
    delta: z.string(),
})
    .passthrough();
const ItemLifecycleNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    item: z
        .object({
        id: z.string().optional(),
        type: z.string().optional(),
    })
        .passthrough(),
})
    .passthrough();
const ContextCompactedNotificationSchema = z
    .object({
    threadId: z.string(),
    turnId: z.string().optional(),
})
    .passthrough();
const CodexEventThreadIdFields = {
    threadId: z.string().optional(),
    thread_id: z.string().optional(),
};
function getCodexEventThreadId(params) {
    return params.threadId ?? params.thread_id ?? params.msg.threadId ?? params.msg.thread_id ?? null;
}
const CodexEventTurnAbortedNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("turn_aborted"),
        reason: z.string().optional(),
    })
        .passthrough(),
})
    .passthrough();
const CodexEventTaskCompleteNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("task_complete"),
    })
        .passthrough(),
})
    .passthrough();
const CodexEventItemLifecycleNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.enum(["item_started", "item_completed"]),
        item: z
            .object({
            id: z.string().optional(),
            type: z.string().optional(),
        })
            .passthrough(),
    })
        .passthrough(),
})
    .passthrough();
const CodexEventExecCommandBeginNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("exec_command_begin"),
        call_id: z.string().optional(),
        command: z.unknown().optional(),
        cwd: z.string().optional(),
    })
        .passthrough(),
})
    .passthrough();
const CodexEventExecCommandEndNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("exec_command_end"),
        call_id: z.string().optional(),
        command: z.unknown().optional(),
        cwd: z.string().optional(),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
        aggregated_output: z.string().nullable().optional(),
        aggregatedOutput: z.string().nullable().optional(),
        formatted_output: z.string().optional(),
        exit_code: z.number().nullable().optional(),
        exitCode: z.number().nullable().optional(),
        success: z.boolean().optional(),
    })
        .passthrough(),
})
    .passthrough();
const CodexEventExecCommandOutputDeltaNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("exec_command_output_delta"),
        call_id: z.string().optional(),
        stream: z.string().optional(),
        chunk: z.string().optional(),
        delta: z.string().optional(),
    })
        .passthrough(),
})
    .passthrough();
const CodexEventTerminalInteractionNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("terminal_interaction"),
        call_id: z.string().optional(),
        process_id: z.union([z.string(), z.number()]).optional(),
        stdin: z.string().optional(),
    })
        .passthrough(),
})
    .passthrough();
const ItemCommandExecutionTerminalInteractionNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    itemId: z.string().optional(),
    processId: z.union([z.string(), z.number()]).optional(),
    stdin: z.string().optional(),
})
    .passthrough();
const CodexEventPatchApplyBeginNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("patch_apply_begin"),
        call_id: z.string().optional(),
        changes: z.unknown().optional(),
    })
        .passthrough(),
})
    .passthrough();
const CodexEventPatchApplyEndNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("patch_apply_end"),
        call_id: z.string().optional(),
        changes: z.unknown().optional(),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
        success: z.boolean().optional(),
    })
        .passthrough(),
})
    .passthrough();
const ItemFileChangeOutputDeltaNotificationSchema = z
    .object({
    threadId: z.string().optional(),
    itemId: z.string(),
    delta: z.string().optional(),
    chunk: z.string().optional(),
})
    .passthrough();
const CodexEventTurnDiffNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("turn_diff"),
        unified_diff: z.string().optional(),
        diff: z.string().optional(),
    })
        .passthrough(),
})
    .passthrough();
const CodexEventThreadRolledBackNotificationSchema = z
    .object({
    ...CodexEventThreadIdFields,
    msg: z
        .object({
        ...CodexEventThreadIdFields,
        type: z.literal("thread_rolled_back"),
        num_turns: z.number().int().nonnegative().optional(),
        numTurns: z.number().int().nonnegative().optional(),
    })
        .passthrough(),
})
    .passthrough();
function getCodexNotificationThreadId(parsed) {
    return "threadId" in parsed ? parsed.threadId : null;
}
function isCodexDeltaNotification(parsed) {
    return (parsed.kind === "agent_message_delta" ||
        parsed.kind === "reasoning_delta" ||
        parsed.kind === "exec_command_output_delta" ||
        parsed.kind === "file_change_output_delta");
}
const CodexNotificationSchema = z.union([
    z
        .object({ method: z.literal("thread/started"), params: ThreadStartedNotificationSchema })
        .transform(({ params }) => ({
        kind: "thread_started",
        threadId: params.thread.id,
    })),
    z.object({ method: z.literal("thread/started"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z.object({ method: z.literal("turn/started"), params: TurnStartedNotificationSchema }).transform(({ params }) => ({
        kind: "turn_started",
        turnId: params.turn.id,
        threadId: params.threadId ?? null,
    })),
    z.object({ method: z.literal("turn/started"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({ method: z.literal("turn/completed"), params: TurnCompletedNotificationSchema })
        .transform(({ params }) => ({
        kind: "turn_completed",
        status: params.turn.status,
        errorMessage: params.turn.error?.message ?? null,
        threadId: params.threadId ?? null,
    })),
    z.object({ method: z.literal("turn/completed"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({ method: z.literal("turn/plan/updated"), params: TurnPlanUpdatedNotificationSchema })
        .transform(({ params }) => ({
        kind: "plan_updated",
        plan: params.plan.map((entry) => ({
            step: entry.step ?? null,
            status: entry.status ?? null,
        })),
        threadId: params.threadId ?? null,
    })),
    z.object({ method: z.literal("turn/plan/updated"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({ method: z.literal("turn/diff/updated"), params: TurnDiffUpdatedNotificationSchema })
        .transform(({ params }) => ({
        kind: "diff_updated",
        diff: params.diff,
        threadId: params.threadId ?? null,
    })),
    z.object({ method: z.literal("turn/diff/updated"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("thread/tokenUsage/updated"),
        params: ThreadTokenUsageUpdatedNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "token_usage_updated",
        tokenUsage: params.tokenUsage,
        threadId: params.threadId ?? null,
    })),
    z.object({ method: z.literal("thread/tokenUsage/updated"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({ method: z.literal("thread/compacted"), params: ContextCompactedNotificationSchema })
        .transform(({ params }) => ({
        kind: "context_compacted",
        threadId: params.threadId,
        turnId: params.turnId ?? null,
    })),
    z.object({ method: z.literal("thread/compacted"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("item/agentMessage/delta"),
        params: ItemTextDeltaNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "agent_message_delta",
        itemId: params.itemId,
        delta: params.delta,
        threadId: params.threadId ?? null,
    })),
    z.object({ method: z.literal("item/agentMessage/delta"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("item/reasoning/summaryTextDelta"),
        params: ItemTextDeltaNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "reasoning_delta",
        itemId: params.itemId,
        delta: params.delta,
        threadId: params.threadId ?? null,
    })),
    z.object({ method: z.literal("item/reasoning/summaryTextDelta"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({ method: z.literal("item/completed"), params: ItemLifecycleNotificationSchema })
        .transform(({ params }) => ({
        kind: "item_completed",
        source: "item",
        threadId: params.threadId ?? null,
        item: params.item,
    })),
    z.object({ method: z.literal("item/completed"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({ method: z.literal("item/started"), params: ItemLifecycleNotificationSchema })
        .transform(({ params }) => ({
        kind: "item_started",
        source: "item",
        threadId: params.threadId ?? null,
        item: params.item,
    })),
    z.object({ method: z.literal("item/started"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/item_started"),
        params: CodexEventItemLifecycleNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "item_started",
        source: "codex_event",
        threadId: getCodexEventThreadId(params),
        item: params.msg.item,
    })),
    z.object({ method: z.literal("codex/event/item_started"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/item_completed"),
        params: CodexEventItemLifecycleNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "item_completed",
        source: "codex_event",
        threadId: getCodexEventThreadId(params),
        item: params.msg.item,
    })),
    z.object({ method: z.literal("codex/event/item_completed"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/exec_command_begin"),
        params: CodexEventExecCommandBeginNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "exec_command_started",
        callId: params.msg.call_id ?? null,
        command: params.msg.command ?? null,
        cwd: params.msg.cwd ?? null,
        threadId: getCodexEventThreadId(params),
    })),
    z.object({ method: z.literal("codex/event/exec_command_begin"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/exec_command_end"),
        params: CodexEventExecCommandEndNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "exec_command_completed",
        callId: params.msg.call_id ?? null,
        command: params.msg.command ?? null,
        cwd: params.msg.cwd ?? null,
        output: params.msg.aggregated_output ??
            params.msg.aggregatedOutput ??
            params.msg.formatted_output ??
            params.msg.stdout ??
            null,
        exitCode: params.msg.exit_code ?? params.msg.exitCode ?? null,
        success: params.msg.success ?? null,
        stderr: params.msg.stderr ?? null,
        threadId: getCodexEventThreadId(params),
    })),
    z.object({ method: z.literal("codex/event/exec_command_end"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/exec_command_output_delta"),
        params: CodexEventExecCommandOutputDeltaNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "exec_command_output_delta",
        callId: params.msg.call_id ?? null,
        stream: params.msg.stream ?? null,
        chunk: params.msg.chunk ?? params.msg.delta ?? null,
        threadId: getCodexEventThreadId(params),
    })),
    z
        .object({
        method: z.literal("codex/event/exec_command_output_delta"),
        params: z.unknown(),
    })
        .transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/terminal_interaction"),
        params: CodexEventTerminalInteractionNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "terminal_interaction",
        source: "codex_event",
        callId: params.msg.call_id ?? null,
        processId: typeof params.msg.process_id === "number"
            ? String(params.msg.process_id)
            : (params.msg.process_id ?? null),
        stdin: params.msg.stdin ?? null,
        threadId: getCodexEventThreadId(params),
    })),
    z
        .object({ method: z.literal("codex/event/terminal_interaction"), params: z.unknown() })
        .transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("item/commandExecution/terminalInteraction"),
        params: ItemCommandExecutionTerminalInteractionNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "terminal_interaction",
        source: "item",
        callId: params.itemId ?? null,
        processId: typeof params.processId === "number"
            ? String(params.processId)
            : (params.processId ?? null),
        stdin: params.stdin ?? null,
        threadId: params.threadId ?? null,
    })),
    z
        .object({
        method: z.literal("item/commandExecution/terminalInteraction"),
        params: z.unknown(),
    })
        .transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/patch_apply_begin"),
        params: CodexEventPatchApplyBeginNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "patch_apply_started",
        callId: params.msg.call_id ?? null,
        changes: params.msg.changes ?? null,
        threadId: getCodexEventThreadId(params),
    })),
    z.object({ method: z.literal("codex/event/patch_apply_begin"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/patch_apply_end"),
        params: CodexEventPatchApplyEndNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "patch_apply_completed",
        callId: params.msg.call_id ?? null,
        changes: params.msg.changes ?? null,
        stdout: params.msg.stdout ?? null,
        stderr: params.msg.stderr ?? null,
        success: params.msg.success ?? null,
        threadId: getCodexEventThreadId(params),
    })),
    z.object({ method: z.literal("codex/event/patch_apply_end"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("item/fileChange/outputDelta"),
        params: ItemFileChangeOutputDeltaNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "file_change_output_delta",
        itemId: params.itemId,
        delta: params.delta ?? params.chunk ?? null,
        threadId: params.threadId ?? null,
    })),
    z.object({ method: z.literal("item/fileChange/outputDelta"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/turn_diff"),
        params: CodexEventTurnDiffNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "diff_updated",
        diff: params.msg.unified_diff ?? params.msg.diff ?? "",
        threadId: getCodexEventThreadId(params),
    })),
    z.object({ method: z.literal("codex/event/turn_diff"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/turn_aborted"),
        params: CodexEventTurnAbortedNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "turn_completed",
        status: "interrupted",
        errorMessage: null,
        threadId: getCodexEventThreadId(params),
    })),
    z.object({ method: z.literal("codex/event/turn_aborted"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/task_complete"),
        params: CodexEventTaskCompleteNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "turn_completed",
        status: "completed",
        errorMessage: null,
        threadId: getCodexEventThreadId(params),
    })),
    z.object({ method: z.literal("codex/event/task_complete"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({
        method: z.literal("codex/event/thread_rolled_back"),
        params: CodexEventThreadRolledBackNotificationSchema,
    })
        .transform(({ params }) => ({
        kind: "thread_rolled_back",
        numTurns: params.msg.num_turns ?? params.msg.numTurns ?? 0,
        threadId: getCodexEventThreadId(params),
    })),
    z.object({ method: z.literal("codex/event/thread_rolled_back"), params: z.unknown() }).transform(({ method, params }) => ({
        kind: "invalid_payload",
        method,
        params,
    })),
    z
        .object({ method: z.string(), params: z.unknown() })
        .transform(({ method, params }) => ({ kind: "unknown_method", method, params })),
]);
async function readCodexConfiguredDefaults(client, logger) {
    let savedConfigDefaults = {};
    try {
        const response = toObjectRecord(await client.request("getUserSavedConfig", {}));
        const config = toObjectRecord(response?.config);
        const modelValue = typeof config?.model === "string" ? config.model : undefined;
        const thinkingOptionValue = typeof config?.modelReasoningEffort === "string" ? config.modelReasoningEffort : null;
        savedConfigDefaults = {
            model: normalizeCodexModelId(modelValue),
            thinkingOptionId: normalizeCodexThinkingOptionId(thinkingOptionValue),
        };
    }
    catch (error) {
        logger.debug({ error }, "Failed to read Codex saved config defaults");
    }
    if (savedConfigDefaults.model && savedConfigDefaults.thinkingOptionId) {
        return savedConfigDefaults;
    }
    let configReadDefaults = {};
    try {
        const response = toObjectRecord(await client.request("config/read", {}));
        const config = toObjectRecord(response?.config);
        const modelValue = typeof config?.model === "string" ? config.model : undefined;
        const thinkingOptionValue = typeof config?.model_reasoning_effort === "string" ? config.model_reasoning_effort : null;
        configReadDefaults = {
            model: normalizeCodexModelId(modelValue),
            thinkingOptionId: normalizeCodexThinkingOptionId(thinkingOptionValue),
        };
    }
    catch (error) {
        logger.debug({ error }, "Failed to read Codex config defaults");
    }
    return mergeCodexConfiguredDefaults(savedConfigDefaults, configReadDefaults);
}
export async function codexAppServerTurnInputFromPrompt(prompt, logger) {
    if (typeof prompt === "string") {
        return [toCodexTextInput(prompt)];
    }
    const output = [];
    let previousTextBlock = false;
    for (const block of prompt) {
        if (block.type === "text") {
            output.push(toCodexTextInput(block.text));
            previousTextBlock = block.text.length > 0;
            continue;
        }
        if (block.type === "skill") {
            output.push(block);
            previousTextBlock = false;
            continue;
        }
        if (block.type === "image") {
            try {
                const filePath = materializeProviderImage({
                    data: block.data,
                    mimeType: block.mimeType,
                }).path;
                output.push({ type: "localImage", path: filePath });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn({ message }, "Failed to write Codex image attachment");
                output.push({
                    ...toCodexTextInput(`User attached image (failed to write temp file): ${message}`),
                });
            }
            previousTextBlock = false;
            continue;
        }
        const attachmentText = renderPromptAttachmentAsText(block);
        output.push(toCodexTextInput(previousTextBlock ? `\n\n${attachmentText}` : attachmentText));
        previousTextBlock = true;
    }
    return output;
}
function toCodexTextInput(text) {
    return {
        type: "text",
        text,
        text_elements: [],
    };
}
export function buildCodexAppServerEnv(runtimeSettings, launchEnv) {
    const env = createProviderEnv({
        runtimeSettings,
        overlays: [launchEnv],
    });
    // Paseo's local Codex settings keep one API key per provider profile in
    // ~/.paseo/codex-provider-profiles.json.  Codex gives an inherited
    // OPENAI_API_KEY precedence over auth.json, so a key that was present when
    // the daemon started can silently win after the user switches profiles.
    // Apply the active profile at every app-server launch and clear an empty
    // profile key so the previous credential cannot leak into the new session.
    // Explicit per-provider/per-session env remains authoritative.
    const hasExplicitApiKey = (runtimeSettings?.env &&
        Object.prototype.hasOwnProperty.call(runtimeSettings.env, "OPENAI_API_KEY")) ||
        (launchEnv && Object.prototype.hasOwnProperty.call(launchEnv, "OPENAI_API_KEY"));
    if (!hasExplicitApiKey) {
        const profileKey = readPaseoActiveCodexApiKey();
        if (profileKey !== undefined) {
            if (profileKey) {
                env.OPENAI_API_KEY = profileKey;
            }
            else {
                delete env.OPENAI_API_KEY;
            }
        }
    }
    return env;
}
function readPaseoActiveCodexApiKey() {
    const profile = readPaseoActiveCodexProfile();
    if (!profile) {
        return undefined;
    }
    return typeof profile.apiKey === "string" ? profile.apiKey.trim() : "";
}
function buildCodexAppServerInitializeParams() {
    return {
        clientInfo: CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_INFO,
        capabilities: {
            experimentalApi: true,
            mcpServerOpenaiFormElicitation: true,
        },
    };
}
function normalizeOpenAICompatibleBaseUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const withoutTrailingSlashes = trimmed.replace(/\/+$/u, "");
    if (withoutTrailingSlashes.endsWith("/v1")) {
        return withoutTrailingSlashes;
    }
    return `${withoutTrailingSlashes}/v1`;
}
function buildPaseoActiveCodexConfig() {
    const profile = readPaseoActiveCodexProfile();
    if (!profile || typeof profile.baseUrl !== "string") {
        return null;
    }
    const providerConfig = {
        name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : profile.id,
        base_url: PASEO_CODEX_PROXY_BASE_URL,
        wire_api: "responses",
        requires_openai_auth: false,
    };
    return {
        model_provider: PASEO_ACTIVE_PROVIDER_ID,
        model_providers: {
            [PASEO_ACTIVE_PROVIDER_ID]: providerConfig,
        },
        ...(typeof profile.model === "string" && profile.model.trim()
            ? { model: profile.model.trim() }
            : {}),
        ...(typeof profile.reasoningEffort === "string"
            ? { model_reasoning_effort: profile.reasoningEffort }
            : {}),
    };
}
function paseoActiveProfileToken(profile) {
    if (!profile) {
        return null;
    }
    return JSON.stringify([
        profile.id,
        profile.name,
        profile.baseUrl,
        profile.apiKey,
        profile.wireApi,
        profile.model,
        profile.reasoningEffort,
        profile.permission,
    ]);
}
function buildCodexCustomProviderConfig(runtimeSettings, customProvider) {
    if (customProvider?.extends !== CODEX_PROVIDER) {
        return null;
    }
    const baseUrl = runtimeSettings?.env?.OPENAI_BASE_URL;
    if (typeof baseUrl !== "string") {
        return null;
    }
    const normalizedBaseUrl = normalizeOpenAICompatibleBaseUrl(baseUrl);
    if (!normalizedBaseUrl) {
        return null;
    }
    const providerConfig = {
        name: customProvider.label,
        base_url: normalizedBaseUrl,
        wire_api: "responses",
    };
    if (runtimeSettings?.env?.OPENAI_API_KEY?.trim()) {
        providerConfig.env_key = "OPENAI_API_KEY";
        providerConfig.requires_openai_auth = false;
    }
    return {
        model_provider: customProvider.id,
        model_providers: {
            [customProvider.id]: providerConfig,
        },
    };
}
export class CodexAppServerAgentSession {
    constructor(config, resumeHandle, logger, spawnAppServer, deps = {}, ephemeral = false, goalsEnabled = false, autoReviewEnabled = false, agentId, initialResumePurpose = "interactive") {
        this.resumeHandle = resumeHandle;
        this.spawnAppServer = spawnAppServer;
        this.deps = deps;
        this.ephemeral = ephemeral;
        this.goalsEnabled = goalsEnabled;
        this.autoReviewEnabled = autoReviewEnabled;
        this.agentId = agentId;
        this.initialResumePurpose = initialResumePurpose;
        this.provider = CODEX_PROVIDER;
        this.capabilities = CODEX_APP_SERVER_CAPABILITIES;
        this.resolvedWorkspaceWrite = null;
        this.resolvedSandboxPolicy = null;
        this.currentThreadId = null;
        this.currentTurnId = null;
        this.pendingForegroundTurnIdentification = null;
        this.client = null;
        this.subscribers = new Set();
        this.nextTurnOrdinal = 0;
        this.activeForegroundTurnId = null;
        this.activeClientMessageId = null;
        this.cachedRuntimeInfo = null;
        this.paseoActiveProfileToken = null;
        this.serviceTier = null;
        this.planModeEnabled = false;
        this.historyPending = false;
        this.persistedHistory = [];
        this.loadingPersistedHistory = false;
        this.persistedProviderSubagentEvents = [];
        this.pendingPermissions = new Map();
        this.mcpElicitationPermissionIds = new Map();
        this.pendingPermissionHandlers = new Map();
        this.resolvedPermissionRequests = new Set();
        this.pendingAgentMessages = new Map();
        this.pendingReasoning = new Map();
        this.pendingCommandOutputDeltas = new Map();
        this.pendingFileChangeOutputDeltas = new Map();
        this.pendingAssistantMessageBoundary = false;
        this.terminalCommandByProcessId = new Map();
        this.pendingUnlabeledTerminalInteractions = new Map();
        this.nextTerminalInteractionOrdinal = 0;
        this.emittedTerminalInteractionKeys = new Set();
        this.emittedExecCommandStartedCallIds = new Set();
        this.emittedExecCommandCompletedCallIds = new Set();
        this.emittedItemStartedIds = new Set();
        this.emittedItemCompletedIds = new Set();
        this.emittedProviderSubagentUserMessageKeys = new Set();
        this.subAgentCallsByCallId = new Map();
        this.subAgentCallIdByChildThreadId = new Map();
        this.pendingSubAgentNotificationsByThreadId = new Map();
        this.warnedUnknownNotificationMethods = new Set();
        this.warnedInvalidNotificationPayloads = new Set();
        this.warnedIncompleteEditToolCallIds = new Set();
        this.latestPlanResult = null;
        this.userMessageTurnIndexes = new Map();
        this.userMessageTurnIds = [];
        this.pendingManualCompactionStarts = 0;
        this.compactionTriggerByItemId = new Map();
        // Codex can report one completed compaction through both channels:
        // `thread/compacted` and a completed `contextCompaction` item.
        this.unpairedCompactionNotificationCompletions = 0;
        this.unpairedCompactionItemCompletions = 0;
        this.connected = false;
        this.connectionPromise = null;
        this.closed = false;
        this.collaborationModes = [];
        this.resolvedCollaborationMode = null;
        this.cachedSkills = null;
        this.logger = logger.child({
            module: "agent",
            provider: CODEX_PROVIDER,
            agentId: this.agentId,
        });
        if (config.modeId !== undefined) {
            validateCodexMode(config.modeId);
        }
        this.hasWorkflowModeOverride = config.modeId !== undefined;
        this.currentMode = config.modeId ?? DEFAULT_CODEX_MODE_ID;
        this.providerOptions = CodexProviderOptionsSchema.parse(config.providerOptions ?? {});
        this.config = config;
        this.config.thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
        if (this.config.featureValues?.fast_mode && codexModelSupportsFastMode(this.config.model)) {
            this.serviceTier = "fast";
        }
        if (this.config.featureValues?.plan_mode) {
            this.planModeEnabled = true;
        }
        if (this.resumeHandle?.sessionId) {
            this.currentThreadId = this.resumeHandle.sessionId;
            this.historyPending = true;
        }
    }
    get id() {
        return this.currentThreadId;
    }
    get features() {
        return buildCodexFeatures({
            modelId: this.config.model,
            fastModeEnabled: this.serviceTier === "fast",
            planModeEnabled: this.planModeEnabled,
            planModeAvailable: this.hasPlanCollaborationMode(),
        });
    }
    syncPaseoActiveProfile() {
        if (!this.deps.usePaseoActiveCodexProfile) {
            return null;
        }
        const profile = readPaseoActiveCodexProfile();
        const token = paseoActiveProfileToken(profile);
        if (token === this.paseoActiveProfileToken) {
            return profile;
        }
        this.paseoActiveProfileToken = token;
        if (!profile) {
            return null;
        }
        this.config.model = normalizeCodexModelId(profile.model);
        this.config.thinkingOptionId = normalizeCodexThinkingOptionId(profile.reasoningEffort);
        if (!codexModelSupportsFastMode(this.config.model)) {
            this.serviceTier = null;
        }
        this.refreshResolvedCollaborationMode();
        this.cachedRuntimeInfo = null;
        return profile;
    }
    async connect() {
        if (this.closed) {
            throw this.createClosedError();
        }
        if (this.connected)
            return;
        if (this.connectionPromise) {
            await this.connectionPromise;
            if (this.closed) {
                throw this.createClosedError();
            }
            return;
        }
        const connectionPromise = this.establishConnection();
        this.connectionPromise = connectionPromise;
        try {
            await connectionPromise;
        }
        finally {
            if (this.connectionPromise === connectionPromise) {
                this.connectionPromise = null;
            }
        }
        if (this.closed) {
            throw this.createClosedError();
        }
    }
    async establishConnection() {
        const child = await this.spawnAppServer();
        const client = new CodexAppServerClient(child, this.logger, () => this.traceContext());
        if (this.closed) {
            await client.dispose();
            throw this.createClosedError();
        }
        this.client = client;
        client.setUnexpectedTerminationHandler((error) => {
            this.handleUnexpectedTermination(error);
        });
        client.setNotificationHandler((method, params) => this.handleNotification(method, params));
        this.registerRequestHandlers();
        try {
            await client.request("initialize", buildCodexAppServerInitializeParams());
            client.notify("initialized", {});
            await this.loadResolvedWorkspaceWrite();
            await this.loadCollaborationModes();
            await this.loadSkills();
            if (this.currentThreadId) {
                await this.ensureThreadLoaded({
                    allowArchivedHistory: this.initialResumePurpose === "history",
                });
                await this.loadPersistedHistory();
            }
            if (this.closed) {
                throw this.createClosedError();
            }
            this.connected = true;
        }
        catch (error) {
            try {
                if (this.client === client) {
                    await this.disposeClient();
                }
                else {
                    await client.dispose();
                }
            }
            catch (disposeError) {
                this.logger.warn({ err: disposeError, connectError: error }, "Failed to dispose Codex app-server client after connection failure");
            }
            throw error;
        }
    }
    async loadResolvedWorkspaceWrite() {
        if (!this.client)
            return;
        try {
            const response = toObjectRecord(await this.client.request("config/read", { cwd: this.config.cwd ?? null }));
            const config = toObjectRecord(response?.config);
            this.resolvedWorkspaceWrite = readSandboxWorkspaceWrite(config?.sandbox_workspace_write);
        }
        catch (error) {
            this.logger.debug({ error }, "Failed to read resolved Codex workspace-write config");
        }
    }
    rememberResolvedSandboxPolicy(response) {
        const sandbox = toObjectRecord(toObjectRecord(response)?.sandbox);
        this.resolvedSandboxPolicy = sandbox ?? null;
        if (sandbox?.type !== "workspaceWrite")
            return;
        this.resolvedWorkspaceWrite = readSandboxWorkspaceWrite(sandbox);
    }
    createClosedError() {
        return new Error("Codex app-server session is closed");
    }
    traceContext() {
        return {
            agentId: this.agentId,
            sessionId: this.currentThreadId ?? undefined,
            turnId: this.activeForegroundTurnId ?? undefined,
        };
    }
    handleUnexpectedTermination(error) {
        this.connected = false;
        const hasActiveRootTurn = this.activeForegroundTurnId !== null || this.currentTurnId !== null;
        this.clearPendingPermissions({ preservePlanApprovals: !hasActiveRootTurn });
        if (hasActiveRootTurn) {
            this.emitEvent({
                type: "turn_failed",
                provider: CODEX_PROVIDER,
                error: error.message,
            });
        }
        this.activeForegroundTurnId = null;
        this.activeClientMessageId = null;
        this.currentTurnId = null;
        this.pendingForegroundTurnIdentification?.resolve(null);
        this.pendingForegroundTurnIdentification = null;
    }
    async loadCollaborationModes() {
        if (!this.client)
            return;
        try {
            const response = toObjectRecord(await this.client.request("collaborationMode/list", {}));
            const data = Array.isArray(response?.data) ? response.data : [];
            this.collaborationModes = data.map((entry) => {
                const record = toObjectRecord(entry);
                return {
                    name: typeof record?.name === "string" ? record.name : "",
                    mode: typeof record?.mode === "string" ? record.mode : null,
                    model: typeof record?.model === "string" ? record.model : null,
                    reasoning_effort: typeof record?.reasoning_effort === "string" ? record.reasoning_effort : null,
                    developer_instructions: typeof record?.developer_instructions === "string"
                        ? record.developer_instructions
                        : null,
                };
            });
        }
        catch (error) {
            this.logger.trace({
                agentId: this.agentId,
                provider: CODEX_PROVIDER,
                sessionId: this.currentThreadId,
                turnId: this.activeForegroundTurnId ?? undefined,
                error,
            }, "provider.codex.metadata.collaboration_modes_failed");
            this.collaborationModes = [];
        }
        this.refreshResolvedCollaborationMode();
    }
    async loadSkills() {
        if (!this.client)
            return;
        try {
            const response = toObjectRecord(await this.client.request("skills/list", {
                cwds: [this.config.cwd],
            }));
            const entries = Array.isArray(response?.data) ? response.data : [];
            const skillsByName = new Map();
            for (const entry of entries) {
                const entryRecord = toObjectRecord(entry);
                const list = Array.isArray(entryRecord?.skills) ? entryRecord.skills : [];
                for (const skill of list) {
                    const skillRecord = toObjectRecord(skill);
                    if (typeof skillRecord?.name !== "string" || typeof skillRecord?.path !== "string")
                        continue;
                    // Codex skills/list returns disabled skills with enabled:false; omit them from
                    // slash-command surfaces so Paseo matches Codex CLI/TUI behavior.
                    // Missing enabled (older binaries) is treated as enabled.
                    if (skillRecord.enabled === false)
                        continue;
                    if (!skillsByName.has(skillRecord.name)) {
                        skillsByName.set(skillRecord.name, {
                            name: skillRecord.name,
                            description: resolveSkillDescription(skillRecord),
                            path: skillRecord.path,
                        });
                    }
                }
            }
            this.cachedSkills = Array.from(skillsByName.values());
        }
        catch (error) {
            this.logger.trace({
                agentId: this.agentId,
                provider: CODEX_PROVIDER,
                sessionId: this.currentThreadId,
                turnId: this.activeForegroundTurnId ?? undefined,
                error,
            }, "provider.codex.metadata.skills_failed");
            this.cachedSkills = null;
        }
    }
    findCollaborationMode(target) {
        if (this.collaborationModes.length === 0)
            return null;
        const findByName = (predicate) => this.collaborationModes.find((entry) => predicate(entry.name.toLowerCase()));
        if (target === "plan") {
            return findByName((name) => name.includes("plan") || name.includes("read")) ?? null;
        }
        return (findByName((name) => name.includes("auto") || name.includes("code")) ??
            this.collaborationModes.find((entry) => {
                const name = entry.name.toLowerCase();
                return !name.includes("plan") && !name.includes("read");
            }) ??
            this.collaborationModes[0] ??
            null);
    }
    hasPlanCollaborationMode() {
        return this.findCollaborationMode("plan") !== null;
    }
    resolveCollaborationMode() {
        const match = this.findCollaborationMode(this.planModeEnabled ? "plan" : "code");
        if (!match)
            return null;
        const settings = {};
        if (match.model)
            settings.model = match.model;
        if (match.reasoning_effort)
            settings.reasoning_effort = match.reasoning_effort;
        const developerInstructions = composeSystemPromptParts(match.developer_instructions, this.config.systemPrompt, this.config.daemonAppendSystemPrompt);
        if (developerInstructions)
            settings.developer_instructions = developerInstructions;
        if (this.config.model)
            settings.model = this.config.model;
        const thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
        if (thinkingOptionId)
            settings.reasoning_effort = thinkingOptionId;
        return { mode: match.mode ?? "code", settings, name: match.name };
    }
    refreshResolvedCollaborationMode() {
        this.resolvedCollaborationMode = this.resolveCollaborationMode();
    }
    applyFeatureValue(featureId, value) {
        this.config.featureValues = {
            ...this.config.featureValues,
            [featureId]: value,
        };
        if (featureId === "fast_mode") {
            this.serviceTier = value ? "fast" : null;
            this.cachedRuntimeInfo = null;
            return;
        }
        this.planModeEnabled = value;
        this.refreshResolvedCollaborationMode();
        this.cachedRuntimeInfo = null;
    }
    rememberPlanResult(item) {
        if (item.detail.type !== "plan") {
            return;
        }
        this.latestPlanResult = {
            callId: item.callId,
            text: item.detail.text,
            turnId: this.currentTurnId,
        };
    }
    emitSyntheticPlanApprovalRequest(planText) {
        this.dismissPendingPlanApprovals("Superseded by a newer plan");
        const requestId = `permission-${randomUUID()}`;
        const request = {
            id: requestId,
            provider: CODEX_PROVIDER,
            name: "CodexPlanApproval",
            kind: "plan",
            title: "Plan",
            description: "Review the proposed plan before implementation starts.",
            input: { plan: planText },
            actions: buildPlanPermissionActions(),
            metadata: {
                planText,
                source: "codex_plan_approval",
            },
        };
        this.pendingPermissions.set(requestId, request);
        this.pendingPermissionHandlers.set(requestId, {
            resolve: () => undefined,
            kind: "plan",
            planText,
        });
        this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
    }
    /**
     * Prepare the session for plan implementation by disabling plan mode
     * and returning the implementation prompt. The caller is responsible for
     * starting the turn through the normal streamAgent path.
     */
    preparePlanImplementation(params) {
        const planText = typeof params.planText === "string" ? normalizePlanMarkdown(params.planText) : "";
        this.applyFeatureValue("plan_mode", false);
        return buildCodexPlanImplementationPrompt(planText);
    }
    registerRequestHandlers() {
        if (!this.client)
            return;
        this.client.setRequestHandler("item/commandExecution/requestApproval", (params) => this.handleCommandApprovalRequest(params));
        this.client.setRequestHandler("item/fileChange/requestApproval", (params) => this.handleFileChangeApprovalRequest(params));
        this.client.setRequestHandler("item/tool/requestUserInput", (params) => this.handleToolApprovalRequest(params));
        this.client.setRequestHandler("mcpServer/elicitation/request", (params, requestId) => this.handleMcpElicitationRequest(params, requestId));
        // Keep the legacy method name for older Codex builds.
        this.client.setRequestHandler("tool/requestUserInput", (params) => this.handleToolApprovalRequest(params));
    }
    async loadPersistedHistory() {
        if (!this.client || !this.currentThreadId)
            return;
        const client = this.client;
        const threadId = this.currentThreadId;
        const history = await loadCodexThreadHistoryTimeline({
            threadId,
            cwd: this.config.cwd ?? null,
            requestThread: (threadIdToRead) => {
                return readCodexThread(client, threadIdToRead);
            },
        });
        const { timeline, subAgentRoutes } = history;
        this.subAgentCallsByCallId.clear();
        this.subAgentCallIdByChildThreadId.clear();
        this.pendingSubAgentNotificationsByThreadId.clear();
        this.persistedProviderSubagentEvents = [];
        this.loadingPersistedHistory = true;
        try {
            await this.loadPersistedSubAgentHistories(client, subAgentRoutes);
        }
        finally {
            this.loadingPersistedHistory = false;
        }
        this.resetCodexUserMessageTurns();
        for (const entry of timeline) {
            if (entry.item.type === "user_message") {
                this.rememberCodexUserMessageTurn(entry.item.messageId);
            }
        }
        this.persistedHistory = timeline;
        this.historyPending = timeline.length > 0;
    }
    async loadPersistedSubAgentHistories(client, rootRoutes) {
        const queue = rootRoutes.map((route) => ({ route, parentCallId: null }));
        const visitedThreadIds = new Set(this.currentThreadId ? [this.currentThreadId] : []);
        while (queue.length > 0 && visitedThreadIds.size < 100) {
            const next = queue.shift();
            if (!next || visitedThreadIds.has(next.route.childThreadId)) {
                continue;
            }
            visitedThreadIds.add(next.route.childThreadId);
            this.registerSubAgentToolCall({
                timelineItem: next.route.toolCall,
                rawItem: { agentThreadId: next.route.childThreadId },
                parentCallId: next.parentCallId,
            });
            try {
                const childHistory = await loadCodexThreadHistoryTimeline({
                    threadId: next.route.childThreadId,
                    cwd: this.config.cwd ?? null,
                    requestThread: (childThreadId) => readCodexThread(client, childThreadId),
                });
                for (const entry of childHistory.timeline) {
                    this.emitProviderSubagentTimeline(next.route.childThreadId, entry.item, entry.timestamp);
                }
                for (const route of childHistory.subAgentRoutes) {
                    queue.push({ route, parentCallId: next.route.toolCall.callId });
                }
            }
            catch (error) {
                this.logger.trace({ err: error, childThreadId: next.route.childThreadId }, "Failed to load persisted Codex child history");
            }
        }
    }
    async ensureThreadLoaded(options = {}) {
        if (!this.client || !this.currentThreadId)
            return;
        try {
            const loaded = toObjectRecord(await this.client.request("thread/loaded/list", {}));
            const ids = Array.isArray(loaded?.data) ? loaded.data : [];
            if (ids.includes(this.currentThreadId)) {
                return;
            }
            const params = { threadId: this.currentThreadId };
            const developerInstructions = composeSystemPromptParts(this.config.systemPrompt, this.config.daemonAppendSystemPrompt);
            if (developerInstructions) {
                params.developerInstructions = developerInstructions;
            }
            const codexConfig = this.buildCodexInnerConfig();
            if (codexConfig) {
                params.config = codexConfig;
            }
            const response = await this.client.request("thread/resume", params);
            this.rememberResolvedSandboxPolicy(response);
        }
        catch (error) {
            const threadId = this.currentThreadId;
            const message = error instanceof Error ? error.message : String(error);
            if (options.allowArchivedHistory === true &&
                isArchivedCodexThreadResumeError(error, threadId)) {
                this.logger.info({ threadId }, "Loading archived Codex thread history without resuming the native session");
                return;
            }
            this.logger.warn({ error, threadId }, "Failed to resume persisted Codex thread");
            throw new Error(`Failed to resume Codex thread ${threadId}: ${message}`, { cause: error });
        }
    }
    parseSlashCommandInput(text) {
        const trimmed = text.trim();
        if (!trimmed.startsWith("/") || trimmed.length <= 1) {
            return null;
        }
        const withoutPrefix = trimmed.slice(1);
        const firstWhitespaceIdx = withoutPrefix.search(/\s/);
        const commandName = firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
        if (!commandName || commandName.includes("/")) {
            return null;
        }
        const rawArgs = firstWhitespaceIdx === -1 ? "" : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
        return rawArgs.length > 0 ? { commandName, args: rawArgs } : { commandName };
    }
    async resolveSlashCommandInvocation(prompt) {
        if (typeof prompt !== "string") {
            return null;
        }
        const parsed = this.parseSlashCommandInput(prompt);
        if (!parsed) {
            return null;
        }
        try {
            const commands = await this.listCommands();
            return commands.some((command) => command.name === parsed.commandName) ? parsed : null;
        }
        catch (error) {
            this.logger.warn({ err: error, commandName: parsed.commandName }, "Failed to resolve slash command; falling back to plain prompt input");
            return null;
        }
    }
    async buildCommandPromptInput(commandName, args) {
        if (commandName.startsWith("prompts:")) {
            const promptName = commandName.slice("prompts:".length);
            const codexHome = resolveCodexHomeDir();
            const promptPath = path.join(codexHome, "prompts", `${promptName}.md`);
            const raw = await fs.readFile(promptPath, "utf8");
            const parsed = parseFrontMatter(raw);
            return expandCodexCustomPrompt(parsed.body, args);
        }
        if (!this.connected) {
            await this.connect();
        }
        else {
            await this.loadSkills();
        }
        const skill = this.cachedSkills?.find((entry) => entry.name === commandName);
        if (skill) {
            const trimmedArgs = args?.trim() ?? "";
            const text = trimmedArgs ? `$${skill.name} ${trimmedArgs}` : `$${skill.name}`;
            const input = [
                { type: "skill", name: skill.name, path: skill.path },
                { type: "text", text },
            ];
            return input;
        }
        return args ? `$${commandName} ${args}` : `$${commandName}`;
    }
    async buildTurnStartParams(prompt, options) {
        this.syncPaseoActiveProfile();
        const input = await this.buildUserInput(prompt);
        const preset = MODE_PRESETS[this.currentMode] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
        const params = {
            threadId: this.currentThreadId,
            input,
        };
        const { approvalPolicy, sandboxPolicyType } = this.applyTurnWorkflowPolicy(params, preset);
        if (this.config.model) {
            params.model = this.config.model;
        }
        const thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
        if (thinkingOptionId) {
            params.effort = thinkingOptionId;
        }
        if (this.serviceTier) {
            params.serviceTier = this.serviceTier;
        }
        if (this.resolvedCollaborationMode) {
            params.collaborationMode = {
                mode: this.resolvedCollaborationMode.mode,
                settings: this.resolvedCollaborationMode.settings,
            };
        }
        if (this.config.cwd) {
            params.cwd = this.config.cwd;
        }
        if (options?.outputSchema) {
            params.outputSchema = normalizeCodexOutputSchema(options.outputSchema);
        }
        const developerInstructions = composeSystemPromptParts(this.config.systemPrompt, this.config.daemonAppendSystemPrompt);
        if (developerInstructions) {
            params.developerInstructions = developerInstructions;
        }
        const codexConfig = this.buildCodexInnerConfig();
        if (codexConfig) {
            params.config = codexConfig;
        }
        return {
            params,
            thinkingOptionId,
            approvalPolicy,
            sandboxPolicyType,
            hasOutputSchema: Boolean(options?.outputSchema),
            hasDeveloperInstructions: Boolean(developerInstructions),
            hasCodexConfig: Boolean(codexConfig),
        };
    }
    applyTurnWorkflowPolicy(params, preset) {
        const savedPermission = this.deps.customCodexPermission ?? readSavedProviderPermission();
        const approvalPolicy = this.providerOptions.approval_policy ?? savedPermission?.approvalPolicy ??
            (this.hasWorkflowModeOverride ? preset.approvalPolicy : undefined);
        const sandboxPolicyType = this.providerOptions.sandbox_mode ?? savedPermission?.sandbox ??
            (this.hasWorkflowModeOverride ? preset.sandbox : undefined);
        if (approvalPolicy) {
            params.approvalPolicy = approvalPolicy;
        }
        if (sandboxPolicyType) {
            const nativeType = toCodexSandboxPolicyType(sandboxPolicyType);
            const workspaceWrite = {
                ...this.resolvedWorkspaceWrite,
                ...this.providerOptions.sandbox_workspace_write,
            };
            params.sandboxPolicy =
                this.resolvedSandboxPolicy?.type === nativeType
                    ? this.resolvedSandboxPolicy
                    : toSandboxPolicy(sandboxPolicyType, workspaceWrite);
        }
        if (this.hasWorkflowModeOverride && !savedPermission && this.providerOptions.approval_policy === undefined) {
            applyApprovalsReviewerParam(params, preset);
        }
        return { approvalPolicy, sandboxPolicyType };
    }
    logTurnStartSummary({ turnId, thinkingOptionId, approvalPolicy, sandboxPolicyType, hasOutputSchema, hasDeveloperInstructions, hasCodexConfig, }) {
        this.logger.info({
            turnId,
            threadId: this.currentThreadId,
            model: this.config.model ?? null,
            modeId: this.currentMode ?? null,
            effort: thinkingOptionId ?? null,
            serviceTier: this.serviceTier,
            cwd: this.config.cwd ?? null,
            approvalPolicy: approvalPolicy ?? null,
            sandboxPolicyType: sandboxPolicyType ?? null,
            hasCollaborationMode: Boolean(this.resolvedCollaborationMode),
            hasOutputSchema,
            hasDeveloperInstructions,
            hasCodexConfig,
        }, "Starting Codex app-server turn");
    }
    async run(prompt, options) {
        let currentAssistantMessageId = null;
        let currentAssistantMessageHasBoundary = false;
        let hasAssistantMessage = false;
        return runProviderTurn({
            prompt,
            runOptions: options,
            startTurn: (p, o) => this.startTurn(p, o),
            subscribe: (callback) => this.subscribe(callback),
            getSessionId: async () => (await this.getRuntimeInfo()).sessionId ?? "",
            reduceFinalText: ({ current, item }) => {
                if (item.type === "assistant_message") {
                    const hasPreviousAssistantMessage = hasAssistantMessage;
                    hasAssistantMessage = true;
                    const isNewMessage = item.messageId === undefined || item.messageId !== currentAssistantMessageId;
                    if (isNewMessage) {
                        currentAssistantMessageId = item.messageId ?? null;
                        currentAssistantMessageHasBoundary =
                            hasPreviousAssistantMessage &&
                                item.text.startsWith(ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN);
                    }
                    const finalTextItem = currentAssistantMessageHasBoundary
                        ? {
                            ...item,
                            text: item.text.startsWith(ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN)
                                ? item.text.slice(ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN.length)
                                : item.text,
                        }
                        : item;
                    return isNewMessage
                        ? finalTextItem.text
                        : appendOrReplaceGrowingAssistantMessage({ current, item: finalTextItem });
                }
                if (item.type === "tool_call" && item.detail.type === "plan") {
                    currentAssistantMessageId = null;
                    currentAssistantMessageHasBoundary = false;
                    return item.detail.text;
                }
                return current;
            },
        });
    }
    async startTurn(prompt, options) {
        if (this.activeForegroundTurnId) {
            throw new Error("A foreground turn is already active");
        }
        this.dismissPendingPlanApprovals("Dismissed by a new prompt");
        try {
            await this.connect();
            if (!this.client) {
                throw new Error("Codex client not initialized");
            }
            const slashCommand = await this.resolveSlashCommandInvocation(prompt);
            const effectivePrompt = slashCommand
                ? await this.buildCommandPromptInput(slashCommand.commandName, slashCommand.args)
                : prompt;
            if (this.currentThreadId) {
                await this.ensureThreadLoaded();
            }
            else {
                await this.ensureThread();
            }
            const turnStart = await this.buildTurnStartParams(effectivePrompt, options);
            const turnId = this.createTurnId();
            this.activeForegroundTurnId = turnId;
            this.activeClientMessageId = options?.clientMessageId ?? null;
            this.currentTurnId = null;
            this.pendingForegroundTurnIdentification?.resolve(null);
            let resolveTurnIdentification;
            const turnIdentification = new Promise((resolvePromise) => {
                resolveTurnIdentification = resolvePromise;
            });
            this.pendingForegroundTurnIdentification = {
                foregroundTurnId: turnId,
                promise: turnIdentification,
                resolve: resolveTurnIdentification,
            };
            this.logTurnStartSummary({
                turnId,
                thinkingOptionId: turnStart.thinkingOptionId,
                approvalPolicy: turnStart.approvalPolicy,
                sandboxPolicyType: turnStart.sandboxPolicyType,
                hasOutputSchema: turnStart.hasOutputSchema,
                hasDeveloperInstructions: turnStart.hasDeveloperInstructions,
                hasCodexConfig: turnStart.hasCodexConfig,
            });
            await this.client.request("turn/start", turnStart.params, TURN_START_TIMEOUT_MS);
            return { turnId };
        }
        catch (error) {
            this.pendingForegroundTurnIdentification?.resolve(null);
            this.pendingForegroundTurnIdentification = null;
            this.activeForegroundTurnId = null;
            this.activeClientMessageId = null;
            throw error;
        }
    }
    rememberCodexUserMessageTurn(messageId) {
        if (typeof messageId !== "string" || messageId.length === 0) {
            return false;
        }
        if (this.userMessageTurnIndexes.has(messageId)) {
            return false;
        }
        this.userMessageTurnIndexes.set(messageId, this.userMessageTurnIds.length);
        this.userMessageTurnIds.push(messageId);
        return true;
    }
    resetCodexUserMessageTurns() {
        this.userMessageTurnIndexes.clear();
        this.userMessageTurnIds.length = 0;
    }
    truncateCodexUserMessageTurns(numTurns) {
        if (numTurns <= 0) {
            return;
        }
        this.userMessageTurnIds.length = Math.max(0, this.userMessageTurnIds.length - numTurns);
        this.userMessageTurnIndexes.clear();
        this.userMessageTurnIds.forEach((messageId, index) => {
            this.userMessageTurnIndexes.set(messageId, index);
        });
    }
    codexUserMessageTurns() {
        return {
            resolve: (messageId) => this.userMessageTurnIndexes.get(messageId) ?? null,
            count: () => this.userMessageTurnIds.length,
        };
    }
    subscribe(callback) {
        this.subscribers.add(callback);
        return () => {
            this.subscribers.delete(callback);
        };
    }
    async *streamHistory() {
        if ((!this.historyPending || this.persistedHistory.length === 0) &&
            this.persistedProviderSubagentEvents.length === 0) {
            return;
        }
        const history = this.persistedHistory;
        const providerSubagents = this.persistedProviderSubagentEvents;
        this.persistedHistory = [];
        this.persistedProviderSubagentEvents = [];
        this.historyPending = false;
        for (const event of providerSubagents) {
            yield event;
        }
        for (const entry of history) {
            yield {
                type: "timeline",
                provider: CODEX_PROVIDER,
                item: entry.item,
                timestamp: entry.timestamp,
            };
        }
    }
    async getRuntimeInfo() {
        this.syncPaseoActiveProfile();
        if (this.cachedRuntimeInfo)
            return { ...this.cachedRuntimeInfo };
        if (!this.connected) {
            await this.connect();
        }
        if (!this.currentThreadId) {
            await this.ensureThread();
        }
        const info = {
            provider: CODEX_PROVIDER,
            sessionId: this.currentThreadId,
            model: this.config.model ?? null,
            thinkingOptionId: normalizeCodexThinkingOptionId(this.config.thinkingOptionId) ?? null,
            modeId: this.currentMode ?? null,
            extra: this.resolvedCollaborationMode
                ? { collaborationMode: this.resolvedCollaborationMode.name }
                : undefined,
        };
        this.cachedRuntimeInfo = info;
        return { ...info };
    }
    async getAvailableModes() {
        if (this.autoReviewEnabled) {
            return CODEX_MODES;
        }
        return CODEX_MODES.filter((mode) => mode.id !== "auto-review");
    }
    async getCurrentMode() {
        return this.currentMode ?? null;
    }
    async setMode(modeId) {
        validateCodexMode(modeId);
        this.currentMode = modeId;
        this.hasWorkflowModeOverride = true;
        this.config.modeId = modeId;
        this.cachedRuntimeInfo = null;
        if (this.activeForegroundTurnId) {
            return MODE_APPLIES_NEXT_TURN_NOTICE;
        }
    }
    async setModel(modelId) {
        this.config.model = modelId ?? undefined;
        if (!codexModelSupportsFastMode(this.config.model)) {
            this.serviceTier = null;
        }
        this.refreshResolvedCollaborationMode();
        this.cachedRuntimeInfo = null;
    }
    async setThinkingOption(thinkingOptionId) {
        this.config.thinkingOptionId = normalizeCodexThinkingOptionId(thinkingOptionId);
        this.refreshResolvedCollaborationMode();
        this.cachedRuntimeInfo = null;
        if (this.activeForegroundTurnId) {
            return THINKING_APPLIES_NEXT_TURN_NOTICE;
        }
    }
    async setFeature(featureId, value) {
        if (featureId === "fast_mode") {
            if (Boolean(value) && !codexModelSupportsFastMode(this.config.model)) {
                throw new Error(`Codex fast mode is not available for model '${this.config.model ?? "default"}'`);
            }
            this.applyFeatureValue("fast_mode", Boolean(value));
            return;
        }
        if (featureId === "plan_mode") {
            this.applyFeatureValue("plan_mode", Boolean(value));
            return;
        }
        throw new Error(`Unknown Codex feature: ${featureId}`);
    }
    getPendingPermissions() {
        return Array.from(this.pendingPermissions.values());
    }
    async respondToPermission(requestId, response) {
        const pending = this.pendingPermissionHandlers.get(requestId);
        if (!pending) {
            throw new Error(`No pending Codex app-server permission request with id '${requestId}'`);
        }
        const pendingRequest = this.pendingPermissions.get(requestId) ?? null;
        if (pending.kind === "plan") {
            return this.handlePlanPermissionResponse({ requestId, response, pending, pendingRequest });
        }
        this.pendingPermissionHandlers.delete(requestId);
        this.pendingPermissions.delete(requestId);
        this.resolvedPermissionRequests.add(requestId);
        if (response.behavior === "deny" && pendingRequest?.kind === "tool") {
            this.emitDeniedToolCallTimelineEvent({ requestId, response, pendingRequest });
        }
        this.emitEvent({
            type: "permission_resolved",
            provider: CODEX_PROVIDER,
            requestId,
            resolution: response,
        });
        if (pending.kind === "command") {
            pending.resolve({ decision: resolvePermissionDecision(response) });
            return;
        }
        if (pending.kind === "file") {
            pending.resolve({ decision: resolvePermissionDecision(response) });
            return;
        }
        if (pending.kind === "mcp_elicitation") {
            pending.resolve({
                action: resolvePermissionDecision(response),
                content: response.behavior === "allow" ? {} : null,
                _meta: null,
            });
            return;
        }
        const questions = pending.questions ?? [];
        const itemId = typeof pendingRequest?.metadata?.itemId === "string"
            ? pendingRequest.metadata.itemId
            : requestId;
        if (response.behavior === "allow") {
            const mappedAnswers = mapCodexQuestionResponseByHeader({
                questions,
                response,
            });
            const answers = mappedAnswers ??
                Object.fromEntries(questions
                    .map((question) => {
                    const fallback = question.options[0]?.label?.trim();
                    return fallback ? [question.id, { answers: [fallback] }] : null;
                })
                    .filter((entry) => entry !== null));
            this.emitEvent({
                type: "timeline",
                provider: CODEX_PROVIDER,
                item: mapCodexQuestionRequestToToolCall({
                    callId: itemId,
                    questions,
                    status: "completed",
                    answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, value.answers])),
                }),
            });
            pending.resolve({ answers });
            return;
        }
        this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: mapCodexQuestionRequestToToolCall({
                callId: itemId,
                questions,
                status: response.interrupt ? "canceled" : "failed",
                error: { message: response.message ?? "Question dismissed" },
            }),
        });
        pending.resolve({ answers: {} });
    }
    handlePlanPermissionResponse(params) {
        const { requestId, response, pending, pendingRequest } = params;
        let followUpPrompt;
        if (response.behavior === "allow") {
            followUpPrompt = this.preparePlanImplementation({
                planText: pending.planText ?? pendingRequest?.metadata?.planText,
            });
        }
        this.resolvePlanPermission(requestId, response);
        if (followUpPrompt) {
            return { followUpPrompt };
        }
    }
    dismissPendingPlanApprovals(message) {
        const requestIds = Array.from(this.pendingPermissionHandlers)
            .filter(([, pending]) => pending.kind === "plan")
            .map(([requestId]) => requestId);
        for (const requestId of requestIds) {
            this.resolvePlanPermission(requestId, { behavior: "deny", message });
        }
    }
    resolvePlanPermission(requestId, resolution) {
        this.pendingPermissionHandlers.delete(requestId);
        this.pendingPermissions.delete(requestId);
        this.resolvedPermissionRequests.add(requestId);
        this.emitEvent({
            type: "permission_resolved",
            provider: CODEX_PROVIDER,
            requestId,
            resolution,
        });
    }
    emitDeniedToolCallTimelineEvent(params) {
        const { requestId, response, pendingRequest } = params;
        let fallbackName;
        if (pendingRequest.name === "CodexBash") {
            fallbackName = "shell";
        }
        else if (pendingRequest.name === "CodexFileChange") {
            fallbackName = "apply_patch";
        }
        else {
            fallbackName = pendingRequest.name;
        }
        this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: {
                type: "tool_call",
                callId: requestId,
                name: fallbackName,
                status: "failed",
                error: { message: response.message ?? "Permission denied" },
                detail: pendingRequest.detail ?? {
                    type: "unknown",
                    input: pendingRequest.input ?? null,
                    output: null,
                },
                metadata: {
                    permissionRequestId: requestId,
                    denied: true,
                },
            },
        });
    }
    describePersistence() {
        if (!this.currentThreadId)
            return null;
        const thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId) ?? null;
        return {
            provider: CODEX_PROVIDER,
            sessionId: this.currentThreadId,
            nativeHandle: this.currentThreadId,
            metadata: {
                provider: CODEX_PROVIDER,
                cwd: this.config.cwd,
                title: this.config.title ?? null,
                threadId: this.currentThreadId,
                modeId: this.config.modeId,
                model: this.config.model ?? null,
                thinkingOptionId,
                providerOptions: this.config.providerOptions,
                toolPolicy: this.config.toolPolicy,
                systemPrompt: this.config.systemPrompt,
                mcpServers: this.config.mcpServers,
            },
        };
    }
    async revertConversation(input) {
        await this.connect();
        if (!this.client) {
            throw new Error("Codex client is not initialized");
        }
        if (this.currentThreadId) {
            await this.ensureThreadLoaded();
        }
        else {
            await this.ensureThread();
        }
        await revertCodexConversation({
            client: this.client,
            threadId: this.currentThreadId,
            messageId: input.messageId,
            cwd: this.config.cwd ?? null,
            model: this.config.model ?? null,
            serviceTier: this.serviceTier,
            userMessageTurns: this.codexUserMessageTurns(),
            setThreadId: async (threadId) => {
                this.currentThreadId = threadId;
                this.cachedRuntimeInfo = null;
                this.persistedHistory = [];
                this.historyPending = false;
                await this.loadPersistedHistory();
            },
        });
    }
    async interrupt() {
        if (!this.client || !this.currentThreadId) {
            throw new Error("Cannot interrupt Codex before the active thread is initialized");
        }
        let turnId = this.currentTurnId;
        const foregroundTurnId = this.activeForegroundTurnId;
        const pendingIdentification = this.pendingForegroundTurnIdentification;
        // turn/start is accepted before Codex publishes the native turn id. Keep the
        // interrupt attached to this foreground turn until that ordered notification arrives.
        if (!turnId &&
            foregroundTurnId &&
            pendingIdentification?.foregroundTurnId === foregroundTurnId) {
            turnId = await pendingIdentification.promise;
        }
        if (!turnId || (foregroundTurnId && this.activeForegroundTurnId !== foregroundTurnId)) {
            throw new Error("Cannot interrupt Codex before turn/started identifies the active turn");
        }
        await this.client.request("turn/interrupt", {
            threadId: this.currentThreadId,
            turnId,
        }, INTERRUPT_TIMEOUT_MS);
    }
    async close() {
        this.closed = true;
        this.clearPendingPermissions();
        this.pendingSubAgentNotificationsByThreadId.clear();
        this.subscribers.clear();
        this.activeForegroundTurnId = null;
        this.activeClientMessageId = null;
        this.pendingForegroundTurnIdentification?.resolve(null);
        this.pendingForegroundTurnIdentification = null;
        await this.disposeClient();
        this.currentThreadId = null;
    }
    clearPendingPermissions(options) {
        for (const [requestId, pending] of this.pendingPermissionHandlers) {
            if (options?.preservePlanApprovals && pending.kind === "plan") {
                continue;
            }
            pending.resolve({ decision: "cancel" });
            this.pendingPermissionHandlers.delete(requestId);
            this.pendingPermissions.delete(requestId);
        }
        this.mcpElicitationPermissionIds.clear();
        this.resolvedPermissionRequests.clear();
    }
    async disposeClient() {
        const client = this.client;
        this.client = null;
        this.connected = false;
        this.currentTurnId = null;
        if (client) {
            await client.dispose();
        }
    }
    async listCommands() {
        const prompts = await listCodexCustomPrompts();
        if (!this.connected) {
            await this.connect();
        }
        else {
            await this.loadSkills();
        }
        const appServerSkills = (this.cachedSkills ?? []).map((skill) => ({
            name: skill.name,
            description: skill.description,
            argumentHint: "",
            kind: "skill",
        }));
        const fallbackSkills = this.cachedSkills === null
            ? await listCodexSkills(this.config.cwd, this.deps.workspaceGitService)
            : [];
        const builtin = [
            {
                name: "compact",
                description: "Summarize conversation to prevent hitting the context limit",
                argumentHint: "",
                kind: "command",
            },
        ];
        if (this.goalsEnabled) {
            builtin.push({
                name: "goal",
                description: "Set, pause, resume, or clear the agent's goal",
                argumentHint: "[<objective>|pause|resume|clear]",
                kind: "command",
            });
        }
        return [...builtin, ...appServerSkills, ...fallbackSkills, ...prompts].sort((a, b) => a.name.localeCompare(b.name));
    }
    tryHandleOutOfBand(prompt) {
        if (typeof prompt !== "string")
            return null;
        const parsed = this.parseSlashCommandInput(prompt);
        if (!parsed)
            return null;
        if (parsed.commandName === "compact") {
            return {
                run: async ({ emit }) => {
                    const error = await this.executeCompactCommand();
                    if (error) {
                        emit({
                            type: "timeline",
                            provider: CODEX_PROVIDER,
                            item: { type: "assistant_message", text: formatOutOfBandStatusMessage(error) },
                        });
                    }
                },
            };
        }
        if (!this.goalsEnabled || parsed.commandName !== "goal")
            return null;
        const subcommand = parseGoalSubcommand(parsed.args);
        return {
            run: async ({ emit }) => {
                const text = formatOutOfBandStatusMessage(await this.executeGoalSubcommand(subcommand));
                emit({
                    type: "timeline",
                    provider: CODEX_PROVIDER,
                    item: { type: "assistant_message", text },
                });
            },
        };
    }
    async executeCompactCommand() {
        try {
            await this.connect();
            if (this.currentThreadId) {
                await this.ensureThreadLoaded();
            }
            else {
                await this.ensureThread();
            }
            if (!this.client || !this.currentThreadId) {
                throw new Error("Codex thread is not available");
            }
            this.pendingManualCompactionStarts += 1;
            try {
                await this.client.request("thread/compact/start", {
                    threadId: this.currentThreadId,
                });
            }
            catch (error) {
                this.pendingManualCompactionStarts = Math.max(0, this.pendingManualCompactionStarts - 1);
                throw error;
            }
            return null;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "unknown error";
            return `Failed to compact context: ${message}`;
        }
    }
    async executeGoalSubcommand(subcommand) {
        if (subcommand.kind === "usage") {
            return "Usage: /goal <objective>|pause|resume|clear";
        }
        try {
            await this.connect();
            if (this.currentThreadId) {
                await this.ensureThreadLoaded();
            }
            else {
                await this.ensureThread();
            }
            if (!this.client || !this.currentThreadId) {
                throw new Error("Codex thread is not available");
            }
            switch (subcommand.kind) {
                case "set": {
                    await this.client.request("thread/goal/set", {
                        threadId: this.currentThreadId,
                        objective: subcommand.objective,
                        status: "active",
                    });
                    return `Goal set: ${subcommand.objective}`;
                }
                case "pause": {
                    await this.client.request("thread/goal/set", {
                        threadId: this.currentThreadId,
                        status: "paused",
                    });
                    return "Goal paused.";
                }
                case "resume": {
                    await this.client.request("thread/goal/set", {
                        threadId: this.currentThreadId,
                        status: "active",
                    });
                    return "Goal resumed.";
                }
                case "clear": {
                    await this.client.request("thread/goal/clear", {
                        threadId: this.currentThreadId,
                    });
                    return "Goal cleared.";
                }
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "unknown error";
            return `Failed to update goal: ${message}`;
        }
    }
    async resolveModelAndThinking() {
        this.syncPaseoActiveProfile();
        if (!this.client) {
            throw new Error("Codex client is not initialized");
        }
        let configuredDefaults = {};
        let model = this.config.model;
        let thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
        if (!model || !thinkingOptionId) {
            configuredDefaults = await readCodexConfiguredDefaults(this.client, this.logger);
        }
        if (!model) {
            model = configuredDefaults.model;
        }
        if (!thinkingOptionId) {
            thinkingOptionId = configuredDefaults.thinkingOptionId;
        }
        if (!model || !thinkingOptionId) {
            const modelResponse = toObjectRecord(await this.client.request("model/list", {}));
            const modelData = Array.isArray(modelResponse?.data) ? modelResponse.data : [];
            const models = modelData
                .map((m) => {
                const record = toObjectRecord(m);
                return {
                    id: typeof record?.id === "string" ? record.id : "",
                    isDefault: !!record?.isDefault,
                    defaultReasoningEffort: typeof record?.defaultReasoningEffort === "string"
                        ? record.defaultReasoningEffort
                        : undefined,
                };
            })
                .filter((m) => m.id);
            const defaultModel = models.find((m) => m.isDefault) ?? models[0];
            if (!defaultModel) {
                throw new Error("No models available from Codex app-server");
            }
            const selectedModel = (model ? models.find((candidate) => candidate.id === model) : undefined) ?? defaultModel;
            if (!model) {
                model = selectedModel.id;
            }
            if (!thinkingOptionId) {
                thinkingOptionId = normalizeCodexThinkingOptionId(selectedModel.defaultReasoningEffort);
            }
        }
        if (!model) {
            throw new Error("Unable to resolve Codex model");
        }
        return { model, thinkingOptionId };
    }
    async ensureThread() {
        if (!this.client)
            return;
        if (this.currentThreadId)
            return;
        const { model, thinkingOptionId } = await this.resolveModelAndThinking();
        this.config.model = model;
        this.config.thinkingOptionId = thinkingOptionId;
        const { params, approvalPolicy, sandbox } = this.buildThreadStartRequest(model);
        const rawResponse = await this.client.request("thread/start", params);
        this.rememberResolvedSandboxPolicy(rawResponse);
        const response = toObjectRecord(rawResponse);
        const threadRecord = toObjectRecord(response?.thread);
        const threadId = typeof threadRecord?.id === "string" ? threadRecord.id : undefined;
        if (!threadId) {
            throw new Error("Codex app-server did not return thread id");
        }
        const responseApprovalsReviewer = typeof response?.approvalsReviewer === "string" ? response.approvalsReviewer : undefined;
        if (shouldPromoteThreadResponseToAutoReview({
            approvalsReviewer: responseApprovalsReviewer,
            approvalPolicy: approvalPolicy ?? String(this.providerOptions.approval_policy ?? ""),
            sandbox: sandbox ?? this.providerOptions.sandbox_mode ?? "",
        })) {
            this.currentMode = "auto-review";
            this.cachedRuntimeInfo = null;
        }
        this.currentThreadId = threadId;
    }
    buildThreadStartRequest(model) {
        const preset = MODE_PRESETS[this.currentMode] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
        const savedPermission = this.deps.customCodexPermission ?? readSavedProviderPermission();
        const approvalPolicy = this.providerOptions.approval_policy ?? savedPermission?.approvalPolicy ??
            (this.hasWorkflowModeOverride ? preset.approvalPolicy : undefined);
        const sandbox = this.providerOptions.sandbox_mode ?? savedPermission?.sandbox ??
            (this.hasWorkflowModeOverride ? preset.sandbox : undefined);
        const innerConfig = this.buildCodexInnerConfig();
        const developerInstructions = composeSystemPromptParts(this.config.systemPrompt, this.config.daemonAppendSystemPrompt);
        const params = {
            model,
            cwd: this.config.cwd ?? null,
            ...(approvalPolicy ? { approvalPolicy } : {}),
            ...(sandbox ? { sandbox } : {}),
            ...(developerInstructions ? { developerInstructions } : {}),
            ...(innerConfig ? { config: innerConfig } : {}),
            ...(this.ephemeral ? { ephemeral: true } : {}),
        };
        if (this.hasWorkflowModeOverride && !savedPermission && this.providerOptions.approval_policy === undefined) {
            applyApprovalsReviewerParam(params, preset);
        }
        return { params, approvalPolicy, sandbox };
    }
    buildCodexInnerConfig() {
        this.syncPaseoActiveProfile();
        const innerConfig = {};
        Object.assign(innerConfig, this.providerOptions);
        if (this.deps.customCodexConfig) {
            Object.assign(innerConfig, this.deps.customCodexConfig);
        }
        if (this.deps.usePaseoActiveCodexProfile) {
            const paseoCodexConfig = buildPaseoActiveCodexConfig();
            if (paseoCodexConfig) {
                Object.assign(innerConfig, paseoCodexConfig);
                innerConfig.features = {
                    ...toObjectRecord(innerConfig.features),
                    remote_compaction_v2: false,
                };
            }
        }
        if (this.config.mcpServers) {
            const mcpServers = {};
            for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
                mcpServers[name] = toCodexMcpConfig(serverConfig);
            }
            innerConfig.mcp_servers = mcpServers;
        }
        const configured = applyCodexToolPolicy(innerConfig, this.config.toolPolicy);
        return Object.keys(configured).length > 0 ? configured : null;
    }
    async buildUserInput(prompt) {
        if (typeof prompt === "string") {
            return [toCodexTextInput(prompt)];
        }
        return await codexAppServerTurnInputFromPrompt(prompt, this.logger);
    }
    emitEvent(event) {
        if (this.loadingPersistedHistory && event.type === "provider_subagent") {
            this.persistedProviderSubagentEvents.push(event);
            return;
        }
        this.notifySubscribers(event);
    }
    notifySubscribers(event) {
        const turnId = this.activeForegroundTurnId;
        const tagged = turnId ? { ...event, turnId } : event;
        this.logger.trace({
            agentId: this.agentId,
            provider: CODEX_PROVIDER,
            sessionId: this.currentThreadId,
            turnId: getAgentStreamEventTurnId(tagged),
            event: tagged,
        }, "provider.codex.event_emit");
        for (const callback of this.subscribers) {
            try {
                callback(tagged);
            }
            catch (error) {
                this.logger.warn({ err: error }, "Subscriber callback threw");
            }
        }
    }
    createTurnId() {
        return `codex-turn-${this.nextTurnOrdinal++}`;
    }
    handleNotification(method, params) {
        const notificationParams = toObjectRecord(params);
        if (method === "serverRequest/resolved" && typeof notificationParams?.requestId === "number") {
            const requestId = this.mcpElicitationPermissionIds.get(notificationParams.requestId);
            if (requestId) {
                const pending = this.pendingPermissionHandlers.get(requestId);
                this.mcpElicitationPermissionIds.delete(notificationParams.requestId);
                if (!pending) {
                    return;
                }
                this.pendingPermissions.delete(requestId);
                this.pendingPermissionHandlers.delete(requestId);
                pending.resolve({ action: "cancel", content: null, _meta: null });
                this.emitEvent({
                    type: "permission_resolved",
                    provider: CODEX_PROVIDER,
                    requestId,
                    resolution: { behavior: "deny", interrupt: true },
                });
            }
            return;
        }
        const parsed = CodexNotificationSchema.parse({ method, params });
        this.traceParsedNotification(method, params, parsed);
        const route = this.resolveCodexThreadRoute(getCodexNotificationThreadId(parsed));
        if (route.kind === "pending_sub_agent") {
            this.bufferPendingSubAgentNotification(route.threadId, parsed);
            return;
        }
        if (route.kind === "sub_agent") {
            this.dispatchSubAgentNotification(parsed, route.callId);
            return;
        }
        this.dispatchParsedNotification(parsed);
    }
    dispatchSubAgentNotification(parsed, callId) {
        switch (parsed.kind) {
            case "thread_started":
                this.emitSubAgentActivityUpdate(callId, "running");
                return;
            case "turn_started":
            case "turn_completed":
            case "agent_message_delta":
            case "reasoning_delta":
            case "item_started":
            case "item_completed":
                this.dispatchParsedNotification(parsed);
                return;
            case "exec_command_output_delta":
            case "file_change_output_delta":
                this.handleCodexDeltaNotification(parsed, callId);
                return;
            case "exec_command_started":
                this.handleExecCommandStartedNotification(parsed, callId);
                return;
            case "exec_command_completed":
                this.handleExecCommandCompletedNotification(parsed, callId);
                return;
            case "patch_apply_started":
                this.handlePatchApplyStartedNotification(parsed, callId);
                return;
            case "patch_apply_completed":
                this.handlePatchApplyCompletedNotification(parsed, callId);
                return;
            default:
                // Aggregate child telemetry is redundant and must not leak into the
                // root timeline. Concrete legacy tools are projected above for Codex
                // versions that do not also emit canonical item lifecycle events.
                return;
        }
    }
    dispatchParsedNotification(parsed) {
        if (isCodexDeltaNotification(parsed)) {
            this.handleCodexDeltaNotification(parsed);
            return;
        }
        if (this.handleThreadStateNotification(parsed)) {
            return;
        }
        switch (parsed.kind) {
            case "thread_started":
                this.handleThreadStartedNotification(parsed);
                return;
            case "turn_started":
                this.handleTurnStartedNotification(parsed);
                return;
            case "turn_completed":
                this.handleTurnCompletedNotification(parsed);
                return;
            case "plan_updated":
                this.handlePlanUpdatedNotification(parsed);
                return;
            case "diff_updated":
                // NOTE: Codex app-server emits frequent `turn/diff/updated` notifications
                // containing a full accumulated unified diff for the *entire turn*.
                // This is not a concrete file-change tool call; it is progress telemetry.
                return;
            case "token_usage_updated":
                this.handleTokenUsageUpdatedNotification(parsed);
                return;
            case "exec_command_started":
                this.handleExecCommandStartedNotification(parsed);
                return;
            case "exec_command_completed":
                this.handleExecCommandCompletedNotification(parsed);
                return;
            case "terminal_interaction":
                this.handleTerminalInteractionNotification(parsed);
                return;
            case "patch_apply_started":
                this.handlePatchApplyStartedNotification(parsed);
                return;
            case "patch_apply_completed":
                this.handlePatchApplyCompletedNotification(parsed);
                return;
            case "item_completed":
                this.handleItemCompletedNotification(parsed);
                return;
            case "item_started":
                this.handleItemStartedNotification(parsed);
                return;
            case "invalid_payload":
                this.warnInvalidNotificationPayload(parsed.method, parsed.params);
                return;
            case "unknown_method":
                this.warnUnknownNotificationMethod(parsed.method, parsed.params);
                return;
            default:
                return;
        }
    }
    resolveCodexThreadRoute(threadId) {
        if (!threadId || !this.currentThreadId || threadId === this.currentThreadId) {
            return { kind: "root" };
        }
        const callId = this.subAgentCallIdByChildThreadId.get(threadId);
        return callId ? { kind: "sub_agent", callId } : { kind: "pending_sub_agent", threadId };
    }
    bufferPendingSubAgentNotification(threadId, parsed) {
        let pending = this.pendingSubAgentNotificationsByThreadId.get(threadId);
        if (!pending) {
            if (this.pendingSubAgentNotificationsByThreadId.size >= MAX_PENDING_SUB_AGENT_THREADS) {
                const oldestThreadId = this.pendingSubAgentNotificationsByThreadId.keys().next().value;
                if (typeof oldestThreadId === "string") {
                    this.pendingSubAgentNotificationsByThreadId.delete(oldestThreadId);
                }
            }
            pending = [];
            this.pendingSubAgentNotificationsByThreadId.set(threadId, pending);
        }
        if (pending.length >= MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD) {
            pending.shift();
        }
        pending.push(parsed);
    }
    replayPendingSubAgentNotifications(threadIds) {
        for (const threadId of threadIds) {
            const pending = this.pendingSubAgentNotificationsByThreadId.get(threadId);
            if (!pending) {
                continue;
            }
            this.pendingSubAgentNotificationsByThreadId.delete(threadId);
            const callId = this.subAgentCallIdByChildThreadId.get(threadId);
            if (!callId) {
                continue;
            }
            for (const parsed of pending) {
                this.dispatchSubAgentNotification(parsed, callId);
            }
        }
    }
    handleThreadStateNotification(parsed) {
        switch (parsed.kind) {
            case "context_compacted":
                this.handleContextCompactedNotification(parsed);
                return true;
            case "thread_rolled_back":
                this.handleThreadRolledBackNotification(parsed);
                return true;
            default:
                return false;
        }
    }
    traceParsedNotification(method, params, parsed) {
        this.logger.trace({
            agentId: this.agentId,
            provider: CODEX_PROVIDER,
            sessionId: this.currentThreadId,
            turnId: this.activeForegroundTurnId ?? undefined,
            method,
            params,
            parsed,
        }, "provider.codex.parsed_event");
    }
    getSubAgentCallIdForThread(threadId) {
        if (!threadId || threadId === this.currentThreadId) {
            return null;
        }
        return this.subAgentCallIdByChildThreadId.get(threadId) ?? null;
    }
    registerSubAgentToolCall(params) {
        const { timelineItem, rawItem, parentCallId } = params;
        if (timelineItem.detail.type !== "sub_agent") {
            return [];
        }
        const existing = this.subAgentCallsByCallId.get(timelineItem.callId);
        const state = existing ??
            {
                callId: timelineItem.callId,
                toolCall: timelineItem,
                parentCallId,
                activityItemIds: new Set(),
                pendingCommandOutputDeltas: new Map(),
                pendingFileChangeOutputDeltas: new Map(),
                childItemOrder: [],
                childItems: new Map(),
                childThreadIds: new Set(),
            };
        state.toolCall = {
            ...timelineItem,
            detail: {
                ...timelineItem.detail,
                log: timelineItem.detail.log ||
                    (state.toolCall.detail.type === "sub_agent" ? state.toolCall.detail.log : ""),
            },
        };
        state.parentCallId ?? (state.parentCallId = parentCallId);
        const activity = readCodexSubAgentActivity(rawItem);
        if (activity?.id) {
            state.activityItemIds.add(activity.id);
        }
        this.subAgentCallsByCallId.set(timelineItem.callId, state);
        const receiverThreadIds = Array.isArray(rawItem.receiverThreadIds)
            ? rawItem.receiverThreadIds.filter((value) => typeof value === "string")
            : [];
        const agentThreadId = typeof rawItem.agentThreadId === "string" && rawItem.agentThreadId.length > 0
            ? rawItem.agentThreadId
            : null;
        const childThreadIds = Array.from(new Set(agentThreadId ? [...receiverThreadIds, agentThreadId] : receiverThreadIds)).filter((threadId) => threadId !== this.currentThreadId);
        for (const receiverThreadId of childThreadIds) {
            this.subAgentCallIdByChildThreadId.set(receiverThreadId, timelineItem.callId);
            state.childThreadIds.add(receiverThreadId);
            this.emitProviderSubagentUpsert(receiverThreadId, state, timelineItem.status);
        }
        return childThreadIds;
    }
    handleRegisteredSubAgentActivity(rawItem) {
        const activity = readCodexSubAgentActivity(rawItem);
        if (!activity) {
            return false;
        }
        const callId = this.subAgentCallIdByChildThreadId.get(activity.agentThreadId);
        if (!callId) {
            return false;
        }
        const state = this.subAgentCallsByCallId.get(callId);
        if (!state) {
            return false;
        }
        if (activity.id && state.activityItemIds.has(activity.id)) {
            return true;
        }
        if (activity.id) {
            state.activityItemIds.add(activity.id);
        }
        const activityToolCall = mapCodexToolCallFromThreadItem(rawItem, {
            cwd: this.config.cwd ?? null,
        });
        if (activityToolCall?.detail.type === "sub_agent" &&
            state.toolCall.detail.type === "sub_agent") {
            state.toolCall = {
                ...state.toolCall,
                detail: {
                    ...state.toolCall.detail,
                    subAgentType: activityToolCall.detail.subAgentType,
                },
            };
        }
        this.emitSubAgentActivityUpdate(callId, activity.kind === "interrupted" ? "canceled" : "running");
        return true;
    }
    handleCompletedContextCompactionItem(item) {
        if (!this.isContextCompactionItem(item)) {
            return false;
        }
        if (this.unpairedCompactionNotificationCompletions > 0) {
            this.unpairedCompactionNotificationCompletions -= 1;
            return true;
        }
        this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: this.createContextCompactionTimelineItem("completed", item.id),
        });
        this.unpairedCompactionItemCompletions += 1;
        return true;
    }
    handleCompletedSpecialItem(parsed, childSubAgentCallId) {
        if (childSubAgentCallId &&
            this.handleSubAgentContextCompactionItem(childSubAgentCallId, parsed.item, "completed")) {
            return true;
        }
        return (this.handleCompletedContextCompactionItem(parsed.item) ||
            this.handleRegisteredSubAgentActivity(parsed.item));
    }
    upsertSubAgentChildItem(callId, itemId, item) {
        const state = this.subAgentCallsByCallId.get(callId);
        if (!state) {
            return;
        }
        if (!state.childItems.has(itemId)) {
            state.childItemOrder.push(itemId);
        }
        state.childItems.set(itemId, item);
    }
    emitCodexToolTimelineItem(timelineItem, subAgentCallId, childThreadId) {
        if (!subAgentCallId) {
            this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
            return;
        }
        this.upsertSubAgentChildItem(subAgentCallId, timelineItem.callId, timelineItem);
        const state = this.subAgentCallsByCallId.get(subAgentCallId);
        if (state) {
            const targetThreadIds = childThreadId ? [childThreadId] : state.childThreadIds;
            for (const targetThreadId of targetThreadIds) {
                this.emitProviderSubagentTimeline(targetThreadId, timelineItem);
            }
        }
        this.emitSubAgentActivityUpdate(subAgentCallId, timelineItem.status === "running" ? "running" : undefined);
    }
    getSubAgentChildTimeline(state) {
        return state.childItemOrder
            .map((itemId) => state.childItems.get(itemId))
            .filter((item) => Boolean(item));
    }
    emitSubAgentActivityUpdate(callId, status) {
        const state = this.subAgentCallsByCallId.get(callId);
        if (!state || state.toolCall.detail.type !== "sub_agent") {
            return;
        }
        const childTimeline = this.getSubAgentChildTimeline(state);
        const log = childTimeline.length > 0
            ? curateAgentActivity(childTimeline, { labelAssistantMessages: true })
            : "";
        const resolvedStatus = status ?? state.toolCall.status;
        for (const childThreadId of state.childThreadIds) {
            this.emitProviderSubagentUpsert(childThreadId, state, resolvedStatus);
        }
        const baseToolCall = {
            ...state.toolCall,
            detail: {
                ...state.toolCall.detail,
                log,
            },
        };
        const nextToolCall = resolvedStatus === "failed"
            ? {
                ...baseToolCall,
                status: "failed",
                error: state.toolCall.error ?? { message: "Sub-agent failed" },
            }
            : {
                ...baseToolCall,
                status: resolvedStatus,
                error: null,
            };
        state.toolCall = nextToolCall;
        if (state.parentCallId && state.parentCallId !== callId) {
            this.upsertSubAgentChildItem(state.parentCallId, state.callId, nextToolCall);
            this.emitSubAgentActivityUpdate(state.parentCallId);
            return;
        }
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: nextToolCall });
    }
    emitProviderSubagentUpsert(childThreadId, state, status) {
        const detail = state.toolCall.detail;
        if (detail.type !== "sub_agent") {
            return;
        }
        let providerStatus = "running";
        if (status === "completed") {
            providerStatus = "completed";
        }
        else if (status === "failed") {
            providerStatus = "failed";
        }
        else if (status === "canceled") {
            providerStatus = "canceled";
        }
        this.emitEvent({
            type: "provider_subagent",
            provider: CODEX_PROVIDER,
            event: {
                type: "upsert",
                id: childThreadId,
                title: detail.subAgentType ?? "Codex subagent",
                description: detail.description ?? null,
                status: providerStatus,
                toolCallId: state.callId,
            },
        });
    }
    emitProviderSubagentTimeline(childThreadId, item, timestamp) {
        this.emitEvent({
            type: "provider_subagent",
            provider: CODEX_PROVIDER,
            event: {
                type: "timeline",
                id: childThreadId,
                item,
                ...(timestamp ? { timestamp } : {}),
            },
        });
    }
    emitCompletedProviderSubagentItem(parsed, timelineItem) {
        const itemId = parsed.item.id;
        if (!parsed.threadId)
            return;
        if (timelineItem.type === "assistant_message" && itemId) {
            const streamedText = this.pendingAgentMessages.get(itemId);
            if (streamedText !== undefined) {
                const suffix = this.buildMissingFinalTextSuffix(timelineItem, streamedText);
                if (suffix)
                    this.emitProviderSubagentTimeline(parsed.threadId, suffix);
                return;
            }
        }
        if (timelineItem.type === "reasoning" && itemId) {
            const streamedText = this.pendingReasoning.get(itemId)?.join("");
            if (streamedText !== undefined) {
                const suffix = this.buildMissingFinalTextSuffix(timelineItem, streamedText);
                if (suffix)
                    this.emitProviderSubagentTimeline(parsed.threadId, suffix);
                return;
            }
        }
        this.emitProviderSubagentTimeline(parsed.threadId, timelineItem);
    }
    emitStartedProviderSubagentItem(threadId, timelineItem) {
        if (threadId) {
            this.emitProviderSubagentTimeline(threadId, timelineItem);
        }
    }
    emitProviderSubagentTimelineItems(threadId, timelineItems) {
        if (!threadId) {
            return;
        }
        for (const timelineItem of timelineItems) {
            this.emitProviderSubagentTimeline(threadId, timelineItem);
        }
    }
    handleSubAgentChildItemCompleted(callId, itemId, timelineItem) {
        this.applyBufferedDeltaTextToTimelineItem(timelineItem, itemId);
        if (itemId) {
            this.upsertSubAgentChildItem(callId, itemId, timelineItem);
            this.pendingAgentMessages.delete(itemId);
            this.pendingReasoning.delete(itemId);
            this.pendingCommandOutputDeltas.delete(itemId);
            this.pendingFileChangeOutputDeltas.delete(itemId);
        }
        this.emitSubAgentActivityUpdate(callId, "running");
    }
    handleSubAgentContextCompactionItem(callId, item, status) {
        if (!this.isContextCompactionItem(item)) {
            return false;
        }
        if (item.id) {
            this.upsertSubAgentChildItem(callId, item.id, { type: "compaction", status });
        }
        this.emitSubAgentActivityUpdate(callId);
        return true;
    }
    shouldSkipCompletedThreadItem(timelineItem, normalizedItemType, itemId) {
        // For commandExecution items, codex/event/exec_command_* is authoritative.
        if (timelineItem.type === "tool_call" && normalizedItemType === "commandExecution") {
            const callId = timelineItem.callId || itemId;
            return Boolean(callId && this.emittedExecCommandCompletedCallIds.has(callId));
        }
        return Boolean(itemId && this.emittedItemCompletedIds.has(itemId));
    }
    handleCodexDeltaNotification(parsed, routedSubAgentCallId = null) {
        if (parsed.kind === "agent_message_delta") {
            const prev = this.pendingAgentMessages.get(parsed.itemId) ?? "";
            const text = prev + parsed.delta;
            this.pendingAgentMessages.set(parsed.itemId, text);
            const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
            if (subAgentCallId) {
                if (parsed.threadId) {
                    this.emitProviderSubagentTimeline(parsed.threadId, {
                        type: "assistant_message",
                        messageId: parsed.itemId,
                        text: parsed.delta,
                    });
                }
                this.upsertSubAgentChildItem(subAgentCallId, parsed.itemId, {
                    type: "assistant_message",
                    messageId: parsed.itemId,
                    text,
                });
                this.emitSubAgentActivityUpdate(subAgentCallId, "running");
                return;
            }
            const isFirstDeltaForItem = prev.length === 0;
            this.emitEvent({
                type: "timeline",
                provider: CODEX_PROVIDER,
                item: {
                    type: "assistant_message",
                    messageId: parsed.itemId,
                    text: isFirstDeltaForItem && this.pendingAssistantMessageBoundary
                        ? `${ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN}${parsed.delta}`
                        : parsed.delta,
                },
            });
            if (isFirstDeltaForItem) {
                this.pendingAssistantMessageBoundary = false;
            }
            return;
        }
        if (parsed.kind === "reasoning_delta") {
            const prev = this.pendingReasoning.get(parsed.itemId) ?? [];
            prev.push(parsed.delta);
            this.pendingReasoning.set(parsed.itemId, prev);
            const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
            if (subAgentCallId) {
                if (parsed.threadId) {
                    this.emitProviderSubagentTimeline(parsed.threadId, {
                        type: "reasoning",
                        text: parsed.delta,
                    });
                }
                this.upsertSubAgentChildItem(subAgentCallId, parsed.itemId, {
                    type: "reasoning",
                    text: prev.join(""),
                });
                this.emitSubAgentActivityUpdate(subAgentCallId, "running");
                return;
            }
            this.emitEvent({
                type: "timeline",
                provider: CODEX_PROVIDER,
                item: { type: "reasoning", text: parsed.delta },
            });
            return;
        }
        if (parsed.kind === "exec_command_output_delta") {
            const outputDeltas = routedSubAgentCallId
                ? this.subAgentCallsByCallId.get(routedSubAgentCallId)?.pendingCommandOutputDeltas
                : this.pendingCommandOutputDeltas;
            if (!outputDeltas) {
                return;
            }
            this.appendOutputDeltaChunk(outputDeltas, parsed.callId, parsed.chunk, {
                decodeBase64: true,
            });
            return;
        }
        const outputDeltas = routedSubAgentCallId
            ? this.subAgentCallsByCallId.get(routedSubAgentCallId)?.pendingFileChangeOutputDeltas
            : this.pendingFileChangeOutputDeltas;
        if (outputDeltas) {
            this.appendOutputDeltaChunk(outputDeltas, parsed.itemId, parsed.delta);
        }
    }
    handleThreadStartedNotification(parsed) {
        this.currentThreadId = parsed.threadId;
        this.emitEvent({
            type: "thread_started",
            provider: CODEX_PROVIDER,
            sessionId: parsed.threadId,
        });
    }
    handleTurnStartedNotification(parsed) {
        const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
        if (subAgentCallId) {
            this.emitSubAgentActivityUpdate(subAgentCallId, "running");
            return;
        }
        this.currentTurnId = parsed.turnId;
        const pendingIdentification = this.pendingForegroundTurnIdentification;
        if (pendingIdentification &&
            pendingIdentification.foregroundTurnId === this.activeForegroundTurnId) {
            pendingIdentification.resolve(parsed.turnId);
            this.pendingForegroundTurnIdentification = null;
        }
        this.resetTurnTrackingState();
        this.emitEvent({ type: "turn_started", provider: CODEX_PROVIDER });
    }
    handleTurnCompletedNotification(parsed) {
        const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
        if (subAgentCallId) {
            let status = "completed";
            if (parsed.status === "failed") {
                status = "failed";
            }
            else if (parsed.status === "interrupted") {
                status = "canceled";
            }
            this.emitSubAgentActivityUpdate(subAgentCallId, status);
            return;
        }
        if (parsed.status === "failed") {
            this.emitEvent({
                type: "turn_failed",
                provider: CODEX_PROVIDER,
                error: parsed.errorMessage ?? "Codex turn failed",
            });
        }
        else if (parsed.status === "interrupted") {
            this.emitEvent({ type: "turn_canceled", provider: CODEX_PROVIDER, reason: "interrupted" });
        }
        else {
            if (this.planModeEnabled && this.latestPlanResult?.text) {
                this.emitSyntheticPlanApprovalRequest(this.latestPlanResult.text);
            }
            this.emitEvent({
                type: "turn_completed",
                provider: CODEX_PROVIDER,
                usage: this.latestUsage,
            });
        }
        this.activeForegroundTurnId = null;
        this.activeClientMessageId = null;
        this.currentTurnId = null;
        this.pendingForegroundTurnIdentification?.resolve(null);
        this.pendingForegroundTurnIdentification = null;
        this.pendingSubAgentNotificationsByThreadId.clear();
        this.resetTurnTrackingState();
    }
    resetTurnTrackingState() {
        this.latestPlanResult = null;
        this.emittedItemStartedIds.clear();
        this.emittedItemCompletedIds.clear();
        this.emittedProviderSubagentUserMessageKeys.clear();
        this.emittedExecCommandStartedCallIds.clear();
        this.emittedExecCommandCompletedCallIds.clear();
        this.pendingAgentMessages.clear();
        this.pendingReasoning.clear();
        this.pendingCommandOutputDeltas.clear();
        this.pendingFileChangeOutputDeltas.clear();
        this.pendingAssistantMessageBoundary = false;
        this.warnedIncompleteEditToolCallIds.clear();
        this.unpairedCompactionNotificationCompletions = 0;
        this.unpairedCompactionItemCompletions = 0;
    }
    handlePlanUpdatedNotification(parsed) {
        const timelineItem = mapCodexPlanToToolCall({
            callId: `plan:${this.currentTurnId ?? this.currentThreadId ?? "current"}`,
            text: planStepsToMarkdown(parsed.plan.map((entry) => ({
                step: entry.step ?? "",
                status: entry.status ?? "pending",
            }))),
        });
        if (timelineItem) {
            this.rememberPlanResult(timelineItem);
            // In plan mode, the same plan is rendered through the synthetic approval
            // permission. Keep the remembered text for that card, but do not also
            // emit a static timeline plan panel.
            if (this.planModeEnabled) {
                return;
            }
            this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
        }
    }
    handleTokenUsageUpdatedNotification(parsed) {
        this.latestUsage = toAgentUsage(parsed.tokenUsage);
        if (this.latestUsage) {
            this.notifySubscribers({
                type: "usage_updated",
                provider: CODEX_PROVIDER,
                usage: this.latestUsage,
            });
        }
    }
    resolveContextCompactionTrigger(itemId) {
        if (itemId) {
            const known = this.compactionTriggerByItemId.get(itemId);
            if (known) {
                return known;
            }
        }
        if (this.pendingManualCompactionStarts > 0) {
            this.pendingManualCompactionStarts -= 1;
            return "manual";
        }
        return undefined;
    }
    createContextCompactionTimelineItem(status, itemId) {
        const trigger = this.resolveContextCompactionTrigger(itemId);
        if (itemId && trigger) {
            if (status === "loading") {
                this.compactionTriggerByItemId.set(itemId, trigger);
            }
            else {
                this.compactionTriggerByItemId.delete(itemId);
            }
        }
        return {
            type: "compaction",
            status,
            ...(trigger ? { trigger } : {}),
        };
    }
    isContextCompactionItem(item) {
        return (normalizeCodexThreadItemType(typeof item.type === "string" ? item.type : undefined) ===
            CODEX_CONTEXT_COMPACTION_TYPE);
    }
    isUserMessageItem(item) {
        return (normalizeCodexThreadItemType(typeof item.type === "string" ? item.type : undefined) ===
            "userMessage");
    }
    handleThreadRolledBackNotification(parsed) {
        this.truncateCodexUserMessageTurns(parsed.numTurns);
    }
    handleContextCompactedNotification(parsed) {
        if (parsed.threadId !== this.currentThreadId) {
            return;
        }
        if (this.unpairedCompactionItemCompletions > 0) {
            this.unpairedCompactionItemCompletions -= 1;
            return;
        }
        this.unpairedCompactionNotificationCompletions += 1;
        this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: this.createContextCompactionTimelineItem("completed"),
            ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
        });
    }
    handleExecCommandStartedNotification(parsed, subAgentCallId = null) {
        const outputDeltas = subAgentCallId
            ? this.subAgentCallsByCallId.get(subAgentCallId)?.pendingCommandOutputDeltas
            : this.pendingCommandOutputDeltas;
        if (!outputDeltas) {
            return;
        }
        if (parsed.callId && !subAgentCallId) {
            this.emittedExecCommandStartedCallIds.add(parsed.callId);
        }
        if (parsed.callId) {
            outputDeltas.delete(parsed.callId);
        }
        const timelineItem = mapCodexExecNotificationToToolCall({
            callId: parsed.callId,
            command: parsed.command,
            cwd: parsed.cwd ?? this.config.cwd ?? null,
            running: true,
        });
        if (timelineItem) {
            this.emitCodexToolTimelineItem(timelineItem, subAgentCallId, parsed.threadId);
        }
    }
    handleExecCommandCompletedNotification(parsed, subAgentCallId = null) {
        const outputDeltas = subAgentCallId
            ? this.subAgentCallsByCallId.get(subAgentCallId)?.pendingCommandOutputDeltas
            : this.pendingCommandOutputDeltas;
        if (!outputDeltas) {
            return;
        }
        const bufferedOutput = this.consumeOutputDelta(outputDeltas, parsed.callId);
        const resolvedOutput = parsed.output ?? bufferedOutput;
        if (!subAgentCallId) {
            this.rememberTerminalProcessForCommand(parsed.command, resolvedOutput);
        }
        const timelineItem = mapCodexExecNotificationToToolCall({
            callId: parsed.callId,
            command: parsed.command,
            cwd: parsed.cwd ?? this.config.cwd ?? null,
            output: resolvedOutput,
            exitCode: parsed.exitCode,
            success: parsed.success,
            stderr: parsed.stderr,
            running: false,
        });
        if (timelineItem) {
            if (!subAgentCallId) {
                this.emittedExecCommandCompletedCallIds.add(timelineItem.callId);
            }
            this.emitCodexToolTimelineItem(timelineItem, subAgentCallId, parsed.threadId);
        }
    }
    handleTerminalInteractionNotification(parsed) {
        const interactionKey = [parsed.processId ?? "", parsed.stdin ?? ""].join("\u0000");
        if (!this.shouldEmitTerminalInteractionKey(interactionKey)) {
            return;
        }
        const command = (parsed.processId ? this.terminalCommandByProcessId.get(parsed.processId) : undefined) ??
            null;
        const callId = this.createTerminalInteractionCallId(parsed.processId, parsed.callId);
        if (!command && parsed.processId) {
            const pendingInteractions = this.pendingUnlabeledTerminalInteractions.get(parsed.processId) ?? [];
            pendingInteractions.push({ callId, stdin: parsed.stdin });
            this.pendingUnlabeledTerminalInteractions.set(parsed.processId, pendingInteractions);
        }
        const timelineItem = mapCodexTerminalInteractionToToolCall({
            callId,
            processId: parsed.processId,
            command,
            stdin: parsed.stdin,
        });
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
    }
    handlePatchApplyStartedNotification(parsed, subAgentCallId = null) {
        const outputDeltas = subAgentCallId
            ? this.subAgentCallsByCallId.get(subAgentCallId)?.pendingFileChangeOutputDeltas
            : this.pendingFileChangeOutputDeltas;
        if (!outputDeltas) {
            return;
        }
        if (parsed.callId) {
            outputDeltas.delete(parsed.callId);
        }
        const timelineItem = mapCodexPatchNotificationToToolCall({
            callId: parsed.callId,
            changes: parsed.changes,
            cwd: this.config.cwd ?? null,
            running: true,
        });
        if (timelineItem) {
            this.warnOnIncompleteEditToolCall(timelineItem, "patch_apply_started", {
                callId: parsed.callId,
                changes: parsed.changes,
            });
            this.emitCodexToolTimelineItem(timelineItem, subAgentCallId, parsed.threadId);
        }
    }
    handlePatchApplyCompletedNotification(parsed, subAgentCallId = null) {
        const outputDeltas = subAgentCallId
            ? this.subAgentCallsByCallId.get(subAgentCallId)?.pendingFileChangeOutputDeltas
            : this.pendingFileChangeOutputDeltas;
        if (!outputDeltas) {
            return;
        }
        const bufferedOutput = this.consumeOutputDelta(outputDeltas, parsed.callId);
        const timelineItem = mapCodexPatchNotificationToToolCall({
            callId: parsed.callId,
            changes: parsed.changes,
            cwd: this.config.cwd ?? null,
            stdout: parsed.stdout ?? bufferedOutput,
            stderr: parsed.stderr,
            success: parsed.success,
            running: false,
        });
        if (timelineItem) {
            this.warnOnIncompleteEditToolCall(timelineItem, "patch_apply_completed", {
                callId: parsed.callId,
                changes: parsed.changes,
                stdout: parsed.stdout,
            });
            this.emitCodexToolTimelineItem(timelineItem, subAgentCallId, parsed.threadId);
        }
    }
    handleItemCompletedNotification(parsed) {
        // Codex emits mirrored lifecycle notifications via both `codex/event/item_*`
        // and canonical `item/*`. Render ordinary items only from the canonical
        // channel, but accept a legacy-only child announcement so it can establish
        // the provider-subagent route.
        if (shouldIgnoreMirroredLifecycleItem(parsed.source, parsed.item)) {
            return;
        }
        if (this.isUserMessageItem(parsed.item)) {
            this.handleUserMessageItem(parsed);
            return;
        }
        const childSubAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
        if (this.handleCompletedSpecialItem(parsed, childSubAgentCallId)) {
            return;
        }
        const timelineItem = threadItemToTimeline(parsed.item, {
            includeUserMessage: false,
            cwd: this.config.cwd ?? null,
        });
        if (!timelineItem) {
            return;
        }
        const registeredChildThreadIds = timelineItem.type === "tool_call"
            ? this.registerSubAgentToolCall({
                timelineItem,
                rawItem: parsed.item,
                parentCallId: childSubAgentCallId,
            })
            : [];
        const imageItems = mcpToolResultImagesToTimeline(parsed.item);
        if (childSubAgentCallId) {
            this.emitCompletedProviderSubagentItem(parsed, timelineItem);
            this.handleSubAgentChildItemCompleted(childSubAgentCallId, parsed.item.id, timelineItem);
            this.emitProviderSubagentTimelineItems(parsed.threadId, imageItems);
            this.replayPendingSubAgentNotifications(registeredChildThreadIds);
            return;
        }
        const normalizedItemType = normalizeCodexThreadItemType(typeof parsed.item.type === "string" ? parsed.item.type : undefined);
        const itemId = parsed.item.id;
        if (this.shouldSkipCompletedThreadItem(timelineItem, normalizedItemType, itemId)) {
            this.replayPendingSubAgentNotifications(registeredChildThreadIds);
            return;
        }
        if (this.consumeStreamedTextCompletion(timelineItem, itemId)) {
            if (timelineItem.type === "assistant_message") {
                this.pendingAssistantMessageBoundary = true;
            }
            if (itemId) {
                this.emittedItemCompletedIds.add(itemId);
                this.emittedItemStartedIds.delete(itemId);
            }
            this.replayPendingSubAgentNotifications(registeredChildThreadIds);
            return;
        }
        this.applyBufferedDeltaTextToTimelineItem(timelineItem, itemId);
        if (timelineItem.type === "tool_call") {
            if (timelineItem.detail.type === "plan") {
                this.rememberPlanResult(timelineItem);
                // Codex can surface plans both as turn/plan updates and as completed
                // thread items. In plan mode, approval owns the visible plan card.
                if (this.planModeEnabled) {
                    return;
                }
            }
            this.warnOnIncompleteEditToolCall(timelineItem, "item_completed", parsed.item);
        }
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
        if (timelineItem.type === "assistant_message") {
            this.pendingAssistantMessageBoundary = true;
        }
        for (const imageItem of imageItems) {
            this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: imageItem });
            this.pendingAssistantMessageBoundary = true;
        }
        if (itemId) {
            this.emittedItemCompletedIds.add(itemId);
            this.emittedItemStartedIds.delete(itemId);
            this.pendingCommandOutputDeltas.delete(itemId);
            this.pendingFileChangeOutputDeltas.delete(itemId);
        }
        this.replayPendingSubAgentNotifications(registeredChildThreadIds);
    }
    consumeStreamedTextCompletion(timelineItem, itemId) {
        if (!itemId) {
            return false;
        }
        if (timelineItem.type === "assistant_message" && this.pendingAgentMessages.has(itemId)) {
            const streamedText = this.pendingAgentMessages.get(itemId) ?? "";
            this.pendingAgentMessages.delete(itemId);
            this.emitMissingFinalTextSuffix(timelineItem, streamedText);
            return true;
        }
        if (timelineItem.type === "reasoning" && this.pendingReasoning.has(itemId)) {
            const streamedText = this.pendingReasoning.get(itemId)?.join("") ?? "";
            this.pendingReasoning.delete(itemId);
            this.emitMissingFinalTextSuffix(timelineItem, streamedText);
            return true;
        }
        return false;
    }
    emitMissingFinalTextSuffix(timelineItem, streamedText) {
        const item = this.buildMissingFinalTextSuffix(timelineItem, streamedText);
        if (item)
            this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item });
    }
    buildMissingFinalTextSuffix(timelineItem, streamedText) {
        if (!timelineItem.text.startsWith(streamedText))
            return timelineItem;
        const suffix = timelineItem.text.slice(streamedText.length);
        if (!suffix)
            return null;
        return timelineItem.type === "assistant_message"
            ? {
                type: timelineItem.type,
                text: suffix,
                ...(timelineItem.messageId ? { messageId: timelineItem.messageId } : {}),
            }
            : { type: timelineItem.type, text: suffix };
    }
    applyBufferedDeltaTextToTimelineItem(timelineItem, itemId) {
        if (!itemId) {
            return;
        }
        if (timelineItem.type === "assistant_message") {
            const buffered = this.pendingAgentMessages.get(itemId);
            if (buffered && buffered.length > 0) {
                if (!timelineItem.text.startsWith(buffered))
                    timelineItem.text = buffered;
            }
            return;
        }
        if (timelineItem.type === "reasoning") {
            const buffered = this.pendingReasoning.get(itemId);
            if (buffered && buffered.length > 0) {
                const streamedText = buffered.join("");
                if (!timelineItem.text.startsWith(streamedText))
                    timelineItem.text = streamedText;
            }
        }
    }
    handleItemStartedNotification(parsed) {
        if (shouldIgnoreMirroredLifecycleItem(parsed.source, parsed.item)) {
            return;
        }
        if (this.isUserMessageItem(parsed.item)) {
            this.handleUserMessageItem(parsed);
            return;
        }
        const childSubAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
        if (childSubAgentCallId &&
            this.handleSubAgentContextCompactionItem(childSubAgentCallId, parsed.item, "loading")) {
            return;
        }
        if (this.isContextCompactionItem(parsed.item)) {
            this.emitEvent({
                type: "timeline",
                provider: CODEX_PROVIDER,
                item: this.createContextCompactionTimelineItem("loading", parsed.item.id),
            });
            return;
        }
        if (this.handleRegisteredSubAgentActivity(parsed.item)) {
            return;
        }
        const timelineItem = threadItemToTimeline(parsed.item, {
            includeUserMessage: false,
            cwd: this.config.cwd ?? null,
        });
        if (!timelineItem || timelineItem.type !== "tool_call") {
            return;
        }
        const registeredChildThreadIds = this.registerSubAgentToolCall({
            timelineItem,
            rawItem: parsed.item,
            parentCallId: childSubAgentCallId,
        });
        if (childSubAgentCallId) {
            this.emitStartedProviderSubagentItem(parsed.threadId, timelineItem);
            if (parsed.item.id) {
                this.upsertSubAgentChildItem(childSubAgentCallId, parsed.item.id, timelineItem);
            }
            this.emitSubAgentActivityUpdate(childSubAgentCallId, "running");
            this.replayPendingSubAgentNotifications(registeredChildThreadIds);
            return;
        }
        const normalizedItemType = normalizeCodexThreadItemType(typeof parsed.item.type === "string" ? parsed.item.type : undefined);
        const itemId = parsed.item.id;
        if (normalizedItemType === "commandExecution") {
            const callId = timelineItem.callId || itemId;
            if (callId && this.emittedExecCommandStartedCallIds.has(callId)) {
                return;
            }
        }
        if (itemId && this.emittedItemStartedIds.has(itemId)) {
            return;
        }
        this.warnOnIncompleteEditToolCall(timelineItem, "item_started", parsed.item);
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
        if (itemId) {
            this.emittedItemStartedIds.add(itemId);
            this.pendingCommandOutputDeltas.delete(itemId);
            this.pendingFileChangeOutputDeltas.delete(itemId);
        }
        this.replayPendingSubAgentNotifications(registeredChildThreadIds);
    }
    handleUserMessageItem(parsed) {
        const itemId = parsed.item.id;
        const timelineItem = threadItemToTimeline(parsed.item, {
            includeUserMessage: true,
            cwd: this.config.cwd ?? null,
        });
        if (!timelineItem || timelineItem.type !== "user_message") {
            return;
        }
        const childSubAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
        if (childSubAgentCallId) {
            const childMessageId = itemId ?? timelineItem.messageId;
            if (!childMessageId) {
                return;
            }
            const childMessageKey = `${parsed.threadId ?? childSubAgentCallId}:${childMessageId}`;
            if (this.emittedProviderSubagentUserMessageKeys.has(childMessageKey)) {
                return;
            }
            this.emittedProviderSubagentUserMessageKeys.add(childMessageKey);
            if (parsed.threadId) {
                this.emitProviderSubagentTimeline(parsed.threadId, timelineItem);
            }
            if (itemId) {
                this.upsertSubAgentChildItem(childSubAgentCallId, itemId, timelineItem);
            }
            this.emitSubAgentActivityUpdate(childSubAgentCallId, "running");
            return;
        }
        if (!this.rememberCodexUserMessageTurn(timelineItem.messageId)) {
            return;
        }
        const item = this.activeClientMessageId
            ? { ...timelineItem, clientMessageId: this.activeClientMessageId }
            : timelineItem;
        this.activeClientMessageId = null;
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item });
    }
    warnUnknownNotificationMethod(method, params) {
        if (this.warnedUnknownNotificationMethods.has(method)) {
            return;
        }
        this.warnedUnknownNotificationMethods.add(method);
        this.logger.trace({
            agentId: this.agentId,
            provider: CODEX_PROVIDER,
            sessionId: this.currentThreadId,
            turnId: this.activeForegroundTurnId ?? undefined,
            method,
            params,
        }, "provider.codex.event_unhandled");
    }
    warnInvalidNotificationPayload(method, params) {
        const key = method;
        if (this.warnedInvalidNotificationPayloads.has(key)) {
            return;
        }
        this.warnedInvalidNotificationPayloads.add(key);
        this.logger.warn({ method, params }, "Invalid Codex app-server notification payload");
    }
    appendOutputDeltaChunk(store, id, chunk, options) {
        if (!id || !chunk) {
            return;
        }
        const normalized = options?.decodeBase64 ? decodeCodexOutputDeltaChunk(chunk) : chunk;
        if (!normalized.length) {
            return;
        }
        const prev = store.get(id) ?? [];
        prev.push(normalized);
        store.set(id, prev);
    }
    consumeOutputDelta(store, id) {
        if (!id) {
            return null;
        }
        const buffered = store.get(id);
        if (!buffered || buffered.length === 0) {
            return null;
        }
        store.delete(id);
        return buffered.join("");
    }
    rememberTerminalProcessForCommand(command, output) {
        const normalizedCommand = normalizeCodexCommandValue(command);
        if (!normalizedCommand) {
            return;
        }
        const displayCommand = typeof normalizedCommand === "string"
            ? normalizedCommand
            : normalizedCommand.join(" ").trim();
        if (!displayCommand) {
            return;
        }
        const processId = extractCodexTerminalSessionId(output ?? undefined);
        if (!processId) {
            return;
        }
        this.terminalCommandByProcessId.set(processId, displayCommand);
        if (!this.pendingUnlabeledTerminalInteractions.has(processId)) {
            return;
        }
        const pendingInteractions = this.pendingUnlabeledTerminalInteractions.get(processId) ?? [];
        this.pendingUnlabeledTerminalInteractions.delete(processId);
        for (const pendingInteraction of pendingInteractions) {
            this.emitEvent({
                type: "timeline",
                provider: CODEX_PROVIDER,
                item: mapCodexTerminalInteractionToToolCall({
                    callId: pendingInteraction.callId,
                    processId,
                    command: displayCommand,
                    stdin: pendingInteraction.stdin,
                }),
            });
        }
    }
    createTerminalInteractionCallId(processId, fallbackCallId) {
        const baseCallId = processId
            ? `terminal-session-${processId}`
            : (nonEmptyString(fallbackCallId ?? undefined) ?? "terminal-interaction");
        this.nextTerminalInteractionOrdinal += 1;
        return `${baseCallId}-${this.nextTerminalInteractionOrdinal}`;
    }
    shouldEmitTerminalInteractionKey(key) {
        if (this.emittedTerminalInteractionKeys.has(key)) {
            return false;
        }
        this.emittedTerminalInteractionKeys.add(key);
        return true;
    }
    warnOnIncompleteEditToolCall(item, source, payload) {
        if (!isEditToolCallWithoutContent(item)) {
            return;
        }
        const warnKey = `${source}:${item.callId}`;
        if (this.warnedIncompleteEditToolCallIds.has(warnKey)) {
            return;
        }
        this.warnedIncompleteEditToolCallIds.add(warnKey);
        this.logger.warn({
            source,
            callId: item.callId,
            status: item.status,
            name: item.name,
            detail: item.detail,
            payload,
        }, "Codex edit tool call is missing diff/content fields");
    }
    handleCommandApprovalRequest(params) {
        const parsed = z
            .object({
            itemId: z.string(),
            threadId: z.string(),
            turnId: z.string(),
            command: z.string().nullable().optional(),
            cwd: z.string().nullable().optional(),
            reason: z.string().nullable().optional(),
        })
            .parse(params);
        const commandPreview = mapCodexExecNotificationToToolCall({
            callId: parsed.itemId,
            command: parsed.command,
            cwd: parsed.cwd ?? this.config.cwd ?? null,
            running: true,
        });
        const requestId = `permission-${parsed.itemId}`;
        const title = parsed.command ? `Run command: ${parsed.command}` : "Run command";
        const request = {
            id: requestId,
            provider: CODEX_PROVIDER,
            name: "CodexBash",
            kind: "tool",
            title,
            description: parsed.reason ?? undefined,
            input: {
                command: parsed.command ?? undefined,
                cwd: parsed.cwd ?? undefined,
            },
            detail: commandPreview?.detail ?? {
                type: "unknown",
                input: {
                    command: parsed.command ?? null,
                    cwd: parsed.cwd ?? null,
                },
                output: null,
            },
            metadata: {
                itemId: parsed.itemId,
                threadId: parsed.threadId,
                turnId: parsed.turnId,
            },
        };
        this.pendingPermissions.set(requestId, request);
        this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
        return new Promise((resolve) => {
            this.pendingPermissionHandlers.set(requestId, { resolve, kind: "command" });
        });
    }
    handleFileChangeApprovalRequest(params) {
        const parsed = z
            .object({
            itemId: z.string(),
            threadId: z.string(),
            turnId: z.string(),
            reason: z.string().nullable().optional(),
        })
            .parse(params);
        const requestId = `permission-${parsed.itemId}`;
        const request = {
            id: requestId,
            provider: CODEX_PROVIDER,
            name: "CodexFileChange",
            kind: "tool",
            title: "Apply file changes",
            description: parsed.reason ?? undefined,
            detail: {
                type: "unknown",
                input: {
                    reason: parsed.reason ?? null,
                },
                output: null,
            },
            metadata: {
                itemId: parsed.itemId,
                threadId: parsed.threadId,
                turnId: parsed.turnId,
            },
        };
        this.pendingPermissions.set(requestId, request);
        this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
        return new Promise((resolve) => {
            this.pendingPermissionHandlers.set(requestId, { resolve, kind: "file" });
        });
    }
    handleToolApprovalRequest(params) {
        const parsed = z
            .object({
            itemId: z.string(),
            threadId: z.string(),
            turnId: z.string(),
            questions: z.array(z.unknown()),
        })
            .parse(params);
        const requestId = `permission-${parsed.itemId}`;
        const questions = normalizeCodexQuestionPrompts(parsed.questions);
        const request = {
            id: requestId,
            provider: CODEX_PROVIDER,
            name: "request_user_input",
            kind: "question",
            title: "Question",
            description: undefined,
            detail: {
                type: "plain_text",
                text: formatCodexQuestionPrompts(questions),
                icon: "brain",
            },
            input: { questions },
            metadata: {
                itemId: parsed.itemId,
                threadId: parsed.threadId,
                turnId: parsed.turnId,
                questions,
            },
        };
        this.pendingPermissions.set(requestId, request);
        this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: mapCodexQuestionRequestToToolCall({
                callId: parsed.itemId,
                questions,
                status: "running",
            }),
        });
        this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
        return new Promise((resolve) => {
            this.pendingPermissionHandlers.set(requestId, {
                resolve,
                kind: "question",
                questions,
            });
        });
    }
    handleMcpElicitationRequest(params, serverRequestId) {
        const parsed = z
            .object({
            threadId: z.string(),
            turnId: z.string().nullable().optional(),
            serverName: z.string(),
            mode: z.enum(["form", "openai/form", "url"]),
            message: z.string(),
            requestedSchema: z.unknown().optional(),
            url: z.string().optional(),
            elicitationId: z.string().optional(),
        })
            .parse(params);
        if (parsed.mode === "url") {
            return Promise.resolve({ action: "decline", content: null, _meta: null });
        }
        const requiredFields = toObjectRecord(parsed.requestedSchema)?.required;
        if (Array.isArray(requiredFields) && requiredFields.length > 0) {
            return Promise.resolve({ action: "decline", content: null, _meta: null });
        }
        const requestId = `permission-${randomUUID()}`;
        const request = {
            id: requestId,
            provider: CODEX_PROVIDER,
            name: "CodexMcpElicitation",
            kind: "tool",
            title: `MCP approval: ${parsed.serverName}`,
            description: parsed.message,
            input: {
                mode: parsed.mode,
                requestedSchema: parsed.requestedSchema ?? null,
                url: parsed.url ?? null,
            },
            metadata: {
                threadId: parsed.threadId,
                turnId: parsed.turnId ?? null,
                serverName: parsed.serverName,
                elicitationId: parsed.elicitationId ?? null,
            },
        };
        this.pendingPermissions.set(requestId, request);
        this.mcpElicitationPermissionIds.set(serverRequestId, requestId);
        this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
        return new Promise((resolve) => {
            this.pendingPermissionHandlers.set(requestId, { resolve, kind: "mcp_elicitation" });
        });
    }
}
export class CodexAppServerAgentClient {
    constructor(logger, runtimeSettings, deps = {}) {
        this.logger = logger;
        this.runtimeSettings = runtimeSettings;
        this.deps = deps;
        this.provider = CODEX_PROVIDER;
        this.capabilities = CODEX_APP_SERVER_CAPABILITIES;
        this.goalsEnabledPromise = null;
        this.autoReviewEnabledPromise = null;
    }
    sessionDeps() {
        const customProvider = this.deps.customProvider;
        const usePaseoActiveCodexProfile = !customProvider ||
            isPaseoManagedCustomProvider(this.runtimeSettings, customProvider);
        return {
            ...this.deps,
            customCodexConfig: usePaseoActiveCodexProfile
                ? null
                : buildCodexCustomProviderConfig(this.runtimeSettings, customProvider),
            customCodexPermission: usePaseoActiveCodexProfile
                ? null
                : parsePaseoProviderPermission(this.runtimeSettings?.env?.PASEO_CODEX_PERMISSION),
            usePaseoActiveCodexProfile,
        };
    }
    resolveGoalsEnabled() {
        if (!this.goalsEnabledPromise) {
            this.goalsEnabledPromise = (async () => {
                try {
                    const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
                    const versionOutput = await resolveBinaryVersion(launchPrefix.command);
                    const enabled = codexVersionAtLeast(versionOutput, CODEX_GOALS_MIN_VERSION);
                    this.logger.trace({
                        provider: CODEX_PROVIDER,
                        versionOutput,
                        enabled,
                    }, "provider.codex.config.goals_resolved");
                    return enabled;
                }
                catch (error) {
                    this.logger.warn({ err: error }, "Failed to probe codex version for goals gate");
                    return false;
                }
            })();
        }
        return this.goalsEnabledPromise;
    }
    resolveAutoReviewEnabled() {
        if (!this.autoReviewEnabledPromise) {
            this.autoReviewEnabledPromise = (async () => {
                try {
                    const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
                    const versionOutput = await resolveBinaryVersion(launchPrefix.command);
                    const enabled = codexVersionAtLeast(versionOutput, CODEX_AUTO_REVIEW_MIN_VERSION);
                    this.logger.trace({
                        provider: CODEX_PROVIDER,
                        versionOutput,
                        enabled,
                    }, "provider.codex.config.auto_review_resolved");
                    return enabled;
                }
                catch (error) {
                    this.logger.warn({ err: error }, "Failed to probe codex version for auto-review gate");
                    return false;
                }
            })();
        }
        return this.autoReviewEnabledPromise;
    }
    async spawnAppServer(launchEnv, options) {
        const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
        const args = [...launchPrefix.args, "app-server"];
        if (options?.goalsEnabled) {
            args.push("--enable", "goals");
        }
        this.logger.trace({
            agentId: options?.agentId,
            provider: CODEX_PROVIDER,
            launchPrefix,
            goalsEnabled: options?.goalsEnabled === true,
        }, "provider.codex.spawn");
        const child = spawnProcess(launchPrefix.command, args, {
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: buildCodexAppServerEnv(this.runtimeSettings, launchEnv),
        });
        assertChildWithPipes(child);
        return child;
    }
    async createSession(config, launchContext, options) {
        if (options?.persistSession === false) {
            this.logger.debug("Codex app-server does not expose an ephemeral-session option; persistSession=false is currently a no-op");
            // TODO: Honor persistSession=false if app-server adds support, or route
            // utility generations through `codex exec --ephemeral` in a larger change.
        }
        const sessionConfig = { ...config, provider: CODEX_PROVIDER };
        const goalsEnabled = await this.resolveGoalsEnabled();
        const autoReviewEnabled = await this.resolveAutoReviewEnabled();
        const session = new CodexAppServerAgentSession(sessionConfig, null, this.logger, () => this.spawnAppServer(launchContext?.env, { goalsEnabled, agentId: launchContext?.agentId }), this.sessionDeps(), options?.persistSession === false, goalsEnabled, autoReviewEnabled, launchContext?.agentId);
        await session.connect();
        return session;
    }
    async resumeSession(handle, overrides, launchContext, options) {
        const storedConfig = (handle.metadata ?? {});
        const merged = {
            ...storedConfig,
            ...overrides,
            provider: CODEX_PROVIDER,
            cwd: overrides?.cwd ?? storedConfig.cwd ?? process.cwd(),
        };
        const goalsEnabled = await this.resolveGoalsEnabled();
        const autoReviewEnabled = await this.resolveAutoReviewEnabled();
        const session = new CodexAppServerAgentSession(merged, handle, this.logger, () => this.spawnAppServer(launchContext?.env, { goalsEnabled, agentId: launchContext?.agentId }), this.sessionDeps(), false, goalsEnabled, autoReviewEnabled, launchContext?.agentId, options?.purpose ?? "interactive");
        await session.connect();
        return session;
    }
    async listImportableSessions(options) {
        const child = await this.spawnAppServer();
        const client = this.deps._createCodexClient?.(child, this.logger, () => ({})) ??
            new CodexAppServerClient(child, this.logger);
        try {
            await client.request("initialize", buildCodexAppServerInitializeParams());
            client.notify("initialized", {});
            const limit = options?.limit ?? 20;
            // thread/list returns the cheap `cwd` field. Fetch a wider window when
            // filtering since most threads will be from other cwds, then keep the
            // local realpath-aware filter for symlink-equivalent workspace paths.
            const listLimit = options?.cwd ? Math.max(limit, 50) : limit;
            const response = toObjectRecord(await client.request("thread/list", {
                limit: listLimit,
                ...(options?.cwd ? { cwd: options.cwd } : {}),
            }));
            const allThreads = Array.isArray(response?.data) ? response.data.filter(isRecord) : [];
            const threads = filterCodexThreadsByCwd(allThreads, options?.cwd);
            return threads.slice(0, limit).map((thread) => {
                const threadId = typeof thread.id === "string" ? thread.id : "";
                const cwd = typeof thread.cwd === "string" ? thread.cwd : process.cwd();
                const preview = typeof thread.preview === "string" ? thread.preview : null;
                const title = typeof thread.name === "string" && thread.name.trim() ? thread.name : preview;
                return {
                    providerHandleId: threadId,
                    cwd,
                    title,
                    firstPromptPreview: preview,
                    lastPromptPreview: preview,
                    lastActivityAt: new Date(((typeof thread.updatedAt === "number" ? thread.updatedAt : undefined) ??
                        (typeof thread.createdAt === "number" ? thread.createdAt : undefined) ??
                        0) * 1000),
                };
            });
        }
        finally {
            await client.dispose();
        }
    }
    async importSession(input, context) {
        return importSessionFromPersistence({
            provider: CODEX_PROVIDER,
            request: input,
            context,
            resumeSession: this.resumeSession.bind(this),
        });
    }
    async fetchCatalog(_options) {
        const [models, autoReviewEnabled] = await Promise.all([
            this.fetchModelsFromAppServer(),
            this.resolveAutoReviewEnabled(),
        ]);
        return {
            models,
            defaultModeId: autoReviewEnabled ? "auto-review" : DEFAULT_CODEX_MODE_ID,
            modes: autoReviewEnabled
                ? CODEX_MODES
                : CODEX_MODES.filter((mode) => mode.id !== "auto-review"),
        };
    }
    async resolveDefaultModeId() {
        return (await this.resolveAutoReviewEnabled()) ? "auto-review" : DEFAULT_CODEX_MODE_ID;
    }
    async fetchModelsFromAppServer() {
        // Codex model/list is global to the app server in this flow; cwd/force are intentionally ignored.
        const child = await this.spawnAppServer();
        const client = new CodexAppServerClient(child, this.logger);
        try {
            await client.request("initialize", buildCodexAppServerInitializeParams());
            client.notify("initialized", {});
            const rawResponse = await client.request("model/list", {});
            const parsedResponse = CodexModelListResponseSchema.safeParse(rawResponse);
            const models = parsedResponse.success ? (parsedResponse.data.data ?? []) : [];
            const configuredDefaults = await readCodexConfiguredDefaults(client, this.logger);
            const configuredDefaultModelId = configuredDefaults.model;
            const configuredDefaultThinkingOptionId = configuredDefaults.thinkingOptionId;
            const hasConfiguredDefaultModel = typeof configuredDefaultModelId === "string"
                ? models.some((model) => model?.id === configuredDefaultModelId)
                : false;
            return models.map((model) => buildCodexModelDefinition(model, {
                configuredDefaultModelId,
                configuredDefaultThinkingOptionId,
                hasConfiguredDefaultModel,
            }));
        }
        finally {
            await client.dispose();
        }
    }
    async archiveNativeSession(handle) {
        const threadId = handle.nativeHandle ?? handle.sessionId;
        if (!threadId)
            return;
        const child = await this.spawnAppServer();
        const client = new CodexAppServerClient(child, this.logger);
        try {
            await client.request("initialize", buildCodexAppServerInitializeParams());
            client.notify("initialized", {});
            await client.request("thread/archive", { threadId });
        }
        finally {
            await client.dispose();
        }
    }
    async unarchiveNativeSession(handle) {
        const threadId = handle.nativeHandle ?? handle.sessionId;
        if (!threadId)
            return;
        const child = await this.spawnAppServer();
        const client = new CodexAppServerClient(child, this.logger);
        try {
            await client.request("initialize", buildCodexAppServerInitializeParams());
            client.notify("initialized", {});
            try {
                await client.request("thread/unarchive", { threadId });
            }
            catch (error) {
                if (!isCodexAlreadyUnarchivedError(error, threadId)) {
                    throw error;
                }
                try {
                    await client.request("thread/read", { threadId });
                }
                catch {
                    throw error;
                }
            }
        }
        finally {
            await client.dispose();
        }
    }
    async isAvailable() {
        const launch = await resolveCodexLaunch(this.runtimeSettings);
        const availability = await checkCodexLaunchAvailable(launch);
        return availability.available;
    }
    async getDiagnostic() {
        try {
            const launch = await resolveCodexLaunch(this.runtimeSettings);
            const availability = await checkCodexLaunchAvailable(launch);
            const entries = [
                ...(await buildCommandResolutionDiagnosticRows(launch, {
                    knownBinaryNames: ["codex"],
                })),
                ...(await buildBinaryDiagnosticRows(launch, availability)),
            ];
            return {
                diagnostic: formatProviderDiagnostic("Codex", entries),
            };
        }
        catch (error) {
            return {
                diagnostic: formatProviderDiagnosticError("Codex", error),
            };
        }
    }
}
function buildCodexModelDefinition(model, ctx) {
    const defaultReasoningEffort = normalizeCodexThinkingOptionId(typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null);
    const resolvedDefaultReasoningEffort = ctx.configuredDefaultThinkingOptionId ?? defaultReasoningEffort;
    const thinkingById = buildCodexThinkingOptionMap(model.supportedReasoningEfforts, resolvedDefaultReasoningEffort, ctx.configuredDefaultThinkingOptionId);
    const thinkingOptions = Array.from(thinkingById.values()).map((option) => Object.assign({}, option, {
        isDefault: option.id === resolvedDefaultReasoningEffort,
    }));
    const defaultThinkingOptionId = resolvedDefaultReasoningEffort ??
        thinkingOptions.find((option) => option.isDefault)?.id ??
        thinkingOptions[0]?.id;
    const isDefaultModel = ctx.hasConfiguredDefaultModel
        ? model.id === ctx.configuredDefaultModelId
        : model.isDefault;
    return {
        provider: CODEX_PROVIDER,
        id: model.id,
        label: normalizeCodexModelLabel(model.displayName ?? ""),
        description: model.description,
        isDefault: isDefaultModel,
        thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
        defaultThinkingOptionId,
        metadata: {
            model: model.model,
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportedReasoningEfforts: model.supportedReasoningEfforts,
        },
    };
}
function buildCodexThinkingOptionMap(supportedReasoningEfforts, resolvedDefaultReasoningEffort, configuredDefaultThinkingOptionId) {
    const thinkingById = new Map();
    if (Array.isArray(supportedReasoningEfforts)) {
        for (const entry of supportedReasoningEfforts) {
            const id = normalizeCodexThinkingOptionId(typeof entry?.reasoningEffort === "string" ? entry.reasoningEffort : null);
            if (!id)
                continue;
            const description = typeof entry?.description === "string" && entry.description.trim().length > 0
                ? entry.description
                : undefined;
            thinkingById.set(id, { id, label: id, description });
        }
    }
    if (resolvedDefaultReasoningEffort && !thinkingById.has(resolvedDefaultReasoningEffort)) {
        thinkingById.set(resolvedDefaultReasoningEffort, {
            id: resolvedDefaultReasoningEffort,
            label: resolvedDefaultReasoningEffort,
            description: configuredDefaultThinkingOptionId === resolvedDefaultReasoningEffort
                ? "Configured default reasoning effort"
                : "Model default reasoning effort",
        });
    }
    return thinkingById;
}
function resolveSkillDescription(skill) {
    if (typeof skill.description === "string") {
        return skill.description;
    }
    if (typeof skill.shortDescription === "string") {
        return skill.shortDescription;
    }
    return "Skill";
}
//# sourceMappingURL=codex-app-server-agent.js.map
