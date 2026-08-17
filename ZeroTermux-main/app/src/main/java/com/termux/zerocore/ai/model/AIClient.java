package com.termux.zerocore.ai.model;

import com.example.xh_lib.utils.LogUtils;
import com.termux.zerocore.ai.llm.model.RequestMessageItem;
import com.termux.zerocore.ai.provider.AIProvider;
import com.termux.zerocore.ai.provider.ClaudeProvider;
import com.termux.zerocore.ai.provider.GeminiProvider;
import com.termux.zerocore.ai.provider.OpenAIProvider;

import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okio.BufferedSource;

/**
 * Generic AI HTTP client that delegates request building and response parsing
 * to an AIProvider implementation.
 */
public class AIClient {
    private static final String TAG = AIClient.class.getSimpleName();

    private static final OkHttpClient sharedClient = new OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build();

    public interface Listener {
        void onError(String errorMessage);
        void onMessage(String content);
        void onComplete();
    }

    /**
     * Look up an AIProvider by format type string.
     */
    public static AIProvider getProvider(String formatType) {
        if (formatType == null) return new OpenAIProvider();
        switch (formatType) {
            case "claude": return new ClaudeProvider();
            case "gemini": return new GeminiProvider();
            default: return new OpenAIProvider();
        }
    }

    /**
     * Send a streaming request to the AI provider.
     *
     * @param provider     The AI provider implementation
     * @param profile      Provider profile with URL, key, model
     * @param messages     Conversation messages (user + assistant, no system)
     * @param systemPrompt System prompt text
     * @param listener     Callback for messages, errors, and completion
     */
    public void ask(AIProvider provider, ProviderProfile profile,
                    List<RequestMessageItem> messages, String systemPrompt,
                    Listener listener) {
        try {
            Request request = provider.buildRequest(profile, messages, systemPrompt, true);

            sharedClient.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(@NotNull Call call, @NotNull IOException e) {
                    LogUtils.e(TAG, "onFailure call: " + call + " ,e: " + e);
                    e.printStackTrace();
                    listener.onMessage("Network error: " + e.getMessage());
                    listener.onComplete();
                }

                @Override
                public void onResponse(@NotNull Call call, @NotNull Response response) throws IOException {
                    LogUtils.e(TAG, "onResponse call: " + call + " ,response: " + response);
                    if (response.isSuccessful()) {
                        try {
                            BufferedSource source = response.body().source();
                            String line;
                            while ((line = source.readUtf8Line()) != null) {
                                if (provider.isStreamComplete(line)) {
                                    break;
                                }
                                try {
                                    String content = provider.parseStreamChunk(line);
                                    if (content != null && !content.isEmpty()) {
                                        listener.onMessage(content);
                                    }
                                } catch (AIProviderException e) {
                                    LogUtils.e(TAG, "Stream parse error: " + e);
                                    // Continue reading — individual chunk errors shouldn't kill the stream
                                }
                            }
                            listener.onComplete();
                        } catch (Exception e) {
                            LogUtils.e(TAG, "onResponse data error: " + e);
                            listener.onMessage("Data error: " + e.getMessage());
                            listener.onComplete();
                        }
                    } else {
                        String errorBody = "";
                        try {
                            errorBody = response.body() != null ? response.body().string() : "";
                        } catch (Exception ignored) {
                        }
                        String errorMsg = provider.parseError(response.code(), errorBody);
                        listener.onMessage(errorMsg);
                        listener.onComplete();
                    }
                }
            });
        } catch (Exception e) {
            e.printStackTrace();
            listener.onMessage("Request error: " + e.getMessage());
            listener.onComplete();
        }
    }
}
