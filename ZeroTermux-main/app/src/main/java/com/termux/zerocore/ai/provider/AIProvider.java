package com.termux.zerocore.ai.provider;

import com.termux.zerocore.ai.llm.model.RequestMessageItem;
import com.termux.zerocore.ai.model.AIProviderException;
import com.termux.zerocore.ai.model.ProviderProfile;

import java.util.List;

import okhttp3.Request;

/**
 * Interface for AI provider format implementations.
 * Each provider owns its entire request/response lifecycle.
 */
public interface AIProvider {

    /** Unique format identifier: "openai", "claude", "gemini" */
    String getFormatType();

    /** Display name: "OpenAI Compatible", "Anthropic Claude", "Google Gemini" */
    String getDisplayName();

    /**
     * Build a complete OkHttp Request for this provider.
     * Provider has full control over URL, headers, and body.
     *
     * @param profile      Provider profile (URL, key, model name)
     * @param messages     Message list (role + content), excluding system prompt
     * @param systemPrompt System prompt text (placed per provider requirements)
     * @param stream       Whether to request streaming
     * @return Complete OkHttp Request ready to execute
     */
    Request buildRequest(ProviderProfile profile, List<RequestMessageItem> messages,
                         String systemPrompt, boolean stream);

    /** Parse a non-streaming response body into assistant content */
    String parseResponse(String responseBody) throws AIProviderException;

    /** Parse a streaming chunk line. Return content delta, or null if no content. */
    String parseStreamChunk(String line) throws AIProviderException;

    /** Return true if this line signals stream completion */
    boolean isStreamComplete(String line);

    /** Parse an error response into a user-friendly message */
    String parseError(int statusCode, String responseBody);
}
