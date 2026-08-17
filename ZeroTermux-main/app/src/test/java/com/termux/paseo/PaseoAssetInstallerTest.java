package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PaseoAssetInstallerTest {
    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void installsByVersionAndAtomicallyReplacesAnOlderTree() throws Exception {
        File destination = new File(temporaryFolder.getRoot(), "runtime");
        PaseoAssetInstaller installer = new PaseoAssetInstaller();

        FakeAssetSource versionOne = new FakeAssetSource()
            .file("runtime/runtime-version", "1")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/payload.txt", "old")
            .file("runtime/stale.txt", "remove me");
        installer.install(versionOne, "runtime", destination);

        FakeAssetSource versionTwo = new FakeAssetSource()
            .file("runtime/runtime-version", "2")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/payload.txt", "new");
        installer.install(versionTwo, "runtime", destination);

        assertEquals("2", read(new File(destination, "runtime-version")));
        assertEquals("new", read(new File(destination, "payload.txt")));
        assertFalse(new File(destination, "stale.txt").exists());

        versionTwo.file("runtime/payload.txt", "should not be recopied");
        installer.install(versionTwo, "runtime", destination);
        assertEquals("new", read(new File(destination, "payload.txt")));
    }

    @Test
    public void failedUpgradeLeavesTheInstalledTreeUntouched() throws Exception {
        File destination = new File(temporaryFolder.getRoot(), "runtime");
        PaseoAssetInstaller installer = new PaseoAssetInstaller();
        installer.install(new FakeAssetSource()
            .file("runtime/runtime-version", "1")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/payload.txt", "working"), "runtime", destination);

        FakeAssetSource brokenUpgrade = new FakeAssetSource()
            .file("runtime/runtime-version", "2")
            .file("runtime/packages/manifest.txt", "")
            .file("runtime/payload.txt", "broken")
            .failOnOpen("runtime/payload.txt");

        assertThrows(IOException.class, () -> installer.install(brokenUpgrade, "runtime", destination));
        assertEquals("1", read(new File(destination, "runtime-version")));
        assertEquals("working", read(new File(destination, "payload.txt")));
    }

    @Test
    public void sameVersionWithCorruptedRuntimePayloadIsReinstalled() throws Exception {
        File destination = new File(temporaryFolder.getRoot(), "runtime");
        PaseoAssetInstaller installer = new PaseoAssetInstaller();
        String payload = "healthy runtime";
        String manifest = sha256(payload) + "  runtime.tgz";
        FakeAssetSource source = new FakeAssetSource()
            .file("runtime/runtime-version", "1")
            .file("runtime/packages/manifest.txt", manifest)
            .file("runtime/packages/runtime.tgz", payload);

        installer.install(source, "runtime", destination);
        Files.write(new File(destination, "packages/runtime.tgz").toPath(),
            "corrupted".getBytes(StandardCharsets.UTF_8));

        installer.install(source, "runtime", destination);

        assertEquals(payload, read(new File(destination, "packages/runtime.tgz")));
    }

    private static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).trim();
    }

    private static String sha256(String contents) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
            .digest(contents.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
        return hex.toString();
    }

    private static final class FakeAssetSource implements PaseoAssetInstaller.AssetSource {
        private final Map<String, byte[]> files = new LinkedHashMap<>();
        private final Set<String> failures = new LinkedHashSet<>();

        FakeAssetSource file(String path, String contents) {
            files.put(path, contents.getBytes(StandardCharsets.UTF_8));
            return this;
        }

        FakeAssetSource failOnOpen(String path) {
            failures.add(path);
            return this;
        }

        @Override
        public String[] list(String path) {
            String prefix = path.endsWith("/") ? path : path + "/";
            Set<String> children = new LinkedHashSet<>();
            for (String file : files.keySet()) {
                if (!file.startsWith(prefix)) continue;
                String remainder = file.substring(prefix.length());
                int slash = remainder.indexOf('/');
                children.add(slash < 0 ? remainder : remainder.substring(0, slash));
            }
            List<String> result = new ArrayList<>(children);
            return result.toArray(new String[0]);
        }

        @Override
        public InputStream open(String path) throws IOException {
            if (failures.contains(path)) throw new IOException("simulated copy failure");
            byte[] contents = files.get(path);
            if (contents == null) throw new IOException("missing asset " + path);
            return new ByteArrayInputStream(contents);
        }
    }
}
