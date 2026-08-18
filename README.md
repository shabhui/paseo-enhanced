# Paseo Enhanced

面向 Android + Termux 自托管场景的 Paseo 0.3.1 增强层。项目保留官方
Paseo 的运行方式，只增加本地管理界面、供应商切换和移动端可用性修复。

## 功能

- Codex 供应商、模型、权限和 API Key 管理，密钥输入可直接粘贴。
- 对话内“挤入模式”：上游繁忙时按原请求节奏持续重试，成功或关闭开关后停止。
- 获取供应商模型列表。
- 对话一键全部导入、单个删除和后台状态同步。
- 手机目录浏览器，可直接选择工作区、Skill 或插件目录。
- Skills 按通用、Codex、Claude 和系统内置分类，支持启停、删除和从导入源更新。
- 插件导入、启停和删除。
- Android 软键盘避让，输入框不会被 IME 覆盖。
- 紧凑型侧边管理面板，避免遮挡 Paseo 原有顶栏和输入区。

## 兼容性

当前补丁严格对应 `@getpaseo/server@0.3.1`。安装器遇到其他版本会停止，
除非显式传入 `--force`。强制安装可能破坏新版 Paseo，不建议普通用户使用。

## 安装

先安装官方 Paseo CLI：

```sh
npm install -g @getpaseo/cli@0.3.1
```

然后在本项目目录执行：

```sh
node install.mjs
```

安装器会：

1. 定位全局安装的 `@getpaseo/server`。
2. 检查版本并验证补丁语法。
3. 在 `~/.paseo/paseo-enhanced-backups/` 创建逐文件备份。
4. 安装管理 API、Codex 代理和自定义 Web UI。
5. 更新 `~/.paseo/config.json` 的本地 Web UI 路径。

安装器不会停止或重启 Paseo。完成当前任务后，请按你原来的方式正常重启
Paseo Daemon；仅刷新页面不足以加载服务端补丁。

可通过参数指定非标准位置：

```sh
node install.mjs --server-root /path/to/@getpaseo/server --paseo-home /path/to/.paseo
```

## 回滚

```sh
node uninstall.mjs
```

回滚脚本恢复最近一次安装前的文件，同样不会自动重启 Paseo。也可以重新安装
官方版本进行完整恢复：

```sh
npm install -g @getpaseo/cli@0.3.1
```

## Android 客户端

独立 arm64 APK 作为 `v2.3.2` GitHub Release 附件发布；本地构建产物位于
`android/releases/PaseoEnhanced-v2.3.2-arm64.apk`，不纳入 Git 跟踪。它已经内置 Termux
bootstrap、Node.js 24、Paseo CLI 0.3.1、Paseo Enhanced 2.3.3 和 Android arm64
原生模块，不需要另外安装 ZeroTermux 或 Termux。首次启动会在应用私有目录离线
安装这些运行文件，启动 Paseo Daemon，等待 `http://127.0.0.1:6767/` 就绪后直接
打开 Web UI。`v2.3.2` 修复了 Windows 构建生成 CRLF runtime manifest 时首次安装误报
缺少内置压缩包的问题。最低系统版本为 Android 7.0（API 24）。

APK SHA-256：
`3053755F0D62E107A3F85464B51205190A833A478E30A0EA2B4043A7908E2081`

Android 工程位于 `ZeroTermux-main/`，离线运行时准备脚本位于
`scripts/prepare-android-runtime.ps1`。应用使用独立包名 `com.paseoe`，可以与原来的
ZeroTermux (`com.termux`) 共存；Termux Java namespace 仍保留为 `com.termux`，
bootstrap 和运行时前缀已迁移到 `/data/data/com.paseoe/files/usr`。

## 安全说明

- 管理 API 只接受回环地址请求。
- Android WebView 只允许 `127.0.0.1:6767`，其他导航和明文 HTTP 地址会被阻止。
- Android 应用备份已关闭，release 签名信息只从构建进程的环境变量读取。
- API Key 保存在用户本机的 `~/.paseo/codex-provider-profiles.json`，不会由
  管理接口返回明文。
- 请勿公开 `.paseo` 目录、Daemon 密钥、会话记录或 Android 签名文件。
- “挤入模式”会持续请求繁忙的上游服务；使用前应确认供应商条款和额度限制。

## 上游更新

本项目采用版本锁定补丁，不能假设未来 Paseo 文件结构不变。升级官方 Paseo 前，
先运行 `npm run check`；若版本变化，应重新基于对应 npm 包审查差异，而不是强制覆盖。

## 第三方声明与 License

本项目基于 Paseo 修改并按 GNU AGPL v3 发布。使用、修改或再分发时，请保留
[LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 和
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，并提供对应源代码。

这里的“增强版”是非官方发行版，不代表 Paseo 官方背书。上游 Paseo 以及本仓库
使用的其他组件、SDK 和 npm 依赖，仍受各自原始许可证约束；不要删除其版权和
许可声明。
