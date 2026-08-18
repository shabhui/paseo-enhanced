const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function validateCommand(command) {
    if (!Array.isArray(command) || command.length === 0 || command.length > 32 ||
        command.some((item) => typeof item !== "string" || !item.trim() || item.length > 8192 || /\0/u.test(item))) {
        throw new Error("Provider command must be a non-empty string array");
    }
    return command.map((item) => item.trim());
}

function validateEnvironment(environment) {
    if (!isRecord(environment)) throw new Error("Provider environment must be a JSON object");
    const result = {};
    for (const [key, value] of Object.entries(environment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.length > 65536 || /[\0\r\n]/u.test(value)) {
            throw new Error(`Invalid provider environment variable: ${key}`);
        }
        result[key] = value;
    }
    return result;
}

export function mergeProviderOverride(existing = {}, input = {}) {
    return mergeProviderOverrides({ selected: existing }, "selected", input).selected ?? {};
}

export function mergeProviderOverrides(overrides = {}, providerId, input = {}) {
    assertProviderId(providerId);
    if (!isRecord(overrides) || !isRecord(input)) throw new Error("Provider configuration must be an object");
    const next = Object.fromEntries(Object.entries(overrides).map(([id, value]) => [id, clone(value) ?? {}]));
    const current = isRecord(next[providerId]) ? next[providerId] : {};
    const updated = { ...current };
    if (Object.prototype.hasOwnProperty.call(input, "enabled")) {
        if (typeof input.enabled !== "boolean") throw new Error("Provider enabled must be boolean");
        updated.enabled = input.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(input, "command")) {
        if (input.command === null) delete updated.command;
        else updated.command = validateCommand(input.command);
    }
    if (Object.prototype.hasOwnProperty.call(input, "env")) {
        if (input.env === null) delete updated.env;
        else updated.env = validateEnvironment(input.env);
    }
    if (Object.prototype.hasOwnProperty.call(input, "additionalModels")) {
        if (input.additionalModels === null) delete updated.additionalModels;
        else if (!Array.isArray(input.additionalModels)) throw new Error("Provider additionalModels must be an array");
        else updated.additionalModels = clone(input.additionalModels);
    }
    if (Object.keys(updated).length === 0) delete next[providerId];
    else next[providerId] = updated;
    return next;
}

export function providerViewFromSnapshot(entry, override = {}) {
    const environment = isRecord(override.env) ? override.env : {};
    return {
        id: entry.provider,
        label: entry.label ?? entry.provider,
        description: entry.description ?? "",
        status: entry.status,
        enabled: entry.enabled !== false,
        available: entry.enabled !== false && entry.status === "ready",
        error: entry.error ?? null,
        config: {
            configured: Object.keys(override).length > 0,
            command: Array.isArray(override.command) ? [...override.command] : null,
            envKeys: Object.keys(environment).sort(),
            additionalModels: Array.isArray(override.additionalModels) ? clone(override.additionalModels) : [],
        },
    };
}

function mutableProviderSettingsFromOverrides(overrides) {
    const providers = {};
    for (const [providerId, override] of Object.entries(overrides)) {
        if (!isRecord(override)) continue;
        const mutable = {};
        if (typeof override.enabled === "boolean") mutable.enabled = override.enabled;
        if (Array.isArray(override.additionalModels)) mutable.additionalModels = clone(override.additionalModels);
        if (Object.keys(mutable).length > 0) providers[providerId] = mutable;
    }
    return providers;
}

export function applyProviderOverridesToRuntime(runtime, overrides) {
    if (!isRecord(overrides)) throw new Error("Provider configuration must be an object");
    const baseOverrides = Object.keys(overrides).length > 0 ? clone(overrides) : undefined;
    const mutableProviders = mutableProviderSettingsFromOverrides(overrides);

    if (runtime.daemonConfigStore) {
        const current = runtime.daemonConfigStore.get();
        runtime.daemonConfigStore.current = { ...current, providers: mutableProviders };
    }

    runtime.providerSnapshotManager.baseProviderOverrides = baseOverrides;
    const state = runtime.providerSnapshotManager.applyMutableProviderConfig(mutableProviders);
    runtime.agentManager.updateProviderRegistry(state);
    return state;
}

export function assertProviderId(value) {
    if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
        throw new Error("Invalid provider id");
    }
    return value;
}
