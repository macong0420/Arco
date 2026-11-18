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

function createExtensionHost({ userData, ses, isShell, attachWindow, resolveDebuggerTarget, openSidePanel, closeSidePanel, windowFor, report, ...impl }) {
  const bridge = new ElectronChromeExtensions({ ...impl, session: ses, requestPermissions: async () => false });
  const preloadPath = require.resolve('electron-chrome-extensions/preload');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const additions = `
      if ((manifest.permissions || []).includes('debugger')) Object.defineProperty(chrome, 'debugger', { enumerable: true, configurable: true, value: { attach: invokeExtension2('debugger.attach'), detach: invokeExtension2('debugger.detach'), sendCommand: invokeExtension2('debugger.sendCommand'), onEvent: new ExtensionEvent('debugger.onEvent'), onDetach: new ExtensionEvent('debugger.onDetach') } });
      if ((manifest.permissions || []).includes('sidePanel')) Object.defineProperty(chrome, 'sidePanel', { enumerable: true, configurable: true, value: { setPanelBehavior: invokeExtension2('sidePanel.setPanelBehavior'), setOptions: invokeExtension2('sidePanel.setOptions'), getOptions: invokeExtension2('sidePanel.getOptions'), open: invokeExtension2('sidePanel.open') } });
      Object.defineProperty(chrome, 'management', { enumerable: true, configurable: true, value: { ...chrome.management, getSelf: async () => ({ id: extensionId, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, installType: 'normal', enabled: true }) } });
      Object.freeze(chrome);`;
  if (!preload.includes('      Object.freeze(chrome);')) throw new Error('无法初始化扩展兼容 API');
  const compatPreload = path.join(userData, 'ExtensionCompatPreload.cjs');
  fs.writeFileSync(compatPreload, preload.replace('      Object.freeze(chrome);', additions), { mode: 0o600 });
  ses.unregisterPreloadScript?.('crx-mv2-preload'); ses.unregisterPreloadScript?.('crx-mv3-preload');
  if (ses.registerPreloadScript) {
    ses.registerPreloadScript({ id: 'crx-mv2-preload', type: 'frame', filePath: compatPreload });
    ses.registerPreloadScript({ id: 'crx-mv3-preload', type: 'service-worker', filePath: compatPreload });
  } else ses.setPreloads([...ses.getPreloads().filter(file => file !== preloadPath), compatPreload]);
  const router = bridge.ctx.router, dispatch = router.onExtensionMessage.bind(router);
  const sidePanelBehavior = new Map(), sidePanelOptions = new Map(), debuggerAttachments = new Map();
  // 没有弹窗、没有侧栏的扩展，点图标后唯一的变化是它自己改标题或角标；工具栏又藏在会关掉的扩展面板里，
  // 所以把这次变化转成一条提示，否则用户看不出点击是否生效。
  const clickReports = new Map();
  const finishClick = (extensionID, message) => {
    const click = clickReports.get(extensionID);
    if (!click) return;
    clickReports.delete(extensionID);
    clearTimeout(click.timer);
    if (message) report?.(click.win, message);
  };
  const noteClick = (win, extensionID, name) => {
    const previous = clickReports.get(extensionID);
    if (previous) clearTimeout(previous.timer);
    clickReports.set(extensionID, { win, name, badge: '', timer: setTimeout(() => finishClick(extensionID, `已执行「${name}」的点击操作`), 1500) });
  };
  const noteAction = (extensionID, field, value) => {
    const click = clickReports.get(extensionID);
    if (!click) return;
    if (field === 'title' && typeof value === 'string' && value) return finishClick(extensionID, value);
    if (field === 'badge') {
      click.badge = typeof value === 'string' ? value : '';
      clearTimeout(click.timer);
      // 扩展通常先设角标再设标题；稍等片刻，让更有信息量的标题先到。
      click.timer = setTimeout(() => finishClick(extensionID, click.badge ? `「${click.name}」：${click.badge}` : `已执行「${click.name}」的点击操作`), 500);
    }
  };
  const requirePermission = (extension, permission) => {
    if (!extension.manifest.permissions?.includes(permission)) throw new Error(`扩展没有声明 ${permission} 权限`);
  };
  const panelOptions = (extension, tabID) => {
    const options = sidePanelOptions.get(extension.id);
    const specific = Number.isSafeInteger(tabID) ? options?.get(tabID) : null;
    const global = options?.get(0);
    const selected = specific || global || {};
    return { path: selected.path || extension.manifest.side_panel?.default_path || '', enabled: selected.enabled !== false };
  };
  const debuggerTarget = target => {
    const tabID = target?.tabId;
    if (!Number.isSafeInteger(tabID) || tabID < 1) throw new Error('只支持调试 Arco 管理的网页标签');
    const wc = resolveDebuggerTarget?.(tabID);
    if (!wc || wc.isDestroyed() || wc.session !== ses || !/^https?:$/.test(new URL(wc.getURL()).protocol)) throw new Error('调试目标不是可用的普通网页标签');
    return { tabID, wc };
  };
  const releaseDebugger = (wc, attachment, reason, notify = false) => {
    if (debuggerAttachments.get(wc) !== attachment) return;
    debuggerAttachments.delete(wc);
    wc.debugger.removeListener('message', attachment.onMessage);
    wc.debugger.removeListener('detach', attachment.onDetach);
    wc.removeListener('destroyed', attachment.onDestroyed);
    if (notify) router.sendEvent(attachment.extensionID, 'debugger.onDetach', { tabId: attachment.tabID }, reason || 'target_closed');
  };
  const debuggerMessage = (extension, method, args) => {
    requirePermission(extension, 'debugger');
    if (method === 'debugger.attach') {
      const { tabID, wc } = debuggerTarget(args[0]);
      if (debuggerAttachments.has(wc) || wc.debugger.isAttached()) throw new Error('调试目标已被另一个调试器占用');
      const version = args[1] === undefined ? '1.3' : args[1];
      if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) throw new Error('Chrome DevTools 协议版本无效');
      const attachment = { extensionID: extension.id, tabID };
      attachment.onMessage = (_event, command, params) => router.sendEvent(extension.id, 'debugger.onEvent', { tabId: tabID }, command, params || {});
      attachment.onDetach = (_event, reason) => releaseDebugger(wc, attachment, reason, true);
      attachment.onDestroyed = () => releaseDebugger(wc, attachment, 'target_closed');
      wc.debugger.on('message', attachment.onMessage); wc.debugger.on('detach', attachment.onDetach); wc.once('destroyed', attachment.onDestroyed);
      try { wc.debugger.attach(version); debuggerAttachments.set(wc, attachment); }
      catch (cause) { wc.debugger.removeListener('message', attachment.onMessage); wc.debugger.removeListener('detach', attachment.onDetach); wc.removeListener('destroyed', attachment.onDestroyed); throw cause; }
      return;
    }
    const { wc, tabID } = debuggerTarget(args[0]), attachment = debuggerAttachments.get(wc);
    if (!attachment || attachment.extensionID !== extension.id || !wc.debugger.isAttached()) throw new Error('此扩展没有附加到该标签');
    if (method === 'debugger.detach') { wc.debugger.detach(); return; }
    if (method === 'debugger.sendCommand') {
      const command = args[1], params = args[2] || {};
      if (typeof command !== 'string' || !/^[A-Za-z]+\.[A-Za-z][\w]*$/.test(command) || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('DevTools 命令无效');
      return wc.debugger.sendCommand(command, params);
    }
    throw new Error('不支持此 chrome.debugger 方法');
  };
  const sidePanelMessage = async (extension, method, args) => {
    requirePermission(extension, 'sidePanel');
    if (method === 'sidePanel.setPanelBehavior') {
      if (typeof args[0]?.openPanelOnActionClick !== 'boolean') throw new Error('sidePanel 行为无效');
      sidePanelBehavior.set(extension.id, args[0].openPanelOnActionClick);
      return;
    }
    if (method === 'sidePanel.setOptions') {
      const value = args[0];
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value.tabId !== undefined && !Number.isSafeInteger(value.tabId)) || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) throw new Error('sidePanel 选项无效');
      const options = sidePanelOptions.get(extension.id) || new Map(), key = value.tabId ?? 0, next = { ...options.get(key) };
      if (value.path !== undefined) {
        const url = new URL(extensionURL(value.path, ses, extension.id));
        if (url.protocol !== 'chrome-extension:' || url.hostname !== extension.id) throw new Error('扩展侧栏必须是此扩展自己的页面');
        next.path = value.path;
      }
      if (value.enabled !== undefined) next.enabled = value.enabled;
      options.set(key, next); sidePanelOptions.set(extension.id, options);
      if (!next.enabled) closeSidePanel?.(extension.id, value.tabId);
      return;
    }
    if (method === 'sidePanel.getOptions') return panelOptions(extension, args[0]?.tabId);
    if (method === 'sidePanel.open') {
      const details = args[0] || {}, selected = panelOptions(extension, details.tabId);
      if (!selected.enabled || !selected.path) throw new Error('此标签没有启用扩展侧栏');
      if (!openSidePanel) throw new Error('Arco 侧栏不可用');
      return openSidePanel(extension.id, details, selected.path, false);
    }
    throw new Error('不支持此 chrome.sidePanel 方法');
  };
  const wake = async extensionID => {
    const extension = extensionID && ses.extensions.getExtension(extensionID);
    const manifest = extension?.manifest || {};
    if (!extension || manifest.action?.default_popup || manifest.browser_action?.default_popup || !manifest.background?.service_worker) return;
    await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${extensionID}/`).catch(() => {});
    const listening = () => (router.listeners.get('browserAction.onClicked') || []).some(listener => listener.extensionId === extensionID);
    const ready = () => manifest.side_panel ? sidePanelBehavior.has(extensionID) : listening();
    for (let i = 0; i < 40 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  };
  const shellMethods = new Set(['browserAction.getState', 'browserAction.activate', 'browserAction.addObserver', 'browserAction.removeObserver']);
  router.onExtensionMessage = async (event, extensionID, method, ...args) => {
    if (shellMethods.has(method)) {
      if (!isShell(event)) throw new Error('未授权的扩展工具栏请求');
      if (method === 'browserAction.activate') {
        const details = args.find(value => value && typeof value === 'object' && typeof value.extensionId === 'string');
        const extension = details && ses.extensions.getExtension(details.extensionId);
        try {
          if (!extension) return await dispatch(event, extensionID, method, ...args);
          await wake(extension.id);
          if (sidePanelBehavior.get(extension.id) && extension.manifest.side_panel?.default_path && openSidePanel) {
            const selected = panelOptions(extension, details.tabId);
            if (selected.enabled) return await openSidePanel(extension.id, details, selected.path, true);
          }
          if (!bridge.api.browserAction.getPopupUrl(extension.id, details.tabId)) noteClick(windowFor?.(event), extension.id, extension.name || extension.id);
          return await dispatch(event, extensionID, method, ...args);
        } catch (error) {
          // 点击失败原来只写进主进程日志，界面上毫无动静。
          report?.(windowFor?.(event), error?.message || '扩展操作失败');
          return undefined;
        }
      }
    } else {
      const senderSession = event.type === 'service-worker' ? event.session : event.sender.session;
      const senderURL = event.type === 'service-worker' ? event.serviceWorker.scope : event.senderFrame?.url;
      let url; try { url = new URL(senderURL); } catch { throw new Error('未授权的扩展请求'); }
      const extension = extensionID && ses.extensions.getExtension(extensionID);
      if (senderSession !== ses || url.protocol !== 'chrome-extension:' || url.hostname !== extensionID || !extension) throw new Error('未授权的扩展请求');
      if (typeof method !== 'string') throw new Error('未授权的扩展请求');
      if (method === 'browserAction.setTitle') noteAction(extensionID, 'title', args[0]?.title);
      else if (method === 'browserAction.setBadgeText') noteAction(extensionID, 'badge', args[0]?.text);
      if (method.startsWith('debugger.')) return debuggerMessage(extension, method, args);
      if (method.startsWith('sidePanel.')) return sidePanelMessage(extension, method, args);
      if (method === 'management.getSelf') return { id: extension.id, name: extension.name || extension.manifest.name, version: extension.version || extension.manifest.version, installType: 'normal', enabled: true };
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
    sidePanelBehavior.delete(extension.id); sidePanelOptions.delete(extension.id);
    for (const [wc, attachment] of debuggerAttachments) if (attachment.extensionID === extension.id) {
      releaseDebugger(wc, attachment, 'extension_unloaded');
      if (!wc.isDestroyed() && wc.debugger.isAttached()) { try { wc.debugger.detach(); } catch {} }
    }
    closeSidePanel?.(extension.id);
    for (const [window, id] of ownedWindows) if (id === extension.id && !window.isDestroyed()) window.close();
  });

  return {
    shellPreload,
    url(value, ownerID = '') { return extensionURL(value, ses, ownerID); },
    track(wc, win) { bridge.addTab(wc, win); },
    select(wc) { bridge.selectTab(wc); },
    contextMenu(wc, params) { return bridge.getContextMenuItems(wc, params); },
    ownWindow,
    sidePanelReady(id) { return sidePanelBehavior.has(id); },
    async click(win, id, anchor) {
      if (win.private) throw new Error('无痕窗口不能打开扩展');
      const extension = ses.extensions.getExtension(id);
      if (!extension) throw new Error('这个扩展没有启用');
      const tab = win.tabs.get(win.activeID);
      if (!tab || tab.view.webContents.isDestroyed()) throw new Error('请先打开一个网页标签页');
      bridge.selectTab(tab.view.webContents);
      await wake(id);
      if (extension.manifest.side_panel?.default_path) {
        const selected = panelOptions(extension, tab.view.webContents.id);
        if (selected.enabled && openSidePanel) return openSidePanel(id, { windowId: win.id, tabId: tab.view.webContents.id }, selected.path, true);
      }
      const details = { eventType: 'click', extensionId: id, tabId: tab.view.webContents.id, anchorRect: anchor, alignment: 'bottom left' };
      await win.shell.webContents.executeJavaScript(`window.browserAction.activate('persist:arco', ${JSON.stringify(details)})`, true);
    },
  };
}
module.exports = { createExtensionHost, extensionURL };
