(function (global) {
  'use strict';

  /**
   * 大厅「安装 / 快捷方式」：优先系统 PWA 安装，否则下载 .url，并提示 iOS 添加主屏幕。
   */
  function createPwaInstall(options) {
    const opts = options || {};
    const button = opts.button || document.getElementById('pwaInstallBtn');
    const basePath = String(opts.basePath || '/inkmesh').replace(/\/$/, '') || '/inkmesh';
    const setStatus = typeof opts.setStatus === 'function' ? opts.setStatus : () => {};
    let deferredPrompt = null;

    /** 注册 Pages 根路径上的 service worker（本地 FastAPI 无此文件则跳过）。 */
    function registerServiceWorker() {
      if (!('serviceWorker' in navigator)) return;
      const swUrl = basePath + '/sw.js';
      navigator.serviceWorker.register(swUrl).catch(() => {});
    }

    /** 下载 Windows / 通用 Internet Shortcut（.url）。 */
    function downloadUrlShortcut() {
      const target = location.origin + basePath + '/';
      const body = '[InternetShortcut]\r\nURL=' + target + '\r\n';
      const blob = new Blob([body], { type: 'application/internet-shortcut' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'Inkmesh.url';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 0);
    }

    /** 点击：有 beforeinstallprompt 则安装，否则下载快捷方式并给出提示。 */
    async function onClick() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try {
          await deferredPrompt.userChoice;
        } catch (_err) {}
        deferredPrompt = null;
        setStatus('已请求安装 Inkmesh');
        return;
      }
      downloadUrlShortcut();
      const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isiOS) {
        setStatus('已下载快捷方式。iPhone/iPad：用 Safari 打开本页 → 分享 → 添加到主屏幕');
      } else {
        setStatus('已下载 Inkmesh.url；也可在浏览器菜单里选择「安装应用」或「创建快捷方式」');
      }
    }

    /** 绑定按钮与 install 事件。 */
    function bind() {
      registerServiceWorker();
      window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        deferredPrompt = event;
      });
      if (button) button.addEventListener('click', () => { onClick(); });
    }

    return { bind, downloadUrlShortcut };
  }

  global.createPwaInstall = createPwaInstall;
})(window);
