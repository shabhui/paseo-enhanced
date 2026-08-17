package com.termux.zerocore.ai.provider;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.termux.zerocore.ai.llm.model.RequestMessageItem;
import com.termux.zerocore.ai.model.AIProviderException;
import com.termux.zerocore.ai.model.ProviderProfile;

import java.util.List;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;

/**
 * Anthropic Claude Messages API provider.
 * System prompt is a top-level field, not in the messages array.
 * Auth uses x-api-key header + anthropic-version header.
 */
public class ClaudeProvider implements AIProvider {

    private static final String ANTHROPIC_VERSION = "2023-06-01";

    @Override
    public String getFormatType() {
        return "claude";
    }

    @Override
    public String getDisplayName() {
        return "Anthropic Claude";
    }

    @Override
    public Request buildRequest(ProviderProfile profile, List<RequestMessageItem> messages,
                                String systemPrompt, boolean stream) {
        JsonArray messagesArray = new JsonArray();

        // Claude: system prompt is top-level, NOT in messages array
        // Only include user and assistant messages
        for (RequestMessageItem item : messages) {
            if (RequestMessageItem.ROLE_SYSTEM.equals(item.role)) continue;
            JsonObject msg = new JsonObject();
            msg.addProperty("role", item.role);
            msg.addProperty("content", item.content);
            messagesArray.add(msg);
        }

        JsonObject body = new JsonObject();
        body.addProperty("model", profile.getModelName());
        body.addProperty("max_tokens", 4096);
        if (systemPrompt != null && !systemPrompt.isEmpty()) {
            body.addProperty("system", systemPrompt);
        }
        body.add("messages", messagesArray);
        body.addProperty("stream", stream);

        RequestBody requestBody = RequestBody.create(
            body.toString(),
            MediaType.parse("application/json; charset=utf-8"));

        return new Request.Builder()
            .url(profile.getApiUrl())
            .addHeader("x-api-key", profile.getApiKey())
            .addHeader("anthropic-version", ANTHROPIC_VERSION)
            .addHeader("Content-Type", "application/json")
            .post(requestBody)
            .build();
    }

    @Override
    public String parseResponse(String responseBody) throws AIProviderException {
        try {
            JsonObject json = JsonParser.parseString(responseBody).getAsJsonObject();
            JsonArray content = json.getAsJsonArray("content");
            StringBuilder result = new StringBuilder();
            for (int i = 0; i < content.size(); i++) {
                JsonObject block = content.get(i).getAsJsonObject();
                if ("text".equals(block.get("type").getAsString())) {
                    result.append(block.get("text").getAsString());
                }
            }
            return result.toString();
        } catch (Exception e) {
            throw new AIProviderException("Failed to parse Claude response", e);
        }
    }

    @Override
    public String parseStreamChunk(String line) throws AIProviderException {
        // Claude SSE format: "event: content_block_delta" then "data: {...}"
        if (!line.startsWith("data: ")) return null;
        String cleanLine = line.substring(6);
        if (cleanLine.isEmpty() || cleanLine.charAt(0) != '{') return null;

        try {
            JsonObject json = JsonParser.parseString(cleanLine).getAsJsonObject();
            String type = json.has("type") ? json.get("type").getAsString() : "";
            if ("content_block_delta".equals(type)) {
                JsonObject delta = json.getAsJsonObject("delta");
                if (delta != null && delta.has("text")) {
                    return delta.get("text").getAsString();
                }
            }
            return null;
        } catch (Exception e) {
            throw new AIProviderException("Failed to parse Claude stream chunk", e);
        }
    }

    @Override
    public boolean isStreamComplete(String line) {
        if (!line.startsWith("data: ")) return false;
        String cleanLine = line.substring(6);
        try {
            JsonObject json = JsonParser.parseString(cleanLine).getAsJsonObject();
            return "message_stop".equals(json.has("type") ? json.get("type").getAsString() : "");
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public String parseError(int statusCode, String responseBody) {
        String providerMessage = null;
        try {
            JsonObject json = JsonParser.parseString(responseBody).getAsJsonObject();
            if (json.has("error")) {
                JsonObject error = json.getAsJsonObject("error");
                providerMessage = error.has("message") ? error.get("message").getAsString() : responseBody;
            }
        } catch (Exception ignored) {
        }
        if (providerMessage == null || providerMessage.isEmpty()) {
            providerMessage = responseBody;
        }
        return ProviderErrorUtils.formatError(statusCode, providerMessage);
    }
}
