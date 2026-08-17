package com.termux.zerocore.ai.llm.data;

import java.util.List;

public class ChatSession {
    private String sessionId;
    private String sessionName;
    private long createdAt;
    private long providerId;

    public ChatSession(String sessionId, String sessionName, long createdAt) {
        this(sessionId, sessionName, createdAt, 0);
    }

    public ChatSession(String sessionId, String sessionName, long createdAt, long providerId) {
        this.sessionId = sessionId;
        this.sessionName = sessionName;
        this.createdAt = createdAt;
        this.providerId = providerId;
    }

    public String getSessionId() {
        return sessionId;
    }

    public String getSessionName() {
        return sessionName;
    }

    public void setSessionName(String sessionName) {
        this.sessionName = sessionName;
    }

    public long getCreatedAt() {
        return createdAt;
    }

    public long getProviderId() {
        return providerId;
    }

    public void setProviderId(long providerId) {
        this.providerId = providerId;
    }
}
