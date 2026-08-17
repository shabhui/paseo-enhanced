package com.termux.zerocore.ai.activity

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.cardview.widget.CardView
import com.example.xh_lib.utils.UUtils
import com.termux.R
import com.termux.app.TermuxService
import com.termux.zerocore.ai.deepseek.activity.ZeroTermuxDeepSeekSettingsActivity
import com.termux.zerocore.dialog.SwitchDialog
import com.termux.zerocore.ftp.utils.UserSetManage
import com.termux.zerocore.llm.activity.ZeroTermuxLLMSettingsActivity
import com.termux.zerocore.settings.BaseTitleActivity

class MainAiSettings : BaseTitleActivity() {

    private val mDeepseekAiSwitch by lazy { findViewById<CardView>(R.id.deepseek_ai_switch) }
    private val mCustomAiSwitch by lazy { findViewById<CardView>(R.id.custom_ai_switch) }

    private val mDeepSeekEntry by lazy { findViewById<CardView>(R.id.deep_seek_entry) }
    private val mCustomAiEntry by lazy { findViewById<CardView>(R.id.custom_ai_entry) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_zero_termux_ai_settings)
        setBaseTitle(UUtils.getString(R.string.ai_settings))
        val ztUserBean = UserSetManage.get().getZTUserBean()
        // 设置当前默认AI
        switchAi(ztUserBean.isCustomAi)
        mCustomAiSwitch.setOnClickListener {
            setSwitchThisAi(true)
            showCloseDialog()
        }
        mDeepseekAiSwitch.setOnClickListener {
            setSwitchThisAi(false)
            showCloseDialog()
        }
        mDeepSeekEntry.setOnClickListener {
            startActivity(Intent(this@MainAiSettings, ZeroTermuxDeepSeekSettingsActivity::class.java))
        }
        mCustomAiEntry.setOnClickListener {
            startActivity(Intent(this@MainAiSettings, ZeroTermuxLLMSettingsActivity::class.java))
        }
    }

    private fun showCloseDialog() {
        val switchDialog = SwitchDialog(this)
        switchDialog.createSwitchDialog(getString(R.string.ai_dialog_reset))
        switchDialog.ok!!.setOnClickListener { _: View? ->
            Intent(
                this@MainAiSettings,
                TermuxService::class.java
            ).setAction("com.termux.service_stop")
            System.exit(0)
            finish()
        }
        switchDialog.setCancelable(false)
        switchDialog.cancel!!.visibility = View.GONE
        switchDialog.show()
    }

    private fun setSwitchThisAi(isCustomAi: Boolean) {
        val ztUserBean = UserSetManage.get().getZTUserBean()
        ztUserBean.isCustomAi = isCustomAi
        UserSetManage.get().setZTUserBean(ztUserBean)
        switchAi(ztUserBean.isCustomAi)
    }

    private fun switchAi(isCustomAi: Boolean) {
        mDeepseekAiSwitch.setCardBackgroundColor(getColor(R.color.color_55000000))
        mCustomAiSwitch.setCardBackgroundColor(getColor(R.color.color_55000000))
        if (isCustomAi) {
            mCustomAiSwitch.setCardBackgroundColor(getColor(R.color.color_5548baf3))
        } else {
            mDeepseekAiSwitch.setCardBackgroundColor(getColor(R.color.color_5548baf3))
        }
    }
}
