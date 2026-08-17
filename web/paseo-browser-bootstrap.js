(function () {
  "use strict";

  if (window.__PASEO_BROWSER_BOOTSTRAP_LOADED__) return;
  window.__PASEO_BROWSER_BOOTSTRAP_LOADED__ = true;

  var SETTINGS_KEY = "@paseo:app-settings";
  var CHINESE_MARKER_KEY = "@paseo:zh-cn-enabled:v1";
  var QUEUE_SEND_MARKER_KEY = "@paseo:queue-send-enabled:v2";

  function enableChineseOnce() {
    document.documentElement.lang = "zh-CN";
    try {
      if (window.localStorage.getItem(CHINESE_MARKER_KEY) === "1") return;

      var raw = window.localStorage.getItem(SETTINGS_KEY);
      var settings = raw ? JSON.parse(raw) : {};
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        settings = {};
      }
      settings.language = "zh-CN";
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      window.localStorage.setItem(CHINESE_MARKER_KEY, "1");
    } catch (error) {
      console.warn("[Paseo] 无法写入中文界面设置", error);
    }
  }

  function enableQueueSendOnce() {
    try {
      if (window.localStorage.getItem(QUEUE_SEND_MARKER_KEY) === "1") return;

      var raw = window.localStorage.getItem(SETTINGS_KEY);
      var settings = raw ? JSON.parse(raw) : {};
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        settings = {};
      }
      settings.sendBehavior = "queue";
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      window.localStorage.setItem(QUEUE_SEND_MARKER_KEY, "1");
    } catch (error) {
      console.warn("[Paseo] 无法把 Enter 设置为消息排队", error);
    }
  }

  function installCompatibilityFixes() {
    if (typeof window.queueMicrotask !== "function") {
      window.queueMicrotask = function (callback) {
        Promise.resolve().then(callback).catch(function (error) {
          window.setTimeout(function () { throw error; }, 0);
        });
      };
    }

    if (typeof window.requestIdleCallback !== "function") {
      window.requestIdleCallback = function (callback) {
        return window.setTimeout(function () {
          callback({ didTimeout: false, timeRemaining: function () { return 0; } });
        }, 1);
      };
    }
    if (typeof window.cancelIdleCallback !== "function") {
      window.cancelIdleCallback = function (id) { window.clearTimeout(id); };
    }

    try {
      if (!navigator.languages || navigator.languages.length === 0) {
        Object.defineProperty(navigator, "languages", {
          configurable: true,
          get: function () { return [navigator.language || "zh-CN"]; }
        });
      }
    } catch (_) {
      // Some embedded browsers expose a non-configurable Navigator object.
    }

    try {
      if (window.MediaQueryList &&
          !window.MediaQueryList.prototype.addEventListener &&
          window.MediaQueryList.prototype.addListener) {
        window.MediaQueryList.prototype.addEventListener = function (_, listener) {
          this.addListener(listener);
        };
        window.MediaQueryList.prototype.removeEventListener = function (_, listener) {
          this.removeListener(listener);
        };
      }
    } catch (_) {
      // Older WebViews can make browser prototypes read-only.
    }

    try {
      if (window.crypto &&
          typeof window.crypto.randomUUID !== "function" &&
          typeof window.crypto.getRandomValues === "function") {
        window.crypto.randomUUID = function () {
          var bytes = new Uint8Array(16);
          window.crypto.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
          var hex = [];
          for (var index = 0; index < bytes.length; index += 1) {
            var value = bytes[index].toString(16);
            hex.push(value.length === 1 ? "0" + value : value);
          }
          return hex.slice(0, 4).join("") + "-" +
            hex.slice(4, 6).join("") + "-" +
            hex.slice(6, 8).join("") + "-" +
            hex.slice(8, 10).join("") + "-" +
            hex.slice(10).join("");
        };
      }
    } catch (_) {
      // Secure-context restrictions can make crypto properties read-only.
    }
  }

  function installBrowserStatus() {
    var root = null;
    var messageNode = null;
    var retryButton = null;
    var hideTimer = null;

    function ensureStatus() {
      if (root) return;

      var style = document.createElement("style");
      style.textContent = [
        "#paseo-browser-status{position:fixed;left:50%;top:calc(10px + env(safe-area-inset-top));z-index:2147483600;display:none;align-items:center;gap:10px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:9px 10px 9px 13px;transform:translateX(-50%);border:1px solid rgba(255,255,255,.16);border-radius:10px;background:rgba(30,34,32,.96);color:#f4f6f4;box-shadow:0 10px 32px rgba(0,0,0,.32);font:13px/18px system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif}",
        "#paseo-browser-status[data-open=true]{display:flex}",
        "#paseo-browser-status[data-kind=success]{border-color:rgba(54,162,105,.65)}",
        "#paseo-browser-status[data-kind=error]{border-color:rgba(225,107,100,.72)}",
        "#paseo-browser-retry{display:none;flex:none;padding:5px 9px;border:1px solid rgba(255,255,255,.24);border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}",
        "#paseo-browser-retry[data-open=true]{display:block}",
        "@media(prefers-color-scheme:light){#paseo-browser-status{border-color:rgba(24,32,27,.16);background:rgba(255,255,255,.97);color:#18201b;box-shadow:0 10px 32px rgba(24,32,27,.16)}#paseo-browser-retry{border-color:rgba(24,32,27,.22)}}"
      ].join("");
      document.head.appendChild(style);

      root = document.createElement("div");
      root.id = "paseo-browser-status";
      root.setAttribute("role", "status");
      root.setAttribute("aria-live", "polite");

      messageNode = document.createElement("span");
      retryButton = document.createElement("button");
      retryButton.id = "paseo-browser-retry";
      retryButton.type = "button";
      retryButton.textContent = "刷新";
      retryButton.addEventListener("click", function () { window.location.reload(); });

      root.appendChild(messageNode);
      root.appendChild(retryButton);
      document.body.appendChild(root);
    }

    function show(message, kind, canRetry, autoHideMs) {
      ensureStatus();
      if (hideTimer) window.clearTimeout(hideTimer);
      messageNode.textContent = message;
      root.dataset.kind = kind || "";
      root.dataset.open = "true";
      retryButton.dataset.open = canRetry ? "true" : "false";
      if (autoHideMs) {
        hideTimer = window.setTimeout(function () {
          root.dataset.open = "false";
        }, autoHideMs);
      }
    }

    window.__PASEO_BROWSER_SHOW__ = show;

    window.addEventListener("offline", function () {
      show("网络已断开，恢复后 Paseo 会自动重连。", "error", false, 0);
    });
    window.addEventListener("online", function () {
      show("网络已恢复，正在重新连接。", "success", false, 2200);
    });
    window.addEventListener("unhandledrejection", function (event) {
      var reason = event.reason;
      var message = reason && reason.message ? reason.message : String(reason || "");
      if (/websocket|network|failed to fetch|load failed|connection lost|transport not connected/i.test(message)) {
        show("连接暂时中断，Paseo 正在自动重连。", "error", true, 7000);
      }
    });
    window.addEventListener("error", function (event) {
      var target = event.target;
      if (!target || target === window) return;
      var tagName = target.tagName;
      if (tagName === "SCRIPT" || tagName === "LINK") {
        show("页面资源加载失败，请检查网络后刷新。", "error", true, 0);
      }
    }, true);

    if (navigator.onLine === false) {
      window.setTimeout(function () {
        show("网络已断开，恢复后 Paseo 会自动重连。", "error", false, 0);
      }, 0);
    }
  }

  function installConversationSync() {
    var lastSnapshot = null;
    var pending = false;
    async function poll() {
      if (pending || navigator.onLine === false) {
        window.setTimeout(poll, 12000);
        return;
      }
      pending = true;
      try {
        var response = await fetch("/api/paseo-manager?action=conversations", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error("状态同步失败");
        var payload = await response.json();
        var entries = Array.isArray(payload.conversations) ? payload.conversations : [];
        var snapshot = entries.map(function (item) { return [item.id, item.status || "unknown"].join("\u001f"); }).sort().join("\u001e");
        var changed = lastSnapshot !== null && snapshot !== lastSnapshot;
        lastSnapshot = snapshot;
        try { window.dispatchEvent(new CustomEvent("paseo:conversations-updated", { detail: payload })); } catch (_) {}
        if (changed && typeof window.__PASEO_BROWSER_SHOW__ === "function") {
          window.__PASEO_BROWSER_SHOW__("后台状态已同步", "success", false, 1800);
        }
      } catch (_) {
        // The existing online/offline and reconnect notices handle transient failures.
      } finally {
        pending = false;
        window.setTimeout(poll, 12000);
      }
    }
    window.setTimeout(poll, 12000);
  }

  function installKeyboardAvoidance() {
    var viewport = window.visualViewport;
    function sync() {
      var windowHeight = Number(window.innerHeight) || 0;
      var visualHeight = viewport && Number(viewport.height) || 0;
      var nativeInset = Number(window.__PASEO_NATIVE_KEYBOARD_INSET__) || 0;
      var height = visualHeight > 0 && windowHeight > 0
        ? Math.min(visualHeight, windowHeight)
        : (visualHeight || windowHeight);
      if (height > 0) {
        var inset = Math.max(0, windowHeight - height);
        document.documentElement.style.setProperty("--paseo-viewport-height", height + "px");
        document.documentElement.style.setProperty("--paseo-keyboard-inset", nativeInset > 0 ? "0px" : inset + "px");
        document.documentElement.classList.toggle("paseo-keyboard-open", nativeInset > 80 || inset > 80);
      }
    }
    if (viewport) {
      viewport.addEventListener("resize", sync);
      viewport.addEventListener("scroll", sync);
    }
    window.addEventListener("resize", sync);
    document.addEventListener("focusin", function (event) {
      var target = event.target;
      if (!target || !target.matches || !target.matches("input,textarea,select,[contenteditable=true]")) return;
      function reveal() {
        try { target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" }); } catch (_) { /* older WebView */ }
      }
      /* React Native Web often mounts the composer after focus; repeat after layout. */
      window.setTimeout(reveal, 60);
      window.setTimeout(reveal, 220);
      window.setTimeout(reveal, 480);
    }, true);
    sync();
  }

  enableChineseOnce();
  enableQueueSendOnce();
  installCompatibilityFixes();
  installKeyboardAvoidance();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { installBrowserStatus(); installConversationSync(); }, { once: true });
  } else {
    installBrowserStatus();
    installConversationSync();
  }
})();
