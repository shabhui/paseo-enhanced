package com.termux.zerocore.llm.activity

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.Editable
import android.text.SpannableString
import android.text.Spanned
import android.text.TextUtils
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.cardview.widget.CardView
import com.example.xh_lib.utils.UUtils
import com.termux.R
import com.termux.zerocore.ai.llm.data.ChatDatabaseHelper
import com.termux.zerocore.ai.llm.model.Config
import com.termux.zerocore.ai.model.ProviderProfile
import com.termux.zerocore.ftp.utils.UserSetManage
import com.termux.zerocore.settings.BaseTitleActivity


class ZeroTermuxLLMSettingsActivity : BaseTitleActivity() {
    companion object {
        public val TAG = ZeroTermuxLLMSettingsActivity::class.java.simpleName
    }

    private val mKeyClick by lazy { findViewById<EditText>(R.id.key_click) }
    //private val mLlmApiKeyEdit by lazy { findViewById<EditText>(R.id.llm_api_key_edit) }
    private val mKeyClickSummary by lazy { findViewById<TextView>(R.id.key_click_summary) }
    //private val mLlmKeySummary by lazy { findViewById<TextView>(R.id.llm_key_summary) }

    private val mAiVisibleSwitch by lazy { findViewById<SwitchCompat>(R.id.ai_visible_switch) }
    private val mAiVisibleLayout by lazy { findViewById<LinearLayout>(R.id.ai_visible_layout) }

    private val mProviderListContainer by lazy { findViewById<LinearLayout>(R.id.provider_list_container) }
    private val mAddProviderCard by lazy { findViewById<CardView>(R.id.add_provider_card) }
    private val mSystemPromptEdit by lazy { findViewById<EditText>(R.id.system_prompt_edit) }

    private lateinit var dbHelper: ChatDatabaseHelper

    // Format type display names and values
    private val formatTypes = arrayOf("openai", "claude", "gemini")
    private val defaultUrls = mapOf(
        "openai" to "https://api.futureppo.top/v1/chat/completions",
        "claude" to "https://api.anthropic.com/v1/messages",
        "gemini" to "https://generativelanguage.googleapis.com/v1beta"
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_zero_termux_llm_settings)
        setBaseTitle(UUtils.getString(R.string.ai_settings_title))
        dbHelper = ChatDatabaseHelper(this)
        initView()
        initStatus()
        initProviderList()
        initSystemPrompt()
    }

    private fun initView() {
         setSwitchStatus(mAiVisibleSwitch, mAiVisibleLayout)

        // 设置AI蓝色点击识别
        val commandLink = UserSetManage.get().getZTUserBean().commandLink
        if (commandLink.isNullOrEmpty()) {
            mKeyClick.setText(Config.COMMANDS)
        } else {
            mKeyClick.setText(commandLink)
        }

        mKeyClick.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(
                p0: CharSequence?,
                p1: Int,
                p2: Int,
                p3: Int
            ) {

            }

            override fun onTextChanged(
                p0: CharSequence?,
                p1: Int,
                p2: Int,
                p3: Int
            ) {
                val ztUserBean = UserSetManage.get().getZTUserBean()
                var command = p0?.toString()
                if (!TextUtils.isEmpty(command) && command!!.contains("，")) {
                    command = p0?.toString()?.replace("，", ",")
                    mKeyClick.setText(command)
                    mKeyClick.setSelection(command!!.length);
                }
                ztUserBean.commandLink = command
                UserSetManage.get().setZTUserBean(ztUserBean)
            }

            override fun afterTextChanged(p0: Editable?) {

            }

        })

        /*// 设置 AI Key
        val providerApiKey = dbHelper.defaultProvider?.apiKey
        val legacyApiKey = UserSetManage.get().getZTUserBean().customApiKey
        val llmApiKey = if (!providerApiKey.isNullOrEmpty()) providerApiKey else legacyApiKey
        if (!TextUtils.isEmpty(llmApiKey)) {
            mLlmApiKeyEdit.setText(llmApiKey)
            if (providerApiKey.isNullOrEmpty()) {
                dbHelper.updateDefaultProviderApiKey(llmApiKey)
            }
        }
       mLlmApiKeyEdit.addTextChangedListener(object : TextWatcher {
           override fun beforeTextChanged(
               p0: CharSequence?,
               p1: Int,
               p2: Int,
               p3: Int
           ) {
           }
           override fun onTextChanged(
               p0: CharSequence?,
               p1: Int,
               p2: Int,
               p3: Int
           ) {
               val ztUserBean = UserSetManage.get().getZTUserBean()
               val llmApiKey = p0?.toString()
               ztUserBean.customApiKey = llmApiKey
               UserSetManage.get().setZTUserBean(ztUserBean)
               dbHelper.updateDefaultProviderApiKey(llmApiKey)
           }
           override fun afterTextChanged(p0: Editable?) {
           }
       })*/

        // Add Provider button
        mAddProviderCard.setOnClickListener {
            showProviderDialog(null)
        }
    }

    private fun initStatus() {
        val ztUserBean = UserSetManage.get().getZTUserBean()
        mAiVisibleSwitch.isChecked = ztUserBean.isIsCustomVisibleTerminal

        mKeyClickSummary.text = getKeyClickText(UUtils.getString(R.string.deepseek_settings_recognition_edit_keyword),
            UUtils.getString(R.string.deepseek_settings_recognition_edit_info), object : ClickableSpan() {
            override fun onClick(widget: View) {
                mKeyClick.setText(Config.COMMANDS)
            }
        })

       /* mLlmKeySummary.text = getKeyClickText(UUtils.getString(R.string.deepseek_settings_key_edit_info_keyword),
            UUtils.getString(R.string.deepseek_settings_key_edit_info), object : ClickableSpan() {
                override fun onClick(widget: View) {
                    startActivity(Intent(this@ZeroTermuxLLMSettingsActivity, ZeroTermuxLLMKeyActivity::class.java))
                }
            })
        mLlmKeySummary.movementMethod = LinkMovementMethod.getInstance()*/
        mKeyClickSummary.movementMethod = LinkMovementMethod.getInstance()
    }

    // ========================= Provider Management =========================

    private fun initProviderList() {
        refreshProviderList()
    }

    private fun refreshProviderList() {
        mProviderListContainer.removeAllViews()
        val providers = dbHelper.getAllProviders()
        for (provider in providers) {
            addProviderItemView(provider)
        }
    }

    private fun addProviderItemView(provider: ProviderProfile) {
        val itemView = LayoutInflater.from(this)
            .inflate(R.layout.item_provider_setting, mProviderListContainer, false) as CardView

        val nameText = itemView.findViewById<TextView>(R.id.provider_item_name)
        val formatText = itemView.findViewById<TextView>(R.id.provider_item_format)
        val defaultBtn = itemView.findViewById<TextView>(R.id.provider_item_default)
        val editBtn = itemView.findViewById<TextView>(R.id.provider_item_edit)
        val deleteBtn = itemView.findViewById<TextView>(R.id.provider_item_delete)

        nameText.text = if (provider.isDefault) {
            "${provider.name} (${getString(R.string.ai_provider_default_badge)})"
        } else {
            provider.name
        }

        formatText.text = getFormatDisplayName(provider.formatType)

        // Hide "Set Default" button if already default
        if (provider.isDefault) {
            defaultBtn.visibility = View.GONE
        } else {
            defaultBtn.setOnClickListener {
                dbHelper.setDefaultProvider(provider.id)
                Toast.makeText(this, R.string.ai_provider_set_default_done, Toast.LENGTH_SHORT).show()
                refreshProviderList()
            }
        }

        editBtn.setOnClickListener {
            showProviderDialog(provider)
        }

        deleteBtn.setOnClickListener {
            if (dbHelper.getProviderCount() <= 1) {
                Toast.makeText(this, R.string.ai_provider_delete_last, Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            AlertDialog.Builder(this)
                .setMessage(String.format(getString(R.string.ai_provider_delete_confirm), provider.name))
                .setPositiveButton(R.string.ai_delete) { _, _ ->
                    dbHelper.deleteProvider(provider.id)
                    Toast.makeText(this, R.string.ai_provider_deleted, Toast.LENGTH_SHORT).show()
                    refreshProviderList()
                }
                .setNegativeButton(R.string.ai_cancel, null)
                .show()
        }

        mProviderListContainer.addView(itemView)
    }

    private fun showProviderDialog(existing: ProviderProfile?) {
        val dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_provider_edit, null)
        val nameEdit = dialogView.findViewById<EditText>(R.id.provider_name)
        val formatSpinner = dialogView.findViewById<Spinner>(R.id.provider_format_spinner)
        val urlEdit = dialogView.findViewById<EditText>(R.id.provider_url)
        val keyEdit = dialogView.findViewById<EditText>(R.id.provider_key)
        val modelEdit = dialogView.findViewById<EditText>(R.id.provider_model)

        // Format spinner setup
        val formatNames = arrayOf(
            getString(R.string.ai_format_openai),
            getString(R.string.ai_format_claude),
            getString(R.string.ai_format_gemini)
        )
        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, formatNames)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        formatSpinner.adapter = adapter

        // Auto-fill URL when format changes
        formatSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                // Only auto-fill if URL is empty or matches a default URL
                val currentUrl = urlEdit.text.toString().trim()
                if (currentUrl.isEmpty() || defaultUrls.values.contains(currentUrl)) {
                    urlEdit.setText(defaultUrls[formatTypes[position]] ?: "")
                }
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

        // Fill existing values if editing
        if (existing != null) {
            nameEdit.setText(existing.name)
            urlEdit.setText(existing.apiUrl)
            keyEdit.setText(existing.apiKey)
            modelEdit.setText(existing.modelName)
            val formatIndex = formatTypes.indexOf(existing.formatType)
            if (formatIndex >= 0) formatSpinner.setSelection(formatIndex)
        }

        val title = if (existing != null) getString(R.string.ai_provider_edit) else getString(R.string.ai_provider_add)

        AlertDialog.Builder(this)
            .setTitle(title)
            .setView(dialogView)
            .setPositiveButton(R.string.ai_confirm) { _, _ ->
                val name = nameEdit.text.toString().trim()
                val url = urlEdit.text.toString().trim()
                val key = keyEdit.text.toString().trim()
                val model = modelEdit.text.toString().trim()
                val formatType = formatTypes[formatSpinner.selectedItemPosition]

                // Validation
                if (name.isEmpty()) {
                    Toast.makeText(this, R.string.ai_provider_name_required, Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                if (url.isEmpty()) {
                    Toast.makeText(this, R.string.ai_provider_url_required, Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                if (model.isEmpty()) {
                    Toast.makeText(this, R.string.ai_provider_model_required, Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }

                if (existing != null) {
                    existing.name = name
                    existing.formatType = formatType
                    existing.apiUrl = url
                    existing.apiKey = key
                    existing.modelName = model
                    dbHelper.updateProvider(existing)
                } else {
                    val profile = ProviderProfile(0, name, formatType, url, key, model, false)
                    dbHelper.insertProvider(profile)
                }

                Toast.makeText(this, R.string.ai_provider_saved, Toast.LENGTH_SHORT).show()
                refreshProviderList()
            }
            .setNegativeButton(R.string.ai_cancel, null)
            .show()
    }

    private fun getFormatDisplayName(formatType: String): String {
        return when (formatType) {
            "claude" -> getString(R.string.ai_format_claude)
            "gemini" -> getString(R.string.ai_format_gemini)
            else -> getString(R.string.ai_format_openai)
        }
    }

    // ========================= System Prompt =========================

    private fun initSystemPrompt() {
        val ztUserBean = UserSetManage.get().getZTUserBean()
        val customPrompt = ztUserBean.customSystemPrompt
        if (!customPrompt.isNullOrEmpty()) {
            mSystemPromptEdit.setText(customPrompt)
        } else {
            mSystemPromptEdit.setText(UUtils.getString(R.string.deepseek_zs))
        }

        mSystemPromptEdit.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                val bean = UserSetManage.get().getZTUserBean()
                bean.customSystemPrompt = s?.toString() ?: ""
                UserSetManage.get().setZTUserBean(bean)
            }
        })
    }

    // ========================= Utils =========================

    private fun getKeyClickText(keyword: String, text: String, clickableSpan: ClickableSpan) :SpannableString {
        val spannableString = SpannableString(text)
        val startIndex = text.indexOf(keyword)
        val endIndex = startIndex + keyword.length

        if (startIndex != -1) {
            spannableString.setSpan(
                clickableSpan,
                startIndex,
                endIndex,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )

             spannableString.setSpan(ForegroundColorSpan(UUtils.getColor(R.color.color_48baf3)), startIndex, endIndex, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            return spannableString;
        }
        return spannableString;
    }

    private fun setSwitchStatus(switchCompat: SwitchCompat, linearLayout: LinearLayout) {
        linearLayout.setOnClickListener {
            switchCompat.isChecked = !(switchCompat.isChecked)
        }
        switchCompat.setOnCheckedChangeListener { buttonView, isChecked ->
            val ztUserBean = UserSetManage.get().getZTUserBean()
            when (switchCompat) {
                mAiVisibleSwitch -> {
                     ztUserBean.isIsCustomVisibleTerminal = switchCompat.isChecked
                 }

            }
            UserSetManage.get().setZTUserBean(ztUserBean)
        }
    }

}
