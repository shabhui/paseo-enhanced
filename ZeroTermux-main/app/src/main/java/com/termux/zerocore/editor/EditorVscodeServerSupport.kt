package com.termux.zerocore.editor

import com.example.xh_lib.utils.UUtils
import com.termux.shared.termux.TermuxConstants
import java.io.File

/**
 * Termux 内 code-server（VS Code Server）安装/启动辅助。
 *
 * 安装：`pkg install tur-repo && pkg install code-server`（写独立脚本执行，避免 apt 吞多行）。
 * 启动：单行命令 + 精确 pkill，避免误杀启动脚本。
 */
object EditorVscodeServerSupport {

    const val PORT = 13337
    const val LOCAL_URL = "http://127.0.0.1:$PORT"

    private val home: String
        get() = TermuxConstants.TERMUX_HOME_DIR_PATH

    private val binPrefix: String
        get() = TermuxConstants.TERMUX_BIN_PREFIX_DIR_PATH

    private val readyMarker: File
        get() = File(home, ".zerotermux/vscode-server.ready")

    private val binary: File
        get() = File(binPrefix, "code-server")

    private val configFile: String
        get() = "$home/.config/code-server/config.yaml"

    /** 安装脚本名刻意不含 code-server，避免被 pkill -f 误伤。 */
    private val installScript: String
        get() = "$home/.zerotermux/zt-cs-install.sh"

    fun isInstalled(): Boolean {
        return resolveBinaryPath() != null
    }

    fun resolveBinaryPath(): String? {
        if (binary.canExecute()) return binary.absolutePath
        val local = File(home, ".local/bin/code-server")
        if (local.canExecute()) return local.absolutePath
        return null
    }

    fun lanHost(): String {
        val ip = runCatching { UUtils.getHostIP() }.getOrNull().orEmpty().trim()
        return if (ip.isEmpty() || ip == "0.0.0.0" || ip.startsWith("127.")) {
            "127.0.0.1"
        } else {
            ip
        }
    }

    fun externalUrl(): String = "http://${lanHost()}:$PORT"

    fun externalAddress(): String = "${lanHost()}:$PORT"

    fun installAndPrepareShell(): String {
        val marker = readyMarker.absolutePath
        val script = installScript
        return buildString {
            appendLine("mkdir -p \"$home/.zerotermux\" \"$home/.config/code-server\"")
            appendLine("cat > \"$script\" <<'ZTSCRIPT'")
            appendLine("#!$binPrefix/bash")
            appendLine("set -e")
            appendLine("export DEBIAN_FRONTEND=noninteractive")
            appendLine("export ASSUME_ALWAYS_YES=true")
            appendLine("echo '[ZeroTermux] Installing VS Code Server…'")
            appendLine("pkg update -y </dev/null")
            appendLine("pkg install -y tur-repo </dev/null || true")
            appendLine("pkg update -y </dev/null || true")
            appendLine("pkg install -y code-server </dev/null")
            appendLine("printf '%s\\n' 'bind-addr: 0.0.0.0:$PORT' 'auth: none' 'cert: false' > \"$configFile\"")
            appendLine("if command -v code-server >/dev/null 2>&1 && code-server --version >/dev/null 2>&1; then")
            appendLine("  touch \"$marker\"")
            appendLine("  echo '[ZeroTermux] Installed. Tap VS Code again to open.'")
            appendLine("  code-server --version || true")
            appendLine("else")
            appendLine("  echo '[ZeroTermux] Install failed.'")
            appendLine("  exit 1")
            appendLine("fi")
            appendLine("ZTSCRIPT")
            appendLine("chmod +x \"$script\" && bash \"$script\"")
        }
    }

    /**
     * 单行启动：只杀真正的 code-server node 进程，不会误杀启动命令本身。
     */
    fun startServerShell(): String {
        val marker = readyMarker.absolutePath
        val log = "$home/.zerotermux/vscode-server.log"
        val pidFile = "$home/.zerotermux/vscode-server.pid"
        return (
            "export PATH=\"$home/.local/bin:$binPrefix:\$PATH\"; " +
                "mkdir -p \"$home/.zerotermux\" \"$home/.config/code-server\"; " +
                "printf '%s\\n' 'bind-addr: 0.0.0.0:$PORT' 'auth: none' 'cert: false' > \"$configFile\"; " +
                "pkill -f 'lib/code-server/out/node/entry' >/dev/null 2>&1 || true; " +
                "pkill -f 'lib/code-server/lib/node' >/dev/null 2>&1 || true; " +
                "sleep 0.5; " +
                "CS_BIN=\$(command -v code-server); " +
                "if [ -z \"\$CS_BIN\" ]; then " +
                "echo '[ZeroTermux] code-server not found; tap VS Code to reinstall'; exit 1; fi; " +
                "if ! \"\$CS_BIN\" --version >/dev/null 2>&1; then " +
                "rm -f \"$marker\"; " +
                "echo '[ZeroTermux] code-server broken; tap VS Code to reinstall'; exit 1; fi; " +
                "echo '[ZeroTermux] Starting VS Code Server on 0.0.0.0:$PORT …'; " +
                "nohup \"\$CS_BIN\" --bind-addr 0.0.0.0:$PORT --auth none --cert false >\"$log\" 2>&1 & " +
                "echo \$! > \"$pidFile\"; " +
                "ready=0; " +
                "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do " +
                "curl -fsS --connect-timeout 1 \"http://127.0.0.1:$PORT/\" >/dev/null 2>&1 && ready=1 && break; " +
                "sleep 0.5; done; " +
                "touch \"$marker\"; " +
                "if [ \"\$ready\" = 1 ]; then " +
                "echo '[ZeroTermux] VS Code Server is ready: http://127.0.0.1:$PORT/'; " +
                "else echo '[ZeroTermux] VS Code Server failed to start; tail -30 \"$log\"'; tail -30 \"$log\" 2>/dev/null || true; fi"
            ) + "\n"
    }
}
