package com.termux.zerocore.ai.llm;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.Spinner;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.example.xh_lib.utils.LogUtils;
import com.example.xh_lib.utils.UUtils;
import com.termux.R;
import com.termux.zerocore.ai.llm.data.ChatDatabaseHelper;
import com.termux.zerocore.ai.llm.data.ChatMessage;
import com.termux.zerocore.ai.llm.data.ChatMessageAdapter;
import com.termux.zerocore.ai.llm.data.ChatSession;
import com.termux.zerocore.ai.llm.model.Config;
import com.termux.zerocore.ai.llm.model.RequestMessageItem;
import com.termux.zerocore.ai.model.AIClient;
import com.termux.zerocore.ai.model.ProviderProfile;
import com.termux.zerocore.ai.provider.AIProvider;
import com.termux.zerocore.ftp.utils.UserSetManage;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

public class ChatFragment extends Fragment {
    private static final String TAG = ChatFragment.class.getSimpleName();
    private RecyclerView chatRecyclerView;
    private ImageView mCancel;
    private EditText messageInput;
    private TextView sendButton;
    private ChatSession currentSession;
    private View mView;
    private Intent mIntent;

    private AIClient aiClient = new AIClient();
    private AIProvider currentProvider;
    private ProviderProfile currentProfile;
    private List<ProviderProfile> providerList = new ArrayList<>();
    private Spinner providerSpinner;
    private List<RequestMessageItem> requestMessageItemList = new ArrayList<>();
    private static ChatFragment chatFragment;

    private TextView testText;

    private ChatDatabaseHelper dbHelper;
    private List<ChatMessage> messages = new ArrayList<>();
    private ChatMessageAdapter adapter;
    private LLMTransitFragment mLlmTransitFragment;

    private String sessionId;

    private boolean newMsg = true;

    private boolean createS = false;

    public static ChatFragment newInstance() {
        if (chatFragment == null) {
            synchronized (ChatFragment.class) {
                if (chatFragment == null) {
                    chatFragment = new ChatFragment();
                }
                return chatFragment;
            }
        } else {
            return chatFragment;
        }
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        mView = View.inflate(getContext(), R.layout.activity_chat_custom, null);
        initView();
        return mView;
    }

    public void setIntent(Intent intent) {
        this.mIntent = intent;
    }

    public void setLlmTransitFragment(LLMTransitFragment llmTransitFragment) {
        mLlmTransitFragment = llmTransitFragment;
    }

    private void initView() {
        dbHelper = new ChatDatabaseHelper(getContext());
        chatRecyclerView = mView.findViewById(R.id.chatRecyclerView);
        mCancel = mView.findViewById(R.id.cancel);
        messageInput = mView.findViewById(R.id.messageInput);
        sendButton = mView.findViewById(R.id.sendButton);
        testText = mView.findViewById(R.id.testText);
        providerSpinner = mView.findViewById(R.id.provider_spinner);

        if (mIntent == null) {
            LogUtils.e(TAG, "initView intent is null return.");
            return;
        }

        // Clear state from previous session to prevent leakage
        requestMessageItemList.clear();
        messages.clear();
        mText.setLength(0);
        newMsg = true;

        boolean isNew = mIntent.getBooleanExtra("isNew", false);
        if (isNew) {
            createS = true;
            sessionId = UUID.randomUUID().toString();
        } else {
            sessionId = mIntent.getStringExtra("sessionId");
            messages.addAll(dbHelper.getMessagesForSession(sessionId));
            restoreRequestMessagesFromHistory();
        }
        loadCurrentProvider();
        initProviderSpinner();
        mCancel.setOnClickListener(view -> {
            mLlmTransitFragment.switchFragment(0, null);
            messages.clear();
        });
        chatRecyclerView.setLayoutManager(new LinearLayoutManager(getContext()));
        adapter = new ChatMessageAdapter(getContext(), messages);
        chatRecyclerView.setLayoutManager(new LinearLayoutManager(getContext()));
        chatRecyclerView.setAdapter(adapter);

        sendButton.setOnClickListener(v -> sendMessage());
        scrollToBottom();
    }

    private void sendMessage() {
        hideSoftInput(messageInput);
        String message = messageInput.getText().toString();
        if (!message.isEmpty()) {
            up(message);

            dbHelper.insertMessage(sessionId, message, true, System.currentTimeMillis(), 0);
            messages.add(new ChatMessage(message, true, System.currentTimeMillis(), 0));
            adapter.notifyDataSetChanged();
            adapter.notifyItemInserted(messages.size() - 1);
            messageInput.setText("");
            creareS(message);
        }
        scrollToBottom();
    }

    // 新增滚动到底部的方法
    private void scrollToBottom() {
        if (chatRecyclerView != null && adapter != null) {
            // 使用 post 确保在 UI 线程执行，并且在布局更新后执行
            chatRecyclerView.post(() -> {
                if (adapter.getItemCount() > 0) {
                    chatRecyclerView.scrollToPosition(adapter.getItemCount() - 1);
                }
            });
        }
    }

    private void hideSoftInput(EditText editText) {
        if (editText == null)
            return;
        InputMethodManager inputMethodManager = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (inputMethodManager == null)
            return;
        editText.clearFocus();
        inputMethodManager.hideSoftInputFromWindow(editText.getWindowToken(), 0);
    }

    private void creareS(String name) {
        if (createS) {
            long providerId = currentProfile != null ? currentProfile.getId() : 0;
            currentSession = new ChatSession(sessionId, name, System.currentTimeMillis(), providerId);
            dbHelper.insertSession(currentSession.getSessionId(), currentSession.getSessionName(), providerId);
        }
        createS = false;
    }

    private void up(String message) {
        testText.setText("");
        sendButton.setText("...");
        mCancel.setVisibility(View.GONE);
        sendButton.setEnabled(false);
        providerSpinner.setEnabled(false);
        reqModel(message);
    }

    StringBuilder mText = new StringBuilder();

    private void reqModel(String text) {
        // Clear mText at start to prevent stale data from previous errors
        mText.setLength(0);

        requestMessageItemList.add(new RequestMessageItem(RequestMessageItem.ROLE_USER, text));

        // System prompt is passed separately — providers place it per their API requirements
        String systemPrompt = getPrompt();
        Log.e(TAG, "reqModel systemPrompt: " + systemPrompt);
        aiClient.ask(currentProvider, currentProfile, requestMessageItemList, systemPrompt,
            new AIClient.Listener() {
                @Override
                public void onError(String errorMessage) {
                    LogUtils.e(TAG, "AI request error: " + errorMessage);
                    mText.setLength(0);
                    UUtils.runOnUIThread(() -> {
                        localProcessingMessage(errorMessage, true);
                        newMsg = true;
                    });
                }

                @Override
                public void onMessage(String content) {
                    LogUtils.e(TAG, "onMessage content: " + content);
                    mText.append(content);
                    UUtils.runOnUIThread(() -> {
                        LogUtils.e(TAG, "onMessage mText: " + mText);
                        localProcessingMessage(content, false);
                    });
                }

                @Override
                public void onComplete() {
                    input();
                    LogUtils.e(TAG, "onComplete mText: " + mText);
                    if (mText.length() > 0) {
                        UUtils.runOnUIThread(() -> {
                            String msg = mText.toString();
                            LogUtils.e(TAG, "onComplete insertMessage sessionId: " + sessionId + " ,msg: " + msg);
                            dbHelper.insertMessage(sessionId, msg, false, System.currentTimeMillis(), 1);
                            requestMessageItemList.add(new RequestMessageItem(RequestMessageItem.ROLE_ASSISTANT, msg));
                            mText.delete(0, mText.length());
                            newMsg = true;
                        });
                    }
                }
            });
    }

    private void restoreRequestMessagesFromHistory() {
        for (ChatMessage message : messages) {
            requestMessageItemList.add(new RequestMessageItem(
                message.isUser() ? RequestMessageItem.ROLE_USER : RequestMessageItem.ROLE_ASSISTANT,
                message.getMessageText()));
        }
    }


    private void input() {
        UUtils.runOnUIThread(() -> {
            sendButton.setText("send");
            mCancel.setVisibility(View.VISIBLE);
            sendButton.setEnabled(true);
            providerSpinner.setEnabled(true);
        });
    }

    private void updateM(String msg, boolean isError) {
        LogUtils.e(TAG, "updateM newMsg: " + newMsg
            + " ,isError: " + isError
            + " ,msg: " + msg
        );
        if (newMsg || isError) {
            messages.add(new ChatMessage(msg, false, System.currentTimeMillis(), 1));
            adapter.notifyItemInserted(messages.size() - 1);
            newMsg = false;
        } else {
            adapter.updateMessageText(messages.size() - 1, msg);
            scrollToBottom();
        }
    }

    private void localProcessingMessage(String msg, boolean isError) {
        updateM(msg, isError);
    }

    private void initProviderSpinner() {
        providerList.clear();
        providerList.addAll(dbHelper.getAllProviders());

        List<String> providerNames = new ArrayList<>();
        for (ProviderProfile p : providerList) {
            providerNames.add(p.getName());
        }

        ArrayAdapter<String> spinnerAdapter = new ArrayAdapter<>(
            getContext(), R.layout.simple_spinner_item, providerNames);
        spinnerAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        providerSpinner.setAdapter(spinnerAdapter);

        int selectedIndex = 0;
        for (int i = 0; i < providerList.size(); i++) {
            ProviderProfile provider = providerList.get(i);
            if (currentProfile != null && provider.getId() == currentProfile.getId()) {
                selectedIndex = i;
                break;
            }
            if (currentProfile == null && provider.isDefault()) {
                selectedIndex = i;
            }
        }
        if (!providerList.isEmpty()) {
            providerSpinner.setSelection(selectedIndex);
        }

        providerSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            private boolean ignoreInitialSelection = true;

            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (ignoreInitialSelection) {
                    ignoreInitialSelection = false;
                    if (currentProfile == null || position < 0 || position >= providerList.size()
                        || providerList.get(position).getId() == currentProfile.getId()) {
                        return;
                    }
                }
                if (position >= 0 && position < providerList.size()) {
                    currentProfile = providerList.get(position);
                    currentProvider = AIClient.getProvider(currentProfile.getFormatType());
                    // Clear conversation context when switching providers
                    requestMessageItemList.clear();
                    mText.setLength(0);
                    newMsg = true;
                    // Update session provider
                    if (sessionId != null) {
                        dbHelper.updateSessionProvider(sessionId, currentProfile.getId());
                    }
                }
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}

        });
    }

    private void loadCurrentProvider() {
        currentProfile = null;
        if (sessionId != null) {
            ChatSession session = dbHelper.getSessionById(sessionId);
            if (session != null && session.getProviderId() > 0) {
                currentProfile = dbHelper.getProviderById(session.getProviderId());
            }
        }
        if (currentProfile == null) {
            currentProfile = dbHelper.getDefaultProvider();
        }
        if (currentProfile != null) {
            currentProvider = AIClient.getProvider(currentProfile.getFormatType());
        } else {
            // Fallback: use OpenAI-compatible with DeepSeek defaults
            currentProvider = AIClient.getProvider("openai");
            currentProfile = new ProviderProfile(0, "DeepSeek", "openai",
                "https://api.deepseek.com/chat/completions",
                UserSetManage.Companion.get().getZTUserBean().getCustomApiKey(),
                "deepseek-chat", true);
        }
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        mLlmTransitFragment = null;
        if (adapter != null) {
            adapter.release();
        }
        chatFragment = null;
    }

    // 获取终端助手提示语
    private String getPrompt() {
        boolean isLlmVisibleTerminal = UserSetManage.Companion.get().getZTUserBean().isIsCustomVisibleTerminal();
        String customPrompt = UserSetManage.Companion.get().getZTUserBean().getCustomSystemPrompt();
        String basePrompt;
        if (customPrompt != null && !customPrompt.isEmpty()) {
            basePrompt = customPrompt;
        } else {
            basePrompt = UUtils.getString(R.string.ai_custom_prompt);
        }

        if (isLlmVisibleTerminal) {
            String terminalCommands = com.termux.zerocore.utils.SingletonCommunicationUtils.getInstance().getmSingletonCommunicationListener().getTextToTerminal()
                .replace("$", "")
                .replace("~", "")
                .replace("\n", "")
                .trim();
            if (terminalCommands.length() > Config.MAX_VISIBLE) {
                terminalCommands = terminalCommands.substring(terminalCommands.length() - Config.MAX_VISIBLE);
            }
            LogUtils.e(TAG, "getPrompt: " + terminalCommands);
            return basePrompt + " " +  UUtils.getString(R.string.ai_custom_command) + terminalCommands;
        } else {
            return basePrompt;
        }
    }
}
