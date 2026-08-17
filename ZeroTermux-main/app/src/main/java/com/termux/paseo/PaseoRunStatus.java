package com.termux.paseo;

final class PaseoRunStatus {
    private PaseoRunStatus() {
    }

    static PaseoRuntimeState parse(String expectedRunId, String text) {
        String[] lines = text == null ? new String[0] : text.split("\\R", 3);
        if (expectedRunId == null || lines.length < 3 || !expectedRunId.equals(lines[0].trim())) {
            return new PaseoRuntimeState(
                PaseoRuntimeState.Phase.INSTALLING,
                "Waiting for the current Paseo launch");
        }
        return PaseoRuntimeState.parse(lines[1] + "\n" + lines[2]);
    }
}
