package com.termux.zerocore.ai.llm;


import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

import com.termux.R;
import com.termux.zerocore.ai.llm.data.ChatDatabaseHelper;
import com.termux.zerocore.ai.llm.model.RequestMessageItem;
import com.termux.zerocore.ai.model.AIClient;
import com.termux.zerocore.ai.model.ProviderProfile;
import com.termux.zerocore.ai.provider.AIProvider;

import java.util.ArrayList;
import java.util.List;

public class TestActivity extends AppCompatActivity {
    private EditText messageInput;
    private Button sendButton;
    private ChatDatabaseHelper dbHelper;

    private AIClient aiClient = new AIClient();
    private List<RequestMessageItem> requestMessageItemList = new ArrayList<>();

    private TextView testText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_test);

        dbHelper = new ChatDatabaseHelper(this);

        messageInput = findViewById(R.id.messageInput);
        sendButton = findViewById(R.id.sendButton);
        testText = findViewById(R.id.testText);

        sendButton.setOnClickListener(v -> sendMessage());
    }

    private void sendMessage() {
        String message = messageInput.getText().toString();
        if (!message.isEmpty()) {
            testText.setText("");
            sendButton.setText("回答中...");
            sendButton.setEnabled(false);

            reqModel(message);
        }
    }

    private void reqModel(String text) {
        requestMessageItemList.add(new RequestMessageItem("user", text));

        ProviderProfile defaultProfile = dbHelper.getDefaultProvider();
        if (defaultProfile == null) {
            defaultProfile = new ProviderProfile(0, "DeepSeek", "openai",
                "https://api.deepseek.com/chat/completions", "", "deepseek-chat", true);
        }
        AIProvider provider = AIClient.getProvider(defaultProfile.getFormatType());

        aiClient.ask(provider, defaultProfile, requestMessageItemList, "", new AIClient.Listener() {
            @Override
            public void onError(String errorMessage) {
                runOnUiThread(() -> testText.append("\nError: " + errorMessage));
                resetInput();
            }

            @Override
            public void onMessage(String content) {
                runOnUiThread(() -> testText.append(content));
            }

            @Override
            public void onComplete() {
                resetInput();
            }
        });
    }

    private void resetInput() {
        runOnUiThread(() -> {
            sendButton.setText("发送");
            sendButton.setEnabled(true);
        });
    }
}
