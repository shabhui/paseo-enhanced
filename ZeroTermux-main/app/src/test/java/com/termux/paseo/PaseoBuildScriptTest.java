package com.termux.paseo;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import org.junit.Test;

public class PaseoBuildScriptTest {

    @Test
    public void bootstrapDownloadUsesTheRequestedArchitecture() throws Exception {
        File buildFile = new File("build.gradle");
        String buildScript = new String(Files.readAllBytes(buildFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(buildScript.contains("selectedBootstrapArchitectures"));
        assertTrue(buildScript.contains("selectedBootstrapArchitectures.each"));
        assertTrue(buildScript.contains("relocateBootstrap"));
        assertTrue(buildScript.contains("bootstrap-aarch64-com.termux.zip"));
        assertTrue(buildScript.contains("Legacy Termux package name remains in relocated bootstrap"));
        assertTrue(buildScript.contains("Relocated Termux package name must have the same byte length"));
    }

    @Test
    public void relocatedBootstrapPreservesJavaClassesAndChangesOnlyTheAppIdentity() throws Exception {
        File bootstrap = new File("src/main/cpp/bootstrap-aarch64.zip");
        assertTrue("relocated bootstrap is missing", bootstrap.isFile());

        StringBuilder contents = new StringBuilder();
        try (ZipFile zip = new ZipFile(bootstrap)) {
            for (ZipEntry entry : java.util.Collections.list(zip.entries())) {
                contents.append(entry.getName()).append('\n');
                if (entry.isDirectory()) continue;
                try (InputStream input = zip.getInputStream(entry)) {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                    contents.append(new String(output.toByteArray(), StandardCharsets.ISO_8859_1));
                }
            }
        }

        String relocated = contents.toString();
        assertTrue(relocated.contains("/data/data/com.paseoe"));
        assertFalse(relocated.contains("/data/data/com.termux"));
        assertTrue(relocated.contains("com.paseoe/com.termux.app.TermuxService"));
        assertTrue(relocated.contains("com.termux.termuxam.Am"));
        assertFalse(relocated.contains("com.paseoe/com.paseoe.app.TermuxService"));
        assertFalse(relocated.contains("com.paseoe.termuxam.Am"));
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
        assertTrue(buildScript.contains("versionName \"2.3.2\""));
        assertTrue(buildScript.contains("releaseArtifactRequested"));
        assertTrue(buildScript.contains("Release builds require configured signing credentials"));
        assertFalse(buildScript.matches(
            "(?s).*System\\.getenv\\(\"RELEASE_STORE_FILE\"\\)\\s*\\?:.*"));
        assertFalse(buildScript.matches(
            "(?s).*System\\.getenv\\(\"RELEASE_KEY_ALIAS\"\\)\\s*\\?:.*"));
        assertFalse(buildScript.matches(
            "(?s).*System\\.getenv\\(\"RELEASE_STORE_PASSWORD\"\\)\\s*\\?:.*"));
        assertFalse(buildScript.matches(
            "(?s).*System\\.getenv\\(\"RELEASE_KEY_PASSWORD\"\\)\\s*\\?:.*"));
    }

    @Test
    public void runtimeInstallerHotfixUsesAnUpgradeableVersionCode() throws Exception {
        File buildFile = new File("build.gradle");
        String buildScript = new String(
            Files.readAllBytes(buildFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(buildScript.contains("versionCode 119"));
    }
}
