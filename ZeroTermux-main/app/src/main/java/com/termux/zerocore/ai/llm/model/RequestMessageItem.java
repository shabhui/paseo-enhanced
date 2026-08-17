package com.termux.zerocore.ai.llm.model;

public class RequestMessageItem {
    public static final String ROLE_USER = "user";
    public static final String ROLE_ASSISTANT = "assistant";
    public static final String ROLE_SYSTEM = "system";

    public String role;
    public String content;

    public RequestMessageItem() {
    }

    public RequestMessageItem(String role, String content) {
        this.role = role;
        this.content = content;
    }
}
