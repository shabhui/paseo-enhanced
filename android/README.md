# Paseo Enhanced Android

这是基于内置 ZeroTermux 源码的独立 arm64 应用，不依赖手机上另行安装的
ZeroTermux 或 Termux。APK 包含：

- Termux arm64 bootstrap
- Node.js 24.18.0
- Paseo CLI / Server 0.3.1
- Paseo Enhanced 2.3.1
- 为 Android arm64 交叉编译的 `node-pty` 和文件监视模块

首次启动会校验 APK 内运行时清单，在应用私有目录离线安装 Node/Paseo，应用增强
补丁并启动 `127.0.0.1:6767`。运行时目录按版本安装并原子替换，后续启动不会重复
复制相同版本。只有 Paseo 后续访问 AI 服务等正常网络功能需要联网。最低系统版本
为 Android 7.0（API 24）。

## 预构建 APK

文件：`releases/PaseoEnhanced-v2.3.1-arm64.apk`

该文件作为 `v2.3.1` GitHub Release 附件发布，也可由本地 release 构建生成；APK
不纳入 Git 跟踪。

SHA-256：
`4A662DC44D7773535AA05D213D08CE3CFE11037A21BBF062134DAC8F730B4AED`

应用包名为 `com.paseoe`，可以直接与原来的 `com.termux` ZeroTermux 共存，不会覆盖
原应用。Java namespace 仍为 `com.termux`，bootstrap 和内置 Node 运行时已迁移到
`/data/data/com.paseoe/files/usr`；启动时直接解包已校验的运行时归档，不依赖原应用的
dpkg 状态。

## 构建

需要 JDK 21、Android SDK 36、NDK `29.0.14206865`、Node.js 20 或更高版本，
以及 Gradle 9.2.1（工程 wrapper 版本）。先验证或重新生成离线运行时：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\prepare-android-runtime.ps1 -ValidateOnly
# 需要重新下载并生成运行时时，去掉 -ValidateOnly
```

Windows 中文工程路径会使 Gradle Test Executor 丢失测试 classpath。使用临时 ASCII
盘符运行测试和构建。debug 使用 Android 默认调试证书；release 必须通过四个环境
变量注入自己的 keystore，工程不再内置密码：

```powershell
subst P: 'D:\AI项目\paseo-enhanced-main'
Set-Location P:\ZeroTermux-main
gradle :app:testDebugUnitTest --tests 'com.termux.paseo.*' -Darch=arm64
$env:RELEASE_STORE_FILE='C:\path\to\paseo-release.jks'
$env:RELEASE_KEY_ALIAS='your-key-alias'
$env:RELEASE_STORE_PASSWORD='your-store-password'
$env:RELEASE_KEY_PASSWORD='your-key-password'
gradle :app:assembleRelease -Darch=arm64
subst P: /d
```

独立运行时只有 arm64 版本；未传 `-Darch` 时也默认 arm64，其他架构会直接停止构建。

release 产物位于
`ZeroTermux-main/app/build/outputs/apk/release/ZeroTermux-2.3.1-release_arm64-v8a.apk`。
