package com.termux.paseo;

import android.content.res.AssetManager;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public final class PaseoAssetInstaller {
    interface AssetSource {
        String[] list(String path) throws IOException;
        InputStream open(String path) throws IOException;
    }

    private static final int BUFFER_SIZE = 16 * 1024;
    private static final String VERSION_FILE = "runtime-version";
    private static final String PACKAGE_MANIFEST = "packages/manifest.txt";

    public void install(AssetManager assets, String assetRoot, File destination) throws IOException {
        install(new AssetManagerSource(assets), assetRoot, destination);
    }

    void install(AssetSource source, String assetRoot, File destination) throws IOException {
        File parent = destination.getParentFile();
        if (parent == null) throw new IOException("Runtime destination has no parent: " + destination);
        ensureDirectory(parent);

        File staging = new File(parent, destination.getName() + ".staging");
        File backup = new File(parent, destination.getName() + ".backup");
        recoverInterruptedSwap(destination, backup);
        deleteRecursively(staging);

        String bundledVersion = readText(source.open(assetRoot + "/" + VERSION_FILE));
        File installedVersionFile = new File(destination, VERSION_FILE);
        if (destination.isDirectory() && installedVersionFile.isFile() &&
            bundledVersion.equals(readText(installedVersionFile)) &&
            installedPayloadMatches(source, assetRoot, destination)) {
            deleteRecursively(backup);
            return;
        }

        try {
            copyTree(source, assetRoot, staging);
            String stagedVersion = readText(new File(staging, VERSION_FILE));
            if (!bundledVersion.equals(stagedVersion)) {
                throw new IOException("Staged Paseo runtime version does not match bundled assets");
            }
            validateInstalledPayload(source, assetRoot, staging);
        } catch (IOException error) {
            deleteRecursively(staging);
            throw error;
        }

        deleteRecursively(backup);
        if (destination.exists() && !destination.renameTo(backup)) {
            deleteRecursively(staging);
            throw new IOException("Unable to preserve installed runtime " + destination);
        }
        if (!staging.renameTo(destination)) {
            if (backup.exists() && !backup.renameTo(destination)) {
                throw new IOException("Unable to install or restore the Paseo runtime");
            }
            throw new IOException("Unable to install the staged Paseo runtime");
        }
        deleteRecursively(backup);
    }

    private void copyTree(AssetSource source, String assetPath, File destination) throws IOException {
        String[] children = source.list(assetPath);
        if (children != null && children.length > 0) {
            ensureDirectory(destination);
            for (String child : children) {
                copyTree(source, assetPath + "/" + child, new File(destination, child));
            }
            return;
        }

        File parent = destination.getParentFile();
        if (parent != null) ensureDirectory(parent);
        try (InputStream input = source.open(assetPath);
             FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        if (destination.getName().endsWith(".sh")) {
            destination.setExecutable(true, true);
        }
    }

    private static void recoverInterruptedSwap(File destination, File backup) throws IOException {
        if (!destination.exists() && backup.exists() && !backup.renameTo(destination)) {
            throw new IOException("Unable to restore the previous Paseo runtime");
        }
    }

    private static boolean installedPayloadMatches(
        AssetSource source, String assetRoot, File destination) {
        try {
            validateInstalledPayload(source, assetRoot, destination);
            return true;
        } catch (IOException error) {
            return false;
        }
    }

    private static void validateInstalledPayload(
        AssetSource source, String assetRoot, File destination) throws IOException {
        String bundledManifest = readText(source.open(assetRoot + "/" + PACKAGE_MANIFEST));
        File installedManifest = new File(destination, PACKAGE_MANIFEST);
        if (!installedManifest.isFile() || !bundledManifest.equals(readText(installedManifest))) {
            throw new IOException("Installed runtime manifest does not match bundled assets");
        }

        File packageDirectory = new File(destination, "packages").getCanonicalFile();
        String packagePrefix = packageDirectory.getPath() + File.separator;
        for (String line : bundledManifest.split("\\r?\\n")) {
            if (line.trim().isEmpty()) continue;
            int separator = line.indexOf("  ");
            if (separator != 64 || separator + 2 >= line.length()) {
                throw new IOException("Invalid bundled runtime manifest line: " + line);
            }

            String expected = line.substring(0, separator);
            String relative = line.substring(separator + 2);
            File payload = new File(packageDirectory, relative).getCanonicalFile();
            if (!payload.getPath().startsWith(packagePrefix) || !payload.isFile()) {
                throw new IOException("Installed runtime payload is missing: " + relative);
            }
            if (!expected.equals(sha256(payload))) {
                throw new IOException("Installed runtime payload checksum mismatch: " + relative);
            }
        }
    }

    private static String sha256(File file) throws IOException {
        final MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IOException("SHA-256 is unavailable", error);
        }

        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }

        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest.digest()) {
            hex.append(Character.forDigit((value >>> 4) & 0xf, 16));
            hex.append(Character.forDigit(value & 0xf, 16));
        }
        return hex.toString();
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("Unable to create " + directory);
        }
        if (!directory.isDirectory()) throw new IOException("Not a directory: " + directory);
    }

    private static void deleteRecursively(File file) throws IOException {
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Unable to list " + file);
            for (File child : children) deleteRecursively(child);
        }
        if (!file.delete()) throw new IOException("Unable to delete " + file);
    }

    private static String readText(InputStream input) throws IOException {
        try (InputStream stream = input) {
            byte[] buffer = new byte[BUFFER_SIZE];
            StringBuilder contents = new StringBuilder();
            int read;
            while ((read = stream.read(buffer)) != -1) {
                contents.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
            }
            return contents.toString().trim();
        }
    }

    private static String readText(File file) throws IOException {
        return readText(new FileInputStream(file));
    }

    private static final class AssetManagerSource implements AssetSource {
        private final AssetManager assets;

        private AssetManagerSource(AssetManager assets) {
            this.assets = assets;
        }

        @Override
        public String[] list(String path) throws IOException {
            return assets.list(path);
        }

        @Override
        public InputStream open(String path) throws IOException {
            return assets.open(path);
        }
    }
}
