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
 * OpenAI-compatible provider. Covers DeepSeek, OpenAI, Groq, Ollama, vLLM, etc.
 */
public class OpenAIProvider implements AIProvider {

    @Override
    public String getFormatType() {
        return "openai";
    }

    @Override
    public String getDisplayName() {
        return "OpenAI Compatible";
    }

    @Override
    public Request buildRequest(ProviderProfile profile, List<RequestMessageItem> messages,
                                String systemPrompt, boolean stream) {
        JsonArray messagesArray = new JsonArray();

        // System prompt at position 0
        if (systemPrompt != null && !systemPrompt.isEmpty()) {
            JsonObject systemMsg = new JsonObject();
            systemMsg.addProperty("role", RequestMessageItem.ROLE_SYSTEM);
            systemMsg.addProperty("content", systemPrompt);
            messagesArray.add(systemMsg);
        }

        // User/assistant messages
        for (RequestMessageItem item : messages) {
            JsonObject msg = new JsonObject();
            msg.addProperty("role", item.role);
            msg.addProperty("content", item.content);
            messagesArray.add(msg);
        }

        JsonObject body = new JsonObject();
        body.addProperty("model", profile.getModelName());
        body.add("messages", messagesArray);
        body.addProperty("stream", stream);

        RequestBody requestBody = RequestBody.create(
            body.toString(),
            MediaType.parse("application/json; charset=utf-8"));

        return new Request.Builder()
            .url(profile.getApiUrl())
            .addHeader("Authorization", "Bearer " + profile.getApiKey())
            .addHeader("Content-Type", "application/json")
            .post(requestBody)
            .build();
    }

    @Override
    public String parseResponse(String responseBody) throws AIProviderException {
        try {
            JsonObject json = JsonParser.parseString(responseBody).getAsJsonObject();
            return json.getAsJsonArray("choices")
                .get(0).getAsJsonObject()
                .getAsJsonObject("message")
                .get("content").getAsString();
        } catch (Exception e) {
            throw new AIProviderException("Failed to parse OpenAI response", e);
        }
    }

    @Override
    public String parseStreamChunk(String line) throws AIProviderException {
        // Strip "data: " prefix
        String cleanLine = line.startsWith("data: ") ? line.substring(6) : line;
        if (cleanLine.isEmpty() || cleanLine.charAt(0) != '{') {
            return null;
        }
        try {
            JsonObject json = JsonParser.parseString(cleanLine).getAsJsonObject();
            JsonArray choices = json.getAsJsonArray("choices");
            if (choices.size() == 0) return null;
            JsonObject delta = choices.get(0).getAsJsonObject().getAsJsonObject("delta");
            if (delta == null || !delta.has("content")) return null;
            return delta.get("content").getAsString();
        } catch (Exception e) {
            throw new AIProviderException("Failed to parse OpenAI stream chunk", e);
        }
    }

    @Override
    public boolean isStreamComplete(String line) {
        return "data: [DONE]".equals(line.trim());
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
