package com.termux.zerocore.ai.model;

public class ProviderProfile {
    private long id;
    private String name;
    private String formatType; // "openai", "claude", "gemini"
    private String apiUrl;
    private String apiKey;
    private String modelName;
    private boolean isDefault;

    public ProviderProfile() {
    }

    public ProviderProfile(long id, String name, String formatType, String apiUrl,
                           String apiKey, String modelName, boolean isDefault) {
        this.id = id;
        this.name = name;
        this.formatType = formatType;
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.modelName = modelName;
        this.isDefault = isDefault;
    }

    public long getId() { return id; }
    public void setId(long id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getFormatType() { return formatType; }
    public void setFormatType(String formatType) { this.formatType = formatType; }

    public String getApiUrl() { return apiUrl; }
    public void setApiUrl(String apiUrl) { this.apiUrl = apiUrl; }

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }

    public String getModelName() { return modelName; }
    public void setModelName(String modelName) { this.modelName = modelName; }

    public boolean isDefault() { return isDefault; }
    public void setDefault(boolean isDefault) { this.isDefault = isDefault; }
}
