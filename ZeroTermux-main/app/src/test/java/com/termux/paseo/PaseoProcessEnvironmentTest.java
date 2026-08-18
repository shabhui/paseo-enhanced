package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.Test;

public class PaseoProcessEnvironmentTest {

    @Test
    public void createsAnAppOwnedRuntimeEnvironmentWithoutTermuxExec() {
        Map<String, String> inherited = new LinkedHashMap<>();
        inherited.put("LD_PRELOAD", "/data/data/com.paseoe/files/usr/lib/libtermux-exec.so");
        inherited.put("LD_LIBRARY_PATH", "/data/data/com.termux/files/usr/lib");
        inherited.put("ANDROID_ROOT", "/system");

        File filesDirectory = new File("/data/user/0/com.paseoe/files");
        PaseoProcessEnvironment.apply(inherited, filesDirectory);

        assertFalse(inherited.containsKey("LD_PRELOAD"));
        assertFalse(inherited.containsKey("LD_LIBRARY_PATH"));
        assertEquals(new File(filesDirectory, "paseo-home").getAbsolutePath(), inherited.get("HOME"));
        assertEquals(new File(filesDirectory, "usr").getAbsolutePath(), inherited.get("PREFIX"));
        assertTrue(inherited.get("PATH").startsWith(
            new File(filesDirectory, "usr/bin").getAbsolutePath()));
        assertEquals("/system", inherited.get("ANDROID_ROOT"));
    }
}
