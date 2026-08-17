package com.termux.zerocore.settings

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import com.example.xh_lib.utils.UUtils
import com.termux.R

public open class BaseTitleActivity: AppCompatActivity() {
    private var mTitle: TextView? = null
    private var mCancel: ImageView? = null
    private var mBaseFrame: FrameLayout? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }

    override fun setContentView(layoutResID: Int) {
        val childView = LayoutInflater.from(this).inflate(layoutResID, null)
        val thisView = LayoutInflater.from(this).inflate(R.layout.activity_base_title, null)
        mTitle = thisView.findViewById<TextView>(R.id.title)
        mBaseFrame = thisView.findViewById<FrameLayout>(R.id.base_frame)
        mCancel = thisView.findViewById<ImageView>(R.id.cancel)
        mCancel!!.setOnClickListener { finish() }
        mBaseFrame!!.addView(childView)
        super.setContentView(thisView)
    }

    public fun setBaseTitle(title: String) {
        mTitle!!.text = title
    }

    public fun goneCancelButton() {
        mCancel!!.visibility = View.GONE
    }
}
