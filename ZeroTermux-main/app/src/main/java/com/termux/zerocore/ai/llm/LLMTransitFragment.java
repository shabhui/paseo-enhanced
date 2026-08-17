package com.termux.zerocore.ai.llm;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.fragment.app.FragmentTransaction;

import com.example.xh_lib.utils.LogUtils;
import com.termux.R;

public class LLMTransitFragment extends Fragment {
    private static final String TAG = LLMTransitFragment.class.getSimpleName();
    private View mView;
    private FrameLayout mFrameLayout;
    private static LLMTransitFragment llmTransitFragment;

    public static LLMTransitFragment newInstance() {
        if (llmTransitFragment == null) {
            synchronized (LLMTransitFragment.class) {
                if (llmTransitFragment == null) {
                    llmTransitFragment = new LLMTransitFragment();
                }
                return llmTransitFragment;
            }
        } else {
            return llmTransitFragment;
        }
    }

    @Override
    public void onAttach(@NonNull Context context) {
        super.onAttach(context);
        LogUtils.e(TAG, "onAttach...");
        switchFragment(0, null);
    }

    @Override
    public void onResume() {
        super.onResume();
        LogUtils.e(TAG, "onResume...");
    }

    @Override
    public void onStart() {
        super.onStart();
        LogUtils.e(TAG, "onStart...");
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        mView = View.inflate(getContext(), R.layout.fragment_transit_llm, null);
        initView();
        return mView;
    }

    private void initView() {
        mFrameLayout = mView.findViewById(R.id.frame_layout);
    }

    public void switchFragment(int index, Intent intent) {
        FragmentTransaction fragmentTransaction = this.getChildFragmentManager().beginTransaction();
        switch (index) {
            case 0:
                LLMMainFragment llmMainFragment = LLMMainFragment.newInstance();
                llmMainFragment.setLlmTransitFragment(this);
                fragmentTransaction.replace(R.id.frame_layout, llmMainFragment, "LLMMainFragment")
                    .commitAllowingStateLoss();
                break;
            case 1:
                ChatFragment chatFragment = ChatFragment.newInstance();
                chatFragment.setIntent(intent);
                chatFragment.setLlmTransitFragment(this);
                fragmentTransaction.replace(R.id.frame_layout, chatFragment, "ChatFragment")
                    .commitAllowingStateLoss();
                break;
        }
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        llmTransitFragment = null;
    }
}
