package com.termux.paseo;

import java.util.Locale;

public final class PaseoRuntimeState {
    public enum Phase {
        INSTALLING,
        PATCHING,
        STARTING,
        READY,
        ERROR
    }

    private final Phase phase;
    private final String message;

    public PaseoRuntimeState(Phase phase, String message) {
        this.phase = phase;
        this.message = message == null || message.trim().isEmpty()
            ? "Paseo runtime status is unavailable"
            : message.trim();
    }

    public Phase phase() {
        return phase;
    }

    public String message() {
        return message;
    }

    public static PaseoRuntimeState parse(String text) {
        String[] lines = text == null ? new String[0] : text.split("\\R", 3);
        String rawPhase = lines.length == 0 ? "ERROR" : lines[0].trim().toUpperCase(Locale.ROOT);
        String message = lines.length < 2 ? "Paseo runtime status is unavailable" : lines[1];
        try {
            return new PaseoRuntimeState(Phase.valueOf(rawPhase), message);
        } catch (IllegalArgumentException error) {
            return new PaseoRuntimeState(Phase.ERROR, message);
        }
    }
}
