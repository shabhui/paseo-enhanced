package com.termux.zerocore.settings

import android.os.Bundle
import com.example.xh_lib.utils.UUtils
import com.termux.R

class ZTInstallActivity : BaseTitleActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setBaseTitle(UUtils.getString(R.string.zt_install))
        UUtils.showMsg(UUtils.getString(R.string.standalone_companion_apps_disabled))
        finish()
    }
}
