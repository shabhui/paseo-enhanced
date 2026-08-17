package com.termux.zerocore.ai.llm;

import android.content.Intent;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.termux.R;

import com.termux.zerocore.ai.llm.data.ChatDatabaseHelper;
import com.termux.zerocore.ai.llm.data.ChatSession;
import com.termux.zerocore.ai.llm.data.ChatSessionAdapter;
import com.termux.zerocore.llm.activity.ZeroTermuxLLMSettingsActivity;


import java.util.List;

public class LLMMainFragment extends Fragment {
    private static LLMMainFragment llmMainFragment;
    private RecyclerView mRecyclerView;
    private ChatSessionAdapter adapter;
    private ChatDatabaseHelper dbHelper;
    private View mView;
    private TextView mChatEmpty;
    private ImageView mAddImageView;
    private ImageView mSettingsImageView;
    private LLMTransitFragment mLlmTransitFragment;

    public static LLMMainFragment newInstance() {
        if (llmMainFragment == null) {
            synchronized (LLMMainFragment.class) {
                if (llmMainFragment == null) {
                    llmMainFragment = new LLMMainFragment();
                }
                return llmMainFragment;
            }
        } else {
            return llmMainFragment;
        }
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        mView = View.inflate(getContext(), R.layout.fragment_llm_main, null);
        initView();
        return mView;
    }

    private void initView() {
        dbHelper = new ChatDatabaseHelper(getContext());
        mRecyclerView = mView.findViewById(R.id.recyclerView);
        mChatEmpty = mView.findViewById(R.id.chat_empty);
        mAddImageView = mView.findViewById(R.id.add_img);
        mSettingsImageView = mView.findViewById(R.id.settings_img);
        mRecyclerView.setLayoutManager(new LinearLayoutManager(getContext()));
        mAddImageView.setOnClickListener(v -> startNewChat());
        List<ChatSession> allSessions = dbHelper.getAllSessions();
        if (allSessions == null || allSessions.isEmpty()) {
            mChatEmpty.setVisibility(View.VISIBLE);
            mRecyclerView.setVisibility(View.GONE);
        } else {
            mChatEmpty.setVisibility(View.GONE);
            mRecyclerView.setVisibility(View.VISIBLE);
        }
        mSettingsImageView.setOnClickListener(view -> {
            getContext().startActivity(new Intent(getContext(), ZeroTermuxLLMSettingsActivity.class));
        });
    }

    public void setLlmTransitFragment(LLMTransitFragment llmTransitFragment) {
        mLlmTransitFragment = llmTransitFragment;
    }

    private void startNewChat() {
        Intent intent = new Intent();
        intent.putExtra("isNew", true);
        intent.putExtra("createdAt", System.currentTimeMillis()); // 添加当前时间戳
        mLlmTransitFragment.switchFragment(1, intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        adapter = new ChatSessionAdapter(getContext(), dbHelper.getAllSessions(), mLlmTransitFragment);
        mRecyclerView.setAdapter(adapter);
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        mLlmTransitFragment = null;
        if (adapter != null) {
            adapter.release();
        }
        llmMainFragment = null;
    }
}
