'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Import before app readiness so the crx: scheme can be registered as privileged.
const { ElectronChromeExtensions } = require('electron-chrome-extensions');

function extensionURL(value, ses, ownerID = '') {
  let url;
  try { url = new URL(value || 'about:blank', ownerID ? `chrome-extension://${ownerID}/` : undefined); } catch { throw new Error('扩展不能打开这个地址'); }
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.href === 'about:blank') return url.href;
  if (url.protocol === 'chrome-extension:' && url.hostname === ownerID && ses.extensions.getExtension(ownerID)) return url.href;
  throw new Error('扩展只能打开网页或自己的页面');
}

function createExtensionHost({ userData, ses, isShell, attachWindow, ...impl }) {
  const bridge = new ElectronChromeExtensions({ ...impl, session: ses, requestPermissions: async () => false });
  const router = bridge.ctx.router, dispatch = router.onExtensionMessage.bind(router);
  const wake = async extensionID => {
    const extension = extensionID && ses.extensions.getExtension(extensionID);
    const manifest = extension?.manifest || {};
    if (!extension || manifest.action?.default_popup || manifest.browser_action?.default_popup || !manifest.background?.service_worker) return;
    await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${extensionID}/`).catch(() => {});
    const listening = () => (router.listeners.get('browserAction.onClicked') || []).some(listener => listener.extensionId === extensionID);
    for (let i = 0; i < 40 && !listening(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  };
  const shellMethods = new Set(['browserAction.getState', 'browserAction.activate', 'browserAction.addObserver', 'browserAction.removeObserver']);
  router.onExtensionMessage = async (event, extensionID, method, ...args) => {
    if (shellMethods.has(method)) {
      if (!isShell(event)) throw new Error('未授权的扩展工具栏请求');
      // MV3 后台会休眠；点击前等它真正注册好 onClicked，否则事件打在空气里。
      // remote 调用（壳层图标）不带 extensionID，id 在载荷里。
      if (method === 'browserAction.activate') await wake(args[0]?.extensionId);
    } else {
      const senderSession = event.type === 'service-worker' ? event.session : event.sender.session;
      const senderURL = event.type === 'service-worker' ? event.serviceWorker.scope : event.senderFrame?.url;
      let url; try { url = new URL(senderURL); } catch { throw new Error('未授权的扩展请求'); }
      if (senderSession !== ses || url.protocol !== 'chrome-extension:' || url.hostname !== extensionID || !ses.extensions.getExtension(extensionID)) throw new Error('未授权的扩展请求');
      if (/^runtime\.(connectNative|sendNativeMessage|disconnectNative)$/.test(method)) throw new Error('Arco 不允许扩展启动原生应用');
      if (['tabs.create', 'tabs.update', 'windows.create'].includes(method)) {
        const index = args.findIndex(value => value && typeof value === 'object' && 'url' in value);
        if (index >= 0) {
          const details = { ...args[index], __arcoExtensionID: extensionID };
          for (const target of [].concat(details.url || [])) extensionURL(target, ses, extensionID);
          args[index] = details;
        }
      }
      if (method === 'windows.create') {
        const popupSession = event.type === 'service-worker' ? event.session : event.sender.session;
        if (popupSession !== ses || !extensionID || !ses.extensions.getExtension(extensionID)) throw new Error('不允许打开未验证的扩展弹窗');
      }
    }
    return dispatch(event, extensionID, method, ...args);
  };

  const shellPreload = path.join(userData, 'ExtensionShellPreload.cjs');
  const actionPreload = fs.readFileSync(require.resolve('electron-chrome-extensions/browser-action'), 'utf8');
  const appPreload = fs.readFileSync(path.join(__dirname, 'shell-preload.js'), 'utf8');
  fs.writeFileSync(shellPreload, `${actionPreload}\n;module.exports.injectBrowserAction();\n${appPreload}`, { mode: 0o600 });
  // The web component lives in the shell's default session and fetches icons from the extension session.
  ElectronChromeExtensions.handleCRXProtocol(ses);
  ElectronChromeExtensions.handleCRXProtocol(require('electron').session.defaultSession);

  const ownedWindows = new Map();
  const ownWindow = (window, extensionID) => {
    if (!window || !extensionID) return;
    ownedWindows.set(window, extensionID);
    window.once('closed', () => ownedWindows.delete(window));
  };
  bridge.on('browser-action-popup-created', popup => attachWindow(popup.browserWindow, popup.extensionId, false));
  ses.extensions.on('extension-unloaded', (_event, extension) => {
    for (const [window, id] of ownedWindows) if (id === extension.id && !window.isDestroyed()) window.close();
  });

  return {
    shellPreload,
    url(value, ownerID = '') { return extensionURL(value, ses, ownerID); },
    track(wc, win) { bridge.addTab(wc, win); },
    select(wc) { bridge.selectTab(wc); },
    contextMenu(wc, params) { return bridge.getContextMenuItems(wc, params); },
    ownWindow,
    async click(win, id, anchor) {
      if (win.private) throw new Error('无痕窗口不能打开扩展');
      const extension = ses.extensions.getExtension(id);
      if (!extension) throw new Error('这个扩展没有启用');
      const tab = win.tabs.get(win.activeID);
      if (!tab || tab.view.webContents.isDestroyed()) throw new Error('请先打开一个网页标签页');
      bridge.selectTab(tab.view.webContents);
      const details = { eventType: 'click', extensionId: id, tabId: tab.view.webContents.id, anchorRect: anchor, alignment: 'bottom left' };
      await win.shell.webContents.executeJavaScript(`window.browserAction.activate('persist:arco', ${JSON.stringify(details)})`, true);
    },
  };
}
module.exports = { createExtensionHost, extensionURL };
