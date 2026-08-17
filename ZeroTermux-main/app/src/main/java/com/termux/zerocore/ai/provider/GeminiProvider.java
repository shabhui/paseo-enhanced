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
 * Google Gemini API provider.
 * Auth: API key in URL query param (not in header).
 * Uses "contents" array with "parts", "systemInstruction" for system prompt.
 * Gemini uses "model" role instead of "assistant".
 */
public class GeminiProvider implements AIProvider {

    @Override
    public String getFormatType() {
        return "gemini";
    }

    @Override
    public String getDisplayName() {
        return "Google Gemini";
    }

    @Override
    public Request buildRequest(ProviderProfile profile, List<RequestMessageItem> messages,
                                String systemPrompt, boolean stream) {
        JsonArray contentsArray = new JsonArray();

        for (RequestMessageItem item : messages) {
            if (RequestMessageItem.ROLE_SYSTEM.equals(item.role)) continue;
            JsonObject content = new JsonObject();
            // Gemini uses "model" instead of "assistant"
            String role = RequestMessageItem.ROLE_ASSISTANT.equals(item.role) ? "model" : "user";
            content.addProperty("role", role);
            JsonArray parts = new JsonArray();
            JsonObject textPart = new JsonObject();
            textPart.addProperty("text", item.content);
            parts.add(textPart);
            content.add("parts", parts);
            contentsArray.add(content);
        }

        JsonObject body = new JsonObject();
        body.add("contents", contentsArray);

        // System prompt as systemInstruction
        if (systemPrompt != null && !systemPrompt.isEmpty()) {
            JsonObject sysInstruction = new JsonObject();
            JsonArray sysParts = new JsonArray();
            JsonObject sysTextPart = new JsonObject();
            sysTextPart.addProperty("text", systemPrompt);
            sysParts.add(sysTextPart);
            sysInstruction.add("parts", sysParts);
            body.add("systemInstruction", sysInstruction);
        }

        RequestBody requestBody = RequestBody.create(
            body.toString(),
            MediaType.parse("application/json; charset=utf-8"));

        // Build URL: baseUrl/models/modelName:streamGenerateContent?key=apiKey&alt=sse
        // or :generateContent for non-streaming
        String baseUrl = profile.getApiUrl();
        if (baseUrl.endsWith("/")) baseUrl = baseUrl.substring(0, baseUrl.length() - 1);
        String action = stream ? "streamGenerateContent" : "generateContent";
        String url = baseUrl + "/models/" + profile.getModelName() + ":" + action
            + "?key=" + profile.getApiKey();
        if (stream) url += "&alt=sse";

        return new Request.Builder()
            .url(url)
            .addHeader("Content-Type", "application/json")
            .post(requestBody)
            .build();
    }

    @Override
    public String parseResponse(String responseBody) throws AIProviderException {
        try {
            JsonObject json = JsonParser.parseString(responseBody).getAsJsonObject();
            JsonArray candidates = json.getAsJsonArray("candidates");
            JsonObject content = candidates.get(0).getAsJsonObject().getAsJsonObject("content");
            JsonArray parts = content.getAsJsonArray("parts");
            StringBuilder result = new StringBuilder();
            for (int i = 0; i < parts.size(); i++) {
                JsonObject part = parts.get(i).getAsJsonObject();
                if (part.has("text")) {
                    result.append(part.get("text").getAsString());
                }
            }
            return result.toString();
        } catch (Exception e) {
            throw new AIProviderException("Failed to parse Gemini response", e);
        }
    }

    @Override
    public String parseStreamChunk(String line) throws AIProviderException {
        if (!line.startsWith("data: ")) return null;
        String cleanLine = line.substring(6);
        if (cleanLine.isEmpty() || cleanLine.charAt(0) != '{') return null;

        try {
            JsonObject json = JsonParser.parseString(cleanLine).getAsJsonObject();
            if (!json.has("candidates")) return null;
            JsonArray candidates = json.getAsJsonArray("candidates");
            if (candidates.size() == 0) return null;
            JsonObject content = candidates.get(0).getAsJsonObject().getAsJsonObject("content");
            if (content == null || !content.has("parts")) return null;
            JsonArray parts = content.getAsJsonArray("parts");
            if (parts.size() == 0) return null;
            JsonObject part = parts.get(0).getAsJsonObject();
            return part.has("text") ? part.get("text").getAsString() : null;
        } catch (Exception e) {
            throw new AIProviderException("Failed to parse Gemini stream chunk", e);
        }
    }

    @Override
    public boolean isStreamComplete(String line) {
        // Gemini streaming ends when the response body is fully received (connection closes)
        // No explicit [DONE] marker like OpenAI
        return false;
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
