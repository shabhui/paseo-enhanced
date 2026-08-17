package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

public class PaseoPackageIdentityTest {
    private static final String LEGACY_PACKAGE = "com.termux";
    private static final String STANDALONE_PACKAGE = "com.paseoe";

    @Test
    public void standalonePackageDoesNotShareZeroTermuxIdentity() throws Exception {
        String buildScript = read(new File("build.gradle"));
        String manifest = read(new File("src/main/AndroidManifest.xml"));
        String constants = read(new File(
            "../termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java"));
        String shortcuts = read(new File("src/main/res/xml/shortcuts.xml"));

        assertEquals(LEGACY_PACKAGE.length(), STANDALONE_PACKAGE.length());
        assertEquals(LEGACY_PACKAGE.getBytes(StandardCharsets.US_ASCII).length,
            STANDALONE_PACKAGE.getBytes(StandardCharsets.US_ASCII).length);
        assertTrue(buildScript.contains("def standalonePackageName = \"" + STANDALONE_PACKAGE + "\""));
        assertTrue(buildScript.contains("applicationId standalonePackageName"));
        assertTrue(buildScript.contains("manifestPlaceholders.TERMUX_PACKAGE_NAME = standalonePackageName"));
        assertTrue(constants.contains("TERMUX_PACKAGE_NAME = \"" + STANDALONE_PACKAGE + "\""));
        assertTrue(manifest.contains("package=\"com.termux\""));
        assertFalse(manifest.contains("android:sharedUserId"));
        assertFalse(manifest.contains("android:sharedUserLabel"));
        assertTrue(shortcuts.contains("android:targetPackage=\"" + STANDALONE_PACKAGE + "\""));
        assertFalse(shortcuts.contains("android:targetPackage=\"" + LEGACY_PACKAGE + "\""));
    }

    @Test
    public void bundledShellScriptsUseTheStandalonePrivatePrefix() throws Exception {
        File assets = new File("src/main/assets");
        assertNoLegacyPrefixInShellScripts(assets);

        String sharedStrings = read(new File("../termux-shared/src/main/res/values/strings.xml"));
        assertTrue(sharedStrings.contains("<!ENTITY TERMUX_PACKAGE_NAME \"" + STANDALONE_PACKAGE + "\">"));
        assertTrue(sharedStrings.contains("/data/data/" + STANDALONE_PACKAGE + "/files/usr"));
        assertFalse(sharedStrings.contains("/data/data/" + LEGACY_PACKAGE + "/files/usr"));
    }

    @Test
    public void androidComponentClassesKeepTheJavaNamespace() throws Exception {
        String constants = read(new File(
            "../termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java"));

        assertTrue(constants.contains("TERMUX_JAVA_PACKAGE_NAME = \"" + LEGACY_PACKAGE + "\""));
        assertTrue(constants.contains(
            "BUILD_CONFIG_CLASS_NAME = TERMUX_JAVA_PACKAGE_NAME + \".BuildConfig\""));
        assertTrue(constants.contains(
            "TERMUX_ACTIVITY_NAME = TERMUX_JAVA_PACKAGE_NAME + \".app.TermuxActivity\""));
        assertTrue(constants.contains(
            "TERMUX_SERVICE_NAME = TERMUX_JAVA_PACKAGE_NAME + \".app.TermuxService\""));
        assertTrue(constants.contains(
            "RUN_COMMAND_SERVICE_NAME = TERMUX_JAVA_PACKAGE_NAME + \".app.RunCommandService\""));
    }

    @Test
    public void bundledCommandsTargetOnlyTheStandaloneApp() throws Exception {
        String[] broadcastCommands = {"openleftwindow", "openrightwindow", "readcontacts", "smsread"};
        for (String command : broadcastCommands) {
            String contents = read(new File("src/main/assets/runcommand", command));
            assertTrue(command + " must target the standalone reload action",
                contents.contains("com.paseoe.app.reload_style"));
            assertTrue(command + " must target the standalone package",
                contents.contains("-a com.paseoe.app.reload_style com.paseoe"));
            assertFalse(command + " still targets ZeroTermux",
                contents.contains("com.termux.app.reload_style"));
        }

        String adbShell = read(new File("src/main/assets/runcommand/termux-adb-shell.sh"));
        assertTrue(adbShell.contains("/data/user/0/com.paseoe/files/home"));
        assertFalse(adbShell.contains("/data/user/0/com.termux"));
    }

    @Test
    public void standaloneBuildCannotInstallOrRemoveLegacyCompanionApps() throws Exception {
        String installer = read(new File(
            "src/main/java/com/termux/zerocore/settings/ZTInstallActivity.kt"));
        String packageCleaner = read(new File(
            "src/main/java/com/termux/zerocore/utils/PackageMsg.kt"));

        assertTrue(installer.contains("standalone_companion_apps_disabled"));
        assertFalse(installer.contains("getAssets().open(\"apk/"));
        assertFalse(packageCleaner.contains("\"com.termux."));
    }

    private static void assertNoLegacyPrefixInShellScripts(File file) throws Exception {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new AssertionError("Unable to list " + file);
            for (File child : children) assertNoLegacyPrefixInShellScripts(child);
            return;
        }

        if (!file.getName().endsWith(".sh")) return;
        String contents = read(file);
        assertFalse(file + " still references the ZeroTermux private prefix",
            contents.contains("/data/data/" + LEGACY_PACKAGE));
    }

    private static String read(File file) throws Exception {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }
}
