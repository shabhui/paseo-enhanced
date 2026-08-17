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
        File runtimePackageFile = new File("../../scripts/android-runtime/package.json");
        File runtimePreparationFile = new File("../../scripts/prepare-android-runtime.ps1");
        assertTrue("startup script is missing", scriptFile.isFile());
        assertTrue("runtime installer is missing", installerFile.isFile());
        assertTrue("runtime package definition is missing", runtimePackageFile.isFile());
        assertTrue("runtime preparation script is missing", runtimePreparationFile.isFile());

        String script = new String(Files.readAllBytes(scriptFile.toPath()), StandardCharsets.UTF_8);
        String installer = new String(Files.readAllBytes(installerFile.toPath()), StandardCharsets.UTF_8);
        String runtimePackage = new String(Files.readAllBytes(runtimePackageFile.toPath()), StandardCharsets.UTF_8);
        String runtimePreparation = new String(Files.readAllBytes(runtimePreparationFile.toPath()), StandardCharsets.UTF_8);
        assertTrue(runtimePackage.contains("\"@getpaseo/cli\": \"0.3.1\""));
        assertTrue(runtimePreparation.contains("--os=android --cpu=arm64"));
        assertTrue(runtimePreparation.contains("prebuilds\\android-arm64"));
        assertTrue(installer.contains("dpkg -i"));
        assertTrue(installer.contains("paseo-node-modules-arm64.tgz"));
        assertFalse(installer.contains("paseo-node-modules-arm64.tar.gz"));
        assertFalse(installer.contains("pkg update"));
        assertFalse(installer.contains("npm install"));
        assertTrue(script.contains("paseo daemon start --port 6767 --web-ui --no-relay"));
        assertTrue(script.contains("node \"$RUNTIME_DIR/enhanced/install.mjs\""));
        assertTrue(script.contains("install-bundled-runtime.sh"));
        assertTrue(script.contains("wait_for_paseo"));
        assertTrue(script.contains("http://127.0.0.1:6767/"));
        assertTrue(script.contains("RUN_ID=\"${1:?Missing Paseo run id}\""));
        assertTrue(script.contains("STATUS_FILE=\"$APP_DIR/status-$RUN_ID\""));
        assertTrue(script.contains("printf '%s\\n%s\\n%s\\n' \"$RUN_ID\" \"$1\" \"$2\""));
    }
}
