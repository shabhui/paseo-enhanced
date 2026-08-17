package com.termux.zerocore.config.mainmenu.config

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import com.example.xh_lib.utils.UUtils
import com.termux.R
import com.termux.zerocore.activity.WebViewActivity
import com.termux.zerocore.config.mainmenu.MainMenuConfig
import com.termux.zerocore.dialog.LoadingDialog
import com.termux.zerocore.dialog.SwitchDialog
import com.termux.zerocore.editor.EditorVscodeServerSupport
import com.termux.zerocore.utils.SingletonCommunicationUtils
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * 创建项目 → VS Code：首次点击安装 code-server；
 * 已安装则弹出 Loading（不可取消），强制提示即将进入，就绪后自动打开内置浏览器。
 */
class CreateVscodeClickConfig : BaseMenuClickConfig() {

    override fun getType(): Int = MainMenuConfig.CODE_CREATE_PROJECT

    override fun getIcon(context: Context?): Drawable? {
        return context?.getDrawable(R.drawable.ic_project_vscode)
    }

    override fun getString(context: Context?): String? {
        return context?.getString(R.string.menu_create_project_vscode)
    }

    override fun onClick(view: View?, context: Context?) {
        val ctx = context ?: return
        if (!EditorVscodeServerSupport.isInstalled()) {
            showInstallHintDialog(ctx)
            sendToTerminal(EditorVscodeServerSupport.installAndPrepareShell())
            return
        }
        sendToTerminal(EditorVscodeServerSupport.startServerShell())
        val loading = showEnteringLoading(ctx) ?: return
        waitForServerThenOpenBrowser(ctx, loading)
    }

    private fun showEnteringLoading(context: Context): LoadingDialog? {
        val host = (mContext as? Activity) ?: (context as? Activity) ?: return null
        if (host.isFinishing) return null
        val dialog = LoadingDialog(host)
        dialog.msg?.text = context.getString(
            R.string.menu_vscode_loading_enter
        ) + "\n" + context.getString(
            R.string.menu_vscode_open_message,
            EditorVscodeServerSupport.externalAddress()
        )
        dialog.setCancelable(false)
        dialog.setCanceledOnTouchOutside(false)
        dialog.show()
        // show() 后再次写入，确保文案可见且不可关闭
        dialog.msg?.text = context.getString(R.string.menu_vscode_loading_enter) +
            "\n" + context.getString(
            R.string.menu_vscode_open_message,
            EditorVscodeServerSupport.externalAddress()
        )
        dialog.setCancelable(false)
        return dialog
    }

    private fun showInstallHintDialog(context: Context) {
        val host = (mContext as? Activity) ?: (context as? Activity) ?: return
        val dialog = SwitchDialog(host)
        dialog.createSwitchDialog(
            context.getString(
                R.string.menu_vscode_install_message,
                EditorVscodeServerSupport.externalAddress()
            )
        )
        dialog.title?.text = context.getString(R.string.menu_vscode_install_title)
        dialog.other?.visibility = View.GONE
        dialog.cancel?.visibility = View.GONE
        dialog.ok?.text = context.getString(R.string.confirm)
        dialog.ok?.setOnClickListener { dialog.dismiss() }
        dialog.setCancelable(true)
        dialog.show()
    }

    private fun waitForServerThenOpenBrowser(context: Context, loading: LoadingDialog) {
        val handler = Handler(Looper.getMainLooper())
        val deadline = SystemClock.elapsedRealtime() + SERVER_READY_TIMEOUT_MS
        val opened = AtomicBoolean(false)
        val loadingRef = AtomicReference(loading)
        val poll = object : Runnable {
            override fun run() {
                if (opened.get()) return
                bgExecutor.execute {
                    val ready = isLocalServerResponding()
                    handler.post {
                        if (opened.get()) return@post
                        if (ready) {
                            if (opened.compareAndSet(false, true)) {
                                dismissLoading(loadingRef)
                                openBuiltInBrowser(context)
                            }
                            return@post
                        }
                        if (SystemClock.elapsedRealtime() < deadline) {
                            // LoadingDialog 约 30s 会自关，仍显示时刷新文案强化提示
                            loadingRef.get()?.takeIf { it.isShowing }?.msg?.text =
                                context.getString(R.string.menu_vscode_loading_enter) +
                                    "\n" + context.getString(
                                    R.string.menu_vscode_open_message,
                                    EditorVscodeServerSupport.externalAddress()
                                )
                            handler.postDelayed(this, SERVER_POLL_INTERVAL_MS)
                        } else if (opened.compareAndSet(false, true)) {
                            dismissLoading(loadingRef)
                            UUtils.showMsg(context.getString(R.string.menu_vscode_opening_browser))
                            openBuiltInBrowser(context)
                        }
                    }
                }
            }
        }
        handler.postDelayed(poll, SERVER_POLL_INITIAL_DELAY_MS)
    }

    private fun dismissLoading(loadingRef: AtomicReference<LoadingDialog>) {
        val dialog = loadingRef.getAndSet(null) ?: return
        try {
            if (dialog.isShowing) dialog.dismiss()
        } catch (_: Exception) {
        }
    }

    private fun isLocalServerResponding(): Boolean {
        return try {
            val conn = (URL(EditorVscodeServerSupport.LOCAL_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = 1500
                readTimeout = 1500
                instanceFollowRedirects = true
                requestMethod = "GET"
            }
            try {
                conn.responseCode in 200..399
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun openBuiltInBrowser(context: Context) {
        val intent = Intent(context, WebViewActivity::class.java)
        intent.putExtra("title_visible", "gone")
        intent.putExtra("content", EditorVscodeServerSupport.LOCAL_URL)
        if (context !is Activity) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    private fun sendToTerminal(command: String) {
        val listener = SingletonCommunicationUtils.getInstance()
            .getmSingletonCommunicationListener()
        if (listener == null) {
            UUtils.showMsg(UUtils.getString(R.string.editor_java_terminal_unavailable))
            return
        }
        listener.sendTextToTerminal("\n")
        listener.sendTextToTerminal(command)
        if (!command.endsWith("\n")) {
            listener.sendTextToTerminal("\n")
        }
    }

    companion object {
        private val bgExecutor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "ZT-VSCode-Ready").apply { isDaemon = true }
        }
        private const val SERVER_POLL_INITIAL_DELAY_MS = 800L
        private const val SERVER_POLL_INTERVAL_MS = 500L
        private const val SERVER_READY_TIMEOUT_MS = 45_000L
    }
}
