import express from "express";
import { createServer as createHTTPServer } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open } from "fs/promises";
import { randomUUID } from "node:crypto";
import { hostname as getHostname } from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";
import { createCodexConfigRouteHandlers } from "./codex-config.js";
import { createPaseoManagementRouteHandlers } from "./paseo-management.js";
import { startCodexChatProxy, stopCodexChatProxy } from "./codex-chat-proxy.js";
function resolveBoundListenTarget(listenTarget, httpServer) {
    if (listenTarget.type !== "tcp") {
        return listenTarget;
    }
    const address = httpServer.address();
    if (!address || typeof address === "string") {
        throw new Error("HTTP server did not expose a TCP address after listening");
    }
    return {
        type: "tcp",
        host: listenTarget.host,
        port: address.port,
    };
}
// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;
export function parseListenString(listen) {
    // 1. Windows named pipes: \\.\pipe\... or pipe://...
    if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
        return {
            type: "pipe",
            path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
        };
    }
    // 2. Explicit unix:// prefix
    if (listen.startsWith("unix://")) {
        return { type: "socket", path: listen.slice(7) };
    }
    // 3. Reject Windows absolute drive paths — they are not Unix sockets
    if (WINDOWS_DRIVE_RE.test(listen)) {
        throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
    }
    // 4. POSIX absolute path (/ or ~) — Unix socket
    if (listen.startsWith("/") || listen.startsWith("~")) {
        return { type: "socket", path: listen };
    }
    // 5. Pure numeric — TCP port on 127.0.0.1
    const trimmed = listen.trim();
    if (/^\d+$/.test(trimmed)) {
        const port = parseInt(trimmed, 10);
        return { type: "tcp", host: "127.0.0.1", port };
    }
    // 6. host:port — TCP
    if (listen.includes(":")) {
        const lastColonIdx = listen.lastIndexOf(":");
        const host = listen.slice(0, lastColonIdx);
        const portStr = listen.slice(lastColonIdx + 1);
        const parsedPort = parseInt(portStr, 10);
        if (!Number.isFinite(parsedPort)) {
            throw new Error(`Invalid port in listen string: ${listen}`);
        }
        const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
        return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
    }
    throw new Error(`Invalid listen string: ${listen}`);
}
function formatListenTarget(listenTarget) {
    if (!listenTarget) {
        return null;
    }
    if (listenTarget.type === "tcp") {
        return `${listenTarget.host}:${listenTarget.port}`;
    }
    return listenTarget.path;
}
export async function fanOutReconciledWorkspaceUpdates(input) {
    await Promise.all(Array.from(input.sessions, async (session) => {
        try {
            await session.syncWorkspaceGitObserversForExternalWorkspaceIds(input.workspaceIds);
        }
        catch (error) {
            input.logger.warn({ err: error }, "Failed to sync workspace Git observers after reconciliation");
        }
        try {
            await session.emitWorkspaceUpdatesForExternalWorkspaceIds(input.workspaceIds);
        }
        catch (error) {
            input.logger.warn({ err: error }, "Failed to emit workspace updates after reconciliation");
        }
    }));
}
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { createGitHubService } from "../services/github-service.js";
import { createPaseoWorktree as createRegisteredPaseoWorktree } from "./paseo-worktree-service.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createPaseoWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { createPaseoToolCatalog, } from "./agent/tools/paseo-tools.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry, } from "./workspace-registry.js";
import { FileBackedChatService } from "./chat/chat-service.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { LoopService } from "./loop-service.js";
import { ScheduleService } from "./schedule/service.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import { archiveByScope, archivePersistedWorkspaceRecord, killTerminalsForWorkspace, } from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage } from "./messages.js";
import { createConfiguredTerminalManager } from "../terminal/terminal-manager-factory.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createRelayRuntime } from "./relay-runtime.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem } from "./service-proxy.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { createWorkspaceScriptsService } from "./session/workspace-scripts/workspace-scripts-service.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import { createManagedProcessRegistry, createSystemManagedProcessTable, } from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { isHostnameAllowed } from "./hostnames.js";
import { createRequireBearerMiddleware, isAgentMcpRequestAuthorized, } from "./auth.js";
import { createWebUiMiddleware } from "./web-ui.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createGitMutationService } from "./session/git-mutation/git-mutation-service.js";
import { workspaceIdsOnCheckout } from "./workspace-directory.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import { createAgentCommand, } from "./agent/create-agent/create.js";
import { archiveAgentCommand, cancelAgentRunCommand } from "./agent/lifecycle-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import { HubRelationshipController, } from "./hub/relationship-controller.js";
import { DirectHubRelationshipRemote, } from "./hub/relationship-remote.js";
import { DaemonExecutions } from "./hub/daemon-executions.js";
const MAX_MCP_DEBUG_BATCH_ITEMS = 10;
const REDACTED_LOG_VALUE = "[redacted]";
const DOWNLOAD_OPEN_FLAGS = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
function formatHostForHttpUrl(host) {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
function resolveAgentMcpClientHost(host) {
    if (host === "0.0.0.0") {
        return "127.0.0.1";
    }
    if (host === "::" || host === "[::]") {
        return "::1";
    }
    return host;
}
function createAgentMcpBaseUrl(listenTarget) {
    if (!listenTarget || listenTarget.type !== "tcp") {
        return null;
    }
    const host = resolveAgentMcpClientHost(listenTarget.host);
    return new URL("/mcp/agents", `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`).toString();
}
function createTerminalActivityUrl(listenTarget) {
    if (!listenTarget || listenTarget.type !== "tcp") {
        return null;
    }
    const host = resolveAgentMcpClientHost(listenTarget.host);
    return new URL("/api/terminal-activity", `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`).toString();
}
const TerminalActivityReportSchema = z.object({
    terminalId: z.string().min(1),
    token: z.string().min(1),
    state: z.enum(["running", "idle", "needs-input"]),
});
const TERMINAL_ACTIVITY_STATE_MAP = {
    running: "working",
    idle: "idle",
    "needs-input": "attention",
};
const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isLoopbackRemoteAddress(remoteAddress) {
    return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}
export function createTerminalActivityRouteHandler(terminalManager) {
    return async (req, res) => {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        const parsed = TerminalActivityReportSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: "Invalid terminal activity report" });
            return;
        }
        const validation = terminalManager.validateTerminalActivityToken(parsed.data.terminalId, parsed.data.token);
        if (validation !== "valid") {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        try {
            const updated = await terminalManager.setTerminalActivity(parsed.data.terminalId, TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state]);
            if (!updated) {
                res.status(403).json({ error: "Forbidden" });
                return;
            }
            res.status(204).end();
        }
        catch {
            res.status(500).json({ error: "Failed to update terminal activity" });
        }
    };
}
function summarizeAgentMcpDebugMessage(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {
            type: body === null ? "null" : typeof body,
        };
    }
    const record = body;
    const method = typeof record.method === "string" ? record.method : undefined;
    return {
        type: "object",
        ...(typeof record.jsonrpc === "string" ? { jsonrpc: record.jsonrpc } : {}),
        ...(method ? { method } : {}),
        hasId: Object.prototype.hasOwnProperty.call(record, "id"),
        hasParams: Object.prototype.hasOwnProperty.call(record, "params"),
    };
}
function summarizeAgentMcpDebugBody(body) {
    if (!Array.isArray(body)) {
        return summarizeAgentMcpDebugMessage(body);
    }
    const messages = body.slice(0, MAX_MCP_DEBUG_BATCH_ITEMS).map(summarizeAgentMcpDebugMessage);
    return {
        type: "batch",
        count: body.length,
        messages,
        ...(body.length > messages.length ? { omitted: body.length - messages.length } : {}),
    };
}
function createBootstrapManagedProcessRegistry(config, logger) {
    if (config.managedProcesses) {
        return config.managedProcesses;
    }
    return createManagedProcessRegistry({
        paseoHome: config.paseoHome,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger,
    });
}
async function reconcileManagedProcessLedger(managedProcesses, logger) {
    const reapResult = await managedProcesses.reapStale();
    if (reapResult.checked > 0 || reapResult.errors.length > 0) {
        logger.info(reapResult, "Managed helper process ledger reconciled");
    }
}
function mountWebUi(app, config, logger) {
    app.use(createWebUiMiddleware({
        enabled: config.webUi?.enabled ?? false,
        distDir: config.webUi?.distDir ?? null,
        label: getHostname(),
        logger,
    }));
}
function resolveExpressTrustProxySetting(config) {
    return config.trustedProxies ?? ["loopback"];
}
function createInitialMutableDaemonConfig(config) {
    const providers = Object.fromEntries(Object.entries(config.providerOverrides ?? {}).map(([providerId, override]) => {
        const providerConfig = {};
        if (override.enabled !== undefined) {
            providerConfig.enabled = override.enabled;
        }
        if (override.additionalModels) {
            providerConfig.additionalModels = override.additionalModels;
        }
        return [providerId, providerConfig];
    }));
    const initialConfig = {
        relay: { enabled: config.relayEnabled ?? true },
        mcp: { injectIntoAgents: config.mcpInjectIntoAgents ?? true },
        browserTools: { enabled: config.browserToolsEnabled ?? false },
        providers,
        metadataGeneration: {
            providers: config.metadataGeneration?.providers ?? [],
        },
        autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
        enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
        appendSystemPrompt: config.appendSystemPrompt ?? "",
    };
    if (config.terminalProfiles !== undefined) {
        initialConfig.terminalProfiles = config.terminalProfiles;
    }
    return initialConfig;
}
export async function createPaseoDaemon(config, rootLogger, dependencies = {}) {
    configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
    const logger = rootLogger.child({ module: "bootstrap" });
    const bootstrapStart = performance.now();
    const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
    const daemonVersion = config.daemonVersion ?? resolveDaemonVersion(import.meta.url);
    const daemonConfigStore = new DaemonConfigStore(config.paseoHome, createInitialMutableDaemonConfig(config), logger, { relayEnabledMutable: config.relayEnabledMutable ?? true });
    const browserToolsPolicy = new DaemonConfigBrowserToolsPolicy(daemonConfigStore);
    const browserToolsBroker = new BrowserToolsBroker({});
    const serverId = getOrCreateServerId(config.paseoHome, { logger });
    const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
    const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
    // Reconcile the helper-process ledger in the background so it never blocks the
    // daemon from coming up; terminating a live leftover can take a few seconds.
    // Best-effort, so a failure is logged here rather than crashing startup.
    void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
        logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
    });
    let relayRuntime = null;
    const staticDir = config.staticDir;
    const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;
    const downloadTokenStore = new DownloadTokenStore({
        ttlMs: downloadTokenTtlMs,
    });
    // Capability token authenticating the daemon's own agents to the loopback
    // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
    // local agent configs and the daemon's own MCP client — never sent to remote
    // clients — so it cannot be replayed off-box. This lets the injected MCP
    // authenticate even when the daemon password is set via the app (hash only,
    // no plaintext available). Mirrors the /api/files/download capability-token
    // pattern.
    const agentMcpAuthToken = randomUUID();
    const listenTarget = parseListenString(config.listen);
    const app = express();
    app.set("trust proxy", resolveExpressTrustProxySetting(config));
    let boundListenTarget = null;
    let workspaceRegistry = null;
    const terminalManager = createConfiguredTerminalManager({
        getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
    });
    applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });
    const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
        ? config.serviceProxy.publicBaseUrl
        : null;
    const serviceProxy = createServiceProxySubsystem({
        logger,
        publicBaseUrl: serviceProxyPublicBaseUrl,
    });
    const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
    const workspaceSetupRuntime = new WorkspaceSetupRuntime();
    const configuredHostnames = config.hostnames ?? config.allowedHosts;
    let wsServer = null;
    let serviceProxyListenTarget = null;
    const scriptHealthMonitor = new ScriptHealthMonitor({
        serviceProxy,
        onChange: createScriptStatusEmitter({
            sessions: () => wsServer?.listTrustedSessions().map((session) => ({
                emit: (message) => session.emitServerMessage(message),
            })) ?? [],
            serviceProxy,
            runtimeStore: scriptRuntimeStore,
            daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
            resolveWorkspaceDirectory: async (workspaceId) => (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
            logger,
            serviceProxyPublicBaseUrl,
        }),
    });
    const handleBranchChange = createBranchChangeRouteHandler({
        serviceProxy,
        onRoutesChanged: (workspaceId) => {
            scriptHealthMonitor.invalidateWorkspace(workspaceId);
        },
        logger,
    });
    // Service proxy classifies service hosts before daemon auth/route fallthrough.
    // Registered service hosts proxy directly; known service namespaces without a
    // route return 404 and never reach daemon APIs.
    app.use(serviceProxy.middleware());
    // Host allowlist / DNS rebinding protection (vite-like semantics).
    // For non-TCP (unix sockets), skip host validation.
    if (listenTarget.type === "tcp") {
        app.use((req, res, next) => {
            const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
            if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
                res.status(403).json({ error: "Invalid Host header" });
                return;
            }
            next();
        });
    }
    // CORS - allow same-origin + configured origins
    const allowedOrigins = new Set([
        ...config.corsAllowedOrigins,
        // Packaged desktop renderers use the custom paseo:// protocol scheme.
        "paseo://app",
        // For TCP, add localhost variants
        ...(listenTarget.type === "tcp"
            ? [
                `http://${listenTarget.host}:${listenTarget.port}`,
                `http://localhost:${listenTarget.port}`,
                `http://127.0.0.1:${listenTarget.port}`,
            ]
            : []),
    ]);
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
            res.setHeader("Access-Control-Allow-Credentials", "true");
        }
        if (req.method === "OPTIONS") {
            res.status(204).end();
            return;
        }
        next();
    });
    // Local, harmless, and token-gated; deliberately skips daemon auth.
    app.post("/api/terminal-activity", express.json(), createTerminalActivityRouteHandler(terminalManager));
    // Local-only Codex settings used by the bundled WebUI. Never returns the
    // stored API key, only whether one exists and its final four characters.
    const codexConfigRoutes = createCodexConfigRouteHandlers();
    app.get("/api/codex-config", (req, res) => codexConfigRoutes.get(req, res));
    app.post("/api/codex-config", express.json({ limit: "128kb" }), (req, res) => codexConfigRoutes.post(req, res));
    // Local mobile management surface. Runtime services are attached after
    // agent/workspace initialization; static skill/plugin and directory views
    // remain available without touching a running standalone Codex CLI.
    const paseoManagementRoutes = createPaseoManagementRouteHandlers({ logger });
    app.get("/api/paseo-manager", (req, res) => paseoManagementRoutes.get(req, res));
    app.post("/api/paseo-manager", express.json({ limit: "256kb" }), (req, res) => paseoManagementRoutes.post(req, res));
    // Serve the bundled browser web UI when enabled. Mounted after service-proxy
    // classification and host/CORS handling, but before daemon bearer auth, so
    // static app files load without the daemon password while API/WebSocket calls
    // remain protected.
    mountWebUi(app, config, logger);
    app.use(createRequireBearerMiddleware(config.auth, (context) => {
        logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }));
    app.use(express.json());
    // Serve static files from public directory
    app.use("/public", express.static(staticDir));
    // Health check endpoint
    app.get("/api/health", (_req, res) => {
        res.json({ status: "ok", timestamp: new Date().toISOString() });
    });
    app.get("/api/status", (_req, res) => {
        res.json({
            status: "server_info",
            serverId,
            hostname: getHostname(),
            version: daemonVersion,
            listen: formatListenTarget(boundListenTarget ?? listenTarget),
        });
    });
    const handleFileDownload = async (req, res) => {
        const token = typeof req.query.token === "string" && req.query.token.trim().length > 0
            ? req.query.token.trim()
            : null;
        if (!token) {
            res.status(400).json({ error: "Missing download token" });
            return;
        }
        const entry = downloadTokenStore.consumeToken(token);
        if (!entry) {
            res.status(403).json({ error: "Invalid or expired token" });
            return;
        }
        let fileHandle = null;
        try {
            fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
            const fileStats = await fileHandle.stat();
            if (!fileStats.isFile()) {
                res.status(404).json({ error: "File not found" });
                return;
            }
            const safeFileName = entry.fileName.replace(/["\r\n]/g, "_");
            res.setHeader("Content-Type", entry.mimeType);
            res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
            res.setHeader("Content-Length", fileStats.size.toString());
            const stream = fileHandle.createReadStream();
            fileHandle = null;
            stream.on("error", (err) => {
                logger.error({ err }, "Failed to stream download");
                if (!res.headersSent) {
                    res.status(500).json({ error: "Failed to read file" });
                }
                else {
                    res.end();
                }
            });
            stream.pipe(res);
        }
        catch (err) {
            logger.error({ err }, "Failed to download file");
            if (!res.headersSent) {
                res.status(404).json({ error: "File not found" });
            }
        }
        finally {
            await fileHandle?.close().catch(() => undefined);
        }
    };
    app.get("/api/files/download", (req, res) => {
        void handleFileDownload(req, res);
    });
    const httpServer = createHTTPServer(app);
    // Script proxy WebSocket upgrade handler — must be registered before the
    // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
    // script-bound upgrades are forwarded first. The handler is a no-op for
    // requests that don't match a registered script route.
    httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));
    if (config.serviceProxy?.standaloneListen) {
        serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
    }
    const agentStorage = new AgentStorage(config.agentStoragePath, logger);
    const projectRegistry = new FileBackedProjectRegistry(path.join(config.paseoHome, "projects", "projects.json"), logger);
    workspaceRegistry = new FileBackedWorkspaceRegistry(path.join(config.paseoHome, "projects", "workspaces.json"), logger);
    const chatService = new FileBackedChatService({
        paseoHome: config.paseoHome,
        logger,
    });
    const github = createGitHubService();
    const workspaceGitService = new WorkspaceGitServiceImpl({
        logger,
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        deps: {
            forgeOverrides: { github },
        },
    });
    const workspaceProvisioning = createWorkspaceProvisioningService({
        serverId,
        projectRegistry,
        workspaceRegistry,
        workspaceGitService,
        logger,
    });
    const providerSnapshotLogger = logger.child({ module: "provider-snapshot-manager" });
    const providerSnapshotManager = new ProviderSnapshotManager({
        logger: providerSnapshotLogger,
        runtimeSettings: config.agentProviderSettings,
        providerOverrides: config.providerOverrides,
        workspaceGitService,
        managedProcesses,
        isDev: config.isDev === true,
        extraClients: config.agentClients,
    });
    const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
    const agentManager = new AgentManager({
        clients: initialAgentManagerState.clients,
        providerDefinitions: initialAgentManagerState.providerDefinitions,
        registry: agentStorage,
        appendSystemPrompt: config.appendSystemPrompt,
        onWorkspaceStateMayHaveChanged: ({ cwd }) => {
            workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
        },
        mcpAuthToken: agentMcpAuthToken,
        logger,
    });
    const detachAgentStoragePersistence = attachAgentStoragePersistence(logger, agentManager, agentStorage);
    await agentStorage.initialize();
    paseoManagementRoutes.setRuntime({
        serverId,
        logger,
        paseoHome: config.paseoHome,
        daemonConfigStore,
        agentManager,
        agentStorage,
        providerSnapshotManager,
        workspaceProvisioning,
        workspaceRegistry,
    });
    logger.info({ elapsed: elapsed() }, "Agent storage initialized");
    await bootstrapWorkspaceRegistries({
        serverId,
        paseoHome: config.paseoHome,
        agentStorage,
        projectRegistry,
        workspaceRegistry,
        workspaceGitService,
        logger,
    });
    logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
    const teardownArchivedWorkspaceRuntime = (workspaceId) => {
        scriptRuntimeStore.removeForWorkspace(workspaceId);
        releaseWorkspaceServicePortPlan(workspaceId);
    };
    const workspaceReconciliation = new WorkspaceReconciliationService({
        serverId,
        projectRegistry,
        workspaceRegistry,
        logger,
        workspaceGitService,
        onProjectUpdate: (update) => wsServer?.publishProjectUpdate(update),
        onWorkspaceArchived: teardownArchivedWorkspaceRuntime,
        onWorkspacesChanged: async (workspaceIds) => {
            await fanOutReconciledWorkspaceUpdates({
                sessions: wsServer?.listTrustedSessions() ?? [],
                workspaceIds,
                logger,
            });
        },
    });
    await workspaceReconciliation.start();
    void workspaceReconciliation.reconcileNow().catch((error) => {
        logger.warn({ err: error }, "Initial workspace reconciliation failed");
    });
    await chatService.initialize();
    logger.info({ elapsed: elapsed() }, "Chat service initialized");
    const checkoutDiffManager = new CheckoutDiffManager({
        logger,
        paseoHome: config.paseoHome,
        workspaceGitService,
    });
    const archiveWorkspaceRecordExternal = async (workspaceId, context) => {
        const existingWorkspace = await archivePersistedWorkspaceRecord({
            workspaceId,
            workspaceRegistry,
            context,
        });
        if (!existingWorkspace || existingWorkspace.archivedAt)
            return;
        teardownArchivedWorkspaceRuntime(workspaceId);
    };
    // external path→workspace adapter, not ownership: archive-by-path requests that
    // arrive with a worktree path and no workspaceId (old clients / CLI).
    const findWorkspaceIdForCwdExternal = async (cwd) => {
        return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list());
    };
    const ensureWorkspaceForCreateExternal = async (cwd, firstAgentContext) => {
        const workspace = await workspaceProvisioning.createWorkspaceForDirectory(cwd, resolveFirstAgentPromptTitle(firstAgentContext));
        if (firstAgentContext) {
            workspaceAutoName.scheduleForDirectory({
                workspaceId: workspace.workspaceId,
                cwd: workspace.cwd,
                firstAgentContext,
            });
        }
        return workspace.workspaceId;
    };
    const listActiveWorkspacesExternal = async () => {
        const workspaces = await workspaceRegistry.list();
        return workspaces
            .filter((workspace) => !workspace.archivedAt)
            .map((workspace) => ({
            workspaceId: workspace.workspaceId,
            cwd: workspace.cwd,
            kind: workspace.kind,
            worktreeRoot: workspace.worktreeRoot,
            isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
            mainRepoRoot: workspace.mainRepoRoot,
        }));
    };
    const markWorkspaceArchivingExternal = (workspaceIds, archivingAt) => {
        const workspaceIdList = Array.from(workspaceIds);
        for (const session of wsServer?.listTrustedSessions() ?? []) {
            session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
        }
    };
    const clearWorkspaceArchivingExternal = (workspaceIds) => {
        const workspaceIdList = Array.from(workspaceIds);
        for (const session of wsServer?.listTrustedSessions() ?? []) {
            session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
        }
    };
    const emitWorkspaceUpdatesExternal = async (workspaceIds) => {
        const workspaceIdList = Array.from(workspaceIds);
        await Promise.all((wsServer?.listTrustedSessions() ?? []).map((session) => session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList)));
    };
    const ensureWorkspaceForCreateAndBroadcastExternal = async (cwd, firstAgentContext) => {
        const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext);
        await emitWorkspaceUpdatesExternal([workspaceId]);
        return workspaceId;
    };
    const emitWorkspaceUpdateForCwdExternal = async (cwd) => {
        const workspaceIds = workspaceIdsOnCheckout(await workspaceRegistry.list(), cwd);
        await emitWorkspaceUpdatesExternal(workspaceIds);
    };
    const emitExternalSessionMessage = (message) => {
        wsServer?.broadcast(wrapSessionMessage(message));
    };
    const workspaceAutoName = new WorkspaceAutoName({
        agentManager,
        workspaceRegistry,
        workspaceGitService,
        providerSnapshotManager,
        readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
        gitMutation: createGitMutationService({
            workspaceGitService,
            logger,
        }),
        emitWorkspaceUpdateForCwd: emitWorkspaceUpdateForCwdExternal,
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
            await emitWorkspaceUpdatesExternal([workspaceId]);
        },
        logger,
    });
    setupAutoArchiveOnMerge({
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        daemonConfigStore,
        workspaceGitService,
        github,
        agentManager,
        agentStorage,
        terminalManager,
        logger,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getAutoArchivedChangeRequestUrl: async (workspaceId) => (await workspaceRegistry.get(workspaceId))?.autoArchivedChangeRequestUrl ?? null,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    });
    const createPaseoWorktreeForTools = async (input, serviceOptions) => {
        return createPaseoWorktreeWorkflow({
            paseoHome: config.paseoHome,
            worktreesRoot: config.worktreesRoot,
            createPaseoWorktree: async (workflowInput, workflowOptions) => {
                return createRegisteredPaseoWorktree(workflowInput, {
                    github,
                    ...(workflowOptions?.resolveDefaultBranch
                        ? {
                            resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                        }
                        : {}),
                    workspaceGitService,
                    workspaceProvisioning,
                });
            },
            warmWorkspaceGitData: async (workspace) => {
                await Promise.all(wsServer
                    ?.listTrustedSessions()
                    .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? []);
            },
            autoNameWorkspaceBranchForFirstAgent: (autoNameInput) => workspaceAutoName.scheduleForWorktree(autoNameInput),
            emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
                await emitWorkspaceUpdatesExternal([workspaceId]);
            },
            cacheWorkspaceSetupSnapshot: () => { },
            startWorkspaceSetup: (workspaceId, operation) => workspaceSetupRuntime.start(workspaceId, operation),
            emit: emitExternalSessionMessage,
            sessionLogger: logger,
            terminalManager,
            archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
            serviceProxy,
            scriptRuntimeStore,
            getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
            getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
            serviceProxyPublicBaseUrl,
            onScriptsChanged: null,
        }, input, serviceOptions);
    };
    const createAgentCommandDependencies = {
        agentManager,
        agentStorage,
        logger,
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        terminalManager,
        providerSnapshotManager,
        createPaseoWorktree: createPaseoWorktreeForTools,
        ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
    };
    const createAgent = (input) => createAgentCommand(createAgentCommandDependencies, input);
    const archiveWorkspaceByIdExternal = (workspaceId, requestId) => archiveByScope({
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) => killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceIdToKill),
        stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
        sessionLogger: logger,
    }, { scope: { kind: "workspace", workspaceId }, requestId });
    const hubAgentLifecycle = new CreateAgentLifecycleDispatch({
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        agentManager,
        agentStorage,
        github,
        workspaceGitService,
        createPaseoWorktreeWorkflow: createPaseoWorktreeForTools,
        archiveAgentForClose: (agentId) => archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emit: emitExternalSessionMessage,
        emitAgentRemove: async () => undefined,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceId) => killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceId),
        logger,
    });
    const hubRelationships = new HubRelationshipController({
        paseoHome: config.paseoHome,
        serverId,
        daemonPublicKey: daemonKeyPair.publicKeyB64,
        logger,
        remote: dependencies.hubRelationshipRemote ?? new DirectHubRelationshipRemote(),
        clock: dependencies.hubRelationshipClock,
        retryPolicy: dependencies.hubRelationshipRetryPolicy,
        createDaemonId: dependencies.createHubDaemonId,
        attachSocket: async (socket, options) => {
            if (!wsServer)
                throw new Error("WebSocket server is not running");
            await wsServer.attachHubSocket(socket, options);
        },
        createExecutionAgents: (daemonId) => new DaemonExecutions({
            daemonId,
            agentManager,
            agentStorage,
            createAgent,
            interruptAgent: (agentId) => cancelAgentRunCommand({ agentManager, logger }, agentId),
            archiveWorkspace: archiveWorkspaceByIdExternal,
            cleanupFailedCreate: (input) => hubAgentLifecycle.cleanupCreatedWorktreeAfterFailedAgentCreate(input),
        }),
    });
    const loopService = new LoopService({
        paseoHome: config.paseoHome,
        logger,
        agentManager,
        createAgent,
        ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
    });
    await loopService.initialize();
    logger.info({ elapsed: elapsed() }, "Loop service initialized");
    const createScheduleLocalWorkspaceExternal = async (input) => {
        const workspace = await workspaceProvisioning.createWorkspaceForDirectory(input.cwd, resolveFirstAgentPromptTitle(input.firstAgentContext));
        workspaceAutoName.scheduleForDirectory({
            workspaceId: workspace.workspaceId,
            cwd: workspace.cwd,
            firstAgentContext: input.firstAgentContext,
        });
        await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
        return workspace;
    };
    const createSchedulePaseoWorktreeExternal = async (input) => {
        const result = await createPaseoWorktreeForTools({
            cwd: input.cwd,
            firstAgentContext: input.firstAgentContext,
        });
        await emitWorkspaceUpdatesExternal([result.workspace.workspaceId]);
        return result;
    };
    const archiveScheduleWorkspaceExternal = async (workspaceId) => {
        await archiveByScope({
            paseoHome: config.paseoHome,
            paseoWorktreesBaseRoot: config.worktreesRoot,
            github,
            workspaceGitService,
            agentManager,
            agentStorage,
            findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
            listActiveWorkspaces: listActiveWorkspacesExternal,
            getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
            archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
            emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
            markWorkspaceArchiving: markWorkspaceArchivingExternal,
            clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
            killTerminalsForWorkspace: (workspaceIdToKill) => killTerminalsForWorkspace({
                terminalManager,
                sessionLogger: logger,
            }, workspaceIdToKill),
            stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
            sessionLogger: logger,
        }, {
            scope: { kind: "workspace", workspaceId },
            requestId: "schedule-run-finish",
        });
    };
    const scheduleService = new ScheduleService({
        paseoHome: config.paseoHome,
        logger,
        agentManager,
        agentStorage,
        createAgent,
        createDirectoryWorkspace: createScheduleLocalWorkspaceExternal,
        createPaseoWorktreeWorkspace: createSchedulePaseoWorktreeExternal,
        archiveWorkspace: archiveScheduleWorkspaceExternal,
    });
    await scheduleService.start();
    agentManager.setAgentArchivedCallback(async (agentId) => {
        try {
            await scheduleService.completeForAgent(agentId);
        }
        catch (error) {
            logger.warn({ err: error, agentId }, "Failed to complete schedules for archived agent");
        }
    });
    logger.info({ elapsed: elapsed() }, "Schedule service initialized");
    logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
    const persistedRecords = await agentStorage.list();
    logger.info({ elapsed: elapsed() }, `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`);
    logger.info("Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)");
    logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");
    const createAgentToolHostDependencies = (runtime) => ({
        agentManager,
        agentStorage,
        terminalManager,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        scheduleService,
        providerSnapshotManager,
        github,
        workspaceGitService,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        workspaceRegistry,
        projectRegistry,
        createDirectoryWorkspace: async (cwd, title, projectId) => {
            const workspace = await workspaceProvisioning.createWorkspaceForDirectory(cwd, title, projectId);
            await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
            return workspace;
        },
        workspaceScripts: createWorkspaceScriptsService({
            serviceProxy,
            scriptRuntimeStore,
            terminalManager,
            workspaceRegistry,
            projectRegistry,
            workspaceGitService,
            getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
            getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
            serviceProxyPublicBaseUrl,
            resolveScriptHealth: (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
            logger,
            // MCP operations do not belong to one WebSocket session, so lifecycle
            // status updates fan out to every connected client.
            emit: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
            spawnWorkspaceScript,
            globalServicePorts: loadPersistedConfig(config.paseoHome).worktrees?.servicePorts,
        }),
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
        createPaseoWorktree: createAgentCommandDependencies.createPaseoWorktree,
        browserToolsEnabled: browserToolsPolicy.isEnabled(),
        browserToolsBroker,
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        callerAgentId: runtime.callerAgentId,
        enableVoiceTools: runtime.enableVoiceTools,
        voiceOnly: runtime.voiceOnly,
        resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
        resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
        logger,
    });
    const createAgentToolCatalog = (runtime) => createPaseoToolCatalog(createAgentToolHostDependencies(runtime));
    agentManager.setPaseoToolCatalogFactory(createAgentToolCatalog);
    agentManager.setPaseoToolsEnabled(config.mcpInjectIntoAgents !== false);
    const mcpEnabled = config.mcpEnabled ?? true;
    let agentMcpBaseUrl = null;
    if (mcpEnabled) {
        const agentMcpRoute = "/mcp/agents";
        const createAgentMcpSession = async (callerAgentId) => {
            const agentMcpServer = await createAgentMcpServer(createAgentToolHostDependencies({ callerAgentId }));
            // Stateless mode: each HTTP request builds a fresh server + transport that is
            // torn down when the response closes, so no per-session state is retained between
            // requests. The agent control plane only lists and calls tools, neither of which
            // needs cross-request state, so sessions would only pin memory for the life of the
            // daemon (agents that exit without a clean DELETE never get reaped).
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
                // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
                enableDnsRebindingProtection: false,
            });
            Object.assign(transport, {
                onerror: (err) => {
                    logger.error({ err }, "Agent MCP transport error");
                },
            });
            await agentMcpServer.connect(transport);
            return { server: agentMcpServer, transport };
        };
        const runAgentMcpRequest = async (req, res) => {
            // This route is exempt from the global daemon-password middleware, so it
            // authenticates here using the injected capability token (or a valid
            // daemon password). Without this, a password-protected daemon would be
            // wide open on its agent control plane.
            if (!(await isAgentMcpRequestAuthorized({
                password: config.auth?.password,
                capabilityToken: agentMcpAuthToken,
                authorizationHeader: req.header("authorization"),
            }))) {
                res.status(401).json({ error: "Unauthorized" });
                return;
            }
            if (config.mcpDebug) {
                logger.debug({
                    method: req.method,
                    url: req.originalUrl,
                    sessionId: req.header("mcp-session-id"),
                    authorization: req.header("authorization") ? REDACTED_LOG_VALUE : undefined,
                    body: summarizeAgentMcpDebugBody(req.body),
                }, "Agent MCP request");
            }
            try {
                // Stateless: GET (standalone SSE) and DELETE (session termination) have no
                // meaning without sessions. The MCP client tolerates 405 on the GET stream
                // and never issues a DELETE because it is never handed a session id.
                if (req.method !== "POST") {
                    res.status(405).json({
                        jsonrpc: "2.0",
                        error: {
                            code: -32000,
                            message: "Method not allowed",
                        },
                        id: null,
                    });
                    return;
                }
                const callerAgentIdRaw = req.query.callerAgentId;
                let callerAgentId;
                if (typeof callerAgentIdRaw === "string") {
                    callerAgentId = callerAgentIdRaw;
                }
                else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
                    callerAgentId = callerAgentIdRaw[0];
                }
                const { server, transport } = await createAgentMcpSession(callerAgentId);
                res.on("close", () => {
                    void transport.close();
                    void server.close();
                });
                await transport.handleRequest(req, res, req.body);
            }
            catch (err) {
                logger.error({ err }, "Failed to handle Agent MCP request");
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: "2.0",
                        error: {
                            code: -32603,
                            message: "Internal MCP server error",
                        },
                        id: null,
                    });
                }
            }
        };
        const handleAgentMcpRequest = (req, res) => {
            void runAgentMcpRequest(req, res);
        };
        app.post(agentMcpRoute, handleAgentMcpRequest);
        app.get(agentMcpRoute, handleAgentMcpRequest);
        app.delete(agentMcpRoute, handleAgentMcpRequest);
        logger.info({ route: agentMcpRoute }, "Agent MCP server mounted on main app");
    }
    else {
        logger.info("Agent MCP HTTP endpoint disabled");
    }
    const speechService = createSpeechService({
        logger,
        openaiConfig: config.openai,
        speechConfig: config.speech,
    });
    logger.info({ elapsed: elapsed() }, "Speech service created");
    logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");
    const start = async () => {
        let mainStarted = false;
        try {
            await startCodexChatProxy(logger);
            if (serviceProxyListenTarget) {
                const boundServiceProxyTarget = await serviceProxy.startStandalone({
                    listenTarget: serviceProxyListenTarget,
                });
                serviceProxyListenTarget = boundServiceProxyTarget;
                logger.info({
                    listen: formatListenTarget(serviceProxyListenTarget),
                    publicBaseUrl: serviceProxyPublicBaseUrl,
                    elapsed: elapsed(),
                }, "Service proxy listening");
            }
            // Start main HTTP server
            await new Promise((resolve, reject) => {
                const onError = (err) => {
                    httpServer.off("listening", onListening);
                    reject(err);
                };
                const onListening = () => {
                    httpServer.off("error", onError);
                    mainStarted = true;
                    const logAndResolve = async () => {
                        boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
                        const mcpBaseUrl = mcpEnabled ? createAgentMcpBaseUrl(boundListenTarget) : null;
                        agentMcpBaseUrl = config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
                        agentManager.setMcpBaseUrl(agentMcpBaseUrl);
                        agentManager.setPaseoToolsEnabled(config.mcpInjectIntoAgents !== false);
                        daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
                            agentManager.setMcpBaseUrl(value ? mcpBaseUrl : null);
                            agentManager.setPaseoToolsEnabled(value !== false);
                        });
                        daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
                            agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
                        });
                        const relayEnabled = config.relayEnabled ?? true;
                        const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
                        const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
                        const relayUseTls = config.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
                        const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
                        if (boundListenTarget.type === "tcp") {
                            logger.info({
                                host: boundListenTarget.host,
                                port: boundListenTarget.port,
                                authRequired: !!config.auth?.password,
                                elapsed: elapsed(),
                            }, `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`);
                        }
                        else {
                            logger.info({
                                path: boundListenTarget.path,
                                authRequired: !!config.auth?.password,
                                elapsed: elapsed(),
                            }, `Server listening on ${boundListenTarget.path}`);
                        }
                        if (config.auth?.password) {
                            logger.info("Daemon password authentication enabled");
                        }
                        wsServer = new VoiceAssistantWebSocketServer(httpServer, logger, serverId, agentManager, agentStorage, downloadTokenStore, config.paseoHome, daemonConfigStore, mcpBaseUrl, {
                            allowedOrigins,
                            hostnames: configuredHostnames,
                            daemonStatusRpc: dependencies.serverFeatureOverrides?.daemonStatusRpc,
                            relayConfig: dependencies.serverFeatureOverrides?.relayConfig,
                        }, workspaceAutoName, config.auth, speechService, terminalManager, {
                            finalTimeoutMs: config.dictationFinalTimeoutMs,
                        }, daemonVersion, (intent) => {
                            try {
                                config.onLifecycleIntent?.(intent);
                            }
                            catch (error) {
                                logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                            }
                        }, projectRegistry, workspaceRegistry, chatService, loopService, scheduleService, checkoutDiffManager, serviceProxy, scriptRuntimeStore, handleBranchChange, () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null), () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null), (hostname) => scriptHealthMonitor.getHealthForHostname(hostname), workspaceGitService, github, config.pushNotificationSender, providerSnapshotManager, {
                            listen: formatListenTarget(boundListenTarget ?? listenTarget),
                            worktreesRoot: config.worktreesRoot,
                            appBaseUrl: config.appBaseUrl,
                            desktopManaged: config.desktopManaged === true,
                            getRelayConfig: () => relayRuntime?.getConfig() ?? {
                                enabled: daemonConfigStore.get().relay?.enabled ?? relayEnabled,
                                endpoint: relayEndpoint,
                                publicEndpoint: relayPublicEndpoint,
                                useTls: relayUseTls,
                                publicUseTls: relayPublicUseTls,
                            },
                        }, serviceProxyPublicBaseUrl, browserToolsBroker, hubRelationships, workspaceSetupRuntime);
                        relayRuntime = createRelayRuntime({
                            config: {
                                enabled: relayEnabled,
                                endpoint: relayEndpoint,
                                publicEndpoint: relayPublicEndpoint,
                                useTls: relayUseTls,
                                publicUseTls: relayPublicUseTls,
                            },
                            logger,
                            attachSocket: async (ws, metadata) => {
                                if (!wsServer)
                                    throw new Error("WebSocket server is not ready");
                                await wsServer.attachExternalSocket(ws, metadata);
                            },
                            serverId,
                            daemonKeyPair: daemonKeyPair.keyPair,
                        });
                        daemonConfigStore.onFieldChange("relay.enabled", (value) => {
                            relayRuntime?.setEnabled(value === true);
                        });
                        await hubRelationships.start();
                    };
                    logAndResolve().then(resolve, reject);
                };
                httpServer.once("error", onError);
                httpServer.once("listening", onListening);
                if (listenTarget.type === "tcp") {
                    httpServer.listen(listenTarget.port, listenTarget.host);
                }
                else {
                    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
                        unlinkSync(listenTarget.path);
                    }
                    httpServer.listen(listenTarget.path);
                }
            });
            // Start speech service after listening so synchronous Sherpa native
            // model loading doesn't block the server from accepting connections.
            speechService.start();
            scriptHealthMonitor.start();
        }
        catch (error) {
            await stopCodexChatProxy().catch(() => undefined);
            await serviceProxy.stopStandalone().catch(() => undefined);
            if (mainStarted) {
                httpServer.closeAllConnections();
                await new Promise((resolve) => httpServer.close(() => resolve()));
            }
            throw error;
        }
    };
    const stop = async () => {
        await hubRelationships.stop();
        workspaceReconciliation.dispose();
        scriptHealthMonitor.stop();
        // Freeze both ingress and registration before taking the agent closure snapshot.
        wsServer?.prepareForShutdown();
        agentManager.prepareForShutdown();
        await closeAllAgents(logger, agentManager);
        await agentManager.flushForShutdown().catch(() => undefined);
        detachAgentStoragePersistence();
        await agentStorage.flush().catch(() => undefined);
        await providerSnapshotManager.shutdown();
        await stopCodexChatProxy().catch(() => undefined);
        terminalManager.killAll();
        speechService.stop();
        await scheduleService.stop().catch(() => undefined);
        await relayRuntime?.stop().catch(() => undefined);
        if (wsServer) {
            await wsServer.close();
        }
        await serviceProxy.stopStandalone();
        // Force-drop remaining sockets so httpServer.close() resolves promptly.
        // We've already closed wsServer (which sent ws-layer close frames) and
        // stopped every other service, so anything still attached is a TCP
        // socket whose higher-level shutdown hasn't fully released it (e.g.
        // upgraded WS sockets in the closing handshake, or HTTP keep-alive
        // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
        // upgraded sockets, so we use closeAllConnections() here.
        httpServer.closeAllConnections();
        await new Promise((resolve) => {
            httpServer.close(() => resolve());
        });
        // Clean up socket files
        if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
        }
    };
    return {
        config,
        agentManager,
        agentStorage,
        terminalManager,
        serviceProxy,
        scriptRuntimeStore,
        browserToolsBroker,
        start,
        stop,
        getListenTarget: () => boundListenTarget,
    };
}
async function closeAllAgents(logger, agentManager) {
    const agents = agentManager.listAgents();
    await Promise.all(agents.map(async (agent) => {
        try {
            await agentManager.closeAgent(agent.id);
        }
        catch (err) {
            logger.error({ err, agentId: agent.id }, "Failed to close agent");
        }
    }));
}
//# sourceMappingURL=bootstrap.js.map
