# Android client

This is a small WebView wrapper for a Paseo Daemon running on the same Android
device at `127.0.0.1:6767`. The checked-in APK is only a convenience build;
the repository intentionally does not include its signing keystore.

Build with a local Android SDK and Gradle:

```sh
cd android
gradle assembleDebug
```

For a distributable build, configure your own signing key and use
`assembleRelease`. Do not publish the debug APK as a trusted release.

