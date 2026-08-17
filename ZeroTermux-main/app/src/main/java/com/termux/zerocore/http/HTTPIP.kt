package com.termux.zerocore.http

object HTTPIP {
    public const val IP = "https://od.ixcmstudio.cn"
    /** ZeroTermux 离线包镜像根目录（Eclipse LSP 等）。 */
    public const val ZT_DOWNLOAD_BASE = "$IP/ZeroTermux/zt_download"
    //还得脚本位置
    public const val QEMU_HAI = "$IP/"
    //论坛
    public const val ZERO_BBS = "https://termbbs.ixcm.org/"
    // GITHUB Version（请求必须带 User-Agent，否则 GitHub 返回 403）
    public const val GITHUB_VERSION = "https://api.github.com/repos/hanxinhao000/ZeroTermux/releases/latest"
    // 左侧菜单包网络更新地址
    public const val MENU_PACKAGE_URL = "$IP/repository/main/menu/menu_latest.zip"

}
