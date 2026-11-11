'use strict';
const { app, BaseWindow, BrowserWindow, WebContentsView, session, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('./core');
const Library = require('./library');
const browsers = require('./browsers');
const { createExtensionHost } = require('./extension-host');
const { EncryptedVault, MemoryVault } = require('./vault');
const { PasswordSync, mergeCredentials } = require('./password-sync');
const { pathToFileURL } = require('node:url');

const testMode = process.env.ARCO_TEST_MODE === '1' && !!process.env.ARCO_USER_DATA_DIR && !app.isPackaged;
if (testMode && process.env.ARCO_FAIL_BACKUP) {
  const copy = fs.copyFileSync, target = process.env.ARCO_FAIL_BACKUP;
  fs.copyFileSync = (source, ...args) => { if (String(source).endsWith(target)) throw new Error('disk unavailable'); return copy.call(fs, source, ...args); };
}
const userData = process.env.ARCO_USER_DATA_DIR ? path.resolve(process.env.ARCO_USER_DATA_DIR) : path.join(app.getPath('appData'), 'Arco');
if (process.platform !== 'darwin' && !testMode) { dialog.showErrorBox('Arco', '此版本仅支持 macOS。'); app.exit(1); }
app.setPath('userData', userData);
app.setName('Arco');
app.enableSandbox();
const windows = new Set();
let library, vault, passwordSync, extensionHost;
const normalSession = 'persist:arco';
const downloads = new Map();
const closedTabs = [];
let sessionReady = false;
let trackerCount = 0;
const ALLOWED_EXTERNAL = new Set(['mailto:', 'tel:', 'facetime:', 'maps:', 'xmpp:']);
const TRACKER_HOSTS = ['doubleclick.net', 'google-analytics.com', 'googletagmanager.com', 'googlesyndication.com', 'facebook.net', 'connect.facebook.net', 'adservice.google.com', 'scorecardresearch.com', 'hotjar.com', 'segment.io', 'criteo.com', 'criteo.net', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com', 'matomo.cloud'];
function matchesTracker(raw) { try { const host = new URL(raw).hostname; return TRACKER_HOSTS.some(rule => host === rule || host.endsWith('.' + rule)); } catch { return false; } }
function error(message) { throw new Error(typeof message === 'string' ? message : '操作失败'); }
function bounded(value, maximum = 8192) { if (typeof value !== 'string' || value.length > maximum) error('输入无效'); return value; }
function isHTTP(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
function sendState(win) { if (!win || win.isDestroyed() || win.shell.webContents.isDestroyed()) return; layout(win); win.shell.webContents.send('arco:state', serialize(win)); }
function broadcast() { for (const win of windows) sendState(win); }
function publicTab(tab) { const wc = tab.view.webContents; return { id: tab.id, webContentsID: wc.isDestroyed() ? -1 : wc.id, spaceID: tab.spaceID, url: tab.url, title: tab.title, favicon: tab.favicon, loading: !wc.isDestroyed() && wc.isLoading(), canBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(), canForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(), muted: !wc.isDestroyed() && wc.isAudioMuted(), playing: !wc.isDestroyed() && wc.isCurrentlyAudible(), pinned: tab.pinned, store: storeID(tab.url), zoom: !wc.isDestroyed() ? wc.getZoomFactor() : 1 }; }
function serialize(win) {
  return {
    private: win.private, chromium: process.versions.chrome, tabs: [...win.tabs.values()].map(publicTab), activeID: win.activeID, splitID: win.splitID, splitRatio: win.splitRatio,
    spaces: library.data.spaces.map(({ id, name, color, customColor }) => ({ id, name, color, customColor })), activeSpaceID: win.spaceID,
    favorites: library.data.favorites, folders: win.private ? [] : library.space(win.spaceID)?.folders || [], bookmarks: win.private ? [] : library.space(win.spaceID)?.bookmarks || [],
    allBookmarks: library.data.spaces.flatMap(s => s.bookmarks.map(b => ({ ...b, spaceID: s.id }))),
    settings: { ...library.settings, dataDirectory: userData }, history: win.private ? [] : (library.history || []), downloads: [...downloads.values()].filter(d => d.private ? d.windowID === win.id : !win.private).map(({ item, ...record }) => record), warning: library.warning,
    capture: win.capture ? { origin: win.capture.origin, username: win.capture.username } : null, peek: win.peek ? { url: win.peekURL, title: win.peek.webContents.getTitle() } : null,
    snapshots: win.snapshots || [], vault: vault.status(), passwordSyncUnlocked: passwordSync.unlocked, sidebarVisible: win.sidebarVisible, reader: win.reader, syncAvailable: false, testMode
  };
}
function loadSession() {
  return core.loadJSON(library.sessionFile, { version: 1, tabs: [], activeSpaceID: library.data.spaces[0].id, activeID: null, closed: [] }, value => {
    if (!value || value.version !== 1 || !Array.isArray(value.tabs) || !Array.isArray(value.closed)) throw new Error('会话格式不正确');
    for (const tab of value.tabs) if (!tab || typeof tab.id !== 'string' || typeof tab.spaceID !== 'string' || (tab.url !== '' && !isHTTP(tab.url))) throw new Error('会话标签页无效');
    return value;
  });
}
function saveSession() {
  if (!library || !sessionReady) return;
  const normalWindows = [...windows].filter(w => !w.private && !w.isDestroyed());
  const normal = normalWindows.find(w => w.isFocused()) || normalWindows[0];
  const tabs = normal ? normalWindows.flatMap(w => [...w.tabs.values()]).filter(t => !t.url || isHTTP(t.url)).map(t => ({ id: t.id, spaceID: t.spaceID, url: t.url, title: t.title, pinned: t.pinned })) : library.savedSession?.tabs || [];
  const data = { version: 1, tabs, activeSpaceID: normal?.spaceID || library.savedSession?.activeSpaceID, activeID: normal?.activeID || library.savedSession?.activeID, closed: closedTabs.slice(-30), activeBySpace: normal ? Object.fromEntries(normal.lastActive) : library.savedSession?.activeBySpace || {} };
  core.atomicWrite(library.sessionFile, data); library.savedSession = data;
}
function recordHistory(tab) {
  if (tab.window.private || !isHTTP(tab.url)) return;
  const entry = { id: core.id(), url: tab.url, title: tab.title, visitedAt: core.now() };
  library.history = [entry, ...(library.history || []).filter(x => x.url !== entry.url)].slice(0, 10000);
  core.atomicWrite(library.historyFile, library.history);
}
function setBounds(view, bounds) { view.setBounds(Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.max(0, Math.round(value))]))); }
function layout(win) {
  if (win.isDestroyed()) return;
  const [width, height] = win.getContentSize(), side = win.sidebarVisible ? win.sidebarWidth : 0;
  const inset = library.settings.frameInset ? 8 : 0, gap = 8, y = 40 + inset + (win.overlay === 'find' ? 48 : 0);
  const available = Math.max(0, width - side - inset * 2), first = win.tabs.get(win.activeID), second = win.tabs.get(win.splitID);
  const hidden = !!win.overlay && win.overlay !== 'find';
  for (const tab of win.tabs.values()) tab.view.setVisible(!hidden && !!tab.url && (tab.id === win.activeID || tab.id === win.splitID));
  if (first) setBounds(first.view, { x: side + inset, y, width: second ? (available - gap) * win.splitRatio : available, height: Math.max(0, height - y - inset) });
  if (second) setBounds(second.view, { x: side + inset + (available - gap) * win.splitRatio + gap, y, width: (available - gap) * (1 - win.splitRatio), height: Math.max(0, height - y - inset) });
  if (win.peek) { win.peek.setVisible(!hidden); setBounds(win.peek, { x: side + (width - side) * .1, y: height * .1 + 36, width: (width - side) * .8, height: height * .8 - 36 }); }
  setBounds(win.shell, { x: 0, y: 0, width, height });
}
function addPageView(win, tab, selected = false) {
  win.contentView.addChildView(tab.view); tab.view.setVisible(selected); tab.view.setBackgroundColor('#ffffffff'); tab.view.setBorderRadius(8);
}
function removePageView(win, tab) { win.contentView.removeChildView(tab.view); tab.view.setVisible(false); }
function createWindow(isPrivate = false) {
  const win = new BaseWindow({ width: 1280, height: 820, minWidth: 760, minHeight: 500, title: isPrivate ? 'Arco · 无痕窗口' : 'Arco', titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 }, backgroundColor: '#dce7f7' });
  Object.assign(win, { tabs: new Map(), activeID: null, splitID: null, splitRatio: 0.5, spaceID: library.data.spaces[0].id, private: isPrivate, sidebarVisible: true, sidebarWidth: library.settings.sidebarWidth, capture: null, peek: null, peekURL: '', reader: false, overlay: '', snapshots: [], lastActive: new Map(), partition: isPrivate ? 'arco-private-' + core.id() : normalSession });
  if (isPrivate) setupSession(session.fromPartition(win.partition));
  if (!isPrivate) {
    sessionReady = false;
    const loaded = loadSession();
    const history = core.loadJSON(library.historyFile, [], x => Array.isArray(x) ? x : (() => { throw new Error('历史格式不正确'); })());
    library.history ||= history.data; library.savedSession = loaded.data;
    win.spaceID = library.space(loaded.data.activeSpaceID)?.id || library.data.spaces[0].id; win.lastActive = new Map(Object.entries(loaded.data.activeBySpace || {}));
    for (const closed of loaded.data.closed || []) if (closed?.url && !closedTabs.some(x => x.url === closed.url)) closedTabs.push(closed);
    sessionReady = true;
  }
  win.shell = new WebContentsView({ webPreferences: { preload: extensionHost.shellPreload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.contentView.addChildView(win.shell); win.shell.setBackgroundColor('#00000000');
  win.shell.webContents.loadFile(path.join(__dirname, 'shell.html'));
  // 界面脚本加载完成前发出的状态会丢失，首次渲染会停在空白侧栏，所以加载后再推一次。
  win.shell.webContents.once('did-finish-load', () => sendState(win));
  win.shell.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.shell.webContents.on('will-navigate', event => event.preventDefault());
  win.on('resize', () => layout(win)); win.on('closed', () => { for (const tab of win.tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); win.peek?.webContents.close(); if (!win.shell.webContents.isDestroyed()) win.shell.webContents.close(); for (const [id, d] of downloads) if (d.private && d.windowID === win.id) downloads.delete(id); windows.delete(win); });
  win.on('close', () => { if (!win.private) saveSession(); });
  windows.add(win); layout(win);
  if (isPrivate) createTab(win, '', { select: true });
  else {
    for (const saved of library.savedSession.tabs.filter(t => library.space(t.spaceID) && ![...windows].some(w => w !== win && w.tabs.has(t.id)))) createTab(win, saved.url, { ...saved, select: false });
    const active = library.savedSession.activeID && win.tabs.has(library.savedSession.activeID) ? library.savedSession.activeID : [...win.tabs.values()].find(t => t.spaceID === win.spaceID)?.id;
    if (active) selectTab(win, active); else createTab(win, '', { select: true });
  }
  win.show(); sendState(win); return win;
}
function createTab(win, rawURL, options = {}) {
  if (!win || win.isDestroyed() || (!win.private && !library.space(options.spaceID || win.spaceID))) error('空间不存在');
  const url = rawURL && rawURL !== 'about:blank' ? (options.extensionPage ? extensionHost.url(rawURL, options.extensionID) : core.webURL(rawURL)) : '';
  const id = options.id || core.id(), spaceID = win.private ? win.spaceID : options.spaceID || win.spaceID;
  // Adopt Chromium's child WebContents so window.open keeps its opener, WindowProxy and POST body.
  const view = options.webContents ? new WebContentsView({ webContents: options.webContents }) : new WebContentsView({ webPreferences: { partition: win.partition, preload: path.join(__dirname, 'page-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, safeDialogs: true } });
  const tab = { id, spaceID, url, title: options.title || (url ? new URL(url).hostname : '新标签页'), favicon: '', pinned: !!options.pinned, view, window: win };
  win.tabs.set(id, tab); attachTab(tab, options.extensionID || '');
  if (!win.private) extensionHost.track(view.webContents, win);
  if (options.webContents) view.webContents.once('close', () => { if (!win.isDestroyed()) closeTab(win, id); });
  else if (url) view.webContents.loadURL(url).catch(() => {});
  if (options.select !== false) selectTab(win, id); else { addPageView(win, tab, false); if (!win.private && win.tabs.has(win.activeID)) extensionHost.select(win.tabs.get(win.activeID).view.webContents); sendState(win); }
  if (!win.private) saveSession(); return tab;
}
// window.open(url, name, 'width=..,height=..') 这类弹窗必须保留 window.opener，否则三方登录/支付的 postMessage 回传就断了。
function popupSize(features) {
  const size = key => { const match = String(features || '').match(new RegExp(`${key}=(\\d+)`)); return match ? Number(match[1]) : 0; };
  return { width: Math.max(320, Math.min(1200, size('width') || 520)), height: Math.max(240, Math.min(1000, size('height') || 640)) };
}
function attachTab(tab, initialExtensionID = '') {
  const wc = tab.view.webContents, win = tab.window;
  const ownerID = () => {
    if (win.private) return '';
    const source = new URL(wc.getURL() || 'about:blank');
    return source.protocol === 'chrome-extension:' ? source.hostname : source.href === 'about:blank' ? initialExtensionID : '';
  };
  wc.setWindowOpenHandler(details => {
    const extensionID = ownerID();
    if (!isHTTP(details.url) && details.url !== 'about:blank') {
      try { if (!extensionID) throw new Error(); extensionHost.url(details.url, extensionID); }
      catch { try { if (ALLOWED_EXTERNAL.has(new URL(details.url).protocol)) confirmExternal(win, details.url); } catch {} return { action: 'deny' }; }
    }
    const response = { action: 'allow', overrideBrowserWindowOptions: { ...popupSize(details.features), titleBarStyle: 'default', autoHideMenuBar: true, minimizable: false, maximizable: false, fullscreenable: false, webPreferences: { session: session.fromPartition(win.partition), preload: path.join(__dirname, 'page-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } } };
    if (details.disposition !== 'new-window') response.createWindow = options => createTab(win, details.url, { webContents: options.webContents, extensionPage: !!extensionID, extensionID, select: details.disposition !== 'background-tab' }).view.webContents;
    return response;
  });
  wc.on('did-create-window', child => { child.setMenu(null); if (ownerID()) attachExtensionWindow(child, ownerID()); });
  const guardNavigation = (event, url) => {
    if (!isHTTP(url)) {
      try { if (ownerID()) { extensionHost.url(url, ownerID()); return; } } catch {}
      event.preventDefault(); try { if (ALLOWED_EXTERNAL.has(new URL(url).protocol)) confirmExternal(win, url); } catch {}
    }
  };
  wc.on('will-navigate', guardNavigation); wc.on('will-redirect', guardNavigation);
  // 商店安装栏的哨兵地址：只有当前页面确实是同一个扩展的商店详情页时才接受。
  // 注意读 wc.getURL()：did-start-navigation 已经把 tab.url 改成了哨兵地址。
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(STORE_INSTALL)) return;
    event.preventDefault();
    const current = wc.getURL(); tab.url = current; sendState(win);
    const id = storeID(current);
    if (!id || url !== STORE_INSTALL + id) return;
    installFromStore(win, id).catch(cause => console.error('安装扩展失败:', cause.message));
  });
  wc.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) { tab.url = url; tab.window.reader = false; sendState(win); } });
  wc.on('did-navigate', (_, url) => { tab.url = url; sendState(win); saveSession(); });
  wc.on('did-navigate-in-page', (_, url, isMainFrame) => { if (isMainFrame) { tab.url = url; recordHistory(tab); offerStoreInstall(tab); sendState(win); saveSession(); } });
  wc.on('page-title-updated', (event, title) => { event.preventDefault(); tab.title = title.slice(0, 1000) || '新标签页'; sendState(win); });
  wc.on('page-favicon-updated', (_, icons) => { tab.favicon = icons[0] || ''; sendState(win); });
  wc.on('did-finish-load', () => { tab.url = wc.getURL(); recordHistory(tab); offerStoreInstall(tab); sendState(win); });
  wc.on('did-start-loading', () => sendState(win)); wc.on('did-stop-loading', () => sendState(win));
  wc.on('audio-state-changed', () => sendState(win));
  wc.on('ipc-message', (event, channel, payload) => {
    if (event.senderFrame !== wc.mainFrame || !win.tabs.has(tab.id)) return;
    if (channel === 'arco:page-peek') { if (typeof payload?.url === 'string' && isHTTP(payload.url)) openPeek(win, payload.url); return; }
    if (channel === 'arco:page-split') { const other=win.tabs.get(payload?.id);if(other&&other.spaceID===win.spaceID&&other.id!==win.activeID){if(win.splitID)toggleSplit(win);toggleSplit(win,other.id);} return; }
    if (channel !== 'arco:page-password' || win.private) return;
    const origin = safeCaptureOrigin(event.senderFrame.url); if (!origin || payload?.origin !== origin) return;
    if (!payload || typeof payload.password !== 'string' || !payload.password || payload.password.length > 4096 || typeof payload.username !== 'string' || payload.username.length > 1024) return;
    win.capture = { tabID: tab.id, origin, username: payload.username, password: payload.password }; sendState(win);
  });
  wc.on('context-menu', (_, params) => {
    const template = extensionHost.contextMenu(wc, params) || [];
    if (params.linkURL && isHTTP(params.linkURL)) template.push({ label: '在新标签页打开链接', click: () => createTab(win, params.linkURL, { select: true }) }, { label: '在 Peek 中预览', click: () => openPeek(win, params.linkURL) });
    if (params.srcURL && isHTTP(params.srcURL)) template.push({ label: '下载图像', click: () => wc.downloadURL(params.srcURL) });
    template.push({ label: '后退', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: '重新加载', click: () => wc.reload() }, { type: 'separator' }, { label: params.isEditable ? '粘贴' : '复制', role: params.isEditable ? 'paste' : 'copy', enabled: params.isEditable || !!params.selectionText }, { label: '检查元素', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(template).popup();
  });
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' && win.peek) { closePeek(win); event.preventDefault(); }
    if (input.meta || (input.control && input.key !== 'Tab')) {
      const key=input.key.toLowerCase();
      if (['l','t','w','f'].includes(key)) { event.preventDefault();
        if(key==='l')showPalette(win); if(key==='f')win.shell.webContents.send('arco:command','find');
        if(key==='t')input.shift?reopenTab(win):createTab(win,''); if(key==='w')closeTab(win,win.activeID);
      }
    }
  });
}
function extensionBrowser(windowID) {
  const ordinary = [...windows].filter(win => !win.private && !win.isDestroyed());
  return ordinary.find(win => win.id === windowID) || ordinary.find(win => win.isFocused()) || ordinary[0] || createWindow(false);
}
function createExtensionTab(details) {
  // Options pages also reach this trusted adapter internally, without the router's owner tag.
  const target = new URL(details.url || 'about:blank');
  const extensionID = details.__arcoExtensionID || (target.protocol === 'chrome-extension:' ? target.hostname : '');
  const url = extensionHost.url(details.url || 'about:blank', extensionID);
  const win = extensionBrowser(details.windowId);
  const tab = createTab(win, url, { extensionPage: true, extensionID, select: details.active !== false });
  if (details.active !== false) { win.shell.webContents.send('arco:command', 'close-modal'); win.focus(); }
  return [tab.view.webContents, win];
}
function attachExtensionWindow(child, extensionID, track = true) {
  const wc = child.webContents, ses = session.fromPartition(normalSession);
  if (track) extensionHost.track(wc, child);
  extensionHost.ownWindow(child, extensionID);
  const guard = (event, url) => { try { extensionHost.url(url, extensionID); } catch { event.preventDefault(); } };
  wc.on('will-navigate', guard); wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(details => {
    try { extensionHost.url(details.url, extensionID); } catch { return { action: 'deny' }; }
    const response = { action: 'allow', overrideBrowserWindowOptions: { ...popupSize(details.features), webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    if (details.disposition !== 'new-window') response.createWindow = options => {
      const win = extensionBrowser();
      const tab = createTab(win, details.url, { webContents: options.webContents, extensionPage: true, extensionID, select: details.disposition !== 'background-tab' });
      if (details.disposition !== 'background-tab') { win.shell.webContents.send('arco:command', 'close-modal'); setImmediate(() => { if (!win.isDestroyed()) win.focus(); }); }
      return tab.view.webContents;
    };
    return response;
  });
  wc.on('did-create-window', nested => attachExtensionWindow(nested, extensionID));
}
function createExtensionWindow(details) {
  const extensionID = details.__arcoExtensionID || '';
  const urls = [].concat(details.url || 'about:blank');
  if (urls.length > 20) error('一次打开的扩展页面过多');
  for (let i = 0; i < urls.length; i++) urls[i] = extensionHost.url(urls[i], extensionID);
  if (details.type !== 'popup') {
    const win = createWindow(false), blank = win.activeID;
    for (const url of urls) createTab(win, url, { extensionPage: true, extensionID });
    if (urls.length && blank) closeTab(win, blank);
    return win;
  }
  if (urls.length !== 1) error('扩展弹窗只能打开一个页面');
  const owner = extensionBrowser(details.windowId);
  const extension = session.fromPartition(normalSession).extensions.getExtension(extensionID);
  const child = new BrowserWindow({ show: false, width: Math.max(320, Math.min(1440, Number(details.width) || 760)), height: Math.max(240, Math.min(1000, Number(details.height) || 640)), x: details.left, y: details.top, parent: owner, title: extension?.name || '扩展', autoHideMenuBar: true, webPreferences: { session: session.fromPartition(normalSession), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, safeDialogs: true } });
  attachExtensionWindow(child, extensionID);
  child.webContents.once('did-finish-load', () => { if (!child.isDestroyed()) child.show(); });
  child.loadURL(urls[0]).catch(cause => { console.error('扩展页面加载失败:', cause.message); if (!child.isDestroyed()) child.close(); });
  return child;
}
async function openExtensionPopup(win, id, anchor = {}) {
  if (win.private) error('无痕窗口不能打开扩展');
  if (!(library.settings.extensions || []).some(record => record.id === id)) error('扩展不存在');
  const rect = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.max(0, Math.min(10000, Number(anchor[key]) || 0))]));
  const scale = win.shell.webContents.getZoomFactor();
  rect.x = Math.round((win.sidebarVisible ? library.settings.sidebarWidth : 0) + rect.x / scale); rect.y = Math.round(rect.y / scale);
  await extensionHost.click(win, id, rect);
  return { opened: true };
}
function storeID(raw) {
  try {
    const url = new URL(raw);
    if (!/(^|\.)chromewebstore\.google\.com$/.test(url.hostname) || !url.pathname.startsWith('/detail/')) return '';
    const id = url.pathname.split('/').filter(Boolean).pop() || '';
    return /^[a-p]{32}$/.test(id) ? id : '';
  } catch { return ''; }
}
// 商店页面的“添加至 Chrome”在 Electron 里无效，所以注入一条 Arco 自己的安装栏，点它通过哨兵地址回到主进程。
const STORE_INSTALL = 'https://arco-install.invalid/';
function storeBannerScript(id) {
  return `(() => {
    document.getElementById('arco-store-install')?.remove();
    const host = document.createElement('div');
    host.id = 'arco-store-install';
    host.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;gap:12px;padding:9px 14px;background:#292b32;color:#fff;font:13px -apple-system,"PingFang SC",sans-serif;box-shadow:0 2px 14px rgba(0,0,0,.28)';
    const text = document.createElement('span');
    text.textContent = '商店里的“添加至 Chrome”在 Arco 里不生效，用这里安装：';
    const install = document.createElement('button');
    install.textContent = '安装此扩展';
    install.style.cssText = 'border:0;border-radius:13px;padding:5px 14px;background:#fff;color:#292b32;font:inherit;cursor:pointer';
    install.addEventListener('click', () => { location.href = ${JSON.stringify(STORE_INSTALL)} + ${JSON.stringify(id)}; });
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭');
    close.style.cssText = 'border:0;background:none;color:#fff;font:16px -apple-system,sans-serif;cursor:pointer;opacity:.7';
    close.addEventListener('click', () => host.remove());
    host.append(text, install, close);
    document.documentElement.appendChild(host);
  })()`;
}
function offerStoreInstall(tab) {
  const id = storeID(tab.url);
  if (!id || tab.view.webContents.isDestroyed()) return;
  tab.view.webContents.executeJavaScript(storeBannerScript(id), true).catch(() => {});
}
async function installFromStore(win, input) {
  if (win.private) error('无痕窗口不能安装扩展');
  const result = await library.installFromStore(input, testMode ? async () => true : async asked => {
    const detail = [`权限：${asked.permissions.join('、') || '无'}`, asked.optional.length ? `可选权限：${asked.optional.join('、')}` : '', 'Arco 不校验扩展签名。'].filter(Boolean).join('\n');
    const answer = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '安装'], defaultId: 0, cancelId: 0, message: `安装 ${asked.name} ${asked.version}？`, detail: detail.slice(0, 2000) });
    return answer.response === 1;
  });
  if (result.cancelled) return { cancelled: true, list: await library.extensionList() };
  broadcast();
  if (!win.shell.webContents.isDestroyed()) win.shell.webContents.send('arco:command', 'store-installed');
  return result;
}
function safeCaptureOrigin(value) { try { const url = new URL(core.webURL(value)); if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null; return url.origin; } catch { return null; } }
function selectTab(win, tabID) {
  const tab = win.tabs.get(tabID); if (!tab) error('标签页不存在');
  closePeek(win); win.reader = false;
  for (const other of win.tabs.values()) removePageView(win, other);
  win.activeID = tabID; win.spaceID = tab.spaceID; win.lastActive.set(tab.spaceID,tabID); win.splitID = null;
  addPageView(win, tab, true); if (!win.private) extensionHost.select(tab.view.webContents); layout(win); sendState(win); saveSession();
  if (!win.overlay) (tab.url ? tab.view.webContents : win.shell.webContents).focus();
}
function switchSpace(win, spaceID) {
  if (!library.space(spaceID) || win.private) error('空间不存在');
  closePeek(win); win.spaceID = spaceID; win.splitID = null;
  const remembered = win.tabs.get(win.lastActive.get(spaceID));
  const tab = remembered?.spaceID === spaceID ? remembered : [...win.tabs.values()].find(t => t.spaceID === spaceID);
  for (const other of win.tabs.values()) removePageView(win, other);
  win.activeID = null;
  if (tab) selectTab(win, tab.id); else createTab(win, '', { select: true });
  broadcast();
}
function closeTab(win, tabID) {
  const tab = win.tabs.get(tabID); if (!tab) return;
  const wasActive = win.activeID === tabID; win.tabs.delete(tabID); removePageView(win, tab); tab.view.webContents.close();
  if (!win.private && isHTTP(tab.url)) closedTabs.push({ url: tab.url, title: tab.title, spaceID: tab.spaceID, closedAt: core.now() });
  if (win.splitID === tabID) win.splitID = null;
  if (wasActive) { win.activeID = null; const next = [...win.tabs.values()].find(t => t.spaceID === win.spaceID); if (next) selectTab(win, next.id); else createTab(win, '', { select: true }); }
  sendState(win); saveSession();
}
function reopenTab(win) { const closed = closedTabs.pop(); if (closed) createTab(win, closed.url, { spaceID: library.space(closed.spaceID)?.id || win.spaceID, title: closed.title, select: true }); }
function toggleSplit(win, tabID) {
  if (win.splitID) { const previous = win.tabs.get(win.splitID); if (previous) removePageView(win, previous); win.splitID = null; }
  else {
    const other = win.tabs.get(tabID || [...win.tabs.values()].find(t => t.spaceID === win.spaceID && t.id !== win.activeID && t.url)?.id);
    if (!other || other.id === win.activeID || other.spaceID !== win.spaceID || !other.url) error('请选择同一空间的另一个网页标签');
    win.splitID = other.id; addPageView(win, other, true);
  }
  layout(win); sendState(win);
}
function openPeek(win, rawURL) {
  const url = core.webURL(rawURL); closePeek(win);
  win.peek = new WebContentsView({ webPreferences: { partition: win.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.contentView.addChildView(win.peek); win.peek.setBorderRadius(14); win.peek.setBackgroundColor('#ffffffff'); win.peekURL = url;
  win.peek.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.peek.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); closePeek(win); } });
  win.peek.webContents.on('will-navigate', (event, next) => { if (!isHTTP(next)) event.preventDefault(); });
  win.peek.webContents.loadURL(url).catch(() => {}); layout(win); sendState(win);
}
function closePeek(win) { if (win.peek) { win.contentView.removeChildView(win.peek); win.peek.webContents.close(); win.peek = null; win.peekURL = ''; sendState(win); } }
function showPalette(win) { win.shell.webContents.send('arco:command', 'palette'); }
async function confirmExternal(win, url) {
  const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '打开'], defaultId: 0, cancelId: 0, message: '允许打开外部应用？', detail: url.slice(0, 500) });
  if (result.response === 1) await shell.openExternal(url);
}
function findTab(win, id) { const tab = win.tabs.get(id || win.activeID); if (!tab) error('标签页不存在'); return tab; }
function setupSession(ses) {
  const grants = new Set();
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const win = [...windows].find(w => [...w.tabs.values()].some(t => t.view.webContents === wc) || w.peek?.webContents === wc);
    let origin; try { origin = core.exactOrigin(details.requestingUrl); } catch { return callback(false); }
    if (!win || origin !== new URL(wc.getURL()).origin || !['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)) return callback(false);
    const key = origin + '|' + permission;
    if (grants.has(key)) return callback(true);
    const names = { media: '相机或麦克风', geolocation: '位置', notifications: '通知', 'clipboard-read': '读取剪贴板', 'clipboard-sanitized-write': '写入剪贴板' };
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['拒绝', '本次会话允许'], defaultId: 0, cancelId: 0, message: '允许 ' + origin + ' 使用' + names[permission] + '？' });
    if (choice === 1) grants.add(key); callback(choice === 1);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => { try { return !!wc && grants.has(new URL(origin).origin + '|' + permission); } catch { return false; } });
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (library.settings.trackerBlocking && details.resourceType !== 'mainFrame' && matchesTracker(details.url)) { trackerCount++; return callback({ cancel: true }); }
    callback({});
  });
  ses.on('will-download', (_, item, wc) => {
    const owner = [...windows].find(w => [...w.tabs.values()].some(t => t.view.webContents === wc) || w.peek?.webContents === wc);
    if (!owner) { item.cancel(); return; }
    const record = { id: core.id(), windowID: owner.id, private: owner.private, filename: item.getFilename(), path: '', total: item.getTotalBytes(), received: 0, state: 'progressing', item };
    downloads.set(record.id, record);
    item.on('updated', (_, state) => { if (!downloads.has(record.id)) return; record.received = item.getReceivedBytes(); record.total = item.getTotalBytes(); record.state = state; record.path = item.getSavePath(); broadcast(); });
    item.once('done', (_, state) => { if (!downloads.has(record.id)) return; record.state = state; record.path = item.getSavePath(); broadcast(); }); broadcast();
  });
}
const CHANNELS = new Set(['open-url', 'overlay', 'password-sync-unlock', 'password-sync-lock', 'password-sync-now', 'move-bookmark', 'tab-action', 'item-menu', 'vault-status', 'navigate', 'new-tab', 'close-tab', 'select-tab', 'switch-space', 'back', 'forward', 'reload', 'stop', 'reopen-tab', 'clear-tabs', 'toggle-split', 'split-ratio', 'peek', 'close-peek', 'peek-to-tab', 'toggle-sidebar', 'sidebar-width', 'add-space', 'update-space', 'remove-space', 'add-bookmark', 'update-bookmark', 'delete-bookmark', 'add-favorite', 'add-folder', 'update-folder', 'delete-folder', 'import-bookmarks', 'browser-sources', 'import-browser', 'chrome-extensions', 'import-chrome-extensions', 'install-extension-store', 'finish-onboarding', 'export-bookmarks', 'connect-sync', 'disconnect-sync', 'sync-now', 'update-settings', 'history-delete', 'download-open', 'download-reveal', 'download-cancel', 'find', 'find-stop', 'zoom', 'print', 'pdf', 'devtools', 'screenshot', 'reader', 'private-window', 'credentials', 'credential-save', 'credential-read', 'credential-delete', 'credential-fill', 'capture-save', 'capture-dismiss', 'generate-password', 'import-passwords', 'export-passwords', 'add-extension', 'remove-extension', 'extension-list', 'extension-toggle', 'extension-popup', 'copy', 'menu', 'confirm-clear']);
function trustedWindow(event) {
  const win = [...windows].find(w => w.shell.webContents === event.sender);
  if (!win || event.senderFrame !== win.shell.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(path.join(__dirname, 'shell.html')).href) error('未授权的界面请求');
  return win;
}
ipcMain.handle('arco:invoke', async (event, message) => {
  const win = trustedWindow(event);
  if (!message || !CHANNELS.has(message.channel)) error('未知操作');
  const a = message.payload || {};
  try {
    switch (message.channel) {
      case 'overlay': {
        const kind = a.visible ? bounded(a.kind || 'dialog', 32) : '';
        const generation = (win.overlayGeneration || 0) + 1; win.overlayGeneration = generation; const snapshots = [];
        if (kind && kind !== 'find' && !win.overlay) for (const tab of win.tabs.values()) if (tab.view.getVisible()) {
          try { const image = await tab.view.webContents.capturePage(); snapshots.push({ url: image.toDataURL(), bounds: tab.view.getBounds() }); } catch { /* A backdrop is optional while Chromium is between frames. */ }
        }
        if (generation !== win.overlayGeneration || win.isDestroyed()) return true;
        win.snapshots = kind ? (snapshots.length ? snapshots : win.snapshots) : [];
        win.overlay = kind; layout(win); if (kind) win.shell.webContents.focus(); break;
      }
      case 'vault-status': return vault.status();
      case 'password-sync-unlock': if (win.private) error('无痕窗口不能同步密码'); passwordSync.unlock(core.secret(a.passphrase, 1024)); broadcast(); return true;
      case 'password-sync-lock': passwordSync.lock(); broadcast(); return true;
      case 'password-sync-now': {
        if (win.private) error('无痕窗口不能同步密码');
        const remote = passwordSync.readRemote(), local = await vault.exportState(), merged = mergeCredentials(local, remote);
        passwordSync.write(merged); await vault.importState(merged); broadcast(); return true;
      }
      case 'move-bookmark': library.moveBookmark({ ...a, spaceID: a.spaceID || win.spaceID }); broadcast(); break;
      case 'item-menu': showItemMenu(win, a); break;
      case 'tab-action': {
        const tab = findTab(win, a.id);
        if (a.action === 'mute') tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted());
        if (a.action === 'pin') { if (!tab.url) error('请先打开网页'); library.addBookmark({ title: tab.title, url: tab.url, spaceID: tab.spaceID }); tab.pinned = true; }
        if (a.action === 'move') { if (!library.space(a.spaceID)) error('空间不存在'); tab.spaceID = a.spaceID; selectTab(win, tab.id); }
        if (a.action === 'reorder') { const entries = [...win.tabs.values()].filter(x => x !== tab); const index = entries.findIndex(x => x.id === a.beforeID); entries.splice(index < 0 ? entries.length : index, 0, tab); win.tabs = new Map(entries.map(x => [x.id, x])); }
        saveSession(); broadcast(); break;
      }
      case 'open-url': { const url = core.webURL(a.url); const existing = [...win.tabs.values()].find(t => t.url === url && t.spaceID === win.spaceID); if (existing) selectTab(win, existing.id); else createTab(win, url); break; }
      case 'navigate': { const url = core.navigate(bounded(a.input), library.settings.engine); const tab = a.tabID ? findTab(win, a.tabID) : findTab(win); tab.url = url; await tab.view.webContents.loadURL(url); break; }
      case 'new-tab': createTab(win, a.url || '', { select: true }); break;
      case 'close-tab': closeTab(win, bounded(a.id, 128)); break;
      case 'select-tab': selectTab(win, bounded(a.id, 128)); break;
      case 'switch-space': switchSpace(win, bounded(a.id, 128)); break;
      case 'back': findTab(win, a.id).view.webContents.navigationHistory.goBack(); break;
      case 'forward': findTab(win, a.id).view.webContents.navigationHistory.goForward(); break;
      case 'reload': findTab(win, a.id).view.webContents.reload(); break;
      case 'stop': findTab(win, a.id).view.webContents.stop(); break;
      case 'reopen-tab': reopenTab(win); break;
      case 'clear-tabs': {
        if (win.private) { for (const tab of [...win.tabs.values()].filter(t => t.id !== win.activeID)) closeTab(win, tab.id); break; }
        const keep = new Set(library.space(win.spaceID).bookmarks.map(x => x.url)); for (const tab of [...win.tabs.values()].filter(t => t.spaceID === win.spaceID && !keep.has(t.url) && t.id !== win.activeID)) closeTab(win, tab.id); break;
      }
      case 'toggle-split': toggleSplit(win, a.id); break;
      case 'split-ratio': win.splitRatio = Math.max(0.2, Math.min(0.8, Number(a.ratio) || 0.5)); layout(win); sendState(win); break;
      case 'peek': openPeek(win, bounded(a.url)); break;
      case 'close-peek': closePeek(win); break;
      case 'peek-to-tab': { const url = win.peekURL; closePeek(win); if (url) createTab(win, url, { select: true }); break; }
      case 'toggle-sidebar': win.sidebarVisible = !win.sidebarVisible; layout(win); sendState(win); break;
      case 'sidebar-width': win.sidebarWidth = Math.max(216, Math.min(400, Number(a.width) || 240)); library.settings.sidebarWidth = win.sidebarWidth; library.change(); layout(win); sendState(win); break;
      case 'add-space': { const space = library.addSpace(a.name, a.color); if (a.customColor) library.updateSpace({ id: space.id, customColor: a.customColor }); switchSpace(win, space.id); break; }
      case 'update-space': library.updateSpace(a); broadcast(); break;
      case 'remove-space': { library.removeSpace(a.id); for (const w of windows) { if (w.private) continue; for (const tab of [...w.tabs.values()]) if (!library.space(tab.spaceID)) { removePageView(w, tab); tab.view.webContents.close(); w.tabs.delete(tab.id); } if (!library.space(w.spaceID)) switchSpace(w, library.data.spaces[0].id); } saveSession(); broadcast(); break; }
      case 'add-bookmark': library.addBookmark({ ...a, spaceID: a.spaceID || win.spaceID }); broadcast(); break;
      case 'update-bookmark': library.updateBookmark(a); broadcast(); break;
      case 'delete-bookmark': library.deleteBookmark(bounded(a.id, 128)); broadcast(); break;
      case 'add-favorite': { const url=core.webURL(a.url), tab=[...win.tabs.values()].find(t=>t.url===url);const item=library.addFavorite({...a,url,favicon:tab?.favicon || ''});broadcast();return item; }
      case 'add-folder': library.addFolder({ ...a, spaceID: a.spaceID || win.spaceID }); broadcast(); break;
      case 'update-folder': library.updateFolder(a); broadcast(); break;
      case 'delete-folder': library.deleteFolder(bounded(a.id, 128), !!a.removeContents); broadcast(); break;
      case 'import-bookmarks': { const file = a.path || await library.choose('file'); if (file) await library.importFile(file, win.spaceID); broadcast(); break; }
      case 'browser-sources': return browsers.detect();
      case 'import-browser': { const count = await library.importBrowser(bounded(a.id, 200), win.spaceID); broadcast(); return count; }
      case 'chrome-extensions': if (win.private) error('无痕窗口不能管理扩展'); return browsers.chromeExtensions().map(profile => ({ ...profile, extensions: profile.extensions.map(({ source, ...item }) => item) }));
      case 'import-chrome-extensions': if (win.private) error('无痕窗口不能安装扩展'); return await library.importChromeExtensions(bounded(a.profileID, 200), a.ids);
      case 'finish-onboarding': library.settings.onboarded = true; library.change(); broadcast(); break;
      case 'export-bookmarks': return await library.exportFile(win.spaceID);
      case 'connect-sync': { const folder = testMode && a.path ? bounded(a.path) : await library.choose('directory'); if (folder) { passwordSync.lock(); library.settings.syncFolder = folder; library.change(); await library.syncNow(); reconcileSpaces(); broadcast(); } break; }
      case 'disconnect-sync': passwordSync.lock(); library.settings.syncFolder = ''; library.settings.syncStatus = ''; library.change(); broadcast(); break;
      case 'sync-now': await library.syncNow(); reconcileSpaces(); broadcast(); break;
      case 'update-settings': { if (a.engine && core.ENGINES[a.engine]) library.settings.engine = a.engine; if (typeof a.trackerBlocking === 'boolean') library.settings.trackerBlocking = a.trackerBlocking; if (['system', 'light', 'dark'].includes(a.theme)) { library.settings.theme = a.theme; nativeTheme.themeSource = a.theme; } if (typeof a.frameInset === 'boolean') library.settings.frameInset = a.frameInset; library.change(); for (const w of windows) layout(w); broadcast(); break; }
      case 'history-delete': if (win.private) error('无痕窗口没有历史记录'); library.history = library.history.filter(x => x.id !== a.id); core.atomicWrite(library.historyFile, library.history); broadcast(); break;
      case 'download-open': { const item = allowedDownload(win, a.id); if (item.path && item.state === 'completed') await shell.openPath(item.path); break; }
      case 'download-reveal': { const item = allowedDownload(win, a.id); if (item.path) shell.showItemInFolder(item.path); break; }
      case 'download-cancel': { const item = allowedDownload(win, a.id); if (item.state === 'progressing') item.item.cancel(); break; }
      case 'find': { const tab = findTab(win); tab.view.webContents.findInPage(bounded(a.query, 500), { forward: a.forward !== false, findNext: !!a.findNext }); break; }
      case 'find-stop': findTab(win).view.webContents.stopFindInPage('clearSelection'); break;
      case 'zoom': { const wc = findTab(win).view.webContents; wc.setZoomFactor(a.reset ? 1 : Math.max(0.25, Math.min(5, wc.getZoomFactor() + (Number(a.delta) || 0)))); sendState(win); break; }
      case 'print': findTab(win).view.webContents.print({}); break;
      case 'pdf': { const result = await dialog.showSaveDialog(win, { defaultPath: 'Arco-Page.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] }); if (result.filePath) fs.writeFileSync(result.filePath, await findTab(win).view.webContents.printToPDF({ printBackground: true })); break; }
      case 'devtools': findTab(win).view.webContents.openDevTools({ mode: 'detach' }); break;
      case 'screenshot': { const result = await dialog.showSaveDialog(win, { defaultPath: 'Arco-Screenshot.png', filters: [{ name: 'PNG', extensions: ['png'] }] }); if (result.filePath) { const image = await findTab(win).view.webContents.capturePage(); fs.writeFileSync(result.filePath, image.toPNG()); } break; }
      case 'reader': win.reader = !win.reader; sendState(win); return win.reader ? await readerArticle(win) : null;
      case 'private-window': createWindow(true); break;
      case 'credentials': if (win.private) error('无痕窗口中不能管理密码'); return await vault.list();
      case 'credential-save': if (win.private) error('无痕窗口中不能保存密码'); return await vault.save(a);
      case 'credential-read': if (win.private) error('无痕窗口中不能读取密码'); return await vault.read(bounded(a.id, 128));
      case 'credential-delete': await vault.remove(bounded(a.id, 128)); break;
      case 'credential-fill': {
        const tab = findTab(win, a.tabID); if (tab.id !== win.activeID && tab.id !== win.splitID) error('只能填充当前可见标签页');
        const credential = await vault.fill(bounded(a.id, 128), tab.view.webContents.getURL());
        let sameTarget = false;
        try {
          sameTarget = !win.isDestroyed() && !tab.view.webContents.isDestroyed() && win.tabs.get(tab.id) === tab && (tab.id === win.activeID || tab.id === win.splitID) && core.exactOrigin(tab.view.webContents.getURL()) === core.exactOrigin(credential.origin);
        } catch { sameTarget = false; }
        if (!sameTarget) error('标签页已变化，已拒绝填充');
        const count = await tab.view.webContents.executeJavaScript(fillScript(credential.username, credential.password, core.exactOrigin(credential.origin)), true); return { count, username: credential.username };
      }
      case 'capture-save': { if (!win.capture) error('没有待保存的密码'); const capture = win.capture; await vault.save({ origin: capture.origin, username: capture.username, password: capture.password }); win.capture = null; sendState(win); break; }
      case 'capture-dismiss': win.capture = null; sendState(win); break;
      case 'generate-password': return require('node:crypto').randomBytes(24).toString('base64url') + '-A9!';
      case 'import-passwords': { const file = await library.choose('file'); if (!file) return 0; const rows = core.parseCSV(fs.readFileSync(file, 'utf8')); for (const row of rows) await vault.save(row); return rows.length; }
      case 'export-passwords': { if (win.private) error('无痕窗口不能导出密码'); const accepted = await dialog.showMessageBox(win, {type:'warning', buttons:['取消','导出明文'],defaultId:0,cancelId:0,message:'导出的 CSV 包含未加密密码。确定继续？'}); if (accepted.response !== 1) return false; await vault.authenticate(); const result = await dialog.showSaveDialog(win, { defaultPath: 'Arco-Passwords.csv', filters: [{ name: '明文 CSV（请妥善保管）', extensions: ['csv'] }] }); if (!result.filePath) return false; const credentials = await vault.list(), lines = ['name,url,username,password']; for (const item of credentials) { const full = await vault.read(item.id); const escape = value => '"' + String(value).replaceAll('"', '""') + '"'; lines.push([full.title, full.origin, full.username, full.password].map(escape).join(',')); } fs.writeFileSync(result.filePath, '\ufeff' + lines.join('\n'), { mode: 0o600 }); return true; }
      case 'add-extension': if (win.private) error('无痕窗口不能安装扩展'); return await library.addExtension();
      case 'extension-list': if (win.private) error('无痕窗口不能管理扩展'); return await library.extensionList();
      case 'extension-toggle': if (win.private) error('无痕窗口不能管理扩展'); return await library.setExtensionEnabled(bounded(a.id, 200), !!a.enabled);
      case 'extension-popup': return await openExtensionPopup(win, bounded(a.id, 200), a.anchor || {});
      case 'install-extension-store': { const result = await installFromStore(win, bounded(a.input, 500)); return { ...result, list: await library.extensionList() }; }
      case 'remove-extension': if (win.private) error('无痕窗口不能管理扩展'); await library.removeExtension(bounded(a.id, 128)); break;
      case 'copy': clipboard.writeText(bounded(a.text, 1000000)); break;
      case 'menu': showAppMenu(win); break;
      case 'confirm-clear': return dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, message: bounded(a.message, 1000) }) === 1;
    }
    sendState(win); return true;
  } catch (cause) { sendState(win); throw cause; }
});
function fillScript(username, password, origin) {
  return `(() => { if (location.origin !== ${JSON.stringify(origin)}) return 0;
    const visible = el => { if (el.disabled || el.readOnly || el.type === 'hidden') return false; const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width >= 8 && r.height >= 8 && s.visibility === 'visible' && Number(s.opacity) >= .1 && (!el.checkVisibility || el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})); };
    const inputs = [...document.querySelectorAll('input')].filter(visible), passwordField = inputs.find(el => el.type === 'password' && !/new-password/i.test(el.autocomplete || ''));
    if (!passwordField) return 0; const index=inputs.indexOf(passwordField), users=inputs.slice(0,index).filter(el => ['text','email','tel',''].includes(el.type));
    const userField=users.find(el => /username|email/i.test(el.autocomplete || '')) || users.at(-1);
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    const set=(el,value)=>{el.focus();setter.call(el,value);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText'}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    if(userField)set(userField,${JSON.stringify(username)}); set(passwordField,${JSON.stringify(password)}); return 1; })()`;
}
async function readerArticle(win) {
  const wc = findTab(win).view.webContents;
  const source = fs.readFileSync(path.join(__dirname, '..', 'resources', 'Readability.js'), 'utf8');
  await wc.executeJavaScript(source + '\n;true', true);
  const article = await wc.executeJavaScript(`(() => { try { const article = new Readability(document.cloneNode(true)).parse(); return article ? {title:article.title,content:article.content,byline:article.byline || '',url:location.href} : null; } catch(e) { return null; } })()`, true);
  if (!article) error('此页面无法生成阅读视图');
  return article;
}
function showAppMenu(win) {
  const active = win.tabs.get(win.activeID), store = win.private ? '' : storeID(active?.url);
  Menu.buildFromTemplate([
    ...(store ? [{ label: '安装此扩展', click: () => installFromStore(win, store).catch(cause => console.error('安装扩展失败:', cause.message)) }, { type: 'separator' }] : []),
    { label: '新标签页', accelerator: 'CmdOrCtrl+T', click: () => createTab(win, '', { select: true }) },
    { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => closeTab(win, win.activeID) },
    { label: '恢复关闭的标签页', accelerator: 'Shift+CmdOrCtrl+T', click: () => reopenTab(win) },
    { label: '地址与搜索', accelerator: 'CmdOrCtrl+L', click: () => showPalette(win) },
    { label: '页内查找', accelerator: 'CmdOrCtrl+F', click: () => win.shell.webContents.send('arco:command', 'find') },
    { label: '全部标签页', click: () => win.shell.webContents.send('arco:command', 'overview') },
    { label: win.splitID ? '关闭分屏' : '分屏浏览', enabled: !!win.splitID || (!!win.tabs.get(win.activeID)?.url && [...win.tabs.values()].filter(t=>t.spaceID===win.spaceID&&t.url).length>1), click: () => toggleSplit(win) },
    { type: 'separator' },
    ...library.data.spaces.slice(0, 9).map((space, i) => ({ label: `切换到${space.name}`, accelerator: `CmdOrCtrl+${i + 1}`, enabled: !win.private, click: () => switchSpace(win, space.id) })),
    { label: '下一个标签页', accelerator: 'Ctrl+Tab', click: () => { const tabs = [...win.tabs.values()].filter(t => t.spaceID === win.spaceID); const i = tabs.findIndex(t => t.id === win.activeID); if (tabs.length) selectTab(win, tabs[(i + 1) % tabs.length].id); } },
    { type: 'separator' },
    { label: '无痕窗口', accelerator: 'Shift+CmdOrCtrl+N', click: () => createWindow(true) },
    { label: '开发者工具', accelerator: 'Alt+CmdOrCtrl+I', click: () => findTab(win).view.webContents.openDevTools({ mode: 'detach' }) }
  ]).popup();
}
function reconcileSpaces() {
  for (const win of windows) {
    if(win.private)continue;
    for(const tab of [...win.tabs.values()])if(!library.space(tab.spaceID)){removePageView(win,tab);tab.view.webContents.close();win.tabs.delete(tab.id);}
    if(!library.space(win.spaceID))switchSpace(win,library.data.spaces[0].id);
  }
  saveSession();
}
function allowedDownload(win, id) {
  const value = downloads.get(id);
  if (!value || (value.private ? value.windowID !== win.id : win.private)) error('下载记录不可用');
  return value;
}
function installMenu() {
  const focused = () => { const win = BaseWindow.getFocusedWindow(); return windows.has(win) ? win : [...windows].find(w => !w.private) || [...windows][0]; };
  const send = command => { const win = focused(); if (win) win.shell.webContents.send('arco:command', command); };
  const run = action => () => { const win = focused(); if (win) action(win); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label:'文件', submenu:[
      {label:'新建标签页',accelerator:'CmdOrCtrl+T',click:run(w => createTab(w,''))},
      {label:'新建无痕窗口',accelerator:'CmdOrCtrl+Shift+N',click:() => createWindow(true)},
      {label:'关闭标签页',accelerator:'CmdOrCtrl+W',click:run(w => closeTab(w,w.activeID))},
      {label:'恢复关闭的标签页',accelerator:'CmdOrCtrl+Shift+T',click:run(reopenTab)},
      {label:'关闭窗口',accelerator:'CmdOrCtrl+Shift+W',click:run(w => w.close())},
      {label:'打印',accelerator:'CmdOrCtrl+P',click:run(w => findTab(w).view.webContents.print({}))}
    ]},
    {role:'editMenu'},
    {label:'浏览',submenu:[
      {label:'地址与搜索',accelerator:'CmdOrCtrl+L',click:() => send('palette')},
      {label:'页内查找',accelerator:'CmdOrCtrl+F',click:() => send('find')},
      {label:'重新加载',accelerator:'CmdOrCtrl+R',click:run(w => findTab(w).view.webContents.reload())},
      {label:'全部标签页',accelerator:'CmdOrCtrl+Shift+\\',click:() => send('overview')},
      {label:'浏览历史',accelerator:'CmdOrCtrl+Y',click:() => send('history')},
      {label:'设置',accelerator:'CmdOrCtrl+,',click:() => send('settings')},
      {label:'隐藏或显示侧栏',accelerator:'CmdOrCtrl+S',click:run(w => {w.sidebarVisible=!w.sidebarVisible;sendState(w);})},
      {label:'下一个标签页',accelerator:'Ctrl+Tab',click:run(w => { const tabs=[...w.tabs.values()].filter(t=>t.spaceID===w.spaceID);const i=tabs.findIndex(t=>t.id===w.activeID);if(tabs.length)selectTab(w,tabs[(i+1)%tabs.length].id); })},
      ...Array.from({length:9},(_,i)=>({label:'切换空间 '+(i+1),accelerator:'CmdOrCtrl+'+(i+1),click:run(w=>{const space=library.data.spaces[i];if(space&&!w.private)switchSpace(w,space.id);})})),
      {role:'togglefullscreen'}, {role:'toggleDevTools'}
    ]}, {role:'windowMenu'}
  ]));
}
function showItemMenu(win, value) {
  const template=[];
  if(value.kind==='tab') {
    const tab=findTab(win,value.id);
    template.push({label:tab.view.webContents.isAudioMuted()?'取消静音':'静音标签页',click:()=>{tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted());sendState(win);}},
      {label:'固定为书签',enabled:!!tab.url,click:()=>{library.addBookmark({title:tab.title,url:tab.url,spaceID:tab.spaceID});broadcast();}},
      {label:'添加到常驻网站',enabled:!!tab.url,click:()=>{library.addFavorite({title:tab.title,url:tab.url,favicon:tab.favicon});broadcast();}},
      {label:'移到空间',enabled:!win.private,submenu:library.data.spaces.map(s=>({label:s.name,click:()=>{tab.spaceID=s.id;selectTab(win,tab.id);}}))},
      {label:'关闭标签页',click:()=>closeTab(win,tab.id)});
  } else if(value.kind==='bookmark') {
    const space=library.data.spaces.find(s=>s.bookmarks.some(b=>b.id===value.id)), item=space?.bookmarks.find(b=>b.id===value.id);
    if(!item)return;
    template.push({label:'编辑书签',click:()=>win.shell.webContents.send('arco:edit-bookmark',item)},
      {label:'移到空间',submenu:library.data.spaces.map(s=>({label:s.name,click:()=>library.moveBookmark({id:item.id,spaceID:s.id})}))},
      {label:'移到文件夹',submenu:[{label:'顶层',click:()=>library.moveBookmark({id:item.id,spaceID:space.id})},...space.folders.map(f=>({label:f.name,click:()=>library.moveBookmark({id:item.id,spaceID:space.id,parentID:f.id})}))]},
      {label:'取消固定',click:()=>library.deleteBookmark(item.id)});
  } else if(value.kind==='folder') {
    const space=library.space(win.spaceID), folder=space?.folders.find(f=>f.id===value.id);if(!folder)return;
    template.push({label:'重命名文件夹',click:()=>win.shell.webContents.send('arco:edit-folder',folder)},
      {label:'移到文件夹',submenu:[{label:'顶层',click:()=>library.updateFolder({id:folder.id,parentID:null})},...space.folders.filter(f=>f.id!==folder.id&&!library.descendants(space,folder.id).includes(f.id)).map(f=>({label:f.name,click:()=>library.updateFolder({id:folder.id,parentID:f.id})}))]},
      {label:'删除文件夹（保留书签）',click:()=>library.deleteFolder(folder.id)});
  }
  if(template.length)Menu.buildFromTemplate(template).popup({window:win});
}
process.on('unhandledRejection', error => { console.error('Arco 操作失败:', error?.message || '未知错误'); });
app.whenReady().then(async () => {
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  library = new Library(userData, broadcast); vault = testMode ? new MemoryVault() : new EncryptedVault(userData);
  passwordSync = new PasswordSync(() => library.settings.syncFolder, library.settings.deviceID);
  setupSession(session.fromPartition(normalSession));
  extensionHost = createExtensionHost({
    userData, ses: session.fromPartition(normalSession),
    isShell(event) { try { return !trustedWindow(event).private; } catch { return false; } },
    attachWindow: attachExtensionWindow,
    createTab: createExtensionTab,
    createWindow: createExtensionWindow,
    selectTab(wc, owner) {
      if (windows.has(owner)) { const tab = [...owner.tabs.values()].find(t => t.view.webContents === wc); if (tab && owner.activeID !== tab.id) selectTab(owner, tab.id); }
      else if (!owner.isDestroyed()) owner.focus();
    },
    removeTab(wc, owner) {
      if (wc.isDestroyed() || owner.isDestroyed()) return;
      if (windows.has(owner)) { const tab = [...owner.tabs.values()].find(t => t.view.webContents === wc); if (tab) closeTab(owner, tab.id); }
      else owner.close();
    },
    removeWindow(owner) { if (!owner.isDestroyed()) owner.close(); },
    requestPermissions: async () => false,
  });
  nativeTheme.themeSource = library.settings.theme || 'system';
  installMenu();
  await library.loadExtensions();
  if (![...windows].some(win => !win.private)) createWindow(false);
  app.on('activate', () => { if (![...windows].some(w => !w.private)) createWindow(false); });
});
app.on('before-quit', () => { saveSession(); library?.save(); passwordSync?.lock(); vault?.dispose(); });
async function captureComposite(win) {
  const [width,height]=win.getContentSize();
  const base=(await win.shell.webContents.capturePage()).resize({width,height});
  const pixels=base.toBitmap({scaleFactor:1});
  for(const view of [...win.tabs.values()].map(t=>t.view).concat(win.peek?[win.peek]:[])) {
    if(!view.getVisible())continue;
    const bounds=view.getBounds();if(!bounds.width||!bounds.height)continue;
    await view.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    const image=(await view.webContents.capturePage()).resize({width:bounds.width,height:bounds.height});
    const bytes=image.toBitmap({scaleFactor:1});
    for(let y=0;y<bounds.height&&bounds.y+y<height;y++) {
      const count=Math.min(bounds.width,width-bounds.x)*4;
      bytes.copy(pixels,((bounds.y+y)*width+bounds.x)*4,y*bounds.width*4,y*bounds.width*4+count);
    }
  }
  return nativeImage.createFromBitmap(pixels,{width,height,scaleFactor:1});
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
if (testMode) {
  ipcMain.handle('arco:test', async (event, request) => {
    if (!testMode || ![...windows].some(w => w.shell.webContents === event.sender)) throw new Error('Forbidden');
    const { action, payload } = request || {};
    const win = trustedWindow(event);
    if (action === 'state') return serialize(win);
    if (action === 'close-window') { setImmediate(()=>win.close()); return true; }
    if (action === 'views') return [...win.tabs.values()].map(t=>({id:t.id,url:t.url,visible:t.view.getVisible(),bounds:t.view.getBounds(),webContentsID:t.view.webContents.id}));
    if (action === 'focus-page') { findTab(win).view.webContents.focus(); return true; }
    if (action === 'evaluate') return findTab(win, payload?.id).view.webContents.executeJavaScript(payload.script, true);
    if (action === 'windows') return [...windows].map(w => ({ private: w.private, id: w.id }));
    if (action === 'capture') { if(!/^[\w-]+$/.test(payload.name))throw Error('Invalid name');const image=await captureComposite(win);fs.mkdirSync(path.join(__dirname,'..','artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'..','artifacts',payload.name+'.png'),image.toPNG());return true; }
    if (action === 'fixture-secret') { const credential = await vault.save(payload); return credential.id; }
    if (action === 'arm-auth-gate') {
      let release; const pending = new Promise(resolve => { release = resolve; }); const original = vault.authenticate.bind(vault);
      vault.authWaiting = false; vault.releaseAuth = release;
      vault.authenticate = async () => { vault.authWaiting = true; await pending; vault.authenticate = original; return original(); };
      return true;
    }
    if (action === 'auth-waiting') return !!vault.authWaiting;
    if (action === 'release-auth') { vault.releaseAuth?.(); return true; }
    throw new Error('Unknown test action');
  });
}
