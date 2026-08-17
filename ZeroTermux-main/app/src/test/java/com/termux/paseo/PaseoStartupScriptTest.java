package com.termux.paseo;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

public class PaseoStartupScriptTest {

    @Test
    public void startupScriptPinsPaseoAndStartsTheWebUi() throws Exception {
        File scriptFile = new File("src/main/assets/paseo-runtime/start-paseo.sh");
        File installerFile = new File("src/main/assets/paseo-runtime/install-bundled-runtime.sh");
        File termuxRuntimeArchive = new File(
            "src/main/assets/paseo-runtime/packages/termux-node-runtime-arm64.tgz");
        File runtimePackageFile = new File("../../scripts/android-runtime/package.json");
        File runtimePreparationFile = new File("../../scripts/prepare-android-runtime.ps1");
        assertTrue("startup script is missing", scriptFile.isFile());
        assertTrue("runtime installer is missing", installerFile.isFile());
        assertTrue("bundled Termux Node runtime is missing", termuxRuntimeArchive.isFile());
        assertTrue("runtime package definition is missing", runtimePackageFile.isFile());
        assertTrue("runtime preparation script is missing", runtimePreparationFile.isFile());

        String script = new String(Files.readAllBytes(scriptFile.toPath()), StandardCharsets.UTF_8);
        String installer = new String(Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);
        String runtimePackage = new String(Files.readAllBytes(runtimePackageFile.toPath()), StandardCharsets.UTF_8);
        String runtimePreparation = new String(Files.readAllBytes(runtimePreparationFile.toPath()), StandardCharsets.UTF_8);
        assertTrue(runtimePackage.contains("\"@getpaseo/cli\": \"0.3.1\""));
        assertTrue(runtimePreparation.contains("--os=android --cpu=arm64"));
        assertTrue(runtimePreparation.contains("prebuilds\\android-arm64"));
        assertTrue(installer.contains("termux-node-runtime-arm64.tgz"));
        assertTrue(installer.contains("tar -xzf"));
        assertFalse(installer.contains("dpkg -i"));
        assertTrue(installer.contains("paseo-node-modules-arm64.tgz"));
        assertFalse(installer.contains("paseo-node-modules-arm64.tar.gz"));
        assertFalse(installer.contains("pkg update"));
        assertFalse(installer.contains("npm install"));
        assertTrue(runtimePreparation.contains("termux-node-runtime-arm64.tgz"));
        assertTrue(runtimePreparation.contains("com.paseoe"));
        assertTrue(script.contains("paseo daemon start --port 6767 --web-ui --no-relay"));
        assertTrue(script.contains("node \"$RUNTIME_DIR/enhanced/install.mjs\""));
        assertTrue(script.contains("install-bundled-runtime.sh"));
        assertTrue(script.contains("wait_for_paseo"));
        assertTrue(script.contains("http://127.0.0.1:6767/"));
        assertTrue(script.contains("RUN_ID=\"${1:?Missing Paseo run id}\""));
        assertTrue(script.contains("STATUS_FILE=\"$APP_DIR/status-$RUN_ID\""));
        assertTrue(script.contains("printf '%s\\n%s\\n%s\\n' \"$RUN_ID\" \"$1\" \"$2\""));
    }

    @Test
    public void runtimeManifestUsesUnixLineEndings() throws Exception {
        File manifestFile = new File("src/main/assets/paseo-runtime/packages/manifest.txt");
        File runtimePreparationFile = new File("../../scripts/prepare-android-runtime.ps1");

        String manifest = new String(
            Files.readAllBytes(manifestFile.toPath()), StandardCharsets.US_ASCII);
        String runtimePreparation = new String(
            Files.readAllBytes(runtimePreparationFile.toPath()), StandardCharsets.UTF_8);

        assertFalse("Android shell manifest must not contain carriage returns", manifest.contains("\r"));
        assertTrue(runtimePreparation.contains("[System.IO.File]::WriteAllText"));
        assertTrue(runtimePreparation.contains("$manifestLines -join \"`n\""));
    }

    @Test
    public void runtimeControlFilesStayLfAfterGitCheckout() throws Exception {
        File attributesFile = new File("../.gitattributes");
        String attributes = new String(
            Files.readAllBytes(attributesFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(attributes.contains(
            "app/src/main/assets/paseo-runtime/packages/manifest.txt text eol=lf"));
        assertTrue(attributes.contains(
            "app/src/main/assets/paseo-runtime/runtime-version text eol=lf"));
    }

    @Test
    public void runtimeInstallerDefensivelyStripsCarriageReturns() throws Exception {
        File installerFile = new File("src/main/assets/paseo-runtime/install-bundled-runtime.sh");
        String installer = new String(
            Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(installer.contains("relative=\"${relative%$'\\r'}\""));
    }

    @Test
    public void runtimeVersionForcesRepairAfterManifestLineEndingBug() throws Exception {
        File installerFile = new File("src/main/assets/paseo-runtime/install-bundled-runtime.sh");
        File runtimeVersionFile = new File("src/main/assets/paseo-runtime/runtime-version");
        String installer = new String(
            Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);
        String runtimeVersion = new String(
            Files.readAllBytes(runtimeVersionFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(installer.contains("RUNTIME_VERSION=\"paseo-0.3.1-arm64-v3\""));
        assertTrue(runtimeVersion.contains("runtime-3"));
    }
}
