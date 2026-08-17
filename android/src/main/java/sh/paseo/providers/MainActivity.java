package sh.paseo.providers;

import android.app.Activity;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;

public final class MainActivity extends Activity {
  private static final String HOME_URL = "http://127.0.0.1:6767/";
  private WebView webView;
  private FrameLayout container;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    webView = new WebView(this);
    webView.setWebChromeClient(new WebChromeClient());
    webView.setWebViewClient(new ProviderWebViewClient());

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

    // Android 15 edge-to-edge can leave a target-35 WebView under the IME even
    // when ADJUST_RESIZE is requested. Resize the WebView itself so fixed web
    // layouts receive a genuinely smaller viewport.
    container = new FrameLayout(this);
    container.setFitsSystemWindows(false);
    container.addView(webView, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    container.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
      @Override
      public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
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
        final int insetPx = imeBottom;
        final float density = getResources().getDisplayMetrics().density;
        webView.post(new Runnable() {
          @Override
          public void run() {
            float insetCss = density > 0 ? insetPx / density : insetPx;
            String script = "(function(){var i=" + insetCss + ";window.__PASEO_NATIVE_KEYBOARD_INSET__=i;var h=Math.max(1,window.innerHeight||0);document.documentElement.style.setProperty('--paseo-viewport-height',h+'px');document.documentElement.style.setProperty('--paseo-keyboard-inset','0px');document.documentElement.classList.toggle('paseo-keyboard-open',i>80);window.dispatchEvent(new Event('resize'));})();";
            webView.evaluateJavascript(script, null);
          }
        });
        return insets;
      }
    });

    setContentView(container);
    webView.clearCache(true);
    webView.loadUrl(HOME_URL);
  }

  private boolean handleUrl(Uri uri) {
    if (!"paseo".equals(uri.getScheme()) || !"open".equals(uri.getHost())) {
      return false;
    }

    webView.loadUrl(HOME_URL);
    return true;
  }

  @Override
  public void onBackPressed() {
    if (webView != null && webView.canGoBack()) {
      webView.goBack();
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
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

  private final class ProviderWebViewClient extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
      return handleUrl(Uri.parse(url));
    }

    @Override
    public void onPageFinished(WebView view, String url) {
      super.onPageFinished(view, url);
      if (container != null) container.requestApplyInsets();
    }
  }
}
