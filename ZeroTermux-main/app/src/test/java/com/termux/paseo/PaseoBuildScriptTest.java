package com.termux.paseo;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

public class PaseoBuildScriptTest {

    @Test
    public void bootstrapDownloadUsesTheRequestedArchitecture() throws Exception {
        File buildFile = new File("build.gradle");
        String buildScript = new String(Files.readAllBytes(buildFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(buildScript.contains("selectedBootstrapArchitectures"));
        assertTrue(buildScript.contains("selectedBootstrapArchitectures.each"));
    }

    @Test
    public void standaloneBuildDefaultsToArm64AndRequiresInjectedReleaseSigning() throws Exception {
        File buildFile = new File("build.gradle");
        String buildScript = new String(Files.readAllBytes(buildFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(buildScript.contains("System.getProperty(\"arch\", \"arm64\")"));
        assertTrue(buildScript.contains("Standalone Paseo supports only -Darch=arm64"));
        assertTrue(buildScript.contains("RELEASE_STORE_FILE"));
        assertTrue(buildScript.contains("RELEASE_KEY_ALIAS"));
        assertTrue(buildScript.contains("RELEASE_STORE_PASSWORD"));
        assertTrue(buildScript.contains("RELEASE_KEY_PASSWORD"));
        assertFalse(buildScript.contains("?: '123456'"));
        assertFalse(buildScript.contains("?: '654321'"));
        assertFalse(buildScript.contains("xrj45yWGLbsO7W0v"));
    }
}
