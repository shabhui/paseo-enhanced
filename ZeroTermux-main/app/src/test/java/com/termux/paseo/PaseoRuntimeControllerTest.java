package com.termux.paseo;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

public class PaseoRuntimeControllerTest {

    @Test
    public void controllerLaunchesTheAppOwnedRuntimeWithoutATerminalService() throws Exception {
        String source = new String(Files.readAllBytes(new File(
            "src/main/java/com/termux/paseo/PaseoRuntimeController.java").toPath()),
            StandardCharsets.UTF_8);

        assertTrue(source.contains("new ProcessBuilder"));
        assertTrue(source.contains("PaseoProcessEnvironment.apply"));
        assertFalse(source.contains("TermuxService"));
        assertFalse(source.contains("bindService"));
        assertFalse(source.contains("createTermuxTask"));
    }
}
