package com.termux.paseo;

import java.io.File;
import java.util.Map;

final class PaseoProcessEnvironment {
    private PaseoProcessEnvironment() {}

    static void apply(Map<String, String> environment, File filesDirectory) {
        File home = new File(filesDirectory, "paseo-home");
        File prefix = new File(filesDirectory, "usr");
        File temporary = new File(prefix, "tmp");

        environment.remove("LD_PRELOAD");
        environment.remove("LD_LIBRARY_PATH");
        environment.put("HOME", home.getAbsolutePath());
        environment.put("PREFIX", prefix.getAbsolutePath());
        environment.put("TMPDIR", temporary.getAbsolutePath());
        environment.put("PATH", new File(prefix, "bin").getAbsolutePath() +
            ":/system/bin:/system/xbin");
    }
}
