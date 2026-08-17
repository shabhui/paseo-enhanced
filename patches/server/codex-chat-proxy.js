import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const CHAT_PROXY_HOST = "127.0.0.1";
const CHAT_PROXY_PORT = 6768;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_DECOMPRESSED_REQUEST_BYTES = 32 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const HOP_BY_HOP_HEADERS = new Set([
    "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);
const CODEX_REQUEST_HEADERS = new Set([
    "originator", "session-id", "thread-id", "x-client-request-id",
    "x-codex-turn-metadata", "x-codex-window-id",
]);
let managedServer = null;

function readActiveProfile() {
    const profilesPath = path.join(homedir(), ".paseo", "codex-provider-profiles.json");
    const saved = JSON.parse(readFileSync(profilesPath, "utf8"));
    const profile = Array.isArray(saved?.profiles)
        ? saved.profiles.find((item) => item?.id === saved.activeId)
        : null;
    if (!profile || typeof profile.baseUrl !== "string") {
        throw new Error("No active Paseo provider profile is configured");
    }
    return {
        ...profile,
        wireApi: profile.wireApi === "chat" ? "chat" : "responses",
    };
}

function normalizeApiRoot(baseUrl) {
    const normalized = baseUrl.trim().replace(/\/+$/u, "");
    for (const suffix of ["/responses/compact", "/chat/completions", "/responses", "/models"]) {
        if (normalized.endsWith(suffix)) {
            return normalized.slice(0, -suffix.length);
        }
    }
    return normalized;
}

function normalizeChatEndpoint(baseUrl) {
    return `${normalizeApiRoot(baseUrl)}/chat/completions`;
}

function normalizeResponsesEndpoint(baseUrl) {
    return `${normalizeApiRoot(baseUrl)}/responses`;
}

function normalizeModelsEndpoint(baseUrl) {
    return `${normalizeApiRoot(baseUrl)}/models`;
}

function isLoopbackRequest(req) {
    return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "");
}

function squeezeRetryEnabled(profile) {
    return profile?.busyRetryEnabled === true;
}

function canSqueezeRetry(status) {
    const numeric = Number(status);
    return numeric >= 400 && numeric <= 599;
}

function reloadSqueezeProfile(profileLoader, fallback) {
    try {
        const next = profileLoader?.();
        return next && typeof next === "object" ? next : fallback;
    }
    catch {
        return fallback;
    }
}

/* Retry at the same pace as the upstream request. The next profile read is
 * what makes the UI switch an in-flight loop off without killing the request. */
async function fetchWithSqueezeRetry(invoke, profile, profileLoader) {
    let current = profile;
    while (true) {
        let response;
        try {
            response = await invoke(current);
        }
        catch (error) {
            if (!squeezeRetryEnabled(current)) throw error;
            const next = reloadSqueezeProfile(profileLoader, current);
            if (!squeezeRetryEnabled(next)) throw error;
            current = next;
            continue;
        }
        if (response.ok || !canSqueezeRetry(response.status) || !squeezeRetryEnabled(current)) {
            return { response, profile: current };
        }
        const next = reloadSqueezeProfile(profileLoader, current);
        if (!squeezeRetryEnabled(next)) {
            return { response, profile: current };
        }
        try { await response.arrayBuffer(); } catch { /* best effort drain before retry */ }
        current = next;
    }
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
    });
    res.end(payload);
}

function sendError(res, status, message, type = "invalid_request_error") {
    sendJson(res, status, { error: { message, type, code: null, param: null } });
}

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > MAX_REQUEST_BYTES) {
                reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            resolve(Buffer.concat(chunks));
        });
        req.on("error", reject);
    });
}

function decodeRequestBody(rawBody, contentEncoding) {
    const encoding = String(contentEncoding || "identity").split(",")[0].trim().toLowerCase();
    let decoded;
    try {
        if (!encoding || encoding === "identity") decoded = rawBody;
        else if (encoding === "gzip" || encoding === "x-gzip") decoded = gunzipSync(rawBody);
        else if (encoding === "deflate") decoded = inflateSync(rawBody);
        else if (encoding === "br") decoded = brotliDecompressSync(rawBody);
        else throw Object.assign(new Error(`Unsupported request content encoding: ${encoding}`), { status: 415 });
    }
    catch (error) {
        if (error?.status) throw error;
        throw Object.assign(new Error("Unable to decompress the Codex request body"), { status: 400, cause: error });
    }
    if (decoded.length > MAX_DECOMPRESSED_REQUEST_BYTES) {
        throw Object.assign(new Error("Decompressed request body is too large"), { status: 413 });
    }
    return decoded;
}

function parseJsonBody(rawBody, contentEncoding) {
    try {
        return JSON.parse(decodeRequestBody(rawBody, contentEncoding).toString("utf8"));
    }
    catch (error) {
        if (error?.status) throw error;
        throw Object.assign(new Error("Expected a valid JSON request body"), { status: 400, cause: error });
    }
}

function stringValue(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value === undefined || value === null) {
        return "";
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}

function contentText(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return stringValue(content);
    }
    return content.map((part) => {
        if (typeof part === "string") {
            return part;
        }
        if (typeof part?.text === "string") {
            return part.text;
        }
        if (typeof part?.refusal === "string") {
            return part.refusal;
        }
        return "";
    }).filter(Boolean).join("\n");
}

function toChatContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return stringValue(content);
    }
    const parts = [];
    let hasImage = false;
    for (const part of content) {
        if (typeof part === "string") {
            parts.push({ type: "text", text: part });
            continue;
        }
        if (["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string") {
            parts.push({ type: "text", text: part.text });
            continue;
        }
        if (part?.type === "input_image" && typeof part.image_url === "string") {
            hasImage = true;
            parts.push({
                type: "image_url",
                image_url: {
                    url: part.image_url,
                    ...(typeof part.detail === "string" ? { detail: part.detail } : {}),
                },
            });
        }
    }
    if (!hasImage) {
        return parts.map((part) => part.text ?? "").filter(Boolean).join("\n");
    }
    return parts;
}

function safeToolName(value, usedNames) {
    const base = String(value || "tool").replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "tool";
    let candidate = base;
    let suffix = 1;
    while (usedNames.has(candidate)) {
        const ending = `_${suffix++}`;
        candidate = `${base.slice(0, 64 - ending.length)}${ending}`;
    }
    usedNames.add(candidate);
    return candidate;
}

function translateTools(tools) {
    const chatTools = [];
    const responseNameByChatName = new Map();
    const chatNameByResponseName = new Map();
    const usedNames = new Set();
    const addFunction = (tool, responseName, suggestedName) => {
        if (!tool || typeof tool !== "object") {
            return;
        }
        const chatName = safeToolName(suggestedName, usedNames);
        responseNameByChatName.set(chatName, responseName);
        chatNameByResponseName.set(responseName, chatName);
        chatTools.push({
            type: "function",
            function: {
                name: chatName,
                ...(typeof tool.description === "string" ? { description: tool.description } : {}),
                parameters: tool.parameters && typeof tool.parameters === "object"
                    ? tool.parameters
                    : { type: "object", properties: {}, additionalProperties: true },
                ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
            },
        });
    };
    for (const tool of Array.isArray(tools) ? tools : []) {
        if (tool?.type === "function" && typeof tool.name === "string") {
            addFunction(tool, tool.name, tool.name);
            continue;
        }
        if (tool?.type === "custom" && typeof tool.name === "string") {
            addFunction({
                ...tool,
                parameters: {
                    type: "object",
                    properties: { input: { type: "string" } },
                    required: ["input"],
                    additionalProperties: false,
                },
            }, tool.name, tool.name);
            continue;
        }
        if (tool?.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
            for (const child of tool.tools) {
                if (child?.type !== "function" || typeof child.name !== "string") {
                    continue;
                }
                const responseName = `${tool.name}.${child.name}`;
                addFunction(child, responseName, `${tool.name}__${child.name}`);
            }
        }
    }
    return { chatTools, responseNameByChatName, chatNameByResponseName };
}

function appendToolCall(messages, item, chatNameByResponseName) {
    const responseName = typeof item.name === "string" ? item.name : "tool";
    const chatName = chatNameByResponseName.get(responseName) ?? responseName.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
    let assistant = messages.at(-1);
    if (!assistant || assistant.role !== "assistant" || assistant.__paseoSealed === true) {
        assistant = { role: "assistant", content: null, tool_calls: [] };
        messages.push(assistant);
    }
    if (!Array.isArray(assistant.tool_calls)) {
        assistant.tool_calls = [];
    }
    const isCustom = item.type === "custom_tool_call";
    assistant.tool_calls.push({
        id: item.call_id || item.id || `call_${randomUUID().replace(/-/gu, "")}`,
        type: "function",
        function: {
            name: chatName,
            arguments: isCustom
                ? JSON.stringify({ input: stringValue(item.input) })
                : stringValue(item.arguments || "{}"),
        },
    });
}

function translateInput(input, chatNameByResponseName, instructions) {
    const messages = [];
    const systemParts = [];
    if (typeof instructions === "string" && instructions.trim()) {
        systemParts.push(instructions.trim());
    }
    const items = typeof input === "string"
        ? [{ type: "message", role: "user", content: input }]
        : Array.isArray(input) ? input : [];
    for (const item of items) {
        if (!item || typeof item !== "object") {
            continue;
        }
        if (item.type === "message") {
            const role = typeof item.role === "string" ? item.role : "user";
            const content = toChatContent(item.content);
            if (role === "developer" || role === "system") {
                const text = contentText(content);
                if (text) {
                    systemParts.push(text);
                }
                continue;
            }
            messages.push({ role: ["assistant", "user"].includes(role) ? role : "user", content });
            continue;
        }
        if (item.type === "reasoning") {
            const summary = contentText(item.summary);
            if (summary) {
                messages.push({ role: "assistant", content: `[Reasoning summary]\n${summary}` });
            }
            continue;
        }
        if (item.type === "function_call" || item.type === "custom_tool_call") {
            appendToolCall(messages, item, chatNameByResponseName);
            continue;
        }
        if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
            const previous = messages.at(-1);
            if (previous?.role === "assistant") {
                previous.__paseoSealed = true;
            }
            messages.push({
                role: "tool",
                tool_call_id: item.call_id || item.id || "unknown_call",
                content: stringValue(item.output),
            });
            continue;
        }
        if (typeof item.output === "string") {
            messages.push({ role: "user", content: `[Tool output]\n${item.output}` });
        }
    }
    for (const message of messages) {
        delete message.__paseoSealed;
    }
    if (systemParts.length) {
        messages.unshift({ role: "system", content: systemParts.join("\n\n") });
    }
    return messages;
}

function collectRequestTools(body) {
    const tools = Array.isArray(body.tools) ? [...body.tools] : [];
    if (Array.isArray(body.input)) {
        for (const item of body.input) {
            if (item?.type === "additional_tools" && Array.isArray(item.tools)) {
                tools.push(...item.tools);
            }
        }
    }
    return tools;
}

function translateResponseFormat(text) {
    const format = text?.format;
    if (!format || typeof format !== "object" || format.type === "text") {
        return undefined;
    }
    if (format.type === "json_object") {
        return { type: "json_object" };
    }
    if (format.type === "json_schema" && format.schema && typeof format.schema === "object") {
        return {
            type: "json_schema",
            json_schema: {
                name: typeof format.name === "string" && format.name ? format.name : "response",
                schema: format.schema,
                ...(typeof format.description === "string" ? { description: format.description } : {}),
                ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
            },
        };
    }
    return undefined;
}

export function translateResponsesRequest(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Expected a Responses API request object");
    }
    if (typeof body.model !== "string" || !body.model.trim()) {
        throw new Error("A model is required");
    }
    const toolMapping = translateTools(collectRequestTools(body));
    const payload = {
        model: body.model.trim(),
        messages: translateInput(body.input, toolMapping.chatNameByResponseName, body.instructions),
        stream: false,
    };
    if (toolMapping.chatTools.length) {
        payload.tools = toolMapping.chatTools;
        if (["auto", "none", "required"].includes(body.tool_choice)) {
            payload.tool_choice = body.tool_choice;
        }
        if (typeof body.parallel_tool_calls === "boolean") {
            payload.parallel_tool_calls = body.parallel_tool_calls;
        }
    }
    if (Number.isFinite(body.max_output_tokens)) {
        payload.max_completion_tokens = body.max_output_tokens;
    }
    if (Number.isFinite(body.temperature)) {
        payload.temperature = body.temperature;
    }
    if (Number.isFinite(body.top_p)) {
        payload.top_p = body.top_p;
    }
    if (typeof body.reasoning?.effort === "string" && body.reasoning.effort !== "none") {
        payload.reasoning_effort = body.reasoning.effort;
    }
    const responseFormat = translateResponseFormat(body.text);
    if (responseFormat) {
        payload.response_format = responseFormat;
    }
    return { payload, toolMapping };
}

function normalizeChatToolCalls(message) {
    if (Array.isArray(message?.tool_calls)) {
        return message.tool_calls;
    }
    if (message?.function_call && typeof message.function_call === "object") {
        return [{
            id: `call_${randomUUID().replace(/-/gu, "")}`,
            type: "function",
            function: message.function_call,
        }];
    }
    return [];
}

function responseUsage(usage) {
    if (!usage || typeof usage !== "object") {
        return null;
    }
    const inputTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
    const outputTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
    return {
        input_tokens: inputTokens,
        input_tokens_details: {
            cached_tokens: Number.isFinite(usage.prompt_tokens_details?.cached_tokens)
                ? usage.prompt_tokens_details.cached_tokens
                : 0,
        },
        output_tokens: outputTokens,
        output_tokens_details: {
            reasoning_tokens: Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)
                ? usage.completion_tokens_details.reasoning_tokens
                : 0,
        },
        total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : inputTokens + outputTokens,
    };
}

export function chatCompletionToResponse(chatCompletion, requestBody, toolMapping) {
    const choice = Array.isArray(chatCompletion?.choices) ? chatCompletion.choices[0] : null;
    const message = choice?.message && typeof choice.message === "object" ? choice.message : {};
    const output = [];
    let text = contentText(message.content);
    if (!text && typeof message.reasoning_content === "string" && !normalizeChatToolCalls(message).length) {
        text = message.reasoning_content;
    }
    if (text) {
        output.push({
            id: `msg_${randomUUID().replace(/-/gu, "")}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
        });
    }
    for (const toolCall of normalizeChatToolCalls(message)) {
        const chatName = typeof toolCall?.function?.name === "string" ? toolCall.function.name : "tool";
        output.push({
            id: `fc_${randomUUID().replace(/-/gu, "")}`,
            type: "function_call",
            status: "completed",
            arguments: stringValue(toolCall?.function?.arguments || "{}"),
            call_id: typeof toolCall?.id === "string" && toolCall.id
                ? toolCall.id
                : `call_${randomUUID().replace(/-/gu, "")}`,
            name: toolMapping.responseNameByChatName.get(chatName) ?? chatName,
        });
    }
    if (!output.length) {
        output.push({
            id: `msg_${randomUUID().replace(/-/gu, "")}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "", annotations: [] }],
        });
    }
    return {
        id: typeof chatCompletion?.id === "string" && chatCompletion.id
            ? chatCompletion.id.replace(/^chatcmpl-/u, "resp_")
            : `resp_${randomUUID().replace(/-/gu, "")}`,
        object: "response",
        created_at: Number.isFinite(chatCompletion?.created)
            ? chatCompletion.created
            : Math.floor(Date.now() / 1000),
        status: "completed",
        model: typeof chatCompletion?.model === "string" ? chatCompletion.model : requestBody.model,
        output,
        usage: responseUsage(chatCompletion?.usage),
    };
}

function writeSseEvent(res, event, sequenceNumber) {
    const payload = { ...event, sequence_number: sequenceNumber };
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function writeResponsesSse(res, response) {
    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    });
    let sequenceNumber = 0;
    writeSseEvent(res, {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
    }, sequenceNumber++);
    response.output.forEach((item, outputIndex) => {
        if (item.type === "function_call") {
            writeSseEvent(res, {
                type: "response.output_item.added",
                output_index: outputIndex,
                item: { ...item, status: "in_progress", arguments: "" },
            }, sequenceNumber++);
            if (item.arguments) {
                writeSseEvent(res, {
                    type: "response.function_call_arguments.delta",
                    item_id: item.id,
                    output_index: outputIndex,
                    delta: item.arguments,
                }, sequenceNumber++);
            }
            writeSseEvent(res, {
                type: "response.function_call_arguments.done",
                item_id: item.id,
                output_index: outputIndex,
                arguments: item.arguments,
            }, sequenceNumber++);
            writeSseEvent(res, {
                type: "response.output_item.done",
                output_index: outputIndex,
                item,
            }, sequenceNumber++);
            return;
        }
        const part = item.content[0];
        writeSseEvent(res, {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { ...item, status: "in_progress", content: [] },
        }, sequenceNumber++);
        writeSseEvent(res, {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part: { ...part, text: "" },
        }, sequenceNumber++);
        if (part.text) {
            writeSseEvent(res, {
                type: "response.output_text.delta",
                item_id: item.id,
                output_index: outputIndex,
                content_index: 0,
                delta: part.text,
            }, sequenceNumber++);
        }
        writeSseEvent(res, {
            type: "response.output_text.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            text: part.text,
        }, sequenceNumber++);
        writeSseEvent(res, {
            type: "response.content_part.done",
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part,
        }, sequenceNumber++);
        writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
        }, sequenceNumber++);
    });
    writeSseEvent(res, { type: "response.completed", response }, sequenceNumber++);
    res.end("data: [DONE]\n\n");
}

function codexRequestKind(req) {
    try {
        const metadata = JSON.parse(String(req.headers["x-codex-turn-metadata"] || "{}"));
        return typeof metadata?.request_kind === "string" ? metadata.request_kind : "turn";
    }
    catch {
        return "turn";
    }
}

function buildUpstreamHeaders(req, profile, sanitized = false) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || lower === "authorization" || lower === "content-encoding") continue;
        if (sanitized && CODEX_REQUEST_HEADERS.has(lower)) continue;
        if (value !== undefined) headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    headers["content-type"] = "application/json";
    if (typeof profile.apiKey === "string" && profile.apiKey.trim()) {
        headers.authorization = `Bearer ${profile.apiKey.trim()}`;
    }
    return headers;
}

function sanitizedResponsesBody(body) {
    const sanitized = { ...body };
    delete sanitized.client_metadata;
    delete sanitized.prompt_cache_key;
    return sanitized;
}

async function readUpstreamBody(response) {
    const text = await response.text();
    try {
        return { text, payload: text ? JSON.parse(text) : {} };
    }
    catch {
        return { text, payload: null };
    }
}

function upstreamErrorText(status, payload, text) {
    return payload?.error?.message || payload?.message || text || `Upstream failed with HTTP ${status}`;
}

function shouldRetryWithoutCodexMetadata(status, payload, text) {
    if (![400, 422].includes(status)) return false;
    const errorText = [payload?.error?.code, payload?.error?.type, upstreamErrorText(status, payload, text)]
        .filter(Boolean).join(" ").toLowerCase();
    return /invalid_responses_request|invalid codex request|client_metadata|x-codex|prompt_cache_key/u.test(errorText);
}

function shouldUseChatCompatibilityFallback(status, payload, text, requestKind) {
    if ([404, 405, 415, 501].includes(status)) return true;
    if (![400, 422].includes(status)) return false;
    if (requestKind === "compaction") return true;
    const errorText = [payload?.error?.code, payload?.error?.type, upstreamErrorText(status, payload, text)]
        .filter(Boolean).join(" ").toLowerCase();
    return /invalid_responses_request|invalid codex request|responses.+(?:unsupported|not supported)|unsupported.+responses/u.test(errorText);
}

function isHtmlResponse(response) {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

async function pipeUpstreamResponse(res, response) {
    const headers = {};
    for (const [name, value] of response.headers) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || lower === "content-encoding" || lower === "content-length") continue;
        headers[lower] = value;
    }
    res.writeHead(response.status, headers);
    if (!response.body) {
        res.end();
        return;
    }
    for await (const chunk of response.body) {
        if (!res.write(chunk)) {
            await new Promise((resolve) => res.once("drain", resolve));
        }
    }
    res.end();
}

function sendBufferedUpstreamResponse(res, response, text) {
    const headers = {};
    for (const [name, value] of response.headers) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || lower === "content-encoding" || lower === "content-length") continue;
        headers[lower] = value;
    }
    headers["content-length"] = Buffer.byteLength(text);
    res.writeHead(response.status, headers);
    res.end(text);
}

function fetchNativeResponse(req, profile, body, fetchImpl, sanitized = false) {
    const requestBody = sanitized ? sanitizedResponsesBody(body) : body;
    return fetchImpl(normalizeResponsesEndpoint(profile.baseUrl), {
        method: "POST",
        headers: buildUpstreamHeaders(req, profile, sanitized),
        body: JSON.stringify(requestBody),
    });
}

async function parseUpstreamJson(response) {
    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    }
    catch {
        throw Object.assign(new Error(`Chat Completions upstream returned invalid JSON (HTTP ${response.status})`), {
            status: response.ok ? 502 : response.status,
            details: text.slice(0, 2000),
        });
    }
    if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `Chat Completions upstream failed with HTTP ${response.status}`;
        throw Object.assign(new Error(message), { status: response.status, details: payload });
    }
    if (payload?.error) {
        throw Object.assign(new Error(payload.error.message || "Chat Completions upstream returned an error"), {
            status: 502,
            details: payload,
        });
    }
    return payload;
}

async function fetchChatCompletion(profile, payload, fetchImpl, profileLoader) {
    const invoke = (requestPayload, currentProfile) => {
        const headers = { "content-type": "application/json", accept: "application/json" };
        if (typeof currentProfile.apiKey === "string" && currentProfile.apiKey.trim()) {
            headers.authorization = `Bearer ${currentProfile.apiKey.trim()}`;
        }
        return fetchImpl(normalizeChatEndpoint(currentProfile.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        });
    };
    const attempts = [payload];
    const withoutReasoning = { ...payload };
    delete withoutReasoning.reasoning_effort;
    if (JSON.stringify(withoutReasoning) !== JSON.stringify(payload)) attempts.push(withoutReasoning);
    if (Number.isFinite(withoutReasoning.max_completion_tokens)) {
        const legacyTokens = { ...withoutReasoning, max_tokens: withoutReasoning.max_completion_tokens };
        delete legacyTokens.max_completion_tokens;
        attempts.push(legacyTokens);
    }
    const minimal = { ...attempts.at(-1) };
    delete minimal.parallel_tool_calls;
    delete minimal.response_format;
    if (JSON.stringify(minimal) !== JSON.stringify(attempts.at(-1))) attempts.push(minimal);
    let response;
    for (let index = 0; index < attempts.length; index += 1) {
        const result = await fetchWithSqueezeRetry((currentProfile) => invoke(attempts[index], currentProfile), profile, profileLoader);
        response = result.response;
        profile = result.profile;
        if (response.ok || ![400, 422].includes(response.status) || index === attempts.length - 1) break;
        await response.arrayBuffer();
    }
    return parseUpstreamJson(response);
}

async function handleModels(req, res, profile, fetchImpl) {
    if (Array.isArray(profile.models) && profile.models.length) {
        sendJson(res, 200, {
            object: "list",
            data: profile.models.map((id) => ({ id, object: "model", created: 0, owned_by: profile.name || "paseo" })),
        });
        return;
    }
    const headers = { accept: "application/json" };
    if (typeof profile.apiKey === "string" && profile.apiKey.trim()) {
        headers.authorization = `Bearer ${profile.apiKey.trim()}`;
    }
    const response = await fetchImpl(normalizeModelsEndpoint(profile.baseUrl), { headers });
    const payload = await parseUpstreamJson(response);
    sendJson(res, 200, payload);
}

async function respondThroughChat(res, profile, requestBody, fetchImpl, profileLoader) {
    const translated = translateResponsesRequest(requestBody);
    const chatCompletion = await fetchChatCompletion(profile, translated.payload, fetchImpl, profileLoader);
    const response = chatCompletionToResponse(chatCompletion, requestBody, translated.toolMapping);
    if (requestBody.stream === false) {
        sendJson(res, 200, response);
        return;
    }
    writeResponsesSse(res, response);
}

async function handleNativeResponses(req, res, profile, requestBody, fetchImpl, logger, profileLoader) {
    const requestKind = codexRequestKind(req);
    let nativeResult = await fetchWithSqueezeRetry(
        (currentProfile) => fetchNativeResponse(req, currentProfile, requestBody, fetchImpl, false),
        profile,
        profileLoader,
    );
    profile = nativeResult.profile;
    let upstream = nativeResult.response;
    let nativeReturnedHtml = upstream.ok && isHtmlResponse(upstream);
    if (upstream.ok && !nativeReturnedHtml) {
        await pipeUpstreamResponse(res, upstream);
        return;
    }
    let failure = await readUpstreamBody(upstream);
    if (shouldRetryWithoutCodexMetadata(upstream.status, failure.payload, failure.text)) {
        logger?.info?.({ provider: profile.name, requestKind }, "Retrying Responses request without Codex metadata");
        nativeResult = await fetchWithSqueezeRetry(
            (currentProfile) => fetchNativeResponse(req, currentProfile, requestBody, fetchImpl, true),
            profile,
            profileLoader,
        );
        profile = nativeResult.profile;
        upstream = nativeResult.response;
        nativeReturnedHtml = upstream.ok && isHtmlResponse(upstream);
        if (upstream.ok && !nativeReturnedHtml) {
            await pipeUpstreamResponse(res, upstream);
            return;
        }
        failure = await readUpstreamBody(upstream);
    }
    const endpointUnavailable = [404, 405, 415, 501].includes(upstream.status);
    if (nativeReturnedHtml || shouldUseChatCompatibilityFallback(upstream.status, failure.payload, failure.text, requestKind)) {
        try {
            logger?.warn?.({ provider: profile.name, requestKind, status: upstream.status }, "Responses request rejected; falling back to Chat Completions");
            await respondThroughChat(res, profile, requestBody, fetchImpl, profileLoader);
            return;
        }
        catch (fallbackError) {
            logger?.warn?.({ err: fallbackError, provider: profile.name, requestKind }, "Chat Completions fallback also failed");
            if (nativeReturnedHtml || endpointUnavailable) {
                const status = Number.isInteger(fallbackError?.status) && fallbackError.status >= 400 && fallbackError.status <= 599
                    ? fallbackError.status
                    : 502;
                sendError(res, status, `Responses endpoint is unavailable and Chat Completions fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`, "upstream_error");
                return;
            }
        }
    }
    sendBufferedUpstreamResponse(res, upstream, failure.text);
}

async function handleResponses(req, res, profile, fetchImpl, logger, profileLoader) {
    const rawBody = await readRawBody(req);
    const requestBody = parseJsonBody(rawBody, req.headers["content-encoding"]);
    if (profile.wireApi === "chat") {
        await respondThroughChat(res, profile, requestBody, fetchImpl, profileLoader);
        return;
    }
    await handleNativeResponses(req, res, profile, requestBody, fetchImpl, logger, profileLoader);
}

export function createCodexChatProxyServer(options = {}) {
    const logger = options.logger;
    const profileLoader = options.profileLoader ?? readActiveProfile;
    const fetchImpl = options.fetchImpl ?? fetch;
    return createServer((req, res) => {
        void (async () => {
            if (!isLoopbackRequest(req)) {
                sendError(res, 403, "Paseo Codex proxy only accepts localhost requests");
                return;
            }
            const requestPath = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
            if (req.method === "GET" && ["/health", "/v1/health"].includes(requestPath)) {
                sendJson(res, 200, { status: "ok" });
                return;
            }
            const profile = profileLoader();
            if (req.method === "GET" && ["/models", "/v1/models"].includes(requestPath)) {
                await handleModels(req, res, profile, fetchImpl);
                return;
            }
            if (req.method === "POST" && ["/responses", "/v1/responses"].includes(requestPath)) {
                await handleResponses(req, res, profile, fetchImpl, logger, profileLoader);
                return;
            }
            if (req.method === "POST" && ["/responses/compact", "/v1/responses/compact"].includes(requestPath)) {
                req.resume();
                sendError(res, 501, "Standalone remote compaction is disabled for portable Paseo provider switching", "unsupported_feature");
                return;
            }
            sendError(res, 404, `Unsupported Paseo Codex proxy route: ${req.method} ${requestPath}`);
        })().catch((error) => {
            const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
                ? error.status
                : 502;
            logger?.warn?.({ err: error, status }, "Paseo Codex proxy request failed");
            if (!res.headersSent) {
                sendError(res, status, error instanceof Error ? error.message : String(error), "upstream_error");
            }
            else if (!res.writableEnded) {
                res.end();
            }
        });
    });
}

export async function startCodexChatProxy(logger) {
    if (managedServer?.listening) {
        return;
    }
    const server = createCodexChatProxyServer({ logger });
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(CHAT_PROXY_PORT, CHAT_PROXY_HOST);
    });
    managedServer = server;
    logger?.info?.({ host: CHAT_PROXY_HOST, port: CHAT_PROXY_PORT }, "Paseo Codex compatibility proxy listening");
}

export async function stopCodexChatProxy() {
    const server = managedServer;
    managedServer = null;
    if (!server) {
        return;
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
}
