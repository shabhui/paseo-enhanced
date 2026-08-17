package com.termux.zerocore.dialog

import android.content.Context
import android.view.View
import android.widget.TextView
import com.example.xh_lib.utils.UUtils
import com.termux.R

class LoadingOsInstallDialog : BaseDialogCentre {
    public var mMsg:TextView? = null
    constructor(context: Context) : super(context)
    constructor(context: Context, themeResId: Int) : super(context, themeResId)
    override fun initViewDialog(mView: View?) {
        mMsg = mView?.findViewById(R.id.msg)
    }

    override fun getContentView(): Int {
        return R.layout.dialog_install_loading
    }

    public fun setMsg(string: String) {
        mMsg?.text = string
    }
    override fun show() {
        super.show()
        setCancelable(false)
    }
}
