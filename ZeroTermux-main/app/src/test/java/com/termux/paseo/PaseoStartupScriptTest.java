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
        assertTrue(script.contains("\"$NODE\" \"$DAEMON_WORKER\" --no-relay --web-ui &"));
        assertTrue(script.contains("\"$NODE\" \"$RUNTIME_DIR/enhanced/install.mjs\""));
        assertTrue(script.contains("ENHANCED_VERSION=\"2.3.3\""));
        assertTrue(script.contains("install-bundled-runtime.sh"));
        assertTrue(script.contains("wait_for_paseo"));
        assertTrue(script.contains("\"$TOYBOX\" nc -z -w 1 127.0.0.1 6767"));
        assertTrue(script.contains("RUN_ID=\"${1:?Missing Paseo run id}\""));
        assertTrue(script.contains("STATUS_FILE=\"$APP_DIR/status-$RUN_ID\""));
        assertTrue(script.contains("printf '%s\\n%s\\n%s\\n' \"$RUN_ID\" \"$1\" \"$2\""));
    }

    @Test
    public void startupUsesSystemPortReadinessInsteadOfDaemonStatusExitCode() throws Exception {
        File scriptFile = new File("src/main/assets/paseo-runtime/start-paseo.sh");
        String script = new String(
            Files.readAllBytes(scriptFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(script.contains("is_paseo_ready()"));
        assertTrue(script.contains("if ! is_paseo_ready; then"));
        assertFalse(script.contains("\"$NODE\" -e"));
        assertFalse(script.contains("daemon status"));
    }

    @Test
    public void startupOwnsTheForegroundDaemonWorkerProcess() throws Exception {
        File scriptFile = new File("src/main/assets/paseo-runtime/start-paseo.sh");
        String script = new String(
            Files.readAllBytes(scriptFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(script.contains(
            "DAEMON_WORKER=\"$PREFIX/lib/node_modules/@getpaseo/server/dist/server/server/daemon-worker.js\""));
        assertTrue(script.contains("PASEO_LISTEN=127.0.0.1:6767"));
        assertTrue(script.contains("PASEO_WEB_UI_ENABLED=true"));
        assertTrue(script.contains("DAEMON_PID=$!"));
        assertTrue(script.contains("trap stop_daemon EXIT INT TERM"));
        assertTrue(script.contains("wait \"$DAEMON_PID\""));
        assertTrue(script.contains("while [ \"$attempt\" -lt 1200 ]"));
        assertFalse(script.contains("daemon start"));
    }

    @Test
    public void startupDoesNotUseThePaseoCliForDaemonControl() throws Exception {
        File scriptFile = new File("src/main/assets/paseo-runtime/start-paseo.sh");
        String script = new String(
            Files.readAllBytes(scriptFile.toPath()), StandardCharsets.UTF_8);

        assertFalse(script.contains("\"$PASEO\" daemon"));
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

        assertTrue(installer.contains("relative=\"$(printf '%s' \"$relative\" | \"$TOYBOX\" tr -d '\\r')\""));
    }

    @Test
    public void startupRunsWithAndroidSystemShellWithoutTermuxExec() throws Exception {
        File installerFile = new File("src/main/assets/paseo-runtime/install-bundled-runtime.sh");
        File startupFile = new File("src/main/assets/paseo-runtime/start-paseo.sh");
        File controllerFile = new File("src/main/java/com/termux/paseo/PaseoRuntimeController.java");
        String installer = new String(
            Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);
        String startup = new String(
            Files.readAllBytes(startupFile.toPath()), StandardCharsets.UTF_8);
        String controller = new String(
            Files.readAllBytes(controllerFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(installer.startsWith("#!/system/bin/sh\n"));
        assertTrue(startup.startsWith("#!/system/bin/sh\n"));
        assertTrue(installer.contains("\"$TOYBOX\" tar -xzf"));
        assertFalse(installer.contains("$'\\r'"));
        assertFalse(installer.contains("$(<"));
        assertFalse(startup.contains("$(<"));
        assertFalse(controller.contains("TermuxService"));
        assertFalse(controller.contains("ServiceConnection"));
        assertTrue(controller.contains("new ProcessBuilder"));
        assertTrue(controller.contains("environment.remove(\"LD_PRELOAD\")"));
    }

    @Test
    public void runtimeInstallerUsesRelocatedNodeForThePaseoCli() throws Exception {
        File installerFile = new File("src/main/assets/paseo-runtime/install-bundled-runtime.sh");
        String installer = new String(
            Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);

        assertFalse(installer.contains(
            "ln -sf \"$PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo\" \"$PREFIX/bin/paseo\""));
        assertTrue(installer.contains("printf '%s\\n'"));
        assertTrue(installer.contains(
            "exec \"$PREFIX/bin/node\" --disable-warning=DEP0040 " +
            "\"$PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo\" \"$@\""));
        assertTrue(installer.contains("NODE_VERSION=\"$(\"$PREFIX/bin/node\" --version)\""));
        assertFalse(installer.contains("command -v node"));
    }

    @Test
    public void runtimeVersionChecksReadPackageMetadataWithoutLoadingTheCli() throws Exception {
        File installerFile = new File("src/main/assets/paseo-runtime/install-bundled-runtime.sh");
        File startupFile = new File("src/main/assets/paseo-runtime/start-paseo.sh");
        String installer = new String(
            Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);
        String startup = new String(
            Files.readAllBytes(startupFile.toPath()), StandardCharsets.UTF_8);

        assertFalse(installer.contains("\"$PREFIX/bin/paseo\" --version"));
        assertFalse(startup.contains("\"$PASEO\" --version"));
        assertTrue(installer.contains(
            "require('$PREFIX/lib/node_modules/@getpaseo/cli/package.json').version"));
        assertTrue(startup.contains(
            "require('$PREFIX/lib/node_modules/@getpaseo/cli/package.json').version"));
    }

    @Test
    public void runtimePreparationBundlesAllNodeSharedLibraryDependencies() throws Exception {
        File runtimePreparationFile = new File("../../scripts/prepare-android-runtime.ps1");
        String runtimePreparation = new String(
            Files.readAllBytes(runtimePreparationFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(runtimePreparation.contains("pool/main/libc/libc++/libc++_29_aarch64.deb"));
        assertTrue(runtimePreparation.contains("pool/main/o/openssl/openssl_1:3.6.3_aarch64.deb"));
        assertTrue(runtimePreparation.contains("pool/main/z/zlib/zlib_1.3.2_aarch64.deb"));
        assertTrue(runtimePreparation.contains(
            "pool/main/c/ca-certificates/ca-certificates_1:2026.07.16_all.deb"));
        assertTrue(runtimePreparation.contains("lib/libc++_shared.so"));
        assertTrue(runtimePreparation.contains("lib/libcrypto.so.3"));
        assertTrue(runtimePreparation.contains("lib/libssl.so.3"));
        assertTrue(runtimePreparation.contains("lib/libz.so.1"));
        assertTrue(runtimePreparation.contains(
            "tar.exe --format=ustar -czf $termuxArchive"));
    }

    @Test
    public void runtimePreparationPrunesDevelopmentPayloadBeforeArchiving() throws Exception {
        File runtimePreparationFile = new File("../../scripts/prepare-android-runtime.ps1");
        String runtimePreparation = new String(
            Files.readAllBytes(runtimePreparationFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(runtimePreparation.contains("Get-ChildItem -LiteralPath $nodeModules"));
        assertTrue(runtimePreparation.contains("-Filter '*.map'"));
        assertTrue(runtimePreparation.contains("$runtimeDirectoriesToPrune"));
        assertTrue(runtimePreparation.contains("'include'"));
        assertTrue(runtimePreparation.contains("'share\\doc'"));
        assertTrue(runtimePreparation.contains("'share\\man'"));
        assertTrue(runtimePreparation.contains("'lib\\cmake'"));
        assertTrue(runtimePreparation.contains("'lib\\pkgconfig'"));
        assertTrue(runtimePreparation.contains("'lib\\libicuio.so.78.3'"));
        assertTrue(runtimePreparation.contains("'lib\\libicutest.so.78.3'"));
        assertTrue(runtimePreparation.contains("'lib\\libicutu.so.78.3'"));
        assertTrue(runtimePreparation.contains("'lib\\libsqlite3.53.4.so'"));
        assertTrue(runtimePreparation.contains("Non-runtime Termux payload is bundled"));
        assertTrue(runtimePreparation.contains("Source map is bundled in Paseo runtime"));
    }

    @Test
    public void startupScriptsUseAndroidToyboxForBootstrapFileOperations() throws Exception {
        File installerFile = new File("src/main/assets/paseo-runtime/install-bundled-runtime.sh");
        File startupFile = new File("src/main/assets/paseo-runtime/start-paseo.sh");
        String installer = new String(
            Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);
        String startup = new String(
            Files.readAllBytes(startupFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(installer.contains("TOYBOX=\"/system/bin/toybox\""));
        assertTrue(installer.contains("\"$TOYBOX\" sha256sum \"$payload\""));
        assertTrue(installer.contains("\"$TOYBOX\" mkdir -p \"$PREFIX/lib/node_modules\""));
        assertTrue(installer.contains("\"$TOYBOX\" chmod 755"));
        assertTrue(installer.contains("\"$TOYBOX\" rm -f \"$PREFIX/bin/paseo\""));
        assertFalse(installer.contains("| cut"));
        assertFalse(installer.contains("cat > \"$PREFIX/bin/paseo\""));

        assertTrue(startup.contains("TOYBOX=\"/system/bin/toybox\""));
        assertTrue(startup.contains("\"$TOYBOX\" mkdir -p \"$APP_DIR\""));
        assertTrue(startup.contains("\"$TOYBOX\" mv \"$STATUS_FILE.tmp\" \"$STATUS_FILE\""));
        assertTrue(startup.contains("\"$TOYBOX\" sleep 0.5"));
    }

    @Test
    public void runtimeVersionForcesRepairAfterEnhancedInstallerUpdate() throws Exception {
        File installerFile = new File("src/main/assets/paseo-runtime/install-bundled-runtime.sh");
        File runtimeVersionFile = new File("src/main/assets/paseo-runtime/runtime-version");
        String installer = new String(
            Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);
        String runtimeVersion = new String(
            Files.readAllBytes(runtimeVersionFile.toPath()), StandardCharsets.UTF_8);

        assertTrue(installer.contains("RUNTIME_VERSION=\"paseo-0.3.1-arm64-v6\""));
        assertTrue(runtimeVersion.contains("runtime-6"));
    }
}
