package com.termux.paseo;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.termux.R;
import com.termux.app.TermuxActivity;

public final class PaseoActivity extends Activity implements PaseoRuntimeController.Listener {
    private static final String HOME_URL = "http://127.0.0.1:6767/";
    private static final int FILE_CHOOSER_REQUEST = 6767;

    private PaseoRuntimeController runtimeController;
    private FrameLayout root;
    private LinearLayout startupPanel;
    private LinearLayout actions;
    private ProgressBar progress;
    private TextView status;
    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        setContentView(R.layout.activity_paseo);

        root = findViewById(R.id.paseo_root);
        startupPanel = findViewById(R.id.paseo_startup_panel);
        actions = findViewById(R.id.paseo_actions);
        progress = findViewById(R.id.paseo_progress);
        status = findViewById(R.id.paseo_status);
        webView = findViewById(R.id.paseo_webview);

        Button retry = findViewById(R.id.paseo_retry);
        retry.setOnClickListener(view -> {
            actions.setVisibility(View.GONE);
            progress.setVisibility(View.VISIBLE);
            runtimeController.retry();
        });
        Button terminal = findViewById(R.id.paseo_terminal);
        terminal.setOnClickListener(view -> {
            startActivity(new android.content.Intent(this, TermuxActivity.class));
        });

        configureWebView();
        runtimeController = new PaseoRuntimeController();
        runtimeController.start(this, this);
    }

    private void configureWebView() {
        webView.setWebChromeClient(new PaseoWebChromeClient());
        webView.setWebViewClient(new PaseoWebViewClient());
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

        root.setFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int imeBottom = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                imeBottom = ime.bottom;
            }
            int parentHeight = view.getHeight();
            if (parentHeight <= 0) parentHeight = view.getRootView().getHeight();
            ViewGroup.LayoutParams params = webView.getLayoutParams();
            int desiredHeight = imeBottom > 0 && parentHeight > imeBottom
                ? parentHeight - imeBottom : ViewGroup.LayoutParams.MATCH_PARENT;
            if (params.height != desiredHeight) {
                params.height = desiredHeight;
                webView.setLayoutParams(params);
            }
            return insets;
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;
        ValueCallback<Uri[]> callback = fileChooserCallback;
        fileChooserCallback = null;
        callback.onReceiveValue(PaseoFileChooser.parseResult(resultCode, data));
    }

    @Override
    public void onState(PaseoRuntimeState state) {
        runOnUiThread(() -> {
            status.setText(state.message());
            boolean ready = state.phase() == PaseoRuntimeState.Phase.READY;
            boolean error = state.phase() == PaseoRuntimeState.Phase.ERROR;
            if (ready) {
                startupPanel.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                webView.loadUrl(HOME_URL);
                return;
            }
            startupPanel.setVisibility(View.VISIBLE);
            webView.setVisibility(View.GONE);
            progress.setVisibility(error ? View.GONE : View.VISIBLE);
            actions.setVisibility(error ? View.VISIBLE : View.GONE);
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (runtimeController != null) runtimeController.stop();
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private final class PaseoWebChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
            WebView view,
            ValueCallback<Uri[]> callback,
            FileChooserParams params) {
            if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = callback;
            Intent chooser = PaseoFileChooser.createIntent(
                params == null ? null : params.getAcceptTypes(),
                params == null ? FileChooserParams.MODE_OPEN : params.getMode());
            try {
                startActivityForResult(Intent.createChooser(chooser, "Choose image or attachment"),
                    FILE_CHOOSER_REQUEST);
                return true;
            } catch (ActivityNotFoundException error) {
                fileChooserCallback = null;
                callback.onReceiveValue(null);
                return false;
            }
        }
    }

    private static final class PaseoWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(view, url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(view, request.getUrl().toString());
        }

        private boolean handleNavigation(WebView view, String url) {
            PaseoNavigationPolicy.Decision decision = PaseoNavigationPolicy.decide(url);
            if (decision == PaseoNavigationPolicy.Decision.ALLOW_LOCAL) return false;
            if (decision == PaseoNavigationPolicy.Decision.OPEN_HOME) {
                view.loadUrl(HOME_URL);
            }
            return true;
        }
    }
}
