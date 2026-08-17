# Third-party notices

本文件列出本仓库直接重新分发或修改的主要第三方项目。各项目的完整许可
文本和原始版权声明应与本文件一起保留。

## Paseo

- 项目：Paseo
- 来源：<https://github.com/getpaseo/paseo>
- 本地版本：0.3.1
- 许可：GNU Affero General Public License v3（AGPL-3.0）
- 本仓库包含来自 `@getpaseo/server@0.3.1` 的编译 JavaScript 修改版，位于
  `patches/server/`；Web UI 和 Android WebView 客户端也是基于 Paseo 的本地
  运行方式制作的增强层。
- 上游版权声明和完整协议见 [LICENSE](LICENSE)。

## Android SDK / WebView

Android 客户端使用 Android SDK 和系统 WebView 提供的 API。Android Open Source
Project 组件通常按 Apache License 2.0 或其组件附带的许可发布；本仓库没有复制
Android SDK 源码。使用者在构建或再分发 Android 客户端时，应继续遵守本地 SDK
和系统组件附带的通知。

## Node.js 与 npm 依赖

安装器不会把 Node.js、`@getpaseo/cli` 或其全部依赖复制进本仓库，而是要求使用者
自行安装官方 `@getpaseo/cli@0.3.1`。这些依赖的许可证仍由官方 npm 包及其
`node_modules` 中的 LICENSE/NOTICE 文件负责；本仓库不替代这些原始通知。

## 图标和视觉参考

Android 图标来自当前 Paseo 增强客户端构建所使用的 Paseo 图标资源。Paseo
名称、Logo 和原始视觉资产不表示本项目获得 Paseo 官方背书。界面布局借鉴了
常见的启动器和移动端管理面板模式；没有把其他闭源启动器的代码或资源复制到
本仓库。

## 本项目的修改

本仓库新增的安装器、管理面板、状态同步、Provider 扫描超时和 Android 键盘
避让代码，均以与上游兼容的 AGPLv3 条件发布。重新分发修改版时，请保留本文件、
`NOTICE.md`、`LICENSE` 和上游版权信息，并按 AGPLv3 提供对应源代码。

