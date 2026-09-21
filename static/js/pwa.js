/* Install-to-home-screen + offline awareness.
 *
 * Loaded as a plain script (not a module) before the app, so registration starts as
 * early as possible and nothing here can break the app if a browser lacks support.
 *
 * A service worker — and therefore every offline feature — only runs in a secure
 * context: https, or localhost. Over the LAN (http://10.7.x.x:8756) the browser
 * refuses to register one, so this script stays silent there and the app works
 * exactly as before.
 */
(function () {
  "use strict";

  const isSecure = location.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const narrow = () => window.matchMedia("(max-width: 768px)").matches;

  let deferredPrompt = null;
  let swReg = null;

  function toast(msg, type) {
    const wrap = document.getElementById("toast-wrap");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "toast " + (type || "");
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  /* ---------------------------------------------------------------- offline bar */
  function paintOffline(on) {
    let bar = document.getElementById("offline-bar");
    if (!on) { if (bar) bar.remove(); return; }
    if (bar || !document.body) return;
    bar = document.createElement("div");
    bar.id = "offline-bar";
    bar.textContent = "📴 离线模式：已看过的课程仍可复习；评分与 AI 需要联网";
    document.body.appendChild(bar);
  }
  window.addEventListener("offline", () => { paintOffline(true); });
  window.addEventListener("online", () => { paintOffline(false); toast("已恢复联网", "success"); });

  /* Every write in this app goes through fetch (grading a card, starring a question,
     saving notes). Offline those rejects are unavoidable — the change really was not
     saved — but they used to surface as unhandled rejections in the console with no
     explanation on screen. Say it once instead, so studying on a train is honest
     rather than mysteriously broken. */
  let offlineWarnAt = 0;
  window.addEventListener("unhandledrejection", (e) => {
    const msg = String((e.reason && (e.reason.message || e.reason)) || "");
    if (!navigator.onLine || /Failed to fetch|NetworkError|ERR_INTERNET_DISCONNECTED/i.test(msg)) {
      e.preventDefault();
      const now = Date.now();
      if (now - offlineWarnAt > 8000) {
        offlineWarnAt = now;
        toast("📴 离线：这次改动没有保存，联网后再操作一次", "warn");
      }
    }
  });

  /* ------------------------------------------------------------ install button */
  function installButton() {
    if (!deferredPrompt || standalone) return;
    if (document.getElementById("pwa-install")) return;
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    const btn = document.createElement("button");
    btn.id = "pwa-install";
    btn.className = "btn btn-sm btn-accent";
    btn.title = "把这个站装成应用：独立窗口、有自己的图标、离线也能看";
    btn.textContent = "📲 安装到桌面";
    btn.addEventListener("click", async () => {
      btn.remove();
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice.catch(() => ({ outcome: "dismissed" }));
      deferredPrompt = null;
      if (outcome === "accepted") toast("已安装 ✓ 之后从桌面图标打开", "success");
    });
    const footer = sidebar.querySelector(".sidebar-footer");
    if (footer) sidebar.insertBefore(btn, footer);
    else sidebar.appendChild(btn);
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    // On a phone Chrome shows its own install bar; hijacking it there just hides a
    // better-native affordance. On desktop nothing advertises it, so we add a button.
    if (narrow()) return;
    e.preventDefault();
    deferredPrompt = e;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installButton);
    else installButton();
  });
  window.addEventListener("appinstalled", () => {
    const b = document.getElementById("pwa-install");
    if (b) b.remove();
    toast("已安装到桌面 ✓", "success");
  });

  /* iOS has no install event at all: the only path is Share → Add to Home Screen,
     so say it once and remember that we said it. */
  function iosHint() {
    if (!isIOS || standalone) return;
    if (localStorage.getItem("mbbs_ios_install_hint") === "1") return;
    localStorage.setItem("mbbs_ios_install_hint", "1");
    toast("想装成 App：点分享 → 添加到主屏幕（离线也能看已学课程）", "warn");
  }

  /* ------------------------------------------------------------------ register */
  if (isSecure && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then((reg) => {
        swReg = reg;
        if (reg.waiting) reg.waiting.postMessage({ type: "skip-waiting" });
      }).catch(() => { /* private mode, disabled storage — the app still works */ });
    });
    setTimeout(iosHint, 2500);
    if (!navigator.onLine) paintOffline(true);
  } else if (isIOS && !standalone) {
    setTimeout(iosHint, 2500);
  }

  /* Small API for the app / settings: how much is cached, and how to clear it. */
  window.__pwa = {
    isSecure,
    standalone,
    installable: () => !!deferredPrompt,
    install: installButton,
    async offlineInfo() {
      const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.ready.catch(() => null));
      const target = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!target) return null;
      return await new Promise((resolve) => {
        const onMsg = (e) => {
          if (e.data && e.data.type === "offline-info") {
            navigator.serviceWorker.removeEventListener("message", onMsg);
            resolve({ lessons: e.data.lessons, bytes: e.data.bytes });
          }
        };
        navigator.serviceWorker.addEventListener("message", onMsg);
        target.postMessage({ type: "offline-info" });
        setTimeout(() => resolve(null), 2000);
      });
    },
    clearOffline() {
      const target = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (target) target.postMessage({ type: "clear-offline" });
    },
  };
})();
