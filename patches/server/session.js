import equal from "fast-deep-equal";
import { v4 as uuidv4 } from "uuid";
import { lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, resolve, sep } from "path";
import { homedir } from "node:os";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { serializeAgentStreamEvent, } from "./messages.js";
import { TerminalSessionController } from "../terminal/terminal-session-controller.js";
import { CursorError } from "./pagination/cursor.js";
import { SortablePager } from "./pagination/sortable-pager.js";
import { describeAgentHistoryMatches, rankAgentHistoryCandidates } from "./agent-history-search.js";
import { buildConfigOverrides, isStoredAgentProviderAvailable, toAgentPersistenceHandle, } from "./persistence-hooks.js";
import { ensureAgentLoaded, ensureUnarchivedAgentLoaded } from "./agent/agent-loading.js";
import { formatSystemNotificationPrompt, sendPromptToAgent, waitForAgentRunStartWithTimeout, unarchiveAgentState, } from "./agent/agent-prompt.js";
import { resolveCreateAgentTitles, resolveFirstAgentPromptTitle, } from "./agent/create-agent-title.js";
import { respondToAgentPermission } from "./agent/permission-response.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import { createWorkspaceScriptsService, } from "./session/workspace-scripts/workspace-scripts-service.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { getErrorMessage, getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import { getAgentStatusPriority } from "@getpaseo/protocol/agent-state-bucket";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { CLIENT_SHUTDOWN_RPC_REASON, normalizeClientRestartRpcReason, } from "./lifecycle-reasons.js";
import { AgentRunCancellationError } from "./agent/agent-manager.js";
import { buildTimelinePromptIndex } from "./agent/timeline-prompt-index.js";
import { createAgentCommand } from "./agent/create-agent/create.js";
import { resolveCreateAgentIntent } from "./agent/create-agent/intent.js";
import { archiveAgentCommand, cancelAgentRunCommand, closeAgentCommand, detachAgentCommand, setAgentModeCommand, updateAgentCommand, } from "./agent/lifecycle-command.js";
import { buildStoredAgentPayload, resolveStoredAgentPayloadUpdatedAt, toAgentPayload, } from "./agent/agent-projections.js";
import { appendTimelineItemIfAgentKnown, emitLiveTimelineItemIfAgentKnown, } from "./agent/timeline-append.js";
import { projectTimelineRows, selectProjectedTimelinePage, } from "./agent/timeline-projection.js";
import { buildAgentForkContextAttachment } from "./agent/activity-curator.js";
import { buildAgentPrompt } from "./agent/prompt-attachments.js";
import { getAgentStreamEventTurnId, } from "./agent/agent-sdk-types.js";
import { ImportSessionsRequestError, importProviderSession, listImportableProviderSessions, normalizeImportAgentRequest, } from "./agent/import-sessions.js";
import { checkoutLiteFromGitSnapshot, checkoutFromPersistedWorkspacePlacement, deriveWorkspaceDisplayName, } from "./workspace-registry-model.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import { resolveProjectDisplayName, resolveWorkspaceDisplayName, resolveWorkspaceName, } from "./workspace-registry.js";
import { wrapSpokenInput } from "./voice-config.js";
import { isVoicePermissionAllowed } from "./voice-permission-policy.js";
import { readProjectIcon, removeProjectCustomIcon, setProjectCustomIcon, } from "../utils/project-custom-icon.js";
import { VoiceSession } from "./session/voice/voice-session.js";
import { CheckoutSession } from "./session/checkout/checkout-session.js";
import { createWorkspaceGitObserverService, } from "./session/workspace-git-observer/workspace-git-observer-service.js";
import { createAgentStructuredTextGeneration, createGitMetadataGenerator, } from "./session/checkout/git-metadata-generator.js";
import { ChatScheduleLoopSession } from "./session/chat/chat-schedule-loop-session.js";
import { ProviderCatalogSession } from "./session/provider/provider-catalog-session.js";
import { WorkspaceFilesSession } from "./session/files/workspace-files-session.js";
import { AgentConfigSession } from "./session/agent-config/agent-config-session.js";
import { ProjectConfigSession } from "./session/project-config/project-config-session.js";
import { DaemonSession } from "./session/daemon/daemon-session.js";
import { HubExecutionController } from "./hub/execution-controller.js";
import { archivePersistedWorkspaceRecord, archiveWorkspaceContents, } from "./workspace-archive-service.js";
import { renameCurrentBranch as renameCurrentBranchDefault } from "../utils/checkout-git.js";
import { createGitMutationService, } from "./session/git-mutation/git-mutation-service.js";
import { createWorkspaceProvisioningService, WorkspaceProvisioningError, } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createWorkspaceRecoveryService, } from "./session/workspace-recovery/workspace-recovery-service.js";
import { createAgentUpdatesService, matchesAgentUpdatesFilter, } from "./session/agent-updates/agent-updates-service.js";
import { expandTilde } from "../utils/path.js";
import { searchDirectoryEntries, WORKSPACE_SEARCH_HIDDEN_DIRECTORIES, } from "../utils/directory-suggestions.js";
import { createGitHubService, GitHubAuthenticationError, GitHubCliMissingError, GitHubCommandError, } from "../services/github-service.js";
import { summarizeFetchWorkspacesEntries, workspaceIdsOnCheckout, WorkspaceDirectory, } from "./workspace-directory.js";
import { shouldEmitPendingBootstrapUpdate } from "./workspace-bootstrap-dedupe.js";
import { createPaseoWorktree, } from "./paseo-worktree-service.js";
import { buildAgentSessionConfig as buildWorktreeAgentSessionConfig, createPaseoWorktreeWorkflow as createWorktreeWorkflow, handleCreatePaseoWorktreeRequest as handleCreateWorktreeRequest, handlePaseoWorktreeArchiveRequest as handleWorktreeArchiveRequest, handlePaseoWorktreeListRequest as handleWorktreeListRequest, handleWorkspaceSetupStatusRequest as handleWorkspaceSetupStatusRequestMessage, } from "./worktree-session.js";
import { archiveByScope } from "./workspace-archive-service.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
function resolveWorkspaceSetupRuntime(runtime) {
    return runtime ?? new WorkspaceSetupRuntime();
}
import { WorktreeRequestError, toWorktreeWireError } from "./worktree-errors.js";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { createProjectDirectory, ProjectDirectoryRequestError, } from "./project-directory-service.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import { resolveWorktreeSourceCwd } from "./workspace-source.js";
// TODO: Remove once all app store clients are on >=0.1.45 and understand arbitrary provider strings.
// Clients before 0.1.45 validate providers with z.enum(["claude", "codex", "opencode"]) and reject
// the entire session message if they encounter an unknown provider.
const LEGACY_PROVIDER_IDS = new Set(["claude", "codex", "opencode"]);
const MIN_VERSION_ALL_PROVIDERS = "0.1.45";
const MIN_VERSION_EXPLICIT_WORKSPACE_RECOVERY = "0.1.105";
function errorToFriendlyMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === "string")
        return error;
    return "Unknown error";
}
function resolveSubscriptionId(subscribe, requestedSubscriptionId) {
    if (!subscribe)
        return null;
    if (requestedSubscriptionId && requestedSubscriptionId.length > 0) {
        return requestedSubscriptionId;
    }
    return uuidv4();
}
function isAppVersionAtLeast(appVersion, minVersion) {
    if (!appVersion)
        return false;
    // Strip prerelease suffix: "0.1.45-beta.4" -> "0.1.45"
    const base = appVersion.replace(/-.*$/, "");
    const parts = base.split(".").map(Number);
    const minParts = minVersion.split(".").map(Number);
    for (let i = 0; i < minParts.length; i++) {
        const a = parts[i] ?? 0;
        const b = minParts[i] ?? 0;
        if (a > b)
            return true;
        if (a < b)
            return false;
    }
    return true;
}
function clientSupportsAllProviders(appVersion) {
    return isAppVersionAtLeast(appVersion, MIN_VERSION_ALL_PROVIDERS);
}
function clientUsesLegacyWorkspaceRestore(appVersion) {
    return (appVersion !== null && !isAppVersionAtLeast(appVersion, MIN_VERSION_EXPLICIT_WORKSPACE_RECOVERY));
}
function beginAgentDeleteIfSupported(agentStorage, agentId) {
    if ("beginDelete" in agentStorage && typeof agentStorage.beginDelete === "function") {
        agentStorage.beginDelete(agentId);
    }
}
const FETCH_AGENTS_SORT_KEYS = ["status_priority", "created_at", "updated_at", "title"];
export function resolveWaitForFinishError(options) {
    if (options.status !== "error") {
        return null;
    }
    const message = options.final?.lastError;
    return typeof message === "string" && message.trim().length > 0 ? message : "Agent failed";
}
/**
 * Only history carries a query. The active-agents directory filters on
 * structure and never ranks, so it always reads as no query at all.
 */
function agentDirectorySearchQuery(request) {
    if (request.type !== "fetch_agent_history_request")
        return "";
    return request.search?.trim() ?? "";
}
class SessionRequestError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "SessionRequestError";
    }
}
const nodeSessionFileSystem = {
    async isDirectory(path) {
        const stats = await stat(path).catch(() => null);
        return stats?.isDirectory() ?? false;
    },
};
function parseClientCapabilities(capabilities) {
    if (!capabilities) {
        return new Set();
    }
    const known = new Set(Object.values(CLIENT_CAPS));
    const result = [];
    for (const [key, value] of Object.entries(capabilities)) {
        if (value === true && known.has(key)) {
            result.push(key);
        }
    }
    return new Set(result);
}
export function isSessionRpcAllowed(scopes, rpcName) {
    return scopes.some((scope) => {
        if (scope === "*" || scope === rpcName) {
            return true;
        }
        if (!scope.endsWith(".*")) {
            return false;
        }
        return rpcName.startsWith(scope.slice(0, -1));
    });
}
function sessionRequestId(message) {
    if ("requestId" in message && typeof message.requestId === "string") {
        return message.requestId;
    }
    if ("payload" in message &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        "requestId" in message.payload &&
        typeof message.payload.requestId === "string") {
        return message.payload.requestId;
    }
    return null;
}
function describeRegistryTransition(record) {
    if (!record) {
        return "created";
    }
    return record.archivedAt ? "unarchived" : "existing";
}
/**
 * Session represents a single connected client session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
export class Session {
    constructor(options) {
        this.unsubscribeAgentEvents = null;
        this.unsubscribeProjectMutations = null;
        this.unsubscribeWorkspaceMutations = null;
        this.registryMutationQueue = Promise.resolve();
        this.isCleanedUp = false;
        this.viewedTimelineAgentIds = new Set();
        this.viewedTimelineAgentIdsBySource = new Map();
        this.clientCapabilitiesBySource = new Map();
        this.defaultTimelineSubscriptionSource = {};
        this.unsubscribeTerminalWorkspaceContributionEvents = null;
        this.workspaceUpdatesSubscription = null;
        this.workspaceUpdateTails = new Map();
        this.clientActivity = null;
        this.inflightRequests = 0;
        this.peakInflightRequests = 0;
        this.agentsPager = new SortablePager({
            validKeys: FETCH_AGENTS_SORT_KEYS,
            defaultSort: [{ key: "updated_at", direction: "desc" }],
            label: "fetch_agents",
            getId: (agent) => agent.id,
            getSortValue: (agent, key) => {
                switch (key) {
                    case "status_priority":
                        return getAgentStatusPriority({
                            status: agent.status,
                            pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
                            requiresAttention: agent.requiresAttention,
                            attentionReason: agent.attentionReason ?? null,
                        });
                    case "created_at":
                        return Date.parse(agent.createdAt);
                    case "updated_at":
                        return Date.parse(agent.updatedAt);
                    case "title":
                        return agent.title?.toLocaleLowerCase() ?? "";
                }
            },
        });
        const { clientId, scopes, appVersion, clientCapabilities, onMessage, onMessageToSource, onBinaryMessage, onBinaryMessageToSource, getTransportBufferedAmount, onLifecycleIntent, onWorkspaceRecovered, logger, downloadTokenStore, pushTokenStore, paseoHome, worktreesRoot, agentManager, agentStorage, projectRegistry, workspaceRegistry, filesystem, chatService, scheduleService, loopService, checkoutDiffManager, github, renameCurrentBranch, workspaceGitService, workspaceAutoName, daemonConfigStore, stt, sttLanguage, tts, terminalManager, providerSnapshotManager, providerUsageService, serviceProxy, scriptRuntimeStore, workspaceSetupSnapshots, workspaceSetupRuntime, onBranchChanged, getDaemonTcpPort, getDaemonTcpHost, serviceProxyPublicBaseUrl, resolveScriptHealth, voice, voiceBridge, dictation, serverId, daemonVersion, daemonRuntimeConfig, getWebSocketRuntimeMetrics, } = options;
        this.clientId = clientId;
        this.scopes = [...scopes];
        this.appVersion = appVersion ?? null;
        this.clientCapabilities = parseClientCapabilities(clientCapabilities);
        this.sessionId = uuidv4();
        this.onMessage = onMessage;
        this.onMessageToSource = onMessageToSource ?? null;
        this.onBinaryMessage = onBinaryMessage ?? null;
        this.onBinaryMessageToSource = onBinaryMessageToSource ?? null;
        this.getTransportBufferedAmount = getTransportBufferedAmount ?? (() => 0);
        this.onLifecycleIntent = onLifecycleIntent ?? null;
        this.onWorkspaceRecovered = onWorkspaceRecovered ?? null;
        this.pushTokenStore = pushTokenStore;
        this.paseoHome = paseoHome;
        this.worktreesRoot = worktreesRoot;
        this.sessionLogger = logger.child({
            module: "session",
            clientId: this.clientId,
            sessionId: this.sessionId,
        });
        this.workspaceFilesSession = new WorkspaceFilesSession({
            host: {
                emit: (msg, source) => this.emitForSource(msg, source),
                emitBinary: (frame, source) => this.emitBinaryForFileTransfer(frame, source),
                hasBinaryChannel: () => this.onBinaryMessage !== null,
            },
            downloadTokenStore,
            paseoHome,
            logger: this.sessionLogger,
        });
        this.agentManager = agentManager;
        this.agentStorage = agentStorage;
        this.projectRegistry = projectRegistry;
        this.workspaceRegistry = workspaceRegistry;
        this.filesystem = filesystem ?? nodeSessionFileSystem;
        this.github = github ?? createGitHubService();
        this.renameCurrentBranch = renameCurrentBranch ?? renameCurrentBranchDefault;
        this.workspaceGitService = workspaceGitService;
        this.gitMutation = createGitMutationService({
            workspaceGitService: this.workspaceGitService,
            logger: this.sessionLogger,
        });
        this.workspaceAutoName = workspaceAutoName;
        this.workspaceProvisioning = createWorkspaceProvisioningService({
            serverId,
            workspaceRegistry: this.workspaceRegistry,
            projectRegistry: this.projectRegistry,
            workspaceGitService: this.workspaceGitService,
            logger: this.sessionLogger,
        });
        this.workspaceRecovery = createWorkspaceRecoveryService({
            paseoHome: this.paseoHome,
            worktreesRoot: this.worktreesRoot,
            getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
            getProject: (projectId) => this.projectRegistry.get(projectId),
            isDirectory: (path) => this.filesystem.isDirectory(path),
            unarchiveWorkspace: async (workspace) => {
                await this.workspaceProvisioning.ensureWorkspaceRecordUnarchived(workspace);
            },
        });
        this.checkoutSession = new CheckoutSession({
            host: {
                emit: (msg) => this.emit(msg),
                emitWorkspaceUpdateForCwd: (cwd) => this.emitWorkspaceUpdateForCwd(cwd),
                handleWorkspaceGitBranchSnapshot: (cwd, branchName) => this.workspaceGitObserver.handleBranchSnapshot(cwd, branchName),
                renameCurrentBranch: (cwd, branch) => this.renameCurrentBranch(cwd, branch),
            },
            gitMutation: this.gitMutation,
            workspaceGitService: this.workspaceGitService,
            github: this.github,
            checkoutDiffManager,
            gitMetadataGenerator: createGitMetadataGenerator({
                workspaceGitService: this.workspaceGitService,
                generation: createAgentStructuredTextGeneration({
                    agentManager: this.agentManager,
                    providerSnapshotManager,
                    readDaemonConfig: () => this.readStructuredGenerationDaemonConfig(),
                    getFocusedSelection: (cwd) => this.getFocusedAgentSelectionForCwd(cwd),
                }),
            }),
            paseoHome: this.paseoHome,
            worktreesRoot: this.worktreesRoot,
            logger: this.sessionLogger,
        });
        this.workspaceGitObserver = createWorkspaceGitObserverService({
            workspaceGitService: this.workspaceGitService,
            describeWorkspaceRecordWithGitData: (workspace) => this.describeWorkspaceRecordWithGitData(workspace),
            emitWorkspaceUpdateForCwd: (cwd) => this.emitWorkspaceUpdateForCwd(cwd),
            emitWorkspaceUpdateForWorkspaceId: (workspaceId) => this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
            emitStatusUpdate: (cwd, snapshot) => this.checkoutSession.emitStatusUpdate(cwd, snapshot),
            onBranchChanged,
            logger: this.sessionLogger,
        });
        this.chatScheduleLoopSession = new ChatScheduleLoopSession({
            host: {
                emit: (msg) => this.emit(msg),
                listStoredAgents: () => this.agentStorage.list(),
                listLiveAgents: () => this.agentManager.listAgents(),
                resolveAgentIdentifier: (identifier) => this.resolveAgentIdentifier(identifier),
                sendAgentMessage: async (agentId, text) => {
                    await sendPromptToAgent({
                        agentManager: this.agentManager,
                        agentStorage: this.agentStorage,
                        agentId,
                        prompt: formatSystemNotificationPrompt(text),
                        unarchive: false,
                        logger: this.sessionLogger,
                    });
                },
            },
            chatService,
            scheduleService,
            loopService,
            clientId: this.clientId,
            logger: this.sessionLogger,
        });
        this.providerCatalogSession = new ProviderCatalogSession({
            host: {
                emit: (msg) => this.emit(msg),
                isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
                supportsCustomModeIcons: () => this.supports(CLIENT_CAPS.customModeIcons),
                supportsCompactProviderSnapshots: () => this.supports(CLIENT_CAPS.compactProviderSnapshots),
                listProviderAvailability: () => this.agentManager.listProviderAvailability(),
                listDraftFeatures: (config) => this.agentManager.listDraftFeatures(config),
            },
            providerSnapshotManager,
            providerUsageService,
            logger: this.sessionLogger,
        });
        this.agentConfigSession = new AgentConfigSession({
            host: {
                emit: (msg) => this.emit(msg),
            },
            operations: {
                ensureLoaded: async (agentId) => {
                    await ensureUnarchivedAgentLoaded(agentId, {
                        agentManager,
                        agentStorage,
                        logger: this.sessionLogger,
                    });
                },
                setMode: async (agentId, modeId) => (await setAgentModeCommand({ agentManager }, { agentId, modeId })).notice,
                setModel: (agentId, modelId) => agentManager.setAgentModel(agentId, modelId),
                setFeature: (agentId, featureId, value) => agentManager.setAgentFeature(agentId, featureId, value),
                setThinking: (agentId, thinkingOptionId) => agentManager.setAgentThinkingOption(agentId, thinkingOptionId),
            },
            logger: this.sessionLogger,
        });
        this.projectConfigSession = new ProjectConfigSession({
            host: {
                emit: (msg) => this.emit(msg),
            },
            projectRegistry: this.projectRegistry,
            logger: this.sessionLogger,
        });
        this.daemonSession = new DaemonSession({
            host: {
                emit: (msg) => this.emit(msg),
                emitLifecycleIntent: (intent) => this.emitLifecycleIntent(intent),
            },
            clientId: this.clientId,
            paseoHome: this.paseoHome,
            serverId,
            daemonVersion,
            daemonRuntimeConfig,
            getWebSocketRuntimeMetrics,
            listProviderAvailability: () => this.agentManager.listProviderAvailability(),
            listAgents: () => this.agentManager.listAgents(),
            listProjects: () => this.projectRegistry.list(),
            listWorkspaces: () => this.workspaceRegistry.list(),
            logger: this.sessionLogger,
            hubRelationships: options.hubRelationships,
        });
        this.hubExecutionController = options.hubExecutionAgents
            ? new HubExecutionController({
                agents: options.hubExecutionAgents,
                send: (message) => this.emit(message),
            })
            : null;
        this.daemonConfigStore = daemonConfigStore;
        this.terminalManager = terminalManager;
        this.terminalController = new TerminalSessionController({
            terminalManager,
            emit: (msg) => this.emit(msg),
            emitBinary: (frame) => this.emitBinary(frame),
            hasBinaryChannel: () => this.onBinaryMessage !== null,
            isPathWithinRoot: (rootPath, candidatePath) => this.isPathWithinRoot(rootPath, candidatePath),
            sessionLogger: this.sessionLogger,
            listTerminalWorkspaceRefs: () => this.listActiveWorkspaceRefs(),
            clientSupportsWrapReflow: () => this.clientCapabilities.has(CLIENT_CAPS.terminalReflowableSnapshot),
            getClientBufferedAmount: () => this.getTransportBufferedAmount(),
        });
        this.agentUpdates = createAgentUpdatesService({
            emit: (message) => this.emit(message),
            enrichAgentPayload: (payload) => this.enrichAgentPayload(payload),
            buildStoredAgentPayload: (record) => this.buildStoredAgentPayload(record),
            isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
            buildProjectPlacementForWorkspaceId: (workspaceId) => this.buildProjectPlacementForWorkspaceId(workspaceId),
            emitWorkspaceUpdateForWorkspaceId: (workspaceId) => this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
            logger: this.sessionLogger,
        });
        this.createAgentLifecycleDispatch = new CreateAgentLifecycleDispatch({
            paseoHome: this.paseoHome,
            worktreesRoot: this.worktreesRoot,
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            github: this.github,
            workspaceGitService: this.workspaceGitService,
            createPaseoWorktreeWorkflow: (input, workflowOptions) => this.createPaseoWorktreeWorkflow(input, workflowOptions),
            archiveAgentForClose: (agentId) => this.archiveAgentForClose(agentId),
            findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
            listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
            archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
            emit: (message) => this.emit(message),
            emitAgentRemove: (agentId) => this.agentUpdates.removeAgent(agentId),
            emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) => this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
            markWorkspaceArchiving: (workspaceIds, archivingAt) => this.markWorkspaceArchiving(workspaceIds, archivingAt),
            clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
            killTerminalsForWorkspace: (workspaceId) => this.terminalController.killTerminalsForWorkspace(workspaceId),
            logger: this.sessionLogger,
        });
        this.providerSnapshotManager = providerSnapshotManager;
        this.serviceProxy = serviceProxy ?? null;
        this.scriptRuntimeStore = scriptRuntimeStore ?? null;
        this.workspaceSetupSnapshots = workspaceSetupSnapshots ?? new Map();
        this.workspaceSetupRuntime = resolveWorkspaceSetupRuntime(workspaceSetupRuntime);
        this.getDaemonTcpPort = getDaemonTcpPort ?? null;
        this.getDaemonTcpHost = getDaemonTcpHost ?? null;
        this.serviceProxyPublicBaseUrl = serviceProxyPublicBaseUrl ?? null;
        this.resolveScriptHealth = resolveScriptHealth ?? null;
        this.workspaceScripts = createWorkspaceScriptsService({
            serviceProxy: this.serviceProxy,
            scriptRuntimeStore: this.scriptRuntimeStore,
            terminalManager: this.terminalManager,
            workspaceRegistry: this.workspaceRegistry,
            projectRegistry: this.projectRegistry,
            workspaceGitService: this.workspaceGitService,
            getDaemonTcpPort: this.getDaemonTcpPort,
            getDaemonTcpHost: this.getDaemonTcpHost,
            serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
            resolveScriptHealth: this.resolveScriptHealth,
            logger: this.sessionLogger,
            emit: (message) => this.emit(message),
            spawnWorkspaceScript,
            globalServicePorts: loadPersistedConfig(this.paseoHome).worktrees?.servicePorts,
        });
        this.subscribeToOptionalManagers();
        this.workspaceDirectory = new WorkspaceDirectory({
            logger: this.sessionLogger,
            projectRegistry: this.projectRegistry,
            workspaceRegistry: this.workspaceRegistry,
            listAgentPayloads: () => this.listAgentPayloads(),
            listProviderSubagentActivity: async () => this.agentManager.listProviderSubagentActivity(),
            listTerminalActivityContributions: () => this.listTerminalActivityContributions(),
            isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
            buildWorkspaceDescriptor: (input) => this.buildWorkspaceDescriptor(input),
        });
        this.voiceSession = new VoiceSession({
            host: {
                emit: (msg) => this.emit(msg),
                loadAgent: (agentId) => ensureAgentLoaded(agentId, {
                    agentManager: this.agentManager,
                    agentStorage: this.agentStorage,
                    logger: this.sessionLogger,
                }),
                reloadAgentSession: (agentId, overrides) => this.agentManager.reloadAgentSession(agentId, overrides),
                sendSpokenInput: async (agentId, text) => {
                    await this.handleSendAgentMessage(agentId, text, undefined, undefined, undefined, undefined, { spokenInput: true });
                },
                interruptAgentIfRunning: (agentId) => this.interruptAgentIfRunning(agentId),
                hasActiveAgentRun: (agentId) => this.hasActiveAgentRun(agentId),
            },
            logger: this.sessionLogger,
            sessionId: this.sessionId,
            sttLanguage,
            tts,
            stt,
            voice,
            voiceBridge,
            dictation,
        });
        this.subscribeToAgentEvents();
        this.subscribeToRegistryMutations();
        this.sessionLogger.trace({}, "agent.session.lifecycle.created");
    }
    updateAppVersion(appVersion) {
        if (appVersion && appVersion !== this.appVersion) {
            this.appVersion = appVersion;
        }
    }
    updateClientCapabilities(capabilities, source) {
        this.clientCapabilities = parseClientCapabilities(capabilities);
        if (source) {
            this.clientCapabilitiesBySource.set(source, this.clientCapabilities);
        }
        if (!source && !this.supports(CLIENT_CAPS.selectiveAgentTimeline)) {
            this.viewedTimelineAgentIdsBySource.clear();
            this.viewedTimelineAgentIds.clear();
        }
    }
    clearAgentTimelineSubscription(source) {
        this.clientCapabilitiesBySource.delete(source);
        if (this.viewedTimelineAgentIdsBySource.delete(source)) {
            this.rebuildViewedTimelineAgentIds();
        }
    }
    replaceAgentTimelineSubscription(source, agentIds) {
        const subscriptionSource = source ?? this.defaultTimelineSubscriptionSource;
        if (agentIds.length === 0)
            this.viewedTimelineAgentIdsBySource.delete(subscriptionSource);
        else
            this.viewedTimelineAgentIdsBySource.set(subscriptionSource, new Set(agentIds));
        this.rebuildViewedTimelineAgentIds();
    }
    rebuildViewedTimelineAgentIds() {
        const viewedAgentIds = new Set();
        for (const agentIds of this.viewedTimelineAgentIdsBySource.values()) {
            for (const agentId of agentIds)
                viewedAgentIds.add(agentId);
        }
        this.viewedTimelineAgentIds = viewedAgentIds;
    }
    usesSelectiveTimelineDelivery() {
        if (this.clientCapabilitiesBySource.size === 0) {
            return this.supports(CLIENT_CAPS.selectiveAgentTimeline);
        }
        for (const capabilities of this.clientCapabilitiesBySource.values()) {
            if (!capabilities.has(CLIENT_CAPS.selectiveAgentTimeline))
                return false;
        }
        return true;
    }
    forwardAgentStream(event, serializedEvent) {
        if (this.clientCapabilitiesBySource.size === 0 || !this.onMessageToSource) {
            if (this.usesSelectiveTimelineDelivery() && serializedEvent.type === "attention_required") {
                this.emit({
                    type: "agent_attention_required",
                    payload: {
                        agentId: event.agentId,
                        reason: serializedEvent.reason,
                        timestamp: serializedEvent.timestamp,
                        shouldNotify: serializedEvent.shouldNotify,
                        ...(serializedEvent.notification ? { notification: serializedEvent.notification } : {}),
                    },
                });
            }
            else if (!this.usesSelectiveTimelineDelivery() ||
                this.viewedTimelineAgentIds.has(event.agentId)) {
                this.emit({
                    type: "agent_stream",
                    payload: this.buildAgentStreamPayload(event, serializedEvent),
                });
            }
            return;
        }
        for (const [source, capabilities] of this.clientCapabilitiesBySource) {
            const supportsSelectiveDelivery = capabilities.has(CLIENT_CAPS.selectiveAgentTimeline);
            if (supportsSelectiveDelivery && serializedEvent.type === "attention_required") {
                this.onMessageToSource(source, {
                    type: "agent_attention_required",
                    payload: {
                        agentId: event.agentId,
                        reason: serializedEvent.reason,
                        timestamp: serializedEvent.timestamp,
                        shouldNotify: serializedEvent.shouldNotify,
                        ...(serializedEvent.notification ? { notification: serializedEvent.notification } : {}),
                    },
                });
                continue;
            }
            if (supportsSelectiveDelivery &&
                !this.viewedTimelineAgentIdsBySource.get(source)?.has(event.agentId)) {
                continue;
            }
            this.onMessageToSource(source, {
                type: "agent_stream",
                payload: this.buildAgentStreamPayload(event, serializedEvent),
            });
        }
    }
    supports(capability) {
        return this.clientCapabilities.has(capability);
    }
    supportsForSource(capability, source) {
        return (this.clientCapabilitiesBySource.get(source)?.has(capability) ?? this.supports(capability));
    }
    emitProjectUpdate(update) {
        const message = {
            type: "project.update",
            payload: update.kind === "upsert"
                ? { kind: "upsert", project: this.buildProjectDescriptor(update.project) }
                : update,
        };
        if (this.clientCapabilitiesBySource.size === 0 || !this.onMessageToSource) {
            if (this.supports(CLIENT_CAPS.projectUpdates))
                this.emit(message);
            return;
        }
        for (const [source, capabilities] of this.clientCapabilitiesBySource) {
            if (capabilities.has(CLIENT_CAPS.projectUpdates)) {
                this.onMessageToSource(source, message);
            }
        }
    }
    async syncWorkspaceGitObserverForWorkspace(workspace) {
        await this.workspaceGitObserver.syncObserverForWorkspace(workspace);
    }
    async emitWorkspaceUpdateForWorkspaceId(workspaceId) {
        await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
    }
    async emitCreatedWorkspaceUpdate(workspace, optimisticStatus) {
        if (this.workspaceUpdatesSubscription) {
            await this.emitWorkspaceUpdatesForWorkspaceIds([workspace.id], optimisticStatus ? { optimisticStatus } : undefined);
            return;
        }
        // COMPAT(workspaceCreateCausalUpdate): added in v0.1.106, remove after 2027-01-12.
        // Older clients create before subscribing and require the causal update beside the response.
        this.emit({
            type: "workspace_update",
            payload: {
                kind: "upsert",
                workspace: optimisticStatus ? { ...workspace, status: optimisticStatus } : workspace,
            },
        });
    }
    markWorkspaceArchivingForExternalMutation(workspaceIds, archivingAt) {
        this.markWorkspaceArchiving(workspaceIds, archivingAt);
    }
    clearWorkspaceArchivingForExternalMutation(workspaceIds) {
        this.clearWorkspaceArchiving(workspaceIds);
    }
    async emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds) {
        await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds);
    }
    async syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds) {
        await Promise.all(Array.from(new Set(workspaceIds)).map(async (workspaceId) => {
            const workspace = await this.workspaceRegistry.get(workspaceId);
            if (workspace && !workspace.archivedAt) {
                await this.workspaceGitObserver.syncObserverForWorkspace(workspace);
            }
        }));
    }
    async warmWorkspaceGitDataForWorkspace(workspace) {
        await this.workspaceGitObserver.warmGitData(workspace);
    }
    async refreshRecoveredWorkspaceForExternalMutation(workspace) {
        try {
            await this.workspaceGitObserver.warmGitData(workspace);
        }
        catch (error) {
            this.sessionLogger.warn({ err: error, workspaceId: workspace.workspaceId }, "Failed to warm git observer after workspace recovery");
            try {
                await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
            }
            catch (emitError) {
                this.sessionLogger.warn({ err: emitError, workspaceId: workspace.workspaceId }, "Failed to emit workspace update after recovery");
            }
        }
    }
    /**
     * Get the client's current activity state
     */
    getClientActivity() {
        return this.clientActivity;
    }
    getFocusedAgentSelectionForCwd(cwd) {
        const focusedAgentId = this.clientActivity?.focusedAgentId;
        if (!focusedAgentId) {
            return undefined;
        }
        const agent = this.agentManager.getAgent(focusedAgentId);
        if (!agent || agent.cwd !== cwd) {
            return undefined;
        }
        return {
            provider: agent.provider,
            model: agent.runtimeInfo?.model ?? agent.config.model ?? null,
            thinkingOptionId: agent.runtimeInfo?.thinkingOptionId ?? agent.config.thinkingOptionId ?? null,
        };
    }
    readStructuredGenerationDaemonConfig() {
        return {
            metadataGeneration: this.daemonConfigStore.get().metadataGeneration,
        };
    }
    getRuntimeMetrics() {
        const terminalMetrics = this.terminalController.getMetrics();
        const workspaceGitMetrics = this.workspaceGitObserver.getMetrics();
        return {
            terminalDirectorySubscriptionCount: terminalMetrics.directorySubscriptionCount,
            terminalSubscriptionCount: terminalMetrics.streamSubscriptionCount,
            workspaceGitWatchedDirectoryCount: workspaceGitMetrics.watchedDirectoryCount,
            workspaceGitWorkspaceRecordCount: workspaceGitMetrics.workspaceRecordCount,
            workspaceGitSubscriptionCount: workspaceGitMetrics.subscriptionCount,
            inflightRequests: this.inflightRequests,
            peakInflightRequests: this.peakInflightRequests,
        };
    }
    emitServerMessage(message) {
        this.emit(message);
    }
    /**
     * Send initial state to client after connection
     */
    async sendInitialState() {
        // No unsolicited agent list hydration. Callers must use fetch_agents_request.
    }
    /**
     * Interrupt the agent's active run so the next prompt starts a fresh turn.
     * Returns once the manager confirms the stream has been cancelled.
     */
    async interruptAgentIfRunning(agentId) {
        const snapshot = this.agentManager.getAgent(agentId);
        if (!snapshot) {
            this.sessionLogger.trace({ agentId }, "agent.session.interrupt.not_found");
            throw new Error(`Agent ${agentId} not found`);
        }
        const hasInFlightRun = this.agentManager.hasInFlightRun(agentId);
        if (!hasInFlightRun) {
            this.sessionLogger.trace({
                agentId,
                provider: snapshot.provider,
                lifecycle: snapshot.lifecycle,
                hasInFlightRun,
            }, "agent.session.interrupt.skip_not_running");
            return;
        }
        this.sessionLogger.debug({ agentId, lifecycle: snapshot.lifecycle, hasInFlightRun }, "interruptAgentIfRunning: interrupting");
        const t0 = Date.now();
        const cancellation = await this.agentManager.cancelAgentRun(agentId);
        this.sessionLogger.debug({ agentId, cancellation: cancellation.status, durationMs: Date.now() - t0 }, "interruptAgentIfRunning: cancelAgentRun completed");
        if (cancellation.status === "refused") {
            this.sessionLogger.warn({ agentId }, "interruptAgentIfRunning: reported running but no active run was cancelled");
            throw new AgentRunCancellationError(agentId, "stop");
        }
    }
    hasActiveAgentRun(agentId) {
        if (!agentId) {
            return false;
        }
        return this.agentManager.hasInFlightRun(agentId);
    }
    handleAgentRunError(agentId, error, context) {
        const message = errorToFriendlyMessage(error);
        this.sessionLogger.error({ err: error, agentId, context }, `${context} for agent ${agentId}`);
        this.emit({
            type: "activity_log",
            payload: {
                id: uuidv4(),
                timestamp: new Date(),
                type: "error",
                content: `${context}: ${message}`,
            },
        });
    }
    /**
     * Subscribe to AgentManager events and forward them to the client
     */
    subscribeToOptionalManagers() {
        this.terminalController.start();
        if (this.terminalManager) {
            this.unsubscribeTerminalWorkspaceContributionEvents =
                this.terminalManager.subscribeTerminalWorkspaceContributionChanged((event) => {
                    void this.emitWorkspaceUpdateForTerminalContribution(event).catch((error) => {
                        this.sessionLogger.warn({ err: error, terminalId: event.terminalId }, "Failed to emit workspace update after terminal contribution changed");
                    });
                });
        }
        this.providerCatalogSession.start();
    }
    subscribeToRegistryMutations() {
        this.unsubscribeProjectMutations?.();
        this.unsubscribeProjectMutations =
            this.projectRegistry.subscribeToMutations?.((mutation) => this.enqueueRegistryMutation(() => this.handleProjectMutation(mutation))) ?? null;
        this.unsubscribeWorkspaceMutations?.();
        this.unsubscribeWorkspaceMutations =
            this.workspaceRegistry.subscribeToMutations?.((mutation) => this.enqueueRegistryMutation(() => this.handleWorkspaceMutation(mutation))) ?? null;
    }
    enqueueRegistryMutation(handleMutation) {
        const next = this.registryMutationQueue.then(handleMutation);
        this.registryMutationQueue = next.catch(() => { });
        return next;
    }
    async handleWorkspaceMutation(mutation) {
        try {
            if (this.isCleanedUp) {
                return;
            }
            if (mutation.kind === "archive" ||
                mutation.kind === "remove" ||
                mutation.workspace?.archivedAt) {
                this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
            }
            else {
                await this.syncWorkspaceMutationObserver(mutation);
            }
            if (this.isCleanedUp) {
                return;
            }
            await this.emitWorkspaceUpdatesForWorkspaceIds([mutation.workspaceId], mutation.expectsInitialAgent ? { optimisticStatus: "running" } : undefined);
        }
        catch (error) {
            this.sessionLogger.warn({ err: error, workspaceId: mutation.workspaceId, mutationKind: mutation.kind }, "Failed to apply workspace mutation to session");
        }
    }
    async syncWorkspaceMutationObserver(mutation) {
        const subscription = this.workspaceUpdatesSubscription;
        if (!mutation.workspace || !subscription) {
            return;
        }
        const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
            workspaceIds: [mutation.workspaceId],
            includeGitData: false,
        });
        const descriptor = descriptorsByWorkspaceId.get(mutation.workspaceId);
        if (!descriptor ||
            !this.matchesWorkspaceFilter({ workspace: descriptor, filter: subscription.filter })) {
            this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
            return;
        }
        const currentWorkspace = await this.workspaceRegistry.get(mutation.workspaceId);
        if (!currentWorkspace || currentWorkspace.archivedAt) {
            this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
            return;
        }
        await this.workspaceGitObserver.syncObserverForWorkspace(currentWorkspace);
        if (this.isCleanedUp) {
            this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
        }
    }
    async handleProjectMutation(mutation) {
        try {
            const subscription = this.workspaceUpdatesSubscription;
            if (this.isCleanedUp || !subscription) {
                return;
            }
            const projectWorkspaceIds = (await this.workspaceRegistry.list())
                .filter((workspace) => workspace.projectId === mutation.projectId)
                .map((workspace) => workspace.workspaceId);
            if (mutation.kind === "remove") {
                const visibleWorkspaceIds = projectWorkspaceIds.filter((workspaceId) => {
                    const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
                    return (lastEmitted?.kind === "upsert" ||
                        (lastEmitted?.kind === "remove" &&
                            lastEmitted.emptyProject?.projectId === mutation.projectId));
                });
                let updateIds = visibleWorkspaceIds;
                if (updateIds.length === 0 &&
                    subscription.visibleEmptyProjectIds?.has(mutation.projectId)) {
                    updateIds = [mutation.projectId];
                }
                if (updateIds.length === 0) {
                    return;
                }
                for (const workspaceId of projectWorkspaceIds) {
                    this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
                }
                await this.emitWorkspaceUpdatesForWorkspaceIds(updateIds, {
                    removedProjectId: mutation.projectId,
                });
                return;
            }
            if (mutation.kind === "archive" || mutation.project?.archivedAt) {
                for (const workspaceId of projectWorkspaceIds) {
                    this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
                }
            }
            await this.emitWorkspaceUpdatesForWorkspaceIds(projectWorkspaceIds);
        }
        catch (error) {
            this.sessionLogger.warn({ err: error, projectId: mutation.projectId, mutationKind: mutation.kind }, "Failed to apply project mutation to session");
        }
    }
    subscribeToAgentEvents() {
        if (this.unsubscribeAgentEvents) {
            this.unsubscribeAgentEvents();
        }
        this.unsubscribeAgentEvents = this.agentManager.subscribe((event) => {
            if (event.type === "agent_state") {
                this.sessionLogger.trace({
                    agentId: event.agent.id,
                    provider: event.agent.provider,
                    providerSessionId: event.agent.persistence?.sessionId ?? undefined,
                    turnId: event.agent.activeForegroundTurnId ?? undefined,
                    lifecycle: event.agent.lifecycle,
                }, "agent.session.forward_update");
                void this.agentUpdates.forwardLiveAgent(event.agent);
                return;
            }
            if (event.type === "provider_subagent") {
                this.emitProviderSubagentWorkspaceUpdate(event.event);
                if (!this.supports(CLIENT_CAPS.providerSubagents)) {
                    return;
                }
                const update = event.event;
                if (update.type === "upsert") {
                    this.emit({
                        type: "agent.provider_subagents.update",
                        payload: { kind: "upsert", subagent: update.subagent },
                    });
                }
                else if (update.type === "timeline") {
                    this.emit({
                        type: "agent.provider_subagents.update",
                        payload: {
                            kind: "timeline",
                            parentAgentId: update.parentAgentId,
                            subagentId: update.subagentId,
                            provider: update.provider,
                            item: update.row.item,
                            timestamp: update.row.timestamp,
                            seq: update.row.seq,
                            epoch: update.epoch,
                        },
                    });
                }
                else {
                    this.emit({
                        type: "agent.provider_subagents.update",
                        payload: {
                            kind: "remove",
                            parentAgentId: update.parentAgentId,
                            subagentId: update.subagentId,
                        },
                    });
                }
                return;
            }
            if (this.voiceSession.isActiveForAgent(event.agentId) &&
                event.event.type === "permission_requested" &&
                isVoicePermissionAllowed(event.event.request)) {
                const requestId = event.event.request.id;
                void this.agentManager
                    .respondToPermission(event.agentId, requestId, {
                    behavior: "allow",
                })
                    .catch((error) => {
                    this.sessionLogger.warn({
                        err: error,
                        agentId: event.agentId,
                        requestId,
                    }, "Failed to auto-allow speak tool permission in voice mode");
                });
            }
            const serializedEvent = serializeAgentStreamEvent(event.event);
            if (!serializedEvent) {
                return;
            }
            this.sessionLogger.trace({
                agentId: event.agentId,
                provider: event.event.provider,
                turnId: getAgentStreamEventTurnId(event.event),
                seq: event.seq,
                epoch: event.epoch,
                event: event.event,
            }, "agent.session.forward_stream");
            this.forwardAgentStream(event, serializedEvent);
            if (event.event.type === "permission_requested") {
                this.emit({
                    type: "agent_permission_request",
                    payload: {
                        agentId: event.agentId,
                        request: event.event.request,
                    },
                });
            }
            else if (event.event.type === "permission_resolved") {
                this.emit({
                    type: "agent_permission_resolved",
                    payload: {
                        agentId: event.agentId,
                        requestId: event.event.requestId,
                        resolution: event.event.resolution,
                    },
                });
            }
            // Title updates may be applied asynchronously after agent creation.
        }, { replayState: false });
    }
    emitProviderSubagentWorkspaceUpdate(event) {
        if (event.type === "timeline") {
            return;
        }
        const parentAgentId = event.type === "upsert" ? event.subagent.parentAgentId : event.parentAgentId;
        const parent = this.agentManager.getAgent(parentAgentId);
        if (!parent?.workspaceId) {
            return;
        }
        void this.emitWorkspaceUpdateForWorkspaceId(parent.workspaceId).catch((error) => {
            this.sessionLogger.error({ err: error, parentAgentId, workspaceId: parent.workspaceId }, "Failed to emit provider subagent workspace update");
        });
    }
    buildAgentStreamPayload(event, serializedEvent) {
        return {
            agentId: event.agentId,
            event: serializedEvent,
            timestamp: event.timestamp ?? new Date().toISOString(),
            ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
            ...(typeof event.epoch === "string" ? { epoch: event.epoch } : {}),
        };
    }
    async enrichAgentPayload(payload) {
        const storedRecord = await this.agentStorage.get(payload.id);
        payload.title = storedRecord?.title ?? null;
        payload.archivedAt = storedRecord?.archivedAt ?? null;
        return payload;
    }
    buildAgentPayload(agent) {
        return this.enrichAgentPayload(toAgentPayload(agent));
    }
    buildStoredAgentPayload(record, registeredProviderIds = new Set(this.providerSnapshotManager.listRegisteredProviderIds())) {
        return buildStoredAgentPayload(record, registeredProviderIds);
    }
    isProviderVisibleToClient(provider) {
        if (clientSupportsAllProviders(this.appVersion)) {
            return true;
        }
        return LEGACY_PROVIDER_IDS.has(provider);
    }
    async buildProjectPlacementForWorkspace(workspace, projectRecord) {
        const project = projectRecord ?? (await this.projectRegistry.get(workspace.projectId));
        if (!project) {
            throw new Error(`Project not found for workspace ${workspace.workspaceId}`);
        }
        const snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);
        const checkout = checkoutFromPersistedWorkspacePlacement({
            workspace,
            // COMPAT(workspacePlacementBackfill): added in v0.1.107, remove after 2027-01-15.
            // Legacy records can lack branch and worktreeRoot because persisted registries
            // are not migrated in place.
            fallbackBranch: snapshot?.git.currentBranch ?? null,
            fallbackWorktreeRoot: snapshot?.git.repoRoot,
        });
        return {
            projectKey: project.projectId,
            projectName: resolveProjectDisplayName(project),
            workspaceName: resolveWorkspaceDisplayName(workspace),
            checkout,
        };
    }
    async buildProjectPlacementForWorkspaceId(workspaceId) {
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (!workspace)
            return null;
        const project = await this.projectRegistry.get(workspace.projectId);
        if (!project)
            return null;
        return this.buildProjectPlacementForWorkspace(workspace, project);
    }
    /**
     * Main entry point for processing session messages
     */
    async handleMessage(msg, source) {
        this.inflightRequests++;
        if (this.inflightRequests > this.peakInflightRequests) {
            this.peakInflightRequests = this.inflightRequests;
        }
        try {
            this.sessionLogger.trace({
                messageType: msg.type,
                payloadBytes: JSON.stringify(msg).length,
            }, "agent.session.inbound");
            if (!isSessionRpcAllowed(this.scopes, msg.type)) {
                const requestId = sessionRequestId(msg);
                if (requestId) {
                    this.emit({
                        type: "rpc_error",
                        payload: {
                            requestId,
                            requestType: msg.type,
                            error: `Session is not authorized for ${msg.type}`,
                            code: "access_denied",
                        },
                    });
                }
                return;
            }
            try {
                await this.dispatchInboundMessage(msg, source);
            }
            catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                this.sessionLogger.error({ err }, "Error handling message");
                const requestId = "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : undefined;
                if (typeof requestId === "string") {
                    try {
                        this.emit({
                            type: "rpc_error",
                            payload: {
                                requestId,
                                requestType: msg.type,
                                error: `Request failed: ${err.message}`,
                                code: "handler_error",
                            },
                        });
                    }
                    catch (emitError) {
                        this.sessionLogger.error({ err: emitError }, "Failed to emit rpc_error");
                    }
                }
                this.emit({
                    type: "activity_log",
                    payload: {
                        id: uuidv4(),
                        timestamp: new Date(),
                        type: "error",
                        content: `Error: ${err.message}`,
                    },
                });
            }
        }
        finally {
            this.inflightRequests--;
        }
    }
    setScopes(scopes) {
        this.scopes = [...scopes];
    }
    async dispatchInboundMessage(msg, source) {
        const promise = this.dispatchVoiceAndControlMessage(msg) ??
            this.dispatchAgentRewindMessage(msg) ??
            this.dispatchAgentRelationshipMessage(msg) ??
            this.dispatchAgentTimelineMessage(msg, source) ??
            this.dispatchHubExecutionMessage(msg) ??
            this.dispatchAgentLifecycleMessage(msg) ??
            this.dispatchAgentConfigMessage(msg) ??
            this.dispatchCheckoutMessage(msg) ??
            this.dispatchWorkspaceRecoveryMessage(msg) ??
            this.dispatchWorkspaceAndProjectMessage(msg) ??
            this.dispatchWorkspaceFileMessage(msg, source) ??
            this.dispatchProviderMessage(msg) ??
            this.dispatchTerminalMessage(msg) ??
            this.dispatchChatScheduleLoopMessage(msg) ??
            this.dispatchMiscMessage(msg);
        if (promise)
            await promise;
    }
    dispatchVoiceAndControlMessage(msg) {
        switch (msg.type) {
            case "voice_audio_chunk":
                return this.voiceSession.handleAudioChunk(msg);
            case "abort_request":
                return this.voiceSession.handleAbort();
            case "audio_played":
                this.voiceSession.handleAudioPlayed(msg.id);
                return undefined;
            case "set_voice_mode":
                return this.voiceSession.handleSetVoiceMode(msg.enabled, msg.agentId, msg.requestId);
            case "dictation_stream_start":
                return this.voiceSession.handleDictationStreamStart(msg);
            case "dictation_stream_chunk":
                return this.voiceSession.handleDictationChunk({
                    dictationId: msg.dictationId,
                    seq: msg.seq,
                    audioBase64: msg.audio,
                    format: msg.format,
                });
            case "dictation_stream_finish":
                return this.voiceSession.handleDictationFinish(msg.dictationId, msg.finalSeq);
            case "dictation_stream_cancel":
                this.voiceSession.handleDictationCancel(msg.dictationId);
                return undefined;
            case "restart_server_request":
                return this.handleRestartServerRequest(msg.requestId, msg.reason);
            case "shutdown_server_request":
                return this.handleShutdownServerRequest(msg.requestId);
            case "client_heartbeat":
                this.handleClientHeartbeat(msg);
                return undefined;
            case "ping": {
                const now = Date.now();
                this.emit({
                    type: "pong",
                    payload: {
                        requestId: msg.requestId,
                        clientSentAt: msg.clientSentAt,
                        serverReceivedAt: now,
                        serverSentAt: now,
                    },
                });
                return undefined;
            }
            default:
                return undefined;
        }
    }
    dispatchAgentRewindMessage(msg) {
        switch (msg.type) {
            case "agent.rewind.request":
                return this.handleAgentRewindRequest(msg);
            default:
                return undefined;
        }
    }
    dispatchAgentRelationshipMessage(msg) {
        switch (msg.type) {
            case "agent.detach.request":
                return this.handleDetachAgentRequest(msg.agentId, msg.requestId);
            default:
                return undefined;
        }
    }
    dispatchAgentTimelineMessage(msg, source) {
        switch (msg.type) {
            case "fetch_agent_timeline_request":
                return this.handleFetchAgentTimelineRequest(msg, source);
            case "agent.timeline.list_prompts.request":
                return this.handleAgentTimelineListPromptsRequest(msg, source);
            case "agent.provider_subagents.list.request":
                return this.handleProviderSubagentListRequest(msg);
            case "agent.provider_subagents.timeline.get.request":
                return this.handleProviderSubagentTimelineRequest(msg);
            case "agent.timeline.set_subscription.request": {
                const agentIds = [...new Set(msg.agentIds)].sort();
                if (source
                    ? this.supportsForSource(CLIENT_CAPS.selectiveAgentTimeline, source)
                    : this.supports(CLIENT_CAPS.selectiveAgentTimeline)) {
                    this.replaceAgentTimelineSubscription(source, agentIds);
                }
                const response = {
                    type: "agent.timeline.set_subscription.response",
                    payload: { agentIds, requestId: msg.requestId },
                };
                if (source && this.onMessageToSource)
                    this.onMessageToSource(source, response);
                else
                    this.emit(response);
                return undefined;
            }
            case "agent.fork_context.request":
                return this.handleAgentForkContextRequest(msg);
            default:
                return undefined;
        }
    }
    dispatchHubExecutionMessage(msg) {
        if (msg.type === "hub.execution.agent.create.request") {
            return this.hubExecutionController?.createAgent(msg);
        }
        if (msg.type === "hub.execution.control.request") {
            return this.hubExecutionController?.controlExecution(msg);
        }
        return undefined;
    }
    dispatchAgentLifecycleMessage(msg) {
        switch (msg.type) {
            case "fetch_agents_request":
                return this.handleFetchAgents(msg);
            case "fetch_agent_history_request":
                return this.handleFetchAgentHistory(msg);
            case "fetch_recent_provider_sessions_request":
                return this.handleFetchRecentProviderSessions(msg);
            case "fetch_agent_request":
                return this.handleFetchAgent(msg.agentId, msg.requestId);
            case "delete_agent_request":
                return this.handleDeleteAgentRequest(msg.agentId, msg.requestId);
            case "archive_agent_request":
                return this.handleArchiveAgentRequest(msg.agentId, msg.requestId);
            case "close_items_request":
                return this.handleCloseItemsRequest(msg);
            case "update_agent_request":
                return this.handleUpdateAgentRequest(msg.agentId, msg.name, msg.labels, msg.requestId);
            case "project.rename.request":
                return this.handleProjectRenameRequest(msg.projectId, msg.customName, msg.requestId);
            case "project.icon.set.request":
                return this.handleProjectIconSetRequest(msg);
            case "send_agent_message_request":
                return this.handleSendAgentMessageRequest(msg);
            case "wait_for_finish_request":
                return this.handleWaitForFinish(msg.agentId, msg.requestId, msg.timeoutMs);
            case "create_agent_request":
                return this.handleCreateAgentRequest(msg);
            case "resume_agent_request":
                return this.handleResumeAgentRequest(msg);
            case "import_agent_request":
                return this.handleImportAgentRequest(msg);
            case "refresh_agent_request":
                return this.handleRefreshAgentRequest(msg);
            case "cancel_agent_request":
                return this.handleCancelAgentRequest(msg.agentId, msg.requestId);
            case "agent_permission_response":
                return this.handleAgentPermissionResponse(msg.agentId, msg.requestId, msg.response);
            case "clear_agent_attention":
                return this.handleClearAgentAttention(msg.agentId, msg.requestId);
            default:
                return undefined;
        }
    }
    dispatchAgentConfigMessage(msg) {
        switch (msg.type) {
            case "set_agent_mode_request":
                return this.agentConfigSession.handleSetAgentModeRequest(msg);
            case "set_agent_model_request":
                return this.agentConfigSession.handleSetAgentModelRequest(msg);
            case "set_agent_feature_request":
                return this.agentConfigSession.handleSetAgentFeatureRequest(msg);
            case "set_agent_thinking_request":
                return this.agentConfigSession.handleSetAgentThinkingRequest(msg);
            case "get_daemon_config_request":
                this.emit({
                    type: "get_daemon_config_response",
                    payload: { requestId: msg.requestId, config: this.daemonConfigStore.get() },
                });
                return undefined;
            case "daemon.get_status.request":
                return this.daemonSession.handleGetStatusRequest(msg);
            case "daemon.get_pairing_offer.request":
                return this.daemonSession.handleGetPairingOfferRequest(msg);
            case "hub.management.daemon.connect.request":
            case "hub.management.daemon.get_status.request":
            case "hub.management.daemon.disconnect.request":
                return this.daemonSession.handleHubRelationshipRequest(msg);
            case "diagnostics.request":
                return this.daemonSession.handleDiagnosticsRequest(msg);
            case "daemon.update.request":
                return this.daemonSession.handleUpdateRequest(msg);
            case "set_daemon_config_request":
                this.emit({
                    type: "set_daemon_config_response",
                    payload: {
                        requestId: msg.requestId,
                        config: this.daemonConfigStore.patch(msg.config),
                    },
                });
                return undefined;
            case "read_project_config_request":
                return this.projectConfigSession.handleReadProjectConfigRequest(msg);
            case "write_project_config_request":
                return this.projectConfigSession.handleWriteProjectConfigRequest(msg);
            default:
                return undefined;
        }
    }
    // eslint-disable-next-line complexity
    dispatchCheckoutMessage(msg) {
        switch (msg.type) {
            case "checkout_status_request":
                return this.checkoutSession.handleStatusRequest(msg);
            case "checkout.commits.list.request":
                return this.checkoutSession.handleCommitsListRequest(msg);
            case "checkout.commits.file_diff.request":
                return this.checkoutSession.handleCommitFileDiffRequest(msg);
            case "validate_branch_request":
                return this.checkoutSession.handleValidateBranchRequest(msg);
            case "branch_suggestions_request":
                return this.checkoutSession.handleBranchSuggestionsRequest(msg);
            case "directory_suggestions_request":
                return this.handleDirectorySuggestionsRequest(msg);
            case "subscribe_checkout_diff_request":
                return this.checkoutSession.handleSubscribeDiffRequest(msg);
            case "unsubscribe_checkout_diff_request":
                this.checkoutSession.handleUnsubscribeDiffRequest(msg);
                return undefined;
            case "checkout_switch_branch_request":
                return this.checkoutSession.handleCheckoutSwitchBranchRequest(msg);
            case "checkout.rename_branch.request":
                return this.checkoutSession.handleCheckoutRenameBranchRequest(msg);
            case "checkout_commit_request":
                return this.checkoutSession.handleCheckoutCommitRequest(msg);
            case "checkout_merge_request":
                return this.checkoutSession.handleCheckoutMergeRequest(msg);
            case "checkout_merge_from_base_request":
                return this.checkoutSession.handleCheckoutMergeFromBaseRequest(msg);
            case "checkout_pull_request":
                return this.checkoutSession.handleCheckoutPullRequest(msg);
            case "checkout_push_request":
                return this.checkoutSession.handleCheckoutPushRequest(msg);
            case "checkout.refresh.request":
                return this.checkoutSession.handleRefreshRequest(msg);
            case "checkout_pr_create_request":
                return this.checkoutSession.handleCheckoutPrCreateRequest(msg);
            case "checkout_pr_merge_request":
                return this.checkoutSession.handleCheckoutPrMergeRequest(msg);
            case "checkout.forge.set_auto_merge.request":
            case "checkout.github.set_auto_merge.request":
                return this.checkoutSession.handleCheckoutForgeSetAutoMergeRequest(msg);
            case "checkout.forge.get_check_details.request":
            case "checkout.github.get_check_details.request":
                return this.checkoutSession.handleCheckoutForgeGetCheckDetailsRequest(msg);
            case "checkout_pr_status_request":
                return this.checkoutSession.handleCheckoutPrStatusRequest(msg);
            case "pull_request_timeline_request":
                return this.checkoutSession.handlePullRequestTimelineRequest(msg);
            case "forge.search.request":
            case "github_search_request":
                return this.checkoutSession.handleForgeSearchRequest(msg);
            case "stash_save_request":
                return this.checkoutSession.handleStashSaveRequest(msg);
            case "stash_pop_request":
                return this.checkoutSession.handleStashPopRequest(msg);
            case "stash_list_request":
                return this.checkoutSession.handleStashListRequest(msg);
            default:
                return undefined;
        }
    }
    dispatchWorkspaceAndProjectMessage(msg) {
        switch (msg.type) {
            case "fetch_workspaces_request":
                return this.handleFetchWorkspacesRequest(msg);
            case "project.list.request":
                return this.handleProjectListRequest(msg.requestId);
            case "paseo_worktree_list_request":
                return this.handlePaseoWorktreeListRequest(msg);
            case "paseo_worktree_archive_request":
                return this.handlePaseoWorktreeArchiveRequest(msg);
            case "create_paseo_worktree_request":
                return this.handleCreatePaseoWorktreeRequest(msg);
            case "workspace_setup_status_request":
                return this.handleWorkspaceSetupStatusRequest(msg);
            // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
            case "list_available_editors_request":
                return this.handleLegacyListAvailableEditorsRequest(msg);
            case "open_in_editor_request":
                return this.handleLegacyOpenInEditorRequest(msg);
            case "open_project_request":
                return this.handleOpenProjectRequest(msg);
            case "project.add.request":
                return this.handleProjectAddRequest(msg);
            case "project.create_directory.request":
                return this.handleProjectCreateDirectoryRequest(msg);
            case "workspace.github.search_repositories.request":
                return this.handleWorkspaceGithubSearchRepositoriesRequest(msg);
            case "project.github.clone.request":
                return this.handleProjectGithubCloneRequest(msg);
            case "archive_workspace_request":
                return this.handleArchiveWorkspaceRequest(msg);
            case "project.remove.request":
                return this.handleProjectRemoveRequest(msg);
            case "workspace.create.request":
                return this.handleWorkspaceCreateRequest(msg);
            case "workspace.clear_attention.request":
                return this.handleWorkspaceClearAttentionRequest(msg);
            case "workspace.title.set.request":
                return this.handleWorkspaceTitleSetRequest(msg.workspaceId, msg.title, msg.requestId);
            case "workspace.pin.set.request":
                return this.handleWorkspacePinSetRequest(msg.workspaceId, msg.pinned, msg.requestId);
            default:
                return undefined;
        }
    }
    dispatchWorkspaceFileMessage(msg, source) {
        switch (msg.type) {
            case "file_explorer_request":
                return this.workspaceFilesSession.handleFileExplorerRequest(msg, source);
            case "fs.file.subscribe.request":
                return this.workspaceFilesSession.handleFileSubscribeRequest(msg);
            case "fs.file.unsubscribe.request":
                this.workspaceFilesSession.handleFileUnsubscribeRequest(msg);
                return undefined;
            case "fs.file.write.request":
                return this.workspaceFilesSession.handleFileWriteRequest(msg);
            case "project_icon_request":
                return this.workspaceFilesSession.handleProjectIconRequest(msg);
            case "project.icon.get.request":
                return this.handleProjectIconGetRequest(msg.projectId, msg.requestId);
            case "file_download_token_request":
                return this.workspaceFilesSession.handleFileDownloadTokenRequest(msg);
            case "file.upload.request":
                this.workspaceFilesSession.handleFileUploadRequest(msg);
                return undefined;
            default:
                return undefined;
        }
    }
    dispatchWorkspaceRecoveryMessage(msg) {
        switch (msg.type) {
            case "workspace.recovery.inspect.request":
                return this.handleWorkspaceRecoveryInspectRequest(msg);
            case "workspace.recovery.restore.request":
                return this.handleWorkspaceRecoveryRestoreRequest(msg);
            default:
                return undefined;
        }
    }
    dispatchProviderMessage(msg) {
        switch (msg.type) {
            case "list_provider_models_request":
                return this.providerCatalogSession.handleListProviderModelsRequest(msg);
            case "list_provider_modes_request":
                return this.providerCatalogSession.handleListProviderModesRequest(msg);
            case "list_provider_features_request":
                return this.providerCatalogSession.handleListProviderFeaturesRequest(msg);
            case "list_available_providers_request":
                return this.providerCatalogSession.handleListAvailableProvidersRequest(msg);
            case "get_providers_snapshot_request":
                return this.providerCatalogSession.handleGetProvidersSnapshotRequest(msg);
            case "refresh_providers_snapshot_request":
                return this.providerCatalogSession.handleRefreshProvidersSnapshotRequest(msg);
            case "provider_diagnostic_request":
                return this.providerCatalogSession.handleProviderDiagnosticRequest(msg);
            case "provider.usage.list.request":
                return this.providerCatalogSession.handleProviderUsageListRequest(msg);
            default:
                return undefined;
        }
    }
    dispatchTerminalMessage(msg) {
        switch (msg.type) {
            case "start_workspace_script_request":
                return this.handleStartWorkspaceScriptRequest(msg);
            case "workspace.script.list.request":
                return this.handleWorkspaceScriptListRequest(msg);
            case "workspace.script.start.request":
                return this.handleWorkspaceScriptStartRequest(msg);
            case "workspace.script.stop.request":
                return this.handleWorkspaceScriptStopRequest(msg);
            default:
                return this.terminalController.dispatch(msg);
        }
    }
    // eslint-disable-next-line complexity
    dispatchChatScheduleLoopMessage(msg) {
        switch (msg.type) {
            case "chat/create":
                return this.chatScheduleLoopSession.handleChatCreateRequest(msg);
            case "chat/list":
                return this.chatScheduleLoopSession.handleChatListRequest(msg);
            case "chat/inspect":
                return this.chatScheduleLoopSession.handleChatInspectRequest(msg);
            case "chat/delete":
                return this.chatScheduleLoopSession.handleChatDeleteRequest(msg);
            case "chat/post":
                return this.chatScheduleLoopSession.handleChatPostRequest(msg);
            case "chat/read":
                return this.chatScheduleLoopSession.handleChatReadRequest(msg);
            case "chat/wait":
                return this.chatScheduleLoopSession.handleChatWaitRequest(msg);
            case "loop/run":
                return this.chatScheduleLoopSession.handleLoopRunRequest(msg);
            case "loop/list":
                return this.chatScheduleLoopSession.handleLoopListRequest(msg);
            case "loop/inspect":
                return this.chatScheduleLoopSession.handleLoopInspectRequest(msg);
            case "loop/logs":
                return this.chatScheduleLoopSession.handleLoopLogsRequest(msg);
            case "loop/stop":
                return this.chatScheduleLoopSession.handleLoopStopRequest(msg);
            case "schedule/create":
                return this.chatScheduleLoopSession.handleScheduleCreateRequest(msg);
            case "schedule/list":
                return this.chatScheduleLoopSession.handleScheduleListRequest(msg);
            case "schedule/inspect":
                return this.chatScheduleLoopSession.handleScheduleInspectRequest(msg);
            case "schedule/logs":
                return this.chatScheduleLoopSession.handleScheduleLogsRequest(msg);
            case "schedule/pause":
                return this.chatScheduleLoopSession.handleSchedulePauseRequest(msg);
            case "schedule/resume":
                return this.chatScheduleLoopSession.handleScheduleResumeRequest(msg);
            case "schedule/delete":
                return this.chatScheduleLoopSession.handleScheduleDeleteRequest(msg);
            case "schedule/run-once":
                return this.chatScheduleLoopSession.handleScheduleRunOnceRequest(msg);
            case "schedule/update":
                return this.chatScheduleLoopSession.handleScheduleUpdateRequest(msg);
            default:
                return undefined;
        }
    }
    async dispatchMiscMessage(msg) {
        switch (msg.type) {
            case "list_commands_request":
                await this.handleListCommandsRequest(msg);
                return;
            case "register_push_token":
                this.handleRegisterPushToken(msg.token);
                return;
        }
    }
    resetPeakInflight() {
        this.peakInflightRequests = this.inflightRequests;
    }
    getSessionId() {
        return this.sessionId;
    }
    async handleBinaryFrame(binaryFrame) {
        if (binaryFrame.kind === "file_transfer") {
            await this.workspaceFilesSession.handleFileTransferFrame(binaryFrame.frame);
            return;
        }
        this.terminalController.handleBinaryFrame(binaryFrame.frame);
    }
    async handleRestartServerRequest(requestId, reason) {
        const lifecycleReason = normalizeClientRestartRpcReason(reason);
        const payload = {
            status: "restart_requested",
            clientId: this.clientId,
        };
        if (reason && reason.trim().length > 0) {
            payload.reason = reason;
        }
        payload.requestId = requestId;
        this.sessionLogger.warn({ reason: lifecycleReason }, "Restart requested via websocket");
        this.emit({
            type: "status",
            payload,
        });
        this.emitLifecycleIntent({
            type: "restart",
            clientId: this.clientId,
            requestId,
            reason: lifecycleReason,
        });
    }
    async handleShutdownServerRequest(requestId) {
        const reason = CLIENT_SHUTDOWN_RPC_REASON;
        this.sessionLogger.warn({ reason }, "Shutdown requested via websocket");
        this.emit({
            type: "status",
            payload: {
                status: "shutdown_requested",
                clientId: this.clientId,
                requestId,
            },
        });
        this.emitLifecycleIntent({
            type: "shutdown",
            clientId: this.clientId,
            requestId,
            reason,
        });
    }
    emitLifecycleIntent(intent) {
        if (!this.onLifecycleIntent) {
            return;
        }
        try {
            this.onLifecycleIntent(intent);
        }
        catch (error) {
            this.sessionLogger.error({ err: error, intent }, "Lifecycle intent handler failed");
        }
    }
    async handleDeleteAgentRequest(agentId, requestId) {
        this.sessionLogger.info({ agentId }, `Deleting agent ${agentId} from registry`);
        const knownWorkspaceId = this.agentManager.getAgent(agentId)?.workspaceId ??
            (await this.agentStorage.get(agentId))?.workspaceId ??
            null;
        // File-backed storage still needs an early delete fence before closeAgent().
        beginAgentDeleteIfSupported(this.agentStorage, agentId);
        try {
            await closeAgentCommand({ agentManager: this.agentManager }, agentId);
        }
        catch (error) {
            this.sessionLogger.warn({ err: error, agentId }, `Failed to close agent ${agentId} during delete`);
        }
        // Drain queued persistence from the just-closed agent before removing its
        // durable snapshot, otherwise an in-flight background write can recreate it.
        await this.agentManager.flush();
        try {
            await this.agentStorage.remove(agentId);
            await this.agentManager.deleteAgentState(agentId);
        }
        catch (error) {
            this.sessionLogger.error({ err: error, agentId }, `Failed to fully delete agent ${agentId}`);
        }
        this.emit({
            type: "agent_deleted",
            payload: {
                agentId,
                requestId,
            },
        });
        await this.agentUpdates.removeAgent(agentId);
        if (knownWorkspaceId) {
            await this.emitWorkspaceUpdateForWorkspaceId(knownWorkspaceId);
        }
    }
    async handleArchiveAgentRequest(agentId, requestId) {
        this.sessionLogger.info({ agentId }, `Archiving agent ${agentId}`);
        const { archivedAt } = await this.archiveAgentForClose(agentId);
        this.emit({
            type: "agent_archived",
            payload: {
                agentId,
                archivedAt,
                requestId,
            },
        });
    }
    async archiveAgentForClose(agentId) {
        const { archivedAt, record: archivedRecord } = await archiveAgentCommand({
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.sessionLogger,
        }, agentId);
        if (this.agentUpdates.hasSubscription()) {
            const payload = await this.agentUpdates.emitStoredRecord(archivedRecord);
            if (payload.workspaceId) {
                await this.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
            }
        }
        return { agentId, archivedAt };
    }
    async handleDetachAgentRequest(agentId, requestId) {
        this.sessionLogger.info({ agentId, requestId }, "Detaching agent from parent");
        try {
            const result = await detachAgentCommand({ agentManager: this.agentManager }, agentId);
            const affectedWorkspaceIds = new Set();
            if (!result.live) {
                const payload = await this.agentUpdates.emitStoredRecord(result.record);
                if (payload.workspaceId) {
                    affectedWorkspaceIds.add(payload.workspaceId);
                }
            }
            else if (result.record.workspaceId) {
                affectedWorkspaceIds.add(result.record.workspaceId);
            }
            if (result.previousParentAgentId) {
                const rootWorkspaceId = await this.resolveDelegationRootWorkspaceId(result.previousParentAgentId);
                if (rootWorkspaceId) {
                    affectedWorkspaceIds.add(rootWorkspaceId);
                }
            }
            await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
            this.emit({
                type: "agent.detach.response",
                payload: {
                    requestId,
                    agentId,
                    accepted: true,
                    error: null,
                },
            });
        }
        catch (error) {
            const message = getErrorMessageOr(error, "Failed to detach agent");
            this.sessionLogger.error({ err: error, agentId, requestId }, "Failed to detach agent");
            this.emit({
                type: "agent.detach.response",
                payload: {
                    requestId,
                    agentId,
                    accepted: false,
                    error: message,
                },
            });
        }
    }
    async handleCloseItemsRequest(msg) {
        const archiveResults = await Promise.allSettled(msg.agentIds.map((agentId) => this.archiveAgentForClose(agentId)));
        const agents = [];
        for (let i = 0; i < archiveResults.length; i += 1) {
            const result = archiveResults[i];
            if (result.status === "fulfilled") {
                agents.push(result.value);
            }
            else {
                this.sessionLogger.warn({ err: result.reason, agentId: msg.agentIds[i], requestId: msg.requestId }, "Failed to archive agent during close_items batch");
            }
        }
        const terminals = [];
        for (const terminalId of msg.terminalIds) {
            try {
                terminals.push(this.terminalController.killTerminalForClose(terminalId));
            }
            catch (error) {
                this.sessionLogger.warn({ err: error, terminalId, requestId: msg.requestId }, "Failed to kill terminal during close_items batch");
                terminals.push({
                    terminalId,
                    success: false,
                });
            }
        }
        this.emit({
            type: "close_items_response",
            payload: {
                agents,
                terminals,
                requestId: msg.requestId,
            },
        });
    }
    async unarchiveAgentByHandle(handle) {
        const records = await this.agentStorage.list();
        const matched = records
            .filter((record) => record.persistence?.provider === handle.provider &&
            record.persistence?.sessionId === handle.sessionId)
            .reduce((latest, candidate) => {
            if (!latest) {
                return candidate;
            }
            const updatedDelta = Date.parse(resolveStoredAgentPayloadUpdatedAt(candidate)) -
                Date.parse(resolveStoredAgentPayloadUpdatedAt(latest));
            if (updatedDelta !== 0) {
                return updatedDelta > 0 ? candidate : latest;
            }
            return Date.parse(candidate.createdAt) > Date.parse(latest.createdAt) ? candidate : latest;
        }, null);
        if (!matched) {
            return null;
        }
        const didUnarchive = await unarchiveAgentState(this.agentStorage, this.agentManager, matched.id);
        return {
            record: matched,
            didUnarchive,
            originalArchivedAt: matched.archivedAt ?? null,
        };
    }
    async handleUpdateAgentRequest(agentId, name, labels, requestId) {
        this.sessionLogger.info({
            agentId,
            requestId,
            hasName: typeof name === "string",
            labelCount: labels ? Object.keys(labels).length : 0,
        }, "session: update_agent_request");
        try {
            const result = await updateAgentCommand({ agentManager: this.agentManager }, { agentId, name, labels });
            if (!result.accepted) {
                this.emit({
                    type: "update_agent_response",
                    payload: {
                        requestId,
                        agentId,
                        accepted: false,
                        error: result.error,
                    },
                });
                return;
            }
            this.emit({
                type: "update_agent_response",
                payload: { requestId, agentId, accepted: true, error: null },
            });
        }
        catch (error) {
            this.sessionLogger.error({ err: error, agentId, requestId }, "session: update_agent_request error");
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to update agent: ${getErrorMessage(error)}`,
                },
            });
            this.emit({
                type: "update_agent_response",
                payload: {
                    requestId,
                    agentId,
                    accepted: false,
                    error: getErrorMessageOr(error, "Failed to update agent"),
                },
            });
        }
    }
    async handleProjectRenameRequest(projectId, customName, requestId) {
        this.sessionLogger.info({ projectId, requestId, hasCustomName: typeof customName === "string" }, "session: project.rename.request");
        try {
            const existing = await this.projectRegistry.get(projectId);
            if (!existing) {
                this.emit({
                    type: "project.rename.response",
                    payload: {
                        requestId,
                        projectId,
                        accepted: false,
                        customName: null,
                        error: "Project not found",
                    },
                });
                return;
            }
            const trimmed = customName?.trim() ?? "";
            const nextCustomName = trimmed.length === 0 ? null : trimmed;
            const updated = {
                ...existing,
                customName: nextCustomName,
                updatedAt: new Date().toISOString(),
            };
            await this.projectRegistry.upsert(updated);
            this.emit({
                type: "project.rename.response",
                payload: {
                    requestId,
                    projectId,
                    accepted: true,
                    customName: nextCustomName,
                    error: null,
                },
            });
            // Emit a project.update so clients that track the project as an empty
            // project (no workspaces yet) receive the resolved name immediately.
            this.emitProjectUpdate({ kind: "upsert", project: updated });
            // Re-emit descriptors for every workspace under this project so the new
            // resolved name lands in the UI immediately.
            const workspaces = await this.workspaceRegistry.list();
            const affectedWorkspaceIds = workspaces
                .filter((workspace) => workspace.projectId === existing.projectId)
                .map((workspace) => workspace.workspaceId);
            if (affectedWorkspaceIds.length > 0) {
                await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
            }
        }
        catch (error) {
            this.sessionLogger.error({ err: error, projectId, requestId }, "session: project.rename.request error");
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to rename project: ${getErrorMessage(error)}`,
                },
            });
            this.emit({
                type: "project.rename.response",
                payload: {
                    requestId,
                    projectId,
                    accepted: false,
                    customName: null,
                    error: getErrorMessageOr(error, "Failed to rename project"),
                },
            });
        }
    }
    async handleProjectIconSetRequest(request) {
        const { projectId, requestId } = request;
        try {
            const updated = await setProjectCustomIcon({
                paseoHome: this.paseoHome,
                projectId,
                source: request.source,
                projects: this.projectRegistry,
            });
            this.emit({
                type: "project.icon.set.response",
                payload: { requestId, projectId, accepted: true, error: null },
            });
            this.emitProjectUpdate({ kind: "upsert", project: updated });
            const affectedWorkspaceIds = (await this.workspaceRegistry.list())
                .filter((workspace) => workspace.projectId === projectId)
                .map((workspace) => workspace.workspaceId);
            if (affectedWorkspaceIds.length > 0) {
                await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
            }
        }
        catch (error) {
            this.emit({
                type: "project.icon.set.response",
                payload: {
                    requestId,
                    projectId,
                    accepted: false,
                    error: getErrorMessageOr(error, "Failed to update project icon"),
                },
            });
        }
    }
    async handleProjectIconGetRequest(projectId, requestId) {
        try {
            const project = await this.projectRegistry.get(projectId);
            if (!project)
                throw new Error("Project not found");
            const icon = await readProjectIcon({ paseoHome: this.paseoHome, project });
            this.emit({
                type: "project.icon.get.response",
                payload: { projectId, icon, error: null, requestId },
            });
        }
        catch (error) {
            this.emit({
                type: "project.icon.get.response",
                payload: { projectId, icon: null, error: getErrorMessage(error), requestId },
            });
        }
    }
    async handleProjectRemoveRequest(request) {
        const { projectId, requestId } = request;
        this.sessionLogger.info({ projectId, requestId }, "session: project.remove.request");
        try {
            const project = await this.projectRegistry.get(projectId);
            const resolvedProjectId = project?.projectId ?? projectId;
            const projectWorkspaces = (await this.workspaceRegistry.list()).filter((workspace) => workspace.projectId === resolvedProjectId);
            const activeWorkspaceIds = projectWorkspaces
                .filter((workspace) => !workspace.archivedAt)
                .map((workspace) => workspace.workspaceId);
            if (activeWorkspaceIds.length > 0) {
                this.markWorkspaceArchiving(activeWorkspaceIds, new Date().toISOString());
                await this.emitWorkspaceUpdatesForWorkspaceIds(activeWorkspaceIds);
            }
            const removedWorkspaceIds = [];
            try {
                for (const workspaceId of activeWorkspaceIds) {
                    await archiveWorkspaceContents({
                        agentManager: this.agentManager,
                        agentStorage: this.agentStorage,
                        killTerminalsForWorkspace: (id) => this.terminalController.killTerminalsForWorkspace(id),
                        sessionLogger: this.sessionLogger,
                    }, workspaceId);
                    await this.archiveWorkspaceRecord(workspaceId);
                    removedWorkspaceIds.push(workspaceId);
                }
                await this.projectRegistry.remove(resolvedProjectId);
                await removeProjectCustomIcon({
                    paseoHome: this.paseoHome,
                    projectId: resolvedProjectId,
                }).catch((error) => {
                    this.sessionLogger.warn({ err: error, projectId: resolvedProjectId }, "Failed to clean up removed project icon");
                });
            }
            finally {
                if (activeWorkspaceIds.length > 0) {
                    this.clearWorkspaceArchiving(activeWorkspaceIds);
                }
            }
            const updateIds = removedWorkspaceIds.length > 0
                ? removedWorkspaceIds
                : [projectWorkspaces[0]?.workspaceId ?? projectId];
            await this.emitWorkspaceUpdatesForWorkspaceIds(updateIds, {
                removedProjectId: projectId,
            });
            this.emit({
                type: "project.remove.response",
                payload: {
                    requestId,
                    projectId,
                    accepted: true,
                    removedWorkspaceIds,
                    error: null,
                },
            });
        }
        catch (error) {
            this.sessionLogger.error({ err: error, projectId, requestId }, "session: project.remove.request error");
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to remove project: ${getErrorMessage(error)}`,
                },
            });
            this.emit({
                type: "project.remove.response",
                payload: {
                    requestId,
                    projectId,
                    accepted: false,
                    removedWorkspaceIds: [],
                    error: getErrorMessageOr(error, "Failed to remove project"),
                },
            });
        }
    }
    async handleWorkspaceTitleSetRequest(workspaceId, title, requestId) {
        this.sessionLogger.info({ workspaceId, requestId, hasTitle: typeof title === "string" }, "session: workspace.title.set.request");
        try {
            const trimmed = title?.trim() ?? "";
            const nextTitle = trimmed.length === 0 ? null : trimmed;
            const updatedAt = new Date().toISOString();
            const updated = await this.workspaceRegistry.update(workspaceId, (existing) => ({
                ...existing,
                title: nextTitle,
                updatedAt,
            }));
            if (!updated) {
                this.emit({
                    type: "workspace.title.set.response",
                    payload: {
                        requestId,
                        workspaceId,
                        accepted: false,
                        title: null,
                        error: "Workspace not found",
                    },
                });
                return;
            }
            this.emit({
                type: "workspace.title.set.response",
                payload: {
                    requestId,
                    workspaceId,
                    accepted: true,
                    title: nextTitle,
                    error: null,
                },
            });
            await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
        }
        catch (error) {
            this.sessionLogger.error({ err: error, workspaceId, requestId }, "session: workspace.title.set.request error");
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to set workspace title: ${getErrorMessage(error)}`,
                },
            });
            this.emit({
                type: "workspace.title.set.response",
                payload: {
                    requestId,
                    workspaceId,
                    accepted: false,
                    title: null,
                    error: getErrorMessageOr(error, "Failed to set workspace title"),
                },
            });
        }
    }
    async handleWorkspacePinSetRequest(workspaceId, pinned, requestId) {
        const logContext = { workspaceId, pinned, requestId };
        this.sessionLogger.info(logContext, "session: workspace.pin.set.request");
        const emitResponse = (accepted, pinnedAt, error) => {
            this.emit({
                type: "workspace.pin.set.response",
                payload: { requestId, workspaceId, accepted, pinnedAt, error },
            });
        };
        try {
            const nextPinnedAt = pinned ? new Date().toISOString() : null;
            const updatedAt = new Date().toISOString();
            const updated = await this.workspaceRegistry.update(workspaceId, (existing) => ({
                ...existing,
                pinnedAt: nextPinnedAt,
                updatedAt,
            }));
            if (!updated) {
                emitResponse(false, null, "Workspace not found");
                return;
            }
            emitResponse(true, nextPinnedAt, null);
            await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
        }
        catch (error) {
            this.sessionLogger.error({ ...logContext, err: error }, "session: workspace.pin.set.request error");
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to pin workspace: ${getErrorMessage(error)}`,
                },
            });
            emitResponse(false, null, getErrorMessageOr(error, "Failed to pin workspace"));
        }
    }
    async handleWorkspaceRecoveryInspectRequest(request) {
        const state = await this.workspaceRecovery.inspect(request.workspaceId);
        this.emit({
            type: "workspace.recovery.inspect.response",
            payload: {
                requestId: request.requestId,
                state,
            },
        });
    }
    async handleWorkspaceRecoveryRestoreRequest(request) {
        try {
            await this.restoreWorkspaceAndEmit(request.workspaceId);
            this.emit({
                type: "workspace.recovery.restore.response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    accepted: true,
                    error: null,
                },
            });
        }
        catch (error) {
            const message = getErrorMessageOr(error, "Failed to recover workspace");
            this.sessionLogger.warn({ err: error, workspaceId: request.workspaceId, requestId: request.requestId }, "session: workspace.recovery.restore.request rejected");
            this.emit({
                type: "workspace.recovery.restore.response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    accepted: false,
                    error: message,
                },
            });
        }
    }
    /**
     * Handle text message to agent (with optional image attachments)
     */
    async handleSendAgentMessage(agentId, text, messageId, images, attachments, runOptions, options) {
        this.sessionLogger.info({
            agentId,
            textPreview: text.substring(0, 50),
            imageCount: images?.length ?? 0,
            attachmentCount: attachments?.length ?? 0,
        }, `Sending text to agent ${agentId}${images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ""}${attachments && attachments.length > 0
            ? ` and ${attachments.length} structured attachment(s)`
            : ""}`);
        const promptText = options?.spokenInput ? wrapSpokenInput(text) : text;
        const prompt = buildAgentPrompt(promptText, images, attachments);
        try {
            await sendPromptToAgent({
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                agentId,
                prompt,
                messageId,
                runOptions,
                logger: this.sessionLogger,
            });
            return { ok: true };
        }
        catch (error) {
            this.handleAgentRunError(agentId, error, "Failed to send agent message");
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Handle create agent request
     */
    async handleCreateAgentRequest(msg) {
        const { config, worktreeName, requestId, initialPrompt, clientMessageId, outputSchema, git, worktree, autoArchive, images, attachments, env, } = msg;
        this.sessionLogger.info({ cwd: config.cwd, provider: config.provider, worktreeName }, `Creating agent in ${config.cwd} (${config.provider})${worktreeName ? ` with worktree ${worktreeName}` : ""}`);
        let createdWorktreeForCleanup = null;
        let createdAgentId = null;
        try {
            const requestedCwd = resolve(config.cwd);
            const needsRequestedDirectory = Boolean(worktreeName || git || worktree) || (!msg.workspaceId && !msg.callerAgentId);
            if (needsRequestedDirectory && !(await this.filesystem.isDirectory(requestedCwd))) {
                throw new Error(`Working directory does not exist or is not a directory: ${requestedCwd}`);
            }
            const trimmedPrompt = initialPrompt?.trim();
            const { provisionalTitle } = resolveCreateAgentTitles({
                configTitle: config.title,
                initialPrompt: trimmedPrompt,
            });
            const firstAgentContext = {
                ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
                ...(attachments && attachments.length > 0 ? { attachments } : {}),
            };
            const workspacePromptTitle = resolveFirstAgentPromptTitle(firstAgentContext);
            const createdWorktree = await this.createAgentLifecycleDispatch.createWorktreeForRequest({
                cwd: config.cwd,
                target: worktree,
                firstAgentContext,
                hasLegacyGitOptions: Boolean(git),
            });
            createdWorktreeForCleanup = createdWorktree;
            const resolvedIntent = await this.resolveSessionCreateAgentIntent({
                request: msg,
                createdWorktree,
                workspacePromptTitle,
            });
            const resolvedCwd = resolve(resolvedIntent.config.cwd);
            if (!(await this.filesystem.isDirectory(resolvedCwd))) {
                throw new Error(`Working directory does not exist or is not a directory: ${resolvedCwd}`);
            }
            const { snapshot, liveSnapshot } = await createAgentCommand({
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
                paseoHome: this.paseoHome,
                worktreesRoot: this.worktreesRoot,
                providerSnapshotManager: this.providerSnapshotManager,
            }, {
                kind: "session",
                config: resolvedIntent.config,
                workspaceId: resolvedIntent.intent.workspaceId,
                worktreeName,
                initialPrompt,
                clientMessageId,
                outputSchema,
                images,
                attachments,
                git,
                labels: resolvedIntent.intent.labels,
                env,
                provisionalTitle,
                firstAgentContext,
                buildSessionConfig: (sessionConfig, gitOptions, legacyWorktreeName, ctx) => this.buildAgentSessionConfig(sessionConfig, gitOptions, legacyWorktreeName, ctx),
            });
            createdAgentId = snapshot.id;
            await this.agentUpdates.forwardLiveAgent(snapshot);
            if (resolvedIntent.createdDirectoryWorkspace && trimmedPrompt) {
                this.workspaceAutoName.scheduleForDirectory({
                    workspaceId: resolvedIntent.intent.workspaceId,
                    cwd: resolvedIntent.config.cwd,
                    firstAgentContext,
                }, { currentSelection: this.getFocusedAgentSelectionForCwd(resolvedIntent.config.cwd) });
            }
            this.createAgentLifecycleDispatch.registerAutoArchiveIfRequested({
                autoArchive,
                agentId: snapshot.id,
                createdWorktree,
            });
            if (requestId) {
                const agentPayload = await this.buildAgentPayload(liveSnapshot);
                this.emit({
                    type: "status",
                    payload: {
                        status: "agent_created",
                        agentId: liveSnapshot.id,
                        requestId,
                        agent: agentPayload,
                    },
                });
            }
            this.sessionLogger.info({ agentId: snapshot.id, provider: snapshot.provider }, `Created agent ${snapshot.id} (${snapshot.provider})`);
        }
        catch (error) {
            await this.createAgentLifecycleDispatch.cleanupCreatedWorktreeAfterFailedAgentCreate({
                createdWorktree: createdWorktreeForCleanup,
                createdAgentId,
            });
            const wireError = toWorktreeWireError(error);
            this.sessionLogger.error({ err: error }, "Failed to create agent");
            if (requestId) {
                this.emit({
                    type: "status",
                    payload: {
                        status: "agent_create_failed",
                        requestId,
                        error: wireError.message,
                        errorCode: wireError.code,
                    },
                });
            }
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to create agent: ${wireError.message}`,
                },
            });
        }
    }
    async resolveSessionCreateAgentIntent(input) {
        const { request, createdWorktree } = input;
        const callerAgent = request.callerAgentId
            ? this.agentManager.getAgent(request.callerAgentId)
            : null;
        if (request.callerAgentId && !callerAgent) {
            throw new Error(`Caller agent ${request.callerAgentId} not found`);
        }
        let config = request.config;
        const intent = await resolveCreateAgentIntent({
            explicitWorkspaceId: createdWorktree?.workspace.workspaceId ?? request.workspaceId,
            caller: callerAgent
                ? { id: callerAgent.id, cwd: callerAgent.cwd, workspaceId: callerAgent.workspaceId }
                : null,
            labels: request.labels,
            resolveWorkspace: async (workspaceId) => {
                if (createdWorktree?.workspace.workspaceId === workspaceId) {
                    return { workspaceId, cwd: createdWorktree.workspace.cwd };
                }
                const workspace = await this.workspaceRegistry.get(workspaceId);
                if (!workspace || workspace.archivedAt) {
                    throw new Error(`Workspace ${workspaceId} not found`);
                }
                return { workspaceId, cwd: workspace.cwd };
            },
            createWorkspace: async () => ({
                workspaceId: await this.workspaceProvisioning.resolveOrCreateWorkspaceIdForCreateAgent({
                    createdWorktree: null,
                    cwd: config.cwd,
                    initialTitle: input.workspacePromptTitle,
                }),
                cwd: config.cwd,
            }),
        });
        config = { ...config, cwd: intent.cwd };
        return {
            config,
            intent,
            createdDirectoryWorkspace: !createdWorktree && !request.workspaceId && !callerAgent,
        };
    }
    async handleResumeAgentRequest(msg) {
        const { handle, overrides, requestId } = msg;
        if (!handle) {
            this.sessionLogger.warn("Resume request missing persistence handle");
            if (requestId) {
                this.emit({
                    type: "rpc_error",
                    payload: {
                        requestId,
                        requestType: msg.type,
                        error: "Unable to resume agent: missing persistence handle",
                        code: "agent_resume_failed",
                    },
                });
            }
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: "Unable to resume agent: missing persistence handle",
                },
            });
            return;
        }
        this.sessionLogger.info({ sessionId: handle.sessionId, provider: handle.provider }, `Resuming agent ${handle.sessionId} (${handle.provider})`);
        try {
            const matched = await this.unarchiveAgentByHandle(handle);
            const effectiveOverrides = matched
                ? { ...buildConfigOverrides(matched.record), ...overrides }
                : overrides;
            let snapshot;
            try {
                snapshot = await this.agentManager.resumeAgentFromPersistence(handle, effectiveOverrides);
            }
            catch (error) {
                if (matched?.didUnarchive && matched.originalArchivedAt) {
                    await this.agentManager.archiveSnapshot(matched.record.id, matched.originalArchivedAt);
                }
                throw error;
            }
            await unarchiveAgentState(this.agentStorage, this.agentManager, snapshot.id);
            await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
            await this.agentUpdates.forwardLiveAgent(snapshot);
            const timelineSize = this.agentManager.getTimeline(snapshot.id).length;
            if (requestId) {
                const agentPayload = await this.buildAgentPayload(snapshot);
                this.emit({
                    type: "status",
                    payload: {
                        status: "agent_resumed",
                        agentId: snapshot.id,
                        requestId,
                        timelineSize,
                        agent: agentPayload,
                    },
                });
            }
        }
        catch (error) {
            const message = getErrorMessage(error);
            this.sessionLogger.error({ err: error }, "Failed to resume agent");
            if (requestId) {
                this.emit({
                    type: "rpc_error",
                    payload: {
                        requestId,
                        requestType: msg.type,
                        error: message,
                        code: "agent_resume_failed",
                    },
                });
            }
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to resume agent: ${message}`,
                },
            });
        }
    }
    async handleImportAgentRequest(msg) {
        const normalized = normalizeImportAgentRequest(msg);
        if ("error" in normalized) {
            this.emit({
                type: "status",
                payload: {
                    status: "agent_create_failed",
                    requestId: msg.requestId,
                    error: normalized.error,
                },
            });
            return;
        }
        const { provider, providerHandleId, requestId } = normalized;
        this.sessionLogger.info({ providerHandleId, provider }, `Importing agent ${providerHandleId} (${provider})`);
        try {
            if (!normalized.cwd) {
                throw new Error("Import requires cwd from the selected provider session");
            }
            const { snapshot, timelineSize, createdWorkspace } = await importProviderSession({
                request: normalized,
                workspaceProvisioning: this.workspaceProvisioning,
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
            });
            if (createdWorkspace) {
                await this.registerWorkspaceForImportedAgent(createdWorkspace);
            }
            const agentPayload = await this.buildAgentPayload(snapshot);
            this.emit({
                type: "status",
                payload: {
                    status: "agent_resumed",
                    agentId: snapshot.id,
                    requestId,
                    timelineSize,
                    agent: agentPayload,
                },
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.sessionLogger.error({ err: error }, "Failed to import agent");
            this.emit({
                type: "status",
                payload: {
                    status: "agent_create_failed",
                    requestId,
                    error: message,
                },
            });
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to import agent: ${message}`,
                },
            });
        }
    }
    async handleRefreshAgentRequest(msg) {
        const { agentId, requestId } = msg;
        this.sessionLogger.info({ agentId }, `Refreshing agent ${agentId} from persistence`);
        try {
            await this.restoreOwningWorkspaceForLegacyAgentRefresh(agentId);
            await unarchiveAgentState(this.agentStorage, this.agentManager, agentId);
            let snapshot;
            const existing = this.agentManager.getAgent(agentId);
            if (existing) {
                await this.interruptAgentIfRunning(agentId);
                snapshot = await this.agentManager.reloadAgentSession(agentId, undefined, {
                    rehydrateFromDisk: true,
                });
            }
            else {
                const record = await this.agentStorage.get(agentId);
                if (!record) {
                    throw new Error(`Agent not found: ${agentId}`);
                }
                const registeredProviderIds = this.providerSnapshotManager.listRegisteredProviderIds();
                if (!isStoredAgentProviderAvailable(record, registeredProviderIds)) {
                    throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
                }
                if (!toAgentPersistenceHandle(registeredProviderIds, record.persistence)) {
                    throw new Error(`Agent ${agentId} cannot be refreshed because it lacks persistence`);
                }
                // Share the loader's per-agent in-flight operation with timeline fetches.
                // Unarchiving publishes the record before provider resume finishes, so
                // the agent pane can otherwise race this request and resume it twice.
                snapshot = await ensureAgentLoaded(agentId, {
                    agentManager: this.agentManager,
                    agentStorage: this.agentStorage,
                    broadcastTimeline: true,
                    logger: this.sessionLogger,
                });
            }
            await this.agentManager.hydrateTimelineFromProvider(agentId, { broadcast: true });
            await this.agentUpdates.forwardLiveAgent(snapshot);
            const timelineSize = this.agentManager.getTimeline(agentId).length;
            if (requestId) {
                this.emit({
                    type: "status",
                    payload: {
                        status: "agent_refreshed",
                        agentId,
                        requestId,
                        timelineSize,
                    },
                });
            }
        }
        catch (error) {
            const message = getErrorMessage(error);
            this.sessionLogger.error({ err: error, agentId }, `Failed to refresh agent ${agentId}`);
            if (requestId) {
                this.emit({
                    type: "rpc_error",
                    payload: {
                        requestId,
                        requestType: msg.type,
                        error: message,
                        code: error instanceof WorktreeRequestError ? error.code : "agent_refresh_failed",
                    },
                });
            }
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to refresh agent: ${message}`,
                },
            });
        }
    }
    async handleCancelAgentRequest(agentId, requestId) {
        this.sessionLogger.info({ agentId }, `Cancel request received for agent ${agentId}`);
        try {
            await cancelAgentRunCommand({ agentManager: this.agentManager, logger: this.sessionLogger }, agentId);
            if (requestId) {
                const agent = this.agentManager.getAgent(agentId);
                const payload = agent ? await this.buildAgentPayload(agent) : null;
                this.emit({
                    type: "cancel_agent_response",
                    payload: {
                        requestId,
                        agentId,
                        agent: payload,
                        error: null,
                    },
                });
            }
        }
        catch (error) {
            if (requestId) {
                this.sessionLogger.error({ err: error, agentId }, `Failed to cancel running agent on request for agent ${agentId}`);
                const agent = this.agentManager.getAgent(agentId);
                const payload = agent ? await this.buildAgentPayload(agent) : null;
                this.emit({
                    type: "cancel_agent_response",
                    payload: {
                        requestId,
                        agentId,
                        agent: payload,
                        error: errorToFriendlyMessage(error),
                    },
                });
            }
            else {
                this.handleAgentRunError(agentId, error, "Failed to cancel running agent on request");
            }
        }
    }
    async handleAgentRewindRequest(msg) {
        try {
            await this.agentManager.rewind(msg.agentId, msg.messageId, msg.mode);
            this.emit({
                type: "agent.rewind.response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    ok: true,
                    error: null,
                },
            });
        }
        catch (error) {
            this.emit({
                type: "agent.rewind.response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    ok: false,
                    error: error instanceof Error ? error.message : "Failed to rewind agent",
                },
            });
        }
    }
    async buildAgentSessionConfig(config, gitOptions, legacyWorktreeName, firstAgentContext) {
        return buildWorktreeAgentSessionConfig({
            paseoHome: this.paseoHome,
            worktreesRoot: this.worktreesRoot,
            sessionLogger: this.sessionLogger,
            workspaceGitService: this.workspaceGitService,
            createPaseoWorktree: (input, serviceOptions) => this.createPaseoWorktreeWorkflow(input, {
                ...serviceOptions,
                setupContinuation: {
                    kind: "agent",
                    terminalManager: this.terminalManager,
                    appendTimelineItem: ({ agentId, item }) => appendTimelineItemIfAgentKnown({
                        agentManager: this.agentManager,
                        agentId,
                        item,
                    }),
                    emitLiveTimelineItem: ({ agentId, item }) => emitLiveTimelineItemIfAgentKnown({
                        agentManager: this.agentManager,
                        agentId,
                        item,
                    }),
                    logger: this.sessionLogger,
                },
            }),
            checkoutExistingBranch: (cwd, branch) => this.gitMutation.checkoutExistingBranch(cwd, branch),
            createBranchFromBase: (params) => this.gitMutation.createBranchFromBase(params),
        }, config, gitOptions, legacyWorktreeName, firstAgentContext);
    }
    isPathWithinRoot(rootPath, candidatePath) {
        const resolvedRoot = resolve(rootPath);
        const resolvedCandidate = resolve(candidatePath);
        if (resolvedCandidate === resolvedRoot) {
            return true;
        }
        return resolvedCandidate.startsWith(resolvedRoot + sep);
    }
    /**
     * Handle clearing agent attention flag
     */
    async handleClearAgentAttention(agentId, requestId) {
        const agentIds = Array.isArray(agentId) ? agentId : [agentId];
        try {
            await Promise.all(agentIds.map((id) => ensureAgentLoaded(id, {
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
            })));
            await Promise.all(agentIds.map((id) => this.agentManager.clearAgentAttention(id)));
            if (requestId) {
                const agents = (await Promise.all(agentIds.map(async (id) => {
                    const agent = this.agentManager.getAgent(id);
                    return agent ? this.buildAgentPayload(agent) : null;
                }))).filter((payload) => payload !== null);
                this.emit({
                    type: "clear_agent_attention_response",
                    payload: {
                        requestId,
                        agentId,
                        agents,
                    },
                });
            }
        }
        catch (error) {
            this.sessionLogger.error({ err: error, agentIds }, "Failed to clear agent attention");
            // Don't throw - this is not critical
        }
    }
    /**
     * Handle client heartbeat for activity tracking
     */
    handleClientHeartbeat(msg) {
        const focusedTerminalId = msg.focusedTerminalId?.trim() || null;
        const appVisibilityChangedAt = msg.appVisibilityChangedAt
            ? new Date(msg.appVisibilityChangedAt)
            : new Date(msg.lastActivityAt);
        this.clientActivity = {
            deviceType: msg.deviceType,
            focusedAgentId: msg.focusedAgentId,
            focusedTerminalId,
            lastActivityAt: new Date(msg.lastActivityAt),
            appVisible: msg.appVisible,
            appVisibilityChangedAt,
        };
        if (msg.appVisible && focusedTerminalId) {
            void this.clearFocusedTerminalAttention(focusedTerminalId);
        }
    }
    async clearFocusedTerminalAttention(terminalId) {
        const terminalManager = this.terminalManager;
        if (!terminalManager) {
            return;
        }
        try {
            await terminalManager.clearTerminalAttention(terminalId);
        }
        catch (error) {
            this.sessionLogger.warn({ err: error, terminalId }, "Failed to clear terminal attention");
        }
    }
    /**
     * Handle push token registration
     */
    handleRegisterPushToken(token) {
        this.pushTokenStore.addToken(token);
        this.sessionLogger.info("Registered push token");
    }
    /**
     * Handle list commands request for an agent
     */
    async handleListCommandsRequest(msg) {
        const { agentId, requestId, draftConfig } = msg;
        this.sessionLogger.debug({ agentId, draftConfig }, `Handling list commands request for agent ${agentId}`);
        try {
            const existing = this.agentManager.getAgent(agentId);
            const stored = existing ? null : await this.agentStorage.get(agentId);
            const agent = existing || (stored && !stored.archivedAt)
                ? await ensureAgentLoaded(agentId, {
                    agentManager: this.agentManager,
                    agentStorage: this.agentStorage,
                    logger: this.sessionLogger,
                })
                : null;
            if (agent?.session?.listCommands) {
                const commands = await agent.session.listCommands();
                this.emit({
                    type: "list_commands_response",
                    payload: {
                        agentId,
                        commands,
                        error: null,
                        requestId,
                    },
                });
                return;
            }
            if (!agent && draftConfig) {
                const sessionConfig = {
                    provider: draftConfig.provider,
                    cwd: expandTilde(draftConfig.cwd),
                    ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
                    ...(draftConfig.model ? { model: draftConfig.model } : {}),
                    ...(draftConfig.thinkingOptionId
                        ? { thinkingOptionId: draftConfig.thinkingOptionId }
                        : {}),
                };
                const commands = await this.agentManager.listDraftCommands(sessionConfig);
                this.emit({
                    type: "list_commands_response",
                    payload: {
                        agentId,
                        commands,
                        error: null,
                        requestId,
                    },
                });
                return;
            }
            this.emit({
                type: "list_commands_response",
                payload: {
                    agentId,
                    commands: [],
                    error: agent ? `Agent does not support listing commands` : `Agent not found: ${agentId}`,
                    requestId,
                },
            });
        }
        catch (error) {
            this.sessionLogger.error({ err: error, agentId, draftConfig }, "Failed to list commands");
            this.emit({
                type: "list_commands_response",
                payload: {
                    agentId,
                    commands: [],
                    error: getErrorMessage(error),
                    requestId,
                },
            });
        }
    }
    /**
     * Handle agent permission response from user
     */
    async handleAgentPermissionResponse(agentId, requestId, response) {
        try {
            await respondToAgentPermission({
                agentManager: this.agentManager,
                agentId,
                requestId,
                response,
                logger: this.sessionLogger,
            });
        }
        catch (error) {
            this.sessionLogger.error({ err: error, agentId, requestId }, "Failed to respond to permission");
            this.emit({
                type: "activity_log",
                payload: {
                    id: uuidv4(),
                    timestamp: new Date(),
                    type: "error",
                    content: `Failed to respond to permission: ${getErrorMessage(error)}`,
                },
            });
            throw error;
        }
    }
    async handleDirectorySuggestionsRequest(msg) {
        const { query, limit, requestId, cwd, includeFiles, includeDirectories, matchMode } = msg;
        try {
            const workspaceCwd = cwd?.trim();
            const searchesWorkspace = Boolean(workspaceCwd);
            const entries = await searchDirectoryEntries({
                root: workspaceCwd ? expandTilde(workspaceCwd) : (process.env.HOME ?? homedir()),
                query,
                pathFormat: searchesWorkspace ? "relative" : "absolute",
                pathQueryPolicy: searchesWorkspace ? "slashes" : "rooted",
                blankQueryBehavior: searchesWorkspace ? "children" : "none",
                rootAliases: searchesWorkspace ? [] : ["~"],
                traversableHiddenDirectoryNames: searchesWorkspace
                    ? WORKSPACE_SEARCH_HIDDEN_DIRECTORIES
                    : [],
                confidentResultScanThreshold: searchesWorkspace ? undefined : 5000,
                respectGitIgnore: searchesWorkspace,
                includeFiles,
                includeDirectories,
                matchMode,
                limit,
            });
            const directories = entries
                .filter((entry) => entry.kind === "directory")
                .map((entry) => entry.path);
            this.emit({
                type: "directory_suggestions_response",
                payload: {
                    directories,
                    entries,
                    error: null,
                    requestId,
                },
            });
        }
        catch (error) {
            this.emit({
                type: "directory_suggestions_response",
                payload: {
                    directories: [],
                    entries: [],
                    error: error instanceof Error ? error.message : String(error),
                    requestId,
                },
            });
        }
    }
    async handlePaseoWorktreeListRequest(msg) {
        return handleWorktreeListRequest({
            emit: (message) => this.emit(message),
            paseoHome: this.paseoHome,
            workspaceGitService: this.workspaceGitService,
        }, msg);
    }
    async handlePaseoWorktreeArchiveRequest(msg) {
        return handleWorktreeArchiveRequest({
            paseoHome: this.paseoHome,
            paseoWorktreesBaseRoot: this.worktreesRoot,
            github: this.github,
            workspaceGitService: this.workspaceGitService,
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
            listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
            archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
            emit: (message) => this.emit(message),
            emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) => this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
            markWorkspaceArchiving: (workspaceIds, archivingAt) => this.markWorkspaceArchiving(workspaceIds, archivingAt),
            clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
            killTerminalsForWorkspace: (workspaceId) => this.terminalController.killTerminalsForWorkspace(workspaceId),
            sessionLogger: this.sessionLogger,
        }, msg);
    }
    async listTerminalActivityContributions() {
        const terminalManager = this.terminalManager;
        if (!terminalManager) {
            return [];
        }
        const directories = terminalManager.listDirectories();
        const terminalsByDirectory = await Promise.all(directories.map((cwd) => terminalManager.getTerminals(cwd)));
        return terminalsByDirectory.flat().map((session) => {
            const contribution = {
                cwd: session.cwd,
                activity: session.getActivity(),
            };
            if (session.workspaceId) {
                contribution.workspaceId = session.workspaceId;
            }
            return contribution;
        });
    }
    /**
     * Build the current agent list payload (live + persisted), optionally filtered by labels.
     */
    async listAgentPayloads(filter) {
        const includeArchived = filter?.includeArchived === true;
        const labelEntries = filter?.labels ? Object.entries(filter.labels) : [];
        // Get live agents with session modes
        const agentSnapshots = this.agentManager.listAgents();
        const liveAgents = await Promise.all(agentSnapshots.map((agent) => this.buildAgentPayload(agent)));
        // Add persisted agents that have not been lazily initialized yet
        // (excluding internal agents which are for ephemeral system tasks)
        const registryRecords = await this.agentStorage.list();
        const liveIds = new Set(agentSnapshots.map((a) => a.id));
        const registeredProviderIds = new Set(this.providerSnapshotManager.listRegisteredProviderIds());
        const persistedAgents = registryRecords
            .filter((record) => !liveIds.has(record.id) && !record.internal)
            // Keep raw-record filters ahead of projection; seeded homes can carry thousands of archived agents.
            .filter((record) => includeArchived || !record.archivedAt)
            .filter((record) => labelEntries.every(([key, value]) => record.labels?.[key] === value))
            .filter((record) => filter?.includeUnavailablePersisted === true ||
            isStoredAgentProviderAvailable(record, registeredProviderIds))
            .map((record) => this.buildStoredAgentPayload(record, registeredProviderIds));
        let agents = [...liveAgents, ...persistedAgents];
        agents = agents.filter((agent) => this.isProviderVisibleToClient(agent.provider));
        if (!includeArchived) {
            agents = agents.filter((agent) => !agent.archivedAt);
        }
        // Filter by labels if filter provided
        if (labelEntries.length > 0) {
            agents = agents.filter((agent) => labelEntries.every(([key, value]) => agent.labels[key] === value));
        }
        return agents;
    }
    async resolveAgentIdentifier(identifier) {
        const trimmed = identifier.trim();
        if (!trimmed) {
            return { ok: false, error: "Agent identifier cannot be empty" };
        }
        const stored = await this.agentStorage.list();
        const storedRecords = stored.filter((record) => !record.internal);
        const knownIds = new Set();
        for (const record of storedRecords) {
            knownIds.add(record.id);
        }
        for (const agent of this.agentManager.listAgents()) {
            knownIds.add(agent.id);
        }
        if (knownIds.has(trimmed)) {
            return { ok: true, agentId: trimmed };
        }
        const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
        if (prefixMatches.length === 1) {
            return { ok: true, agentId: prefixMatches[0] };
        }
        if (prefixMatches.length > 1) {
            return {
                ok: false,
                error: `Agent identifier "${trimmed}" is ambiguous (${prefixMatches
                    .slice(0, 5)
                    .map((id) => id.slice(0, 8))
                    .join(", ")}${prefixMatches.length > 5 ? ", …" : ""})`,
            };
        }
        const titleMatches = storedRecords.filter((record) => record.title === trimmed);
        if (titleMatches.length === 1) {
            return { ok: true, agentId: titleMatches[0].id };
        }
        if (titleMatches.length > 1) {
            return {
                ok: false,
                error: `Agent title "${trimmed}" is ambiguous (${titleMatches
                    .slice(0, 5)
                    .map((r) => r.id.slice(0, 8))
                    .join(", ")}${titleMatches.length > 5 ? ", …" : ""})`,
            };
        }
        return { ok: false, error: `Agent not found: ${trimmed}` };
    }
    async getAgentPayloadById(agentId) {
        const live = this.agentManager.getAgent(agentId);
        if (live) {
            const payload = await this.buildAgentPayload(live);
            return this.isProviderVisibleToClient(payload.provider) ? payload : null;
        }
        const record = await this.agentStorage.get(agentId);
        if (!record || record.internal) {
            return null;
        }
        const payload = this.buildStoredAgentPayload(record);
        return this.isProviderVisibleToClient(payload.provider) ? payload : null;
    }
    async resolveDelegationRootWorkspaceId(agentId) {
        const seen = new Set();
        let currentAgentId = agentId;
        while (true) {
            if (seen.has(currentAgentId)) {
                return null;
            }
            seen.add(currentAgentId);
            const live = this.agentManager.getAgent(currentAgentId);
            const source = live ?? (await this.agentStorage.get(currentAgentId));
            if (!source) {
                return null;
            }
            if ("archivedAt" in source && source.archivedAt) {
                return null;
            }
            const parentAgentId = getParentAgentIdFromLabels(source.labels);
            if (!parentAgentId) {
                return source.workspaceId ?? null;
            }
            currentAgentId = parentAgentId;
        }
    }
    async buildActiveProjectPlacementsByWorkspaceId() {
        const [persistedWorkspaces, persistedProjects] = await Promise.all([
            this.workspaceRegistry.list(),
            this.projectRegistry.list(),
        ]);
        const activeProjects = new Map(persistedProjects
            .filter((project) => !project.archivedAt)
            .map((project) => [project.projectId, project]));
        const placementsByWorkspaceId = new Map();
        const pairs = persistedWorkspaces.flatMap((workspace) => {
            if (workspace.archivedAt)
                return [];
            const project = activeProjects.get(workspace.projectId);
            if (!project)
                return [];
            return [{ workspace, project }];
        });
        const placements = await Promise.all(pairs.map(({ workspace, project }) => this.buildProjectPlacementForWorkspace(workspace, project)));
        for (let i = 0; i < pairs.length; i += 1) {
            placementsByWorkspaceId.set(pairs[i].workspace.workspaceId, placements[i]);
        }
        return placementsByWorkspaceId;
    }
    async collectFetchAgentsEntries(params) {
        const { candidates, limit, getPlacement, filter } = params;
        const matchedEntries = [];
        const batchSize = 25;
        for (let start = 0; start < candidates.length && matchedEntries.length <= limit; start += batchSize) {
            const batch = candidates.slice(start, start + batchSize);
            const batchEntries = await Promise.all(batch.map(async (agent) => {
                const project = await getPlacement(agent.workspaceId);
                return project ? { agent, project } : null;
            }));
            for (const entry of batchEntries) {
                if (!entry) {
                    continue;
                }
                if (!matchesAgentUpdatesFilter({
                    agent: entry.agent,
                    project: entry.project,
                    filter,
                })) {
                    continue;
                }
                matchedEntries.push(entry);
                if (matchedEntries.length > limit) {
                    break;
                }
            }
        }
        return matchedEntries;
    }
    async listFetchAgentsEntries(request) {
        const filter = request.type === "fetch_agent_history_request" &&
            request.filter?.includeArchived === undefined
            ? { ...request.filter, includeArchived: true }
            : request.filter;
        const scope = request.type === "fetch_agents_request" ? request.scope : undefined;
        const sort = this.agentsPager.normalizeSort(request.sort);
        let agents = await this.listAgentPayloads({
            labels: filter?.labels,
            includeArchived: filter?.includeArchived,
            includeUnavailablePersisted: request.type === "fetch_agent_history_request",
        });
        const activePlacementsByWorkspaceId = scope === "active" ? await this.buildActiveProjectPlacementsByWorkspaceId() : null;
        if (activePlacementsByWorkspaceId) {
            agents = agents.filter((agent) => !agent.archivedAt &&
                agent.workspaceId != null &&
                activePlacementsByWorkspaceId.has(agent.workspaceId));
        }
        const placementByWorkspaceId = new Map();
        const getPlacement = (workspaceId) => {
            if (!workspaceId) {
                return Promise.resolve(null);
            }
            if (activePlacementsByWorkspaceId) {
                return Promise.resolve(activePlacementsByWorkspaceId.get(workspaceId) ?? null);
            }
            const existing = placementByWorkspaceId.get(workspaceId);
            if (existing) {
                return existing;
            }
            const placementPromise = this.buildProjectPlacementForWorkspaceId(workspaceId);
            placementByWorkspaceId.set(workspaceId, placementPromise);
            return placementPromise;
        };
        const search = agentDirectorySearchQuery(request);
        if (search) {
            return this.listRankedAgentHistoryEntries({
                search,
                agents,
                sort,
                filter,
                getPlacement,
                page: request.page,
            });
        }
        let candidates = [...agents];
        candidates.sort((left, right) => this.agentsPager.compare(left, right, sort));
        const cursorToken = request.page?.cursor;
        if (cursorToken) {
            const cursor = this.decodeAgentCursor(cursorToken, sort);
            candidates = candidates.filter((agent) => this.agentsPager.compareWithCursor(agent, cursor, sort) > 0);
        }
        const limit = request.page?.limit ?? 200;
        const matchedEntries = await this.collectFetchAgentsEntries({
            candidates,
            limit,
            getPlacement,
            filter,
        });
        const pagedEntries = matchedEntries.slice(0, limit);
        const hasMore = matchedEntries.length > limit;
        const nextCursor = hasMore && pagedEntries.length > 0
            ? this.agentsPager.encode(pagedEntries[pagedEntries.length - 1].agent, sort)
            : null;
        return {
            entries: pagedEntries,
            pageInfo: {
                nextCursor,
                prevCursor: request.page?.cursor ?? null,
                hasMore,
            },
        };
    }
    /**
     * The searched history page. Ranking has to see every candidate before it can
     * name the best one, so this path resolves placements for the whole set
     * instead of stopping at the page limit — that is what makes a query answer
     * from all persisted sessions rather than from the first page of them.
     */
    async listRankedAgentHistoryEntries(params) {
        const { search, agents, sort, filter, getPlacement, page } = params;
        if (page?.cursor) {
            // A ranked result set has no pages to walk, so a cursor here is caller
            // misuse. Returning the ranked head instead would hide it.
            throw new SessionRequestError("invalid_cursor", "A history search returns one ranked page; it cannot be paged with a cursor.");
        }
        const allEntries = await this.collectFetchAgentsEntries({
            candidates: agents,
            limit: Number.MAX_SAFE_INTEGER,
            getPlacement,
            filter,
        });
        const ranked = rankAgentHistoryCandidates(search, allEntries, (left, right) => this.agentsPager.compare(left.agent, right.agent, sort));
        const limit = page?.limit ?? 200;
        // Ranges are derived only for the rows that will be rendered; ranking
        // itself never needs them.
        const entries = ranked.slice(0, limit).map((result) => Object.assign({}, result.candidate, {
            searchScore: result.searchScore,
            searchMatches: describeAgentHistoryMatches(search, result.candidate),
        }));
        return {
            entries,
            // No next page exists, so `hasMore` is false and truncation is reported
            // on its own field. See the note on rankAgentHistoryCandidates.
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            searchTruncated: ranked.length > limit,
        };
    }
    decodeAgentCursor(token, sort) {
        try {
            return this.agentsPager.decode(token, sort);
        }
        catch (error) {
            if (error instanceof CursorError) {
                throw new SessionRequestError("invalid_cursor", error.message);
            }
            throw error;
        }
    }
    async describeWorkspaceRecord(workspace, projectRecord) {
        const resolvedProjectRecord = projectRecord ?? (await this.projectRegistry.get(workspace.projectId));
        let diffStat = null;
        const snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);
        if (snapshot?.git.diffStat) {
            diffStat = snapshot.git.diffStat;
        }
        const worktreeSlug = workspace.isPaseoOwnedWorktree && workspace.worktreeRoot
            ? basename(workspace.worktreeRoot)
            : undefined;
        return {
            id: workspace.workspaceId,
            projectId: workspace.projectId,
            projectDisplayName: resolvedProjectRecord
                ? resolveProjectDisplayName(resolvedProjectRecord)
                : workspace.projectId,
            projectCustomName: resolvedProjectRecord?.customName ?? null,
            projectCustomIconRevision: resolvedProjectRecord?.customIconRevision ?? null,
            projectRootPath: resolvedProjectRecord?.rootPath ?? workspace.cwd,
            workspaceDirectory: workspace.cwd,
            worktreeSlug,
            projectKind: (resolvedProjectRecord?.kind ?? "directory") === "git" ? "git" : "non_git",
            workspaceKind: workspace.kind,
            name: resolveWorkspaceDisplayName(workspace),
            title: workspace.title,
            pinnedAt: workspace.pinnedAt,
            archivingAt: null,
            status: "done",
            statusEnteredAt: null,
            activityAt: null,
            diffStat,
            scripts: this.buildWorkspaceScriptPayloadSnapshot(workspace, resolvedProjectRecord),
            ...(resolvedProjectRecord
                ? {
                    project: await this.buildProjectPlacementForWorkspace(workspace, resolvedProjectRecord),
                }
                : {}),
        };
    }
    buildWorkspaceGitRuntimePayload(snapshot) {
        if (!snapshot.git.isGit) {
            return null;
        }
        return {
            currentBranch: snapshot.git.currentBranch,
            remoteUrl: snapshot.git.remoteUrl,
            isPaseoOwnedWorktree: snapshot.git.isPaseoOwnedWorktree,
            isDirty: snapshot.git.isDirty,
            aheadBehind: snapshot.git.aheadBehind,
            aheadOfOrigin: snapshot.git.aheadOfOrigin,
            behindOfOrigin: snapshot.git.behindOfOrigin,
        };
    }
    buildWorkspaceGitHubRuntimePayload(snapshot) {
        return {
            featuresEnabled: snapshot.forge.featuresEnabled,
            pullRequest: snapshot.forge.pullRequest,
            error: snapshot.forge.error,
        };
    }
    async describeWorkspaceRecordWithGitData(workspace, projectRecord) {
        const base = await this.describeWorkspaceRecord(workspace, projectRecord);
        const snapshot = this.workspaceGitService.peekSnapshot(workspace.cwd);
        if (!snapshot) {
            return base;
        }
        const checkout = checkoutLiteFromGitSnapshot(workspace.cwd, snapshot.git);
        const displayName = deriveWorkspaceDisplayName({ cwd: workspace.cwd, checkout });
        return {
            ...base,
            name: resolveWorkspaceName({ title: workspace.title, derivedDisplayName: displayName }),
            diffStat: snapshot.git.diffStat ?? null,
            gitRuntime: this.buildWorkspaceGitRuntimePayload(snapshot) ?? undefined,
            githubRuntime: this.buildWorkspaceGitHubRuntimePayload(snapshot),
            // Reuse the forge already resolved on the snapshot (probe-aware; GitHub-only
            // resolves to "github") so the sidebar/hover-card brand mark matches the
            // status projection without a second resolve.
            forge: snapshot.forge.forge,
        };
    }
    async describeCreatedWorktreeWorkspace(result) {
        const projectRecord = await this.projectRegistry.get(result.workspace.projectId);
        return {
            id: result.workspace.workspaceId,
            projectId: result.workspace.projectId,
            projectDisplayName: projectRecord
                ? resolveProjectDisplayName(projectRecord)
                : result.workspace.projectId,
            projectCustomName: projectRecord?.customName ?? null,
            projectCustomIconRevision: projectRecord?.customIconRevision ?? null,
            projectRootPath: projectRecord?.rootPath ?? result.repoRoot,
            workspaceDirectory: result.workspace.cwd,
            worktreeSlug: basename(result.worktree.worktreePath),
            projectKind: projectRecord?.kind ?? "git",
            workspaceKind: result.workspace.kind,
            name: resolveWorkspaceName({
                title: result.workspace.title,
                derivedDisplayName: result.worktree.branchName || result.workspace.displayName,
            }),
            title: result.workspace.title,
            pinnedAt: result.workspace.pinnedAt,
            archivingAt: null,
            status: "done",
            statusEnteredAt: result.workspace.createdAt,
            activityAt: null,
            diffStat: { additions: 0, deletions: 0 },
            scripts: [],
            gitRuntime: {
                currentBranch: result.worktree.branchName || null,
                remoteUrl: null,
                isPaseoOwnedWorktree: true,
                isDirty: false,
                aheadBehind: null,
                aheadOfOrigin: null,
                behindOfOrigin: null,
            },
            githubRuntime: null,
        };
    }
    async buildWorkspaceDescriptor(input) {
        if (input.includeGitData && input.workspace.kind !== "directory") {
            return this.describeWorkspaceRecordWithGitData(input.workspace, input.projectRecord);
        }
        return this.describeWorkspaceRecord(input.workspace, input.projectRecord);
    }
    markWorkspaceArchiving(workspaceIds, archivingAt) {
        this.workspaceDirectory.markArchiving(workspaceIds, archivingAt);
    }
    clearWorkspaceArchiving(workspaceIds) {
        this.workspaceDirectory.clearArchiving(workspaceIds);
    }
    async buildWorkspaceDescriptorMap(options) {
        return this.workspaceDirectory.buildDescriptorMap(options);
    }
    // external path→workspace adapter, not ownership. Used by archive-by-path flows
    // where the request carries a worktree path (unique to one workspace) rather
    // than a workspaceId. This is a directory lookup for an archive target, not a
    // status/ownership attribution.
    async findWorkspaceIdForCwd(cwd) {
        const workspaces = await this.workspaceRegistry.list();
        return resolveWorkspaceIdForPath(cwd, workspaces);
    }
    matchesWorkspaceFilter(input) {
        return this.workspaceDirectory.matchesFilter(input);
    }
    async listFetchWorkspacesEntries(request) {
        try {
            return await this.workspaceDirectory.listFetchEntries(request);
        }
        catch (error) {
            if (error instanceof CursorError) {
                throw new SessionRequestError("invalid_cursor", error.message);
            }
            throw error;
        }
    }
    bufferOrEmitWorkspaceUpdate(subscription, payload) {
        if (payload.kind === "upsert") {
            subscription.visibleEmptyProjectIds?.delete(payload.workspace.projectId);
        }
        else {
            if (payload.emptyProject) {
                subscription.visibleEmptyProjectIds?.add(payload.emptyProject.projectId);
            }
            if (payload.removedProjectId) {
                subscription.visibleEmptyProjectIds?.delete(payload.removedProjectId);
            }
        }
        if (subscription.isBootstrapping) {
            const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
            subscription.pendingUpdatesByWorkspaceId.set(workspaceId, payload);
            return;
        }
        const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
        subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
        this.emit({
            type: "workspace_update",
            payload,
        });
    }
    flushBootstrappedWorkspaceUpdates(options) {
        const subscription = this.workspaceUpdatesSubscription;
        if (!subscription || !subscription.isBootstrapping) {
            return;
        }
        subscription.isBootstrapping = false;
        const pending = Array.from(subscription.pendingUpdatesByWorkspaceId.values());
        subscription.pendingUpdatesByWorkspaceId.clear();
        for (const payload of pending) {
            if (payload.kind === "upsert") {
                const snapshot = options?.snapshotByWorkspaceId?.get(payload.workspace.id);
                const updateActivityAtMs = payload.workspace.activityAt
                    ? Date.parse(payload.workspace.activityAt)
                    : null;
                const shouldEmit = shouldEmitPendingBootstrapUpdate({
                    snapshot: snapshot
                        ? {
                            status: snapshot.status,
                            statusEnteredAt: snapshot.statusEnteredAt,
                            activityAtMs: snapshot.activityAtMs,
                        }
                        : null,
                    update: {
                        status: payload.workspace.status,
                        statusEnteredAt: payload.workspace.statusEnteredAt ?? null,
                        activityAtMs: Number.isNaN(updateActivityAtMs) ? null : updateActivityAtMs,
                    },
                });
                if (!shouldEmit) {
                    continue;
                }
            }
            const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
            subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
            this.emit({
                type: "workspace_update",
                payload,
            });
        }
    }
    buildProjectDescriptor(project) {
        return {
            projectId: project.projectId,
            ...(project.projectKey ? { projectKey: project.projectKey } : {}),
            projectDisplayName: resolveProjectDisplayName(project),
            projectCustomName: project.customName ?? null,
            projectCustomIconRevision: project.customIconRevision ?? null,
            projectRootPath: project.rootPath,
            projectKind: project.kind,
        };
    }
    async restoreWorkspaceAndEmit(workspaceId) {
        await this.workspaceRecovery.restore(workspaceId);
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (!workspace) {
            throw new Error(`Recovered workspace record not found: ${workspaceId}`);
        }
        if (this.onWorkspaceRecovered) {
            try {
                await this.onWorkspaceRecovered(workspace);
                return;
            }
            catch (error) {
                this.sessionLogger.warn({ err: error, workspaceId }, "Failed to publish workspace recovery to active sessions");
            }
        }
        await this.refreshRecoveredWorkspaceForExternalMutation(workspace);
    }
    async restoreOwningWorkspaceForLegacyAgentRefresh(agentId) {
        // COMPAT(worktreeRestore): clients older than v0.1.105 used refresh_agent_request
        // as their explicit recovery RPC. Remove after 2027-01-11.
        if (!clientUsesLegacyWorkspaceRestore(this.appVersion)) {
            return;
        }
        const record = await this.agentStorage.get(agentId);
        if (!record?.workspaceId) {
            return;
        }
        const recovery = await this.workspaceRecovery.inspect(record.workspaceId);
        if (recovery.kind !== "recoverable") {
            return;
        }
        await this.restoreWorkspaceAndEmit(record.workspaceId);
    }
    async createPaseoWorktree(input, options) {
        const result = await createPaseoWorktree(input, {
            github: this.github,
            ...(options?.resolveDefaultBranch
                ? { resolveDefaultBranch: options.resolveDefaultBranch }
                : {}),
            workspaceGitService: this.workspaceGitService,
            workspaceProvisioning: this.workspaceProvisioning,
        });
        void Promise.all([
            this.gitMutation.notifyGitMutation(input.cwd, "create-worktree"),
            this.gitMutation.notifyGitMutation(result.worktree.worktreePath, "create-worktree"),
        ]).catch((error) => {
            this.sessionLogger.warn({ err: error, cwd: input.cwd, worktreePath: result.worktree.worktreePath }, "Failed to warm git snapshots after creating worktree");
        });
        return result;
    }
    async listActiveWorkspaceRefs() {
        const workspaces = await this.workspaceRegistry.list();
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
    }
    async archiveWorkspaceRecord(workspaceId, archivedAt) {
        const archiveTimestamp = archivedAt ?? new Date().toISOString();
        const existingWorkspace = await archivePersistedWorkspaceRecord({
            workspaceId,
            archivedAt: archiveTimestamp,
            workspaceRegistry: this.workspaceRegistry,
        });
        if (!existingWorkspace) {
            this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
            return;
        }
        if (!existingWorkspace.archivedAt) {
            const activeSiblings = (await this.workspaceRegistry.list()).filter((workspace) => workspace.projectId === existingWorkspace.projectId && !workspace.archivedAt);
            this.sessionLogger.info({
                workspaceId,
                workspaceCwd: existingWorkspace.cwd,
                projectId: existingWorkspace.projectId,
                projectArchived: activeSiblings.length === 0,
                archivedAt: archiveTimestamp,
            }, "Workspace archived");
        }
        await this.teardownArchivedWorkspace(existingWorkspace.workspaceId);
    }
    async teardownArchivedWorkspace(workspaceId) {
        this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
        this.scriptRuntimeStore?.removeForWorkspace(workspaceId);
        releaseWorkspaceServicePortPlan(workspaceId);
    }
    async emitWorkspaceUpdatesForWorkspaceIds(workspaceIds, options) {
        const subscription = this.workspaceUpdatesSubscription;
        if (!subscription) {
            return;
        }
        const uniqueWorkspaceIds = new Set(Array.from(workspaceIds));
        if (uniqueWorkspaceIds.size === 0) {
            return;
        }
        await this.enqueueWorkspaceUpdates(uniqueWorkspaceIds, subscription, options);
    }
    enqueueWorkspaceUpdates(workspaceIds, subscription, options) {
        const previous = Array.from(workspaceIds, (workspaceId) => (this.workspaceUpdateTails.get(workspaceId) ?? Promise.resolve()).catch(() => undefined));
        const next = Promise.all(previous).then(() => this.emitWorkspaceUpdateBatch(workspaceIds, subscription, options));
        for (const workspaceId of workspaceIds) {
            this.workspaceUpdateTails.set(workspaceId, next);
        }
        const clearTail = () => {
            for (const workspaceId of workspaceIds) {
                if (this.workspaceUpdateTails.get(workspaceId) === next) {
                    this.workspaceUpdateTails.delete(workspaceId);
                }
            }
        };
        void next.then(clearTail, clearTail);
        return next;
    }
    async emitWorkspaceUpdateBatch(workspaceIds, subscription, options) {
        if (this.workspaceUpdatesSubscription !== subscription) {
            return;
        }
        const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
            workspaceIds,
            includeGitData: true,
        });
        for (const workspaceId of workspaceIds) {
            if (this.workspaceUpdatesSubscription !== subscription) {
                return;
            }
            const workspace = descriptorsByWorkspaceId.get(workspaceId);
            const filteredWorkspace = workspace && this.matchesWorkspaceFilter({ workspace, filter: subscription.filter })
                ? workspace
                : null;
            const nextWorkspace = this.applyOptimisticWorkspaceStatus(filteredWorkspace, options?.optimisticStatus);
            const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
            if (options?.dedupeGitState &&
                this.workspaceGitObserver.shouldSkipUpdate(workspaceId, nextWorkspace)) {
                continue;
            }
            this.workspaceGitObserver.recordDescriptorState(workspaceId, nextWorkspace);
            if (!nextWorkspace) {
                if (this.shouldSkipWorkspaceRemoval(lastEmitted, options?.removedProjectId)) {
                    continue;
                }
                if (this.workspaceUpdatesSubscription !== subscription) {
                    return;
                }
                subscription.lastEmittedByWorkspaceId.delete(workspaceId);
                this.bufferOrEmitWorkspaceUpdate(subscription, await this.buildWorkspaceRemoveUpdatePayload(workspaceId, options?.removedProjectId));
                continue;
            }
            const nextPayload = {
                kind: "upsert",
                workspace: nextWorkspace,
            };
            if (lastEmitted &&
                lastEmitted.kind === "upsert" &&
                equal(lastEmitted.workspace, nextWorkspace)) {
                continue;
            }
            this.bufferOrEmitWorkspaceUpdate(subscription, nextPayload);
        }
    }
    applyOptimisticWorkspaceStatus(workspace, optimisticStatus) {
        if (!workspace || !optimisticStatus) {
            return workspace;
        }
        return { ...workspace, status: optimisticStatus };
    }
    shouldSkipWorkspaceRemoval(lastEmitted, removedProjectId) {
        if (lastEmitted?.kind === "remove") {
            return !removedProjectId || lastEmitted.removedProjectId === removedProjectId;
        }
        return !lastEmitted && !removedProjectId;
    }
    async buildWorkspaceRemoveUpdatePayload(workspaceId, removedProjectId) {
        if (removedProjectId) {
            return { kind: "remove", id: workspaceId, removedProjectId };
        }
        return {
            kind: "remove",
            id: workspaceId,
            ...(await this.resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(workspaceId)),
        };
    }
    // When a workspace is archived its project may have no active workspaces left.
    // Resolve that project parent so the `remove` update can carry it, keeping the
    // sidebar in sync without a full re-hydration.
    async resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(workspaceId) {
        const archivedWorkspace = await this.workspaceRegistry.get(workspaceId);
        if (!archivedWorkspace) {
            return null;
        }
        const projectWithoutActiveWorkspaces = (await this.workspaceDirectory.listEmptyProjects()).find((project) => project.projectId === archivedWorkspace.projectId);
        return projectWithoutActiveWorkspaces ? { emptyProject: projectWithoutActiveWorkspaces } : null;
    }
    async emitWorkspaceUpdateForTerminalContribution(event) {
        // A terminal's activity contributes only to the workspace it carries. A
        // terminal with no workspaceId attributes to nothing — status is per-id.
        if (!event.workspaceId) {
            return;
        }
        await this.emitWorkspaceUpdatesForWorkspaceIds([event.workspaceId]);
    }
    // A git fact (branch, diff, dirty, PR) changed at `cwd`. Every workspace whose
    // OWN cwd is this folder re-derives its git facts from that folder (id → cwd)
    // and emits its own per-id descriptor. This is a deliberate same-folder fan,
    // not a cwd → id ownership lookup: git never resolves which workspace owns a
    // path. See `workspaceIdsOnCheckout`.
    async emitWorkspaceUpdateForCwd(cwd, options) {
        const workspaceIds = workspaceIdsOnCheckout(await this.workspaceRegistry.list(), cwd);
        if (workspaceIds.length === 0) {
            return;
        }
        await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds, options);
    }
    async handleFetchAgents(request) {
        const requestedSubscriptionId = request.subscribe?.subscriptionId?.trim();
        const subscriptionId = resolveSubscriptionId(request.subscribe, requestedSubscriptionId);
        try {
            if (subscriptionId) {
                this.agentUpdates.beginSubscription({
                    subscriptionId,
                    filter: request.filter,
                });
            }
            const payload = await this.listFetchAgentsEntries(request);
            const snapshotUpdatedAtByAgentId = new Map();
            for (const entry of payload.entries) {
                const parsedUpdatedAt = Date.parse(entry.agent.updatedAt);
                if (!Number.isNaN(parsedUpdatedAt)) {
                    snapshotUpdatedAtByAgentId.set(entry.agent.id, parsedUpdatedAt);
                }
            }
            this.emit({
                type: "fetch_agents_response",
                payload: {
                    requestId: request.requestId,
                    ...(subscriptionId ? { subscriptionId } : {}),
                    ...payload,
                },
            });
            if (subscriptionId) {
                this.agentUpdates.flushBootstrapped(subscriptionId, { snapshotUpdatedAtByAgentId });
            }
        }
        catch (error) {
            if (subscriptionId) {
                this.agentUpdates.clearSubscription(subscriptionId);
            }
            const code = error instanceof SessionRequestError ? error.code : "fetch_agents_failed";
            const message = error instanceof Error ? error.message : "Failed to fetch agents";
            this.sessionLogger.error({ err: error }, "Failed to handle fetch_agents_request");
            this.emit({
                type: "rpc_error",
                payload: {
                    requestId: request.requestId,
                    requestType: request.type,
                    error: message,
                    code,
                },
            });
        }
    }
    async handleFetchAgentHistory(request) {
        try {
            const payload = await this.listFetchAgentsEntries(request);
            this.emit({
                type: "fetch_agent_history_response",
                payload: {
                    requestId: request.requestId,
                    ...payload,
                },
            });
        }
        catch (error) {
            const code = error instanceof SessionRequestError ? error.code : "fetch_agent_history_failed";
            const message = error instanceof Error ? error.message : "Failed to fetch agent history";
            this.sessionLogger.error({ err: error }, "Failed to handle fetch_agent_history_request");
            this.emit({
                type: "rpc_error",
                payload: {
                    requestId: request.requestId,
                    requestType: request.type,
                    error: message,
                    code,
                },
            });
        }
    }
    async handleFetchRecentProviderSessions(request) {
        try {
            const result = await listImportableProviderSessions({
                request,
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                providerSnapshotManager: this.providerSnapshotManager,
            });
            this.emit({
                type: "fetch_recent_provider_sessions_response",
                payload: {
                    requestId: request.requestId,
                    entries: result.entries,
                    ...(result.filteredAlreadyImportedCount > 0
                        ? { filteredAlreadyImportedCount: result.filteredAlreadyImportedCount }
                        : {}),
                },
            });
        }
        catch (error) {
            const code = error instanceof ImportSessionsRequestError
                ? error.code
                : "fetch_recent_provider_sessions_failed";
            const message = error instanceof Error ? error.message : "Failed to fetch recent provider sessions";
            this.sessionLogger.error({ err: error }, "Failed to handle fetch_recent_provider_sessions_request");
            this.emit({
                type: "rpc_error",
                payload: {
                    requestId: request.requestId,
                    requestType: request.type,
                    error: message,
                    code,
                },
            });
        }
    }
    async handleFetchWorkspacesRequest(request) {
        const requestedSubscriptionId = request.subscribe?.subscriptionId?.trim();
        const subscriptionId = resolveSubscriptionId(request.subscribe, requestedSubscriptionId);
        try {
            this.sessionLogger.debug({
                requestId: request.requestId,
                subscribeRequested: Boolean(request.subscribe),
                filter: request.filter ?? null,
                sort: request.sort ?? null,
                page: request.page ?? null,
            }, "fetch_workspaces_request_received");
            if (subscriptionId) {
                this.workspaceUpdatesSubscription = {
                    subscriptionId,
                    filter: request.filter,
                    isBootstrapping: true,
                    pendingUpdatesByWorkspaceId: new Map(),
                    lastEmittedByWorkspaceId: new Map(),
                    visibleEmptyProjectIds: new Set(),
                };
            }
            const payload = await this.listFetchWorkspacesEntries(request);
            this.workspaceGitObserver.syncObservers(payload.entries);
            this.sessionLogger.debug({
                requestId: request.requestId,
                subscriptionId,
                pageInfo: payload.pageInfo,
                payload: summarizeFetchWorkspacesEntries(payload.entries),
            }, "fetch_workspaces_response_ready");
            const snapshot = this.buildBootstrapSnapshot(payload.entries);
            this.seedWorkspaceSubscriptionSnapshot(subscriptionId, request.filter, payload.entries, payload.emptyProjects);
            this.emit({
                type: "fetch_workspaces_response",
                payload: {
                    requestId: request.requestId,
                    ...(subscriptionId ? { subscriptionId } : {}),
                    ...payload,
                },
            });
            if (subscriptionId && this.workspaceUpdatesSubscription?.subscriptionId === subscriptionId) {
                this.flushBootstrappedWorkspaceUpdates(snapshot);
            }
        }
        catch (error) {
            if (subscriptionId && this.workspaceUpdatesSubscription?.subscriptionId === subscriptionId) {
                this.workspaceUpdatesSubscription = null;
            }
            const code = error instanceof SessionRequestError ? error.code : "fetch_workspaces_failed";
            const message = error instanceof Error ? error.message : "Failed to fetch workspaces";
            this.sessionLogger.error({ err: error }, "Failed to handle fetch_workspaces_request");
            this.emit({
                type: "rpc_error",
                payload: {
                    requestId: request.requestId,
                    requestType: request.type,
                    error: message,
                    code,
                },
            });
        }
    }
    async handleProjectListRequest(requestId) {
        try {
            const projects = (await this.projectRegistry.list())
                .filter((project) => !project.archivedAt)
                .map((project) => this.buildProjectDescriptor(project));
            this.emit({
                type: "project.list.response",
                payload: { requestId, projects },
            });
        }
        catch (error) {
            this.sessionLogger.error({ err: error }, "Failed to handle project.list.request");
            this.emit({
                type: "rpc_error",
                payload: {
                    requestId,
                    requestType: "project.list.request",
                    error: error instanceof Error ? error.message : "Failed to list projects",
                    code: "project_list_failed",
                },
            });
        }
    }
    // Build the bootstrap snapshot used by `flushBootstrappedWorkspaceUpdates`
    // to decide which pending updates to drop. Captures the status,
    // statusEnteredAt, and activityAt (parsed to ms) for each workspace entry
    // so a status-only change (e.g. the unmask case), a statusEnteredAt-only
    // change (e.g. a fresh unmask time), AND a fresher activity all still
    // ship to the client.
    buildBootstrapSnapshot(entries) {
        const snapshotByWorkspaceId = new Map();
        for (const entry of entries) {
            const parsedActivity = entry.activityAt ? Date.parse(entry.activityAt) : null;
            snapshotByWorkspaceId.set(entry.id, {
                status: entry.status,
                statusEnteredAt: entry.statusEnteredAt ?? null,
                activityAtMs: Number.isNaN(parsedActivity) ? null : parsedActivity,
            });
        }
        return { snapshotByWorkspaceId };
    }
    seedWorkspaceSubscriptionSnapshot(subscriptionId, filter, entries, emptyProjects) {
        const subscription = this.workspaceUpdatesSubscription;
        if (!subscription)
            return;
        if (subscriptionId && subscription.subscriptionId !== subscriptionId)
            return;
        if (!subscriptionId && !equal(subscription.filter, filter))
            return;
        for (const entry of entries) {
            subscription.lastEmittedByWorkspaceId.set(entry.id, {
                kind: "upsert",
                workspace: entry,
            });
        }
        for (const project of emptyProjects) {
            subscription.visibleEmptyProjectIds?.add(project.projectId);
        }
    }
    async registerWorkspaceForImportedAgent(workspace) {
        try {
            await this.syncWorkspaceGitObserverForWorkspace(workspace);
            await this.describeWorkspaceRecord(workspace);
            await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
        }
        catch (error) {
            this.sessionLogger.warn({ err: error, workspaceId: workspace.workspaceId, cwd: workspace.cwd }, "Failed to register workspace for imported agent");
        }
    }
    async handleWorkspaceCreateRequest(request) {
        try {
            if (request.source.kind === "directory") {
                await this.handleWorkspaceCreateLocal(request);
                return;
            }
            await this.handleWorkspaceCreateWorktree(request);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to create workspace";
            this.sessionLogger.error({ err: error, sourceKind: request.source.kind, requestId: request.requestId }, "Failed to create workspace");
            const errorCode = error instanceof WorkspaceProvisioningError ? error.code : undefined;
            this.emit({
                type: "workspace.create.response",
                payload: {
                    requestId: request.requestId,
                    workspace: null,
                    setupTerminalId: null,
                    error: message,
                    errorCode,
                },
            });
        }
    }
    async handleWorkspaceCreateLocal(request) {
        if (request.source.kind !== "directory") {
            return;
        }
        const cwd = expandTilde(request.source.path);
        const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
        if (!directoryExists) {
            this.emit({
                type: "workspace.create.response",
                payload: {
                    requestId: request.requestId,
                    workspace: null,
                    setupTerminalId: null,
                    error: `Directory not found: ${cwd}`,
                    errorCode: "directory_not_found",
                },
            });
            return;
        }
        const explicitTitle = request.title?.trim() || null;
        const promptTitle = resolveFirstAgentPromptTitle(request.firstAgentContext);
        const workspace = await this.workspaceProvisioning.createWorkspaceForDirectory(cwd, explicitTitle ?? promptTitle, request.source.projectId, { expectsInitialAgent: Boolean(request.firstAgentContext) });
        await this.syncWorkspaceGitObserverForWorkspace(workspace);
        const descriptor = await this.describeWorkspaceRecord(workspace);
        this.emit({
            type: "workspace.create.response",
            payload: {
                requestId: request.requestId,
                workspace: descriptor,
                setupTerminalId: null,
                error: null,
            },
        });
        await this.emitCreatedWorkspaceUpdate(descriptor, request.firstAgentContext ? "running" : undefined);
        void this.workspaceGitService
            .getSnapshot(workspace.cwd, { force: true, includeForge: true, reason: "open_project" })
            .catch((error) => {
            this.sessionLogger.warn({ err: error, cwd: workspace.cwd }, "Background snapshot refresh failed after workspace.create");
        });
        if (request.firstAgentContext) {
            const firstAgentContext = request.firstAgentContext;
            this.workspaceAutoName.scheduleForDirectory({
                workspaceId: workspace.workspaceId,
                cwd: workspace.cwd,
                firstAgentContext,
            }, { currentSelection: this.getFocusedAgentSelectionForCwd(workspace.cwd) });
        }
    }
    async handleWorkspaceCreateWorktree(request) {
        if (request.source.kind !== "worktree") {
            return;
        }
        const source = request.source;
        if (!source.cwd && !source.projectId) {
            this.emit({
                type: "workspace.create.response",
                payload: {
                    requestId: request.requestId,
                    workspace: null,
                    setupTerminalId: null,
                    error: "cwd or projectId is required for a worktree-backed workspace",
                    errorCode: "source_required",
                },
            });
            return;
        }
        const sourceCwd = await resolveWorktreeSourceCwd(source, this.projectRegistry);
        const result = await this.createPaseoWorktreeWorkflow({
            cwd: sourceCwd,
            projectId: source.projectId,
            worktreeSlug: source.worktreeSlug,
            action: source.action,
            refName: source.refName,
            branchName: source.branchName,
            checkoutSource: source.checkoutSource,
            githubPrNumber: source.githubPrNumber,
            firstAgentContext: request.firstAgentContext,
            title: request.title,
        }, source.baseBranch
            ? { resolveDefaultBranch: async () => source.baseBranch }
            : undefined);
        const descriptor = await this.describeCreatedWorktreeWorkspace(result);
        this.emit({
            type: "workspace.create.response",
            payload: {
                requestId: request.requestId,
                workspace: descriptor,
                setupTerminalId: null,
                error: null,
            },
        });
        await this.emitCreatedWorkspaceUpdate(descriptor, request.firstAgentContext ? "running" : undefined);
    }
    async handleOpenProjectRequest(request) {
        const requestedCwd = request.cwd;
        const cwd = expandTilde(requestedCwd);
        const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
        if (!directoryExists) {
            this.sessionLogger.info({ requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" }, "Open project rejected");
            this.emit({
                type: "open_project_response",
                payload: {
                    requestId: request.requestId,
                    workspace: null,
                    error: `Directory not found: ${cwd}`,
                    errorCode: "directory_not_found",
                },
            });
            return;
        }
        try {
            const projectsBefore = new Map();
            for (const project of await this.projectRegistry.list()) {
                projectsBefore.set(project.projectId, project);
            }
            const workspacesBefore = new Map();
            for (const workspaceRecord of await this.workspaceRegistry.list()) {
                workspacesBefore.set(workspaceRecord.workspaceId, workspaceRecord);
            }
            const workspace = await this.workspaceProvisioning.findOrCreateWorkspaceForDirectory(cwd);
            const project = await this.projectRegistry.get(workspace.projectId);
            await this.syncWorkspaceGitObserverForWorkspace(workspace);
            const descriptor = await this.describeWorkspaceRecord(workspace);
            await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
            this.sessionLogger.info({
                requestedCwd,
                resolvedCwd: cwd,
                workspaceCwd: workspace.cwd,
                workspaceId: workspace.workspaceId,
                workspaceKind: workspace.kind,
                workspaceTransition: describeRegistryTransition(workspacesBefore.get(workspace.workspaceId) ?? null),
                projectId: workspace.projectId,
                projectKind: project?.kind ?? null,
                projectTransition: describeRegistryTransition(projectsBefore.get(workspace.projectId) ?? null),
            }, "Project opened");
            this.emit({
                type: "open_project_response",
                payload: {
                    requestId: request.requestId,
                    workspace: descriptor,
                    error: null,
                },
            });
            void this.workspaceGitService
                .getSnapshot(workspace.cwd, {
                force: true,
                includeForge: true,
                reason: "open_project",
            })
                .catch((error) => {
                this.sessionLogger.warn({ err: error, cwd: workspace.cwd }, "Background snapshot refresh failed after open_project");
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to open project";
            this.sessionLogger.error({ err: error, cwd }, "Failed to open project");
            this.emit({
                type: "open_project_response",
                payload: {
                    requestId: request.requestId,
                    workspace: null,
                    error: message,
                },
            });
        }
    }
    async handleProjectAddRequest(request) {
        const requestedCwd = request.cwd;
        const cwd = expandTilde(requestedCwd);
        const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
        if (!directoryExists) {
            this.sessionLogger.info({ requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" }, "Add project rejected");
            this.emit({
                type: "project.add.response",
                payload: {
                    requestId: request.requestId,
                    project: null,
                    error: `Directory not found: ${cwd}`,
                    errorCode: "directory_not_found",
                },
            });
            return;
        }
        try {
            const projectsBefore = new Map();
            for (const project of await this.projectRegistry.list()) {
                projectsBefore.set(project.projectId, project);
            }
            const project = await this.workspaceProvisioning.findOrCreateProjectForDirectory(cwd);
            this.sessionLogger.info({
                requestedCwd,
                resolvedCwd: cwd,
                projectId: project.projectId,
                projectKind: project.kind,
                projectTransition: describeRegistryTransition(projectsBefore.get(project.projectId) ?? null),
            }, "Project added");
            this.emit({
                type: "project.add.response",
                payload: {
                    requestId: request.requestId,
                    project: this.buildProjectDescriptor(project),
                    error: null,
                },
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to add project";
            this.sessionLogger.error({ err: error, cwd }, "Failed to add project");
            this.emit({
                type: "project.add.response",
                payload: {
                    requestId: request.requestId,
                    project: null,
                    error: message,
                },
            });
        }
    }
    async handleProjectCreateDirectoryRequest(request) {
        try {
            const result = await createProjectDirectory({ parentPath: request.parentPath, name: request.name }, {
                registerProject: (directoryPath) => this.workspaceProvisioning.findOrCreateProjectForDirectory(directoryPath),
            });
            this.emit({
                type: "project.create_directory.response",
                payload: {
                    requestId: request.requestId,
                    directoryPath: result.directoryPath,
                    project: this.buildProjectDescriptor(result.project),
                    error: null,
                    errorCode: null,
                },
            });
        }
        catch (error) {
            const requestError = error instanceof ProjectDirectoryRequestError
                ? error
                : new ProjectDirectoryRequestError("registration_failed", error instanceof Error ? error.message : "Failed to create project directory");
            this.sessionLogger.error({
                err: error,
                parentPath: request.parentPath,
                name: request.name,
                errorCode: requestError.code,
            }, "Failed to create project directory");
            this.emit({
                type: "project.create_directory.response",
                payload: {
                    requestId: request.requestId,
                    directoryPath: requestError.directoryPath,
                    project: null,
                    error: requestError.message,
                    errorCode: requestError.code,
                },
            });
        }
    }
    async handleWorkspaceGithubSearchRepositoriesRequest(request) {
        try {
            const searchRepositories = this.github.searchRepositories;
            if (!searchRepositories) {
                throw new Error("GitHub repository search is unavailable");
            }
            const repositories = await searchRepositories.call(this.github, {
                cwd: homedir(),
                query: request.query,
                limit: request.limit,
            });
            this.emit({
                type: "workspace.github.search_repositories.response",
                payload: {
                    requestId: request.requestId,
                    repositories,
                    status: "success",
                    available: true,
                    error: null,
                },
            });
        }
        catch (error) {
            const missing = error instanceof GitHubCliMissingError;
            const unauthenticated = error instanceof GitHubAuthenticationError;
            const commandError = error instanceof GitHubCommandError ? error.stderr.trim() : "";
            let message;
            if (missing) {
                message = "GitHub CLI (gh) is not installed or not in PATH";
            }
            else if (unauthenticated) {
                message = "GitHub CLI is not authenticated. Run gh auth login on the host.";
            }
            else if (commandError) {
                message = commandError;
            }
            else {
                message = error instanceof Error ? error.message : "GitHub search failed";
            }
            let payload;
            if (missing) {
                payload = {
                    status: "unavailable",
                    requestId: request.requestId,
                    repositories: [],
                    reason: "gh_missing",
                    available: false,
                    error: message,
                };
            }
            else if (unauthenticated) {
                payload = {
                    status: "unauthenticated",
                    requestId: request.requestId,
                    repositories: [],
                    available: false,
                    error: message,
                };
            }
            else {
                payload = {
                    status: "error",
                    requestId: request.requestId,
                    repositories: [],
                    available: true,
                    error: message,
                };
            }
            this.sessionLogger.warn({ err: error }, "GitHub repository search failed");
            this.emit({
                type: "workspace.github.search_repositories.response",
                payload,
            });
        }
    }
    async handleProjectGithubCloneRequest(request) {
        let normalizedRepo = request.repo;
        let checkoutPath = null;
        try {
            const repo = normalizeCloneRepository({
                repo: request.repo,
                cloneProtocol: request.cloneProtocol,
            });
            normalizedRepo = repo.displayName;
            const targetParent = resolve(expandTilde(request.targetDirectory.trim()));
            checkoutPath = resolve(targetParent, repo.name);
            if (!this.isPathWithinRoot(targetParent, checkoutPath)) {
                throw new Error("Resolved checkout path must stay inside the target directory");
            }
            await mkdir(targetParent, { recursive: true });
            try {
                await lstat(checkoutPath);
                throw new Error(`Checkout path already exists: ${checkoutPath}`);
            }
            catch (error) {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            }
            const cloneStagingPath = await mkdtemp(resolve(targetParent, ".paseo-clone-"));
            try {
                await runGitCommand(["clone", repo.cloneUrl, cloneStagingPath], {
                    cwd: targetParent,
                    timeout: 5 * 60 * 1000,
                    maxOutputBytes: 1024 * 1024,
                    logger: this.sessionLogger,
                });
                await rename(cloneStagingPath, checkoutPath);
            }
            catch (error) {
                await rm(cloneStagingPath, { recursive: true, force: true }).catch((cleanupError) => {
                    this.sessionLogger.warn({ err: cleanupError, cloneStagingPath }, "Failed to clean up partial GitHub clone");
                });
                throw error;
            }
            const project = await this.workspaceProvisioning.findOrCreateProjectForDirectory(checkoutPath);
            this.emit({
                type: "project.github.clone.response",
                payload: {
                    requestId: request.requestId,
                    repo: repo.displayName,
                    checkoutPath,
                    project: this.buildProjectDescriptor(project),
                    error: null,
                },
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to clone GitHub repo";
            this.sessionLogger.error({ err: error, repo: request.repo, targetDirectory: request.targetDirectory }, "Failed to clone GitHub project");
            this.emit({
                type: "project.github.clone.response",
                payload: {
                    requestId: request.requestId,
                    repo: normalizedRepo,
                    checkoutPath,
                    project: null,
                    error: message,
                },
            });
        }
    }
    // Named accessor: the workspace descriptor builder and the git-watch test both read a workspace's
    // scripts snapshot through here; the workspace-scripts module owns the payload assembly.
    buildWorkspaceScriptPayloadSnapshot(workspace, project) {
        return this.workspaceScripts.buildSnapshot(workspace, project);
    }
    handleStartWorkspaceScriptRequest(request) {
        return this.workspaceScripts.start(request);
    }
    async handleWorkspaceScriptListRequest(request) {
        try {
            const scripts = await this.workspaceScripts.list(request.workspaceId);
            this.emit({
                type: "workspace.script.list.response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    scripts,
                    error: null,
                },
            });
        }
        catch (error) {
            this.emit({
                type: "workspace.script.list.response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    scripts: [],
                    error: error instanceof Error ? error.message : "Failed to list workspace scripts",
                },
            });
        }
    }
    async handleWorkspaceScriptStartRequest(request) {
        try {
            const script = await this.workspaceScripts.launch(request);
            this.emit({
                type: "workspace.script.start.response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    scriptName: request.scriptName,
                    script,
                    error: null,
                },
            });
        }
        catch (error) {
            this.emit({
                type: "workspace.script.start.response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    scriptName: request.scriptName,
                    script: null,
                    error: error instanceof Error ? error.message : "Failed to start workspace script",
                },
            });
        }
    }
    async handleWorkspaceScriptStopRequest(request) {
        try {
            const script = await this.workspaceScripts.stop(request);
            this.emit({
                type: "workspace.script.stop.response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    scriptName: request.scriptName,
                    script,
                    error: null,
                },
            });
        }
        catch (error) {
            this.emit({
                type: "workspace.script.stop.response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    scriptName: request.scriptName,
                    script: null,
                    error: error instanceof Error ? error.message : "Failed to stop workspace script",
                },
            });
        }
    }
    // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
    async handleLegacyListAvailableEditorsRequest(request) {
        this.emit({
            type: "list_available_editors_response",
            payload: {
                requestId: request.requestId,
                editors: [],
                error: "Editor opening moved to the desktop app and is no longer supported by the daemon",
            },
        });
    }
    async handleLegacyOpenInEditorRequest(request) {
        this.emit({
            type: "open_in_editor_response",
            payload: {
                requestId: request.requestId,
                error: "Editor opening moved to the desktop app and is no longer supported by the daemon",
            },
        });
    }
    async handleCreatePaseoWorktreeRequest(request) {
        return handleCreateWorktreeRequest({
            paseoHome: this.paseoHome,
            worktreesRoot: this.worktreesRoot,
            describeWorkspaceRecord: (result) => this.describeCreatedWorktreeWorkspace(result),
            emit: (message) => this.emit(message),
            sessionLogger: this.sessionLogger,
            createPaseoWorktreeWorkflow: (input) => this.createPaseoWorktreeWorkflow(input),
        }, request);
    }
    async createPaseoWorktreeWorkflow(input, options) {
        return createWorktreeWorkflow({
            paseoHome: this.paseoHome,
            worktreesRoot: this.worktreesRoot,
            createPaseoWorktree: (workflowInput, serviceOptions) => this.createPaseoWorktree(workflowInput, serviceOptions),
            warmWorkspaceGitData: (workspace) => this.warmWorkspaceGitDataForWorkspace(workspace),
            autoNameWorkspaceBranchForFirstAgent: (autoNameInput) => this.workspaceAutoName.scheduleForWorktree(autoNameInput, {
                currentSelection: this.getFocusedAgentSelectionForCwd(autoNameInput.workspace.cwd),
            }),
            startWorkspaceSetup: (workspaceId, operation) => this.workspaceSetupRuntime.start(workspaceId, operation),
            emitWorkspaceUpdateForWorkspaceId: (workspaceId) => this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
            cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => {
                this.workspaceSetupSnapshots.set(workspaceId, snapshot);
            },
            emit: (message) => this.emit(message),
            sessionLogger: this.sessionLogger,
            terminalManager: this.terminalManager,
            archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
            serviceProxy: this.serviceProxy,
            scriptRuntimeStore: this.scriptRuntimeStore,
            getDaemonTcpPort: this.getDaemonTcpPort,
            getDaemonTcpHost: this.getDaemonTcpHost,
            serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
            onScriptsChanged: (workspaceId, workspaceDirectory) => {
                this.workspaceScripts.emitStatusUpdate(workspaceId, workspaceDirectory);
            },
        }, input, options);
    }
    async handleWorkspaceSetupStatusRequest(request) {
        return handleWorkspaceSetupStatusRequestMessage({
            emit: (message) => this.emit(message),
            workspaceSetupSnapshots: this.workspaceSetupSnapshots,
        }, request);
    }
    async handleArchiveWorkspaceRequest(request) {
        try {
            const existing = await this.workspaceRegistry.get(request.workspaceId);
            if (!existing) {
                throw new Error(`Workspace not found: ${request.workspaceId}`);
            }
            await archiveByScope({
                paseoHome: this.paseoHome,
                paseoWorktreesBaseRoot: this.worktreesRoot,
                github: this.github,
                workspaceGitService: this.workspaceGitService,
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
                getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
                listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
                archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
                emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds) => this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds),
                markWorkspaceArchiving: (workspaceIds, archivingAt) => this.markWorkspaceArchiving(workspaceIds, archivingAt),
                clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
                killTerminalsForWorkspace: (workspaceId) => this.terminalController.killTerminalsForWorkspace(workspaceId),
                stopWorkspaceSetup: (workspaceId) => this.workspaceSetupRuntime.stop(workspaceId),
                sessionLogger: this.sessionLogger,
            }, {
                scope: { kind: "workspace", workspaceId: existing.workspaceId },
                requestId: request.requestId,
            });
            const archivedWorkspace = await this.workspaceRegistry.get(request.workspaceId);
            const archivedAt = archivedWorkspace?.archivedAt ?? new Date().toISOString();
            this.emit({
                type: "archive_workspace_response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    archivedAt,
                    error: null,
                },
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to archive workspace";
            this.sessionLogger.error({ err: error, workspaceId: request.workspaceId }, "Failed to archive workspace");
            this.emit({
                type: "archive_workspace_response",
                payload: {
                    requestId: request.requestId,
                    workspaceId: request.workspaceId,
                    archivedAt: null,
                    error: message,
                },
            });
        }
    }
    async handleWorkspaceClearAttentionRequest(request) {
        const { requestId, workspaceId } = request;
        const requestedWorkspaceIds = Array.isArray(workspaceId) ? workspaceId : [workspaceId];
        let agents;
        try {
            agents = await this.listAgentPayloads();
        }
        catch (error) {
            const message = getErrorMessage(error);
            const results = requestedWorkspaceIds.map((requestedWorkspaceId) => ({
                workspaceId: requestedWorkspaceId,
                clearedAgentIds: [],
                success: false,
                error: message,
            }));
            this.emit({
                type: "workspace.clear_attention.response",
                payload: {
                    requestId,
                    workspaceId,
                    clearedAgentIds: [],
                    results,
                    success: false,
                    error: message,
                },
            });
            return;
        }
        const results = [];
        for (const requestedWorkspaceId of requestedWorkspaceIds) {
            const clearedAgentIds = [];
            try {
                const workspace = await this.workspaceRegistry.get(requestedWorkspaceId);
                if (!workspace || workspace.archivedAt) {
                    throw new Error(`Workspace not found: ${requestedWorkspaceId}`);
                }
                // Clearing attention is scoped to the workspace that OWNS the agent, by
                // workspaceId — never by comparing cwd strings. A sibling workspace
                // sharing the same directory keeps its own agents' attention.
                const clearableAgentIds = agents
                    .filter((agent) => !agent.archivedAt)
                    .filter((agent) => agent.workspaceId === workspace.workspaceId)
                    .filter((agent) => agent.requiresAttention === true)
                    .filter((agent) => (agent.pendingPermissions?.length ?? 0) === 0)
                    .filter((agent) => agent.attentionReason !== "permission")
                    .map((agent) => agent.id);
                for (const agentId of clearableAgentIds) {
                    const liveAgent = this.agentManager.getAgent(agentId);
                    if (liveAgent) {
                        await this.agentManager.clearAgentAttention(agentId);
                        clearedAgentIds.push(agentId);
                        continue;
                    }
                    const record = await this.agentStorage.get(agentId);
                    if (!record ||
                        record.internal ||
                        record.archivedAt ||
                        record.requiresAttention !== true) {
                        continue;
                    }
                    const nextRecord = {
                        ...record,
                        updatedAt: new Date().toISOString(),
                        requiresAttention: false,
                        attentionReason: null,
                        attentionTimestamp: null,
                    };
                    await this.agentStorage.upsert(nextRecord);
                    const agent = this.buildStoredAgentPayload(nextRecord);
                    const project = await this.buildProjectPlacementForWorkspace(workspace);
                    this.emit({
                        type: "agent_update",
                        payload: {
                            kind: "upsert",
                            agent,
                            project,
                        },
                    });
                    clearedAgentIds.push(agentId);
                }
                await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
                results.push({
                    workspaceId: requestedWorkspaceId,
                    clearedAgentIds,
                    success: true,
                    error: null,
                });
            }
            catch (error) {
                const message = getErrorMessage(error);
                this.sessionLogger.error({ err: error, workspaceId: requestedWorkspaceId }, "Failed to clear workspace attention");
                results.push({
                    workspaceId: requestedWorkspaceId,
                    clearedAgentIds,
                    success: false,
                    error: message,
                });
            }
        }
        const clearedAgentIds = results.flatMap((result) => result.clearedAgentIds);
        const failedResults = results.filter((result) => !result.success);
        this.emit({
            type: "workspace.clear_attention.response",
            payload: {
                requestId,
                workspaceId,
                clearedAgentIds,
                results,
                success: failedResults.length === 0,
                error: failedResults.length === 0
                    ? null
                    : failedResults
                        .map((result) => result.error)
                        .filter((error) => error !== null)
                        .join("; "),
            },
        });
    }
    async handleFetchAgent(agentIdOrIdentifier, requestId) {
        const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
        if (!resolved.ok) {
            this.emit({
                type: "fetch_agent_response",
                payload: { requestId, agent: null, project: null, error: resolved.error },
            });
            return;
        }
        const agent = await this.getAgentPayloadById(resolved.agentId);
        if (!agent) {
            this.emit({
                type: "fetch_agent_response",
                payload: {
                    requestId,
                    agent: null,
                    project: null,
                    error: `Agent not found: ${resolved.agentId}`,
                },
            });
            return;
        }
        const project = agent.workspaceId
            ? await this.buildProjectPlacementForWorkspaceId(agent.workspaceId)
            : null;
        this.emit({
            type: "fetch_agent_response",
            payload: { requestId, agent, project, error: null },
        });
    }
    shouldUseFullTimelineForProjectedPage(input) {
        const { timeline } = input;
        if (timeline.rows.length === 0)
            return false;
        if (timeline.rows.some((row) => row.item.type === "tool_call"))
            return true;
        const firstRow = timeline.rows[0];
        if (timeline.hasOlder &&
            (firstRow?.item.type === "assistant_message" || firstRow?.item.type === "reasoning")) {
            return true;
        }
        const lastRow = timeline.rows.at(-1);
        if (timeline.hasNewer &&
            (lastRow?.item.type === "assistant_message" || lastRow?.item.type === "reasoning")) {
            return true;
        }
        if (!timeline.hasNewer || input.pageLimit === 0)
            return false;
        return projectTimelineRows({ rows: timeline.rows, mode: "projected" }).length < input.pageLimit;
    }
    selectCanonicalTimelineProjection(input) {
        const entries = projectTimelineRows({ rows: input.timeline.rows, mode: "canonical" });
        return {
            timeline: input.timeline,
            entries,
            startSeq: entries[0]?.seqStart ?? null,
            endSeq: entries[entries.length - 1]?.seqEnd ?? null,
            hasOlder: input.timeline.hasOlder,
            hasNewer: input.timeline.hasNewer,
        };
    }
    selectProjectedTimelineProjection(input) {
        const selectedTimeline = this.shouldUseFullTimelineForProjectedPage({
            timeline: input.controlTimeline,
            pageLimit: input.pageLimit,
        })
            ? (input.fullTimeline ??
                this.agentManager.fetchTimeline(input.agentId, { direction: "tail", limit: 0 }))
            : input.controlTimeline;
        const page = selectProjectedTimelinePage({
            rows: selectedTimeline.rows,
            bounds: selectedTimeline.window,
            direction: input.controlTimeline.reset ? "tail" : input.direction,
            ...(input.cursor ? { cursorSeq: input.cursor.seq } : {}),
            limit: input.pageLimit,
        });
        return {
            timeline: selectedTimeline,
            entries: page.entries,
            startSeq: page.startSeq,
            endSeq: page.endSeq,
            hasOlder: page.hasOlder || (page.startSeq !== null && page.startSeq > selectedTimeline.window.minSeq),
            hasNewer: page.hasNewer,
        };
    }
    selectTimelineProjection(input) {
        if (input.projection === "canonical") {
            return this.selectCanonicalTimelineProjection({ timeline: input.controlTimeline });
        }
        return this.selectProjectedTimelineProjection(input);
    }
    async handleFetchAgentTimelineRequest(msg, source) {
        const direction = msg.direction ?? (msg.cursor ? "after" : "tail");
        const projection = msg.projection ?? "projected";
        const requestedLimit = msg.limit;
        const pageLimit = requestedLimit ?? (direction === "after" ? 0 : 200);
        const cursor = msg.cursor
            ? {
                epoch: msg.cursor.epoch,
                seq: msg.cursor.seq,
            }
            : undefined;
        try {
            const snapshot = await ensureAgentLoaded(msg.agentId, {
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
            });
            const agentPayload = await this.buildAgentPayload(snapshot);
            const fetchedControlTimeline = this.agentManager.fetchTimeline(msg.agentId, {
                direction,
                cursor,
                limit: pageLimit,
            });
            const selectedTimeline = this.selectTimelineProjection({
                agentId: msg.agentId,
                projection,
                controlTimeline: fetchedControlTimeline,
                direction,
                ...(cursor ? { cursor } : {}),
                pageLimit,
            });
            const startCursor = selectedTimeline.startSeq !== null
                ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.startSeq }
                : null;
            const endCursor = selectedTimeline.endSeq !== null
                ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.endSeq }
                : null;
            this.emitForSource({
                type: "fetch_agent_timeline_response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    agent: agentPayload,
                    direction,
                    projection,
                    epoch: selectedTimeline.timeline.epoch,
                    reset: fetchedControlTimeline.reset,
                    staleCursor: fetchedControlTimeline.staleCursor,
                    gap: fetchedControlTimeline.gap,
                    window: selectedTimeline.timeline.window,
                    startCursor,
                    endCursor,
                    hasOlder: selectedTimeline.hasOlder,
                    hasNewer: selectedTimeline.hasNewer,
                    ...(msg.mergeWindow === true ? { mergeWindow: true } : {}),
                    entries: selectedTimeline.entries.map((entry) => ({
                        provider: snapshot.provider,
                        item: entry.item,
                        timestamp: entry.timestamp,
                        seqStart: entry.seqStart,
                        seqEnd: entry.seqEnd,
                        sourceSeqRanges: entry.sourceSeqRanges,
                        collapsed: (source
                            ? this.supportsForSource(CLIENT_CAPS.reasoningMergeEnum, source)
                            : this.supports(CLIENT_CAPS.reasoningMergeEnum))
                            ? entry.collapsed
                            : entry.collapsed.filter((value) => value !== "reasoning_merge"),
                    })),
                    error: null,
                },
            }, source);
        }
        catch (error) {
            this.sessionLogger.error({ err: error, agentId: msg.agentId }, "Failed to handle fetch_agent_timeline_request");
            this.emitForSource({
                type: "fetch_agent_timeline_response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    agent: null,
                    direction,
                    projection,
                    epoch: "",
                    reset: false,
                    staleCursor: false,
                    gap: false,
                    window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
                    startCursor: null,
                    endCursor: null,
                    hasOlder: false,
                    hasNewer: false,
                    ...(msg.mergeWindow === true ? { mergeWindow: true } : {}),
                    entries: [],
                    error: error instanceof Error ? error.message : String(error),
                },
            }, source);
        }
    }
    async handleAgentTimelineListPromptsRequest(msg, source) {
        // Draft composer ids are client-side placeholders, not persisted agents.
        // Returning an empty prompt index keeps draft routes quiet instead of
        // surfacing a misleading "Agent not found" error in the browser.
        if (msg.agentId.startsWith("draft_msg_")) {
            this.emitForSource({
                type: "agent.timeline.list_prompts.response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    epoch: "",
                    prompts: [],
                    error: null,
                },
            }, source);
            return;
        }
        try {
            await ensureAgentLoaded(msg.agentId, {
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
            });
            const rows = await this.agentManager.getTimelineRows(msg.agentId);
            const timeline = this.agentManager.fetchTimeline(msg.agentId, {
                direction: "tail",
                limit: 1,
            });
            const index = buildTimelinePromptIndex(timeline.epoch, rows);
            this.emitForSource({
                type: "agent.timeline.list_prompts.response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    ...index,
                    error: null,
                },
            }, source);
        }
        catch (error) {
            this.sessionLogger.error({ err: error, agentId: msg.agentId }, "Failed to handle agent.timeline.list_prompts.request");
            this.emitForSource({
                type: "agent.timeline.list_prompts.response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    epoch: "",
                    prompts: [],
                    error: error instanceof Error ? error.message : String(error),
                },
            }, source);
        }
    }
    async handleProviderSubagentListRequest(msg) {
        try {
            await ensureUnarchivedAgentLoaded(msg.parentAgentId, {
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
            });
            this.emit({
                type: "agent.provider_subagents.list.response",
                payload: {
                    requestId: msg.requestId,
                    parentAgentId: msg.parentAgentId,
                    subagents: this.agentManager.listProviderSubagents(msg.parentAgentId),
                    error: null,
                },
            });
        }
        catch (error) {
            this.emit({
                type: "agent.provider_subagents.list.response",
                payload: {
                    requestId: msg.requestId,
                    parentAgentId: msg.parentAgentId,
                    subagents: [],
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
    async handleProviderSubagentTimelineRequest(msg) {
        const direction = msg.direction ?? (msg.cursor ? "after" : "tail");
        try {
            await ensureUnarchivedAgentLoaded(msg.parentAgentId, {
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
            });
            const descriptor = this.agentManager.getProviderSubagent(msg.parentAgentId, msg.subagentId);
            if (!descriptor) {
                throw new Error("Provider subagent not found");
            }
            const timeline = this.agentManager.fetchProviderSubagentTimeline(msg.parentAgentId, msg.subagentId, {
                direction,
                cursor: msg.cursor,
                limit: msg.limit ?? (direction === "after" ? 0 : 200),
            });
            this.emit({
                type: "agent.provider_subagents.timeline.get.response",
                payload: {
                    requestId: msg.requestId,
                    parentAgentId: msg.parentAgentId,
                    subagentId: msg.subagentId,
                    provider: descriptor.provider,
                    direction,
                    epoch: timeline.epoch,
                    reset: timeline.reset,
                    staleCursor: timeline.staleCursor,
                    gap: timeline.gap,
                    window: timeline.window,
                    hasOlder: timeline.hasOlder,
                    hasNewer: timeline.hasNewer,
                    rows: timeline.rows.map((row) => ({
                        item: row.item,
                        timestamp: row.timestamp,
                        seq: row.seq,
                    })),
                    error: null,
                },
            });
        }
        catch (error) {
            this.emit({
                type: "agent.provider_subagents.timeline.get.response",
                payload: {
                    requestId: msg.requestId,
                    parentAgentId: msg.parentAgentId,
                    subagentId: msg.subagentId,
                    provider: null,
                    direction,
                    epoch: "",
                    reset: false,
                    staleCursor: false,
                    gap: false,
                    window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
                    hasOlder: false,
                    hasNewer: false,
                    rows: [],
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
    async handleAgentForkContextRequest(msg) {
        try {
            const snapshot = await ensureAgentLoaded(msg.agentId, {
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
            });
            const agentPayload = await this.buildAgentPayload(snapshot);
            const timeline = this.agentManager.fetchTimeline(msg.agentId, {
                direction: "tail",
                limit: 0,
            });
            const forkContext = buildAgentForkContextAttachment({
                rows: timeline.rows,
                cursorBoundary: msg.boundaryCursor
                    ? { timelineEpoch: timeline.epoch, cursor: msg.boundaryCursor }
                    : null,
                boundaryMessageId: msg.boundaryMessageId,
                agentTitle: agentPayload.title,
                cwd: snapshot.cwd,
            });
            this.emit({
                type: "agent.fork_context.response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    attachment: forkContext.attachment,
                    itemCount: forkContext.itemCount,
                    boundaryCursor: forkContext.boundaryCursor,
                    boundaryMessageId: forkContext.boundaryMessageId,
                    error: null,
                },
            });
        }
        catch (error) {
            this.sessionLogger.error({ err: error, agentId: msg.agentId }, "Failed to handle agent.fork_context.request");
            this.emit({
                type: "agent.fork_context.response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    attachment: null,
                    itemCount: 0,
                    boundaryCursor: msg.boundaryCursor ?? null,
                    boundaryMessageId: msg.boundaryMessageId ?? null,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
    async handleSendAgentMessageRequest(msg) {
        const resolved = await this.resolveAgentIdentifier(msg.agentId);
        if (!resolved.ok) {
            this.emit({
                type: "send_agent_message_response",
                payload: {
                    requestId: msg.requestId,
                    agentId: msg.agentId,
                    accepted: false,
                    error: resolved.error,
                },
            });
            return;
        }
        try {
            const agentId = resolved.agentId;
            const prompt = buildAgentPrompt(msg.text, msg.images, msg.attachments);
            this.sessionLogger.trace({
                agentId,
                messageId: msg.messageId,
                textPrefix: msg.text.slice(0, 80),
            }, "agent.session.send_agent_message");
            let dispatchResult;
            try {
                dispatchResult = await sendPromptToAgent({
                    agentManager: this.agentManager,
                    agentStorage: this.agentStorage,
                    agentId,
                    prompt,
                    messageId: msg.messageId,
                    logger: this.sessionLogger,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.handleAgentRunError(agentId, error, "Failed to send agent message");
                this.emit({
                    type: "send_agent_message_response",
                    payload: {
                        requestId: msg.requestId,
                        agentId,
                        accepted: false,
                        error: message,
                    },
                });
                return;
            }
            if (dispatchResult.outOfBand) {
                this.emit({
                    type: "send_agent_message_response",
                    payload: {
                        requestId: msg.requestId,
                        agentId,
                        accepted: true,
                        error: null,
                    },
                });
                return;
            }
            try {
                await waitForAgentRunStartWithTimeout(this.agentManager, agentId);
            }
            catch (error) {
                this.emit({
                    type: "send_agent_message_response",
                    payload: {
                        requestId: msg.requestId,
                        agentId,
                        accepted: false,
                        error: errorToFriendlyMessage(error),
                    },
                });
                return;
            }
            this.emit({
                type: "send_agent_message_response",
                payload: {
                    requestId: msg.requestId,
                    agentId,
                    accepted: true,
                    error: null,
                },
            });
        }
        catch (error) {
            this.emit({
                type: "send_agent_message_response",
                payload: {
                    requestId: msg.requestId,
                    agentId: resolved.agentId,
                    accepted: false,
                    error: errorToFriendlyMessage(error),
                },
            });
        }
    }
    async handleWaitForFinish(agentIdOrIdentifier, requestId, timeoutMs) {
        const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
        if (!resolved.ok) {
            this.emit({
                type: "wait_for_finish_response",
                payload: {
                    requestId,
                    status: "error",
                    final: null,
                    error: resolved.error,
                    lastMessage: null,
                },
            });
            return;
        }
        const agentId = resolved.agentId;
        const live = this.agentManager.getAgent(agentId);
        if (!live) {
            const record = await this.agentStorage.get(agentId);
            if (!record || record.internal) {
                this.emit({
                    type: "wait_for_finish_response",
                    payload: {
                        requestId,
                        status: "error",
                        final: null,
                        error: `Agent not found: ${agentId}`,
                        lastMessage: null,
                    },
                });
                return;
            }
            const final = this.buildStoredAgentPayload(record);
            let status;
            if (record.attentionReason === "permission") {
                status = "permission";
            }
            else if (record.lastStatus === "error") {
                status = "error";
            }
            else {
                status = "idle";
            }
            const error = resolveWaitForFinishError({ status, final });
            this.emit({
                type: "wait_for_finish_response",
                payload: { requestId, status, final, error, lastMessage: null },
            });
            return;
        }
        const abortController = new AbortController();
        const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0;
        const timeoutHandle = hasTimeout
            ? setTimeout(() => {
                abortController.abort("timeout");
            }, timeoutMs)
            : null;
        try {
            let result = await this.agentManager.waitForAgentEvent(agentId, {
                signal: abortController.signal,
                waitForActive: true,
            });
            let final = await this.getAgentPayloadById(agentId);
            if (!final) {
                throw new Error(`Agent ${agentId} disappeared while waiting`);
            }
            let status;
            if (result.permission) {
                status = "permission";
            }
            else if (result.status === "error") {
                status = "error";
            }
            else {
                status = "idle";
            }
            const error = resolveWaitForFinishError({ status, final });
            this.emit({
                type: "wait_for_finish_response",
                payload: { requestId, status, final, error, lastMessage: result.lastMessage },
            });
        }
        catch (error) {
            const isAbort = error instanceof Error &&
                (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
            if (!isAbort) {
                const message = errorToFriendlyMessage(error);
                this.sessionLogger.error({ err: error, agentId }, "wait_for_finish_request failed");
                const final = await this.getAgentPayloadById(agentId);
                this.emit({
                    type: "wait_for_finish_response",
                    payload: {
                        requestId,
                        status: "error",
                        final,
                        error: message,
                        lastMessage: null,
                    },
                });
                return;
            }
            const final = await this.getAgentPayloadById(agentId);
            if (!final) {
                throw new Error(`Agent ${agentId} disappeared while waiting`, { cause: error });
            }
            this.emit({
                type: "wait_for_finish_response",
                payload: { requestId, status: "timeout", final, error: null, lastMessage: null },
            });
        }
        finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }
    /**
     * Emit a message to the client
     */
    emit(msg) {
        if (msg.type !== "rpc_error" && !isSessionRpcAllowed(this.scopes, msg.type)) {
            return;
        }
        // JSON.stringify(msg) is only computed when trace is enabled — it runs for
        // every outbound message otherwise, and trace is disabled by default.
        // Optional-chained because test logger stubs don't implement isLevelEnabled.
        if (this.sessionLogger.isLevelEnabled?.("trace")) {
            this.sessionLogger.trace({
                messageType: msg.type,
                payloadBytes: JSON.stringify(msg).length,
            }, "agent.session.outbound");
        }
        this.onMessage(msg);
    }
    emitBinary(frame) {
        if (!this.onBinaryMessage) {
            return;
        }
        try {
            this.onBinaryMessage(frame);
        }
        catch (error) {
            this.sessionLogger.error({ err: error }, "Failed to emit binary frame");
        }
    }
    async emitBinaryForFileTransfer(frame, source) {
        if (source && this.onBinaryMessageToSource) {
            await this.onBinaryMessageToSource(source, frame);
            return;
        }
        this.emitBinary(frame);
    }
    emitForSource(msg, source) {
        if (source && this.onMessageToSource) {
            this.onMessageToSource(source, msg);
            return;
        }
        this.emit(msg);
    }
    /**
     * Clean up session resources
     */
    async cleanup() {
        this.sessionLogger.trace({}, "agent.session.lifecycle.cleanup");
        this.isCleanedUp = true;
        if (this.unsubscribeAgentEvents) {
            this.unsubscribeAgentEvents();
            this.unsubscribeAgentEvents = null;
        }
        this.unsubscribeProjectMutations?.();
        this.unsubscribeProjectMutations = null;
        this.unsubscribeWorkspaceMutations?.();
        this.unsubscribeWorkspaceMutations = null;
        this.agentUpdates.dispose();
        await this.hubExecutionController?.cleanup();
        if (this.unsubscribeTerminalWorkspaceContributionEvents) {
            this.unsubscribeTerminalWorkspaceContributionEvents();
            this.unsubscribeTerminalWorkspaceContributionEvents = null;
        }
        this.providerCatalogSession.dispose();
        await this.voiceSession.cleanup();
        this.terminalController.dispose();
        this.checkoutSession.cleanup();
        this.workspaceGitObserver.dispose();
        this.workspaceFilesSession.dispose();
    }
}
function normalizeCloneRepository(input) {
    const trimmed = input.repo.trim();
    if (!trimmed) {
        throw new Error("Repository is required");
    }
    const remote = parseGitRemoteLocation(trimmed);
    if (remote) {
        const segments = remote.path.split("/").filter(Boolean);
        const name = segments.at(-1);
        if (!name || !isValidGitHubRepoSegment(name)) {
            throw new Error("Repository name contains invalid characters");
        }
        return { name, displayName: remote.path, cloneUrl: trimmed };
    }
    const [owner, rawName, ...extra] = trimmed.split("/");
    if (!owner || !rawName || extra.length > 0) {
        throw new Error("Repository must use owner/repo format or a git remote URL");
    }
    const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
    if (!isValidGitHubRepoSegment(owner) || !isValidGitHubRepoSegment(name)) {
        throw new Error("Repository contains invalid characters");
    }
    if (!input.cloneProtocol) {
        throw new Error("Clone protocol is required for owner/repo repository names");
    }
    const cloneUrl = input.cloneProtocol === "ssh"
        ? `git@github.com:${owner}/${name}.git`
        : `https://github.com/${owner}/${name}.git`;
    return {
        name,
        displayName: `${owner}/${name}`,
        cloneUrl,
    };
}
function isValidGitHubRepoSegment(value) {
    return /^[A-Za-z0-9._-]+$/u.test(value);
}
//# sourceMappingURL=session.js.map
