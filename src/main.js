'use strict';
const { app, BaseWindow, BrowserWindow, WebContentsView, session, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('./core');
const Library = require('./library');
const browsers = require('./browsers');
const browserMigration = require('./browser-migration');
let migrationPending = false;
const { createExtensionHost } = require('./extension-host');
const { EncryptedVault, MemoryVault } = require('./vault');
const { PasswordSync, mergeCredentials } = require('./password-sync');
const { Translator } = require('./translate');
const { pathToFileURL } = require('node:url');

// 平台通行密钥（Passkeys）需要 Arco 自己的 Apple 浏览器授权、签名/配置文件与钥匙串 entitlement。
// 当前 ad-hoc 构建两者都没有：开启 platformPasskeys 只会得到 ASAuthorizationError 1004，
// 配置 Touch ID 认证器又需要 keychain-access-groups 签名。因此如实报告不可用，不伪造授权。
const platformPasskeysAvailable = false;
const testMode = process.env.ARCO_TEST_MODE === '1' && !!process.env.ARCO_USER_DATA_DIR && !app.isPackaged;
if (testMode && process.env.ARCO_FAIL_BACKUP) {
  const copy = fs.copyFileSync, target = process.env.ARCO_FAIL_BACKUP;
  fs.copyFileSync = (source, ...args) => { if (String(source).endsWith(target)) throw new Error('disk unavailable'); return copy.call(fs, source, ...args); };
}
// 故障注入：marker 文件存在时让 Library.json 的最终替换失败，用来验证安装事务的数据保全。
if (testMode && process.env.ARCO_FAIL_LIBRARY_WRITE) {
  const marker = process.env.ARCO_FAIL_LIBRARY_WRITE, rename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => { if (fs.existsSync(marker) && String(to).endsWith('Library.json')) throw new Error('disk unavailable'); return rename.call(fs, from, to, ...args); };
}
// 故障注入：marker 文件存在时让扩展旧备份目录的清理失败，验证清理失败不回滚已生效的新包。
if (testMode && process.env.ARCO_FAIL_BACKUP_CLEANUP) {
  const marker = process.env.ARCO_FAIL_BACKUP_CLEANUP, remove = fs.rmSync;
  fs.rmSync = (target, ...args) => { if (fs.existsSync(marker) && String(target).includes('.backup-')) throw new Error('cleanup unavailable'); return remove.call(fs, target, ...args); };
}
// 开发构建使用独立数据目录：未打包运行不会读写正式安装的 Cookie、密码库、扩展和会话。
const userData = process.env.ARCO_USER_DATA_DIR ? path.resolve(process.env.ARCO_USER_DATA_DIR) : path.join(app.getPath('appData'), app.isPackaged ? 'Arco' : 'Arco-Dev');
if (process.platform !== 'darwin' && !testMode) { dialog.showErrorBox('Arco', '此版本仅支持 macOS。'); app.exit(1); }
app.setPath('userData', userData);
app.setName('Arco');
app.enableSandbox();
// 同一数据目录只允许一个进程写入；第二个实例在读取资料前退出，不复制、不删除旧目录。
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);
else app.on('second-instance', (_event, argv) => { const urls = argv.slice(1).filter(value => isHTTP(value)); if (urls.length) { urls.forEach(openExternalURL); return; } const win = [...windows].find(w => !w.private && !w.isDestroyed()) || [...windows].find(w => !w.isDestroyed()); if (!win) return; if (win.isMinimized()) win.restore(); win.focus(); });
const windows = new Set();
// 系统外链（默认浏览器、open -a Arco https://…、命令行参数）：窗口就绪前先排队，只接受 http/https。
const pendingURLs = process.argv.slice(1).filter(value => isHTTP(value));
let launched = false;
function openExternalURL(url) {
  if (!isHTTP(url)) return;
  if (!launched) { pendingURLs.push(url); return; }
  const win = [...windows].find(w => !w.private && !w.little && !w.isDestroyed()) || [...windows].find(w => !w.private && !w.isDestroyed()) || createWindow(false);
  createTab(win, url, { select: true }); if (win.isMinimized()) win.restore(); win.focus();
}
app.on('open-url', (event, url) => { event.preventDefault(); openExternalURL(url); });
// Dock 图标上的下载进度：总大小未知时显示不确定进度，多个下载时显示数量。
function dockProgress() {
  const active = [...downloads.values()].filter(d => d.item && d.state === 'progressing'), total = active.reduce((sum, d) => sum + d.total, 0);
  const win = [...windows].find(w => !w.isDestroyed());
  if (win) win.setProgressBar(!active.length ? -1 : total ? Math.min(1, active.reduce((sum, d) => sum + d.received, 0) / total) : 2);
  app.dock?.setBadge(active.length > 1 ? String(active.length) : '');
}
let library, vault, passwordSync, extensionHost, translator;
const translationRequests = new Map();
const normalSession = 'persist:arco';
const downloads = new Map();
const popupOwners = new Map();
const closedTabs = [];
let testStoreApproval = true;
let sessionReady = false;
let trackerCount = 0;
const ALLOWED_EXTERNAL = new Set(['mailto:', 'tel:', 'facetime:', 'maps:', 'xmpp:']);
const TRACKER_HOSTS = ['doubleclick.net', 'google-analytics.com', 'googletagmanager.com', 'googlesyndication.com', 'facebook.net', 'connect.facebook.net', 'adservice.google.com', 'scorecardresearch.com', 'hotjar.com', 'segment.io', 'criteo.com', 'criteo.net', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com', 'matomo.cloud'];
function matchesTracker(raw) { try { const host = new URL(raw).hostname; return TRACKER_HOSTS.some(rule => host === rule || host.endsWith('.' + rule)); } catch { return false; } }
function error(message) { throw new Error(typeof message === 'string' ? message : '操作失败'); }
function bounded(value, maximum = 8192) { if (typeof value !== 'string' || value.length > maximum) error('输入无效'); return value; }
function isHTTP(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
const downloadsFile = path.join(userData, 'Downloads.json');
function downloadDirectory() {
  // 测试进程不能写真实“下载”目录；临时构建落在自己的数据目录。
  return testMode ? path.join(userData, 'Downloads') : app.getPath('downloads');
}
const reservedDownloads = new Set();
function uniqueDownloadPath(folder, filename) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const base = path.basename(String(filename || 'download').replace(/[\0/\\]/g, '_')).slice(0, 180) || 'download';
  const extension = path.extname(base), stem = base.slice(0, base.length - extension.length);
  let candidate = path.join(folder, base);
  // 已存在和正在写入的名字都要跳过：并发同名下载不互相覆盖。
  for (let index = 1; (fs.existsSync(candidate) || reservedDownloads.has(candidate)) && index < 1000; index++) candidate = path.join(folder, `${stem} (${index})${extension}`);
  if (fs.existsSync(candidate) || reservedDownloads.has(candidate)) throw new Error('同名下载文件过多，已取消下载');
  reservedDownloads.add(candidate);
  return candidate;
}
function releaseDownloadPath(file) { if (file) reservedDownloads.delete(file); }
function loadDownloadRecords() {
  const stored = core.loadJSON(downloadsFile, [], value => Array.isArray(value) ? value : (() => { throw new Error('下载记录格式不正确'); })());
  for (const record of stored.data.slice(-100)) {
    if (!record || typeof record.id !== 'string' || typeof record.filename !== 'string' || typeof record.path !== 'string') continue;
    // 只有终态记录可以恢复；重启后不存在“还能继续”的下载。
    if (!['completed', 'cancelled', 'interrupted'].includes(record.state)) continue;
    downloads.set(record.id, { ...record, private: false, item: null });
  }
}
// 只持久化普通窗口的已完成/中断/取消记录；无痕下载只留在内存。
function persistDownloads() {
  if (!library) return;
  try { core.atomicWrite(downloadsFile, [...downloads.values()].filter(record => !record.private && ['completed', 'cancelled', 'interrupted'].includes(record.state)).slice(-100).map(({ item, ...record }) => record)); }
  catch (cause) { console.error('无法保存下载记录:', cause.message); }
}
function sendState(win) { if (!win || win.isDestroyed() || win.shell.webContents.isDestroyed()) return; layout(win); win.shell.webContents.send('arco:state', serialize(win)); }
function clearCapture(win, capture) { if (capture && win.capture === capture) win.capture = null; }
function cancelTranslationRequests(wc) {
  for (const [id, request] of translationRequests) {
    if (request.wc !== wc) continue;
    translationRequests.delete(id); clearTimeout(request.timer); request.reject(new Error('页面已变化，翻译已取消'));
  }
}
function pageTranslation(wc, action, texts) {
  const id = core.id();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { translationRequests.delete(id); reject(new Error('页面没有响应翻译请求')); }, 30000);
    translationRequests.set(id, { wc, resolve, reject, timer });
    wc.send('arco:page-translate', { id, action, texts });
  });
}
async function translateTab(win) {
  const tab = findTab(win);
  if (!tab.view || tab.view.webContents.isDestroyed() || !isHTTP(tab.url)) error('请先打开一个网页再翻译');
  const wc = tab.view.webContents, generation = tab.generation || 0;
  if (tab.translation) {
    await pageTranslation(wc, 'restore');
    if (win.tabs.get(tab.id) === tab && (tab.generation || 0) === generation) { tab.translation = null; sendState(win); }
    return null;
  }
  if (tab.translating) error('这个页面正在翻译');
  tab.translating = true; sendState(win);
  try {
    const extracted = await pageTranslation(wc, 'extract');
    const texts = Array.isArray(extracted.texts) ? extracted.texts : [];
    if (!texts.length) error('这个页面没有可翻译的可见文字');
    const joined = texts.join('\n').slice(0, 200000);
    const detected = await translator.detect(joined);
    let result;
    try { result = await translator.translate(bounded(detected.source, 32), texts); }
    catch (cause) {
      if (!wc.isDestroyed()) await pageTranslation(wc, 'restore').catch(() => {});
      throw cause;
    }
    if (!Array.isArray(result.texts) || result.texts.length !== texts.length) error('翻译返回的文字数量不匹配');
    if (win.isDestroyed() || win.tabs.get(tab.id) !== tab || (tab.generation || 0) !== generation || wc.isDestroyed()) error('页面已变化，已取消翻译');
    await pageTranslation(wc, 'apply', result.texts);
    tab.translation = { source: detected.source, count: texts.length };
    return tab.translation;
  } finally {
    tab.translating = false;
    if (!win.isDestroyed()) sendState(win);
  }
}
function openLittleWindow(win, rawURL = '') {
  const tab = win.tabs.get(win.activeID) || findTab(win);
  const url = rawURL ? core.webURL(rawURL) : (tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() : tab.url);
  if (!isHTTP(url)) error('请先打开一个网页再使用小窗口');
  const little = createWindow(false, url, { little: true, owner: win });
  little.littleOwner = win;
  little.once('ready-to-show', () => { if (!little.isDestroyed()) little.show(); });
  return { id: little.id };
}
function broadcast() { for (const win of windows) sendState(win); }
function publicTab(tab) { const wc = tab.view?.webContents, live = !!wc && !wc.isDestroyed(); return { id: tab.id, webContentsID: live ? wc.id : -1, spaceID: tab.spaceID, url: tab.url, title: tab.title, favicon: tab.favicon, loading: live && wc.isLoading(), canBack: live && wc.navigationHistory.canGoBack(), canForward: live && wc.navigationHistory.canGoForward(), muted: live && wc.isAudioMuted(), playing: live && wc.isCurrentlyAudible(), pinned: tab.pinned, store: tab.loadFailed ? '' : storeID(live ? wc.getURL() : tab.url), zoom: live ? wc.getZoomFactor() : 1, asleep: !tab.view }; }
function serialize(win) {
  return {
    private: win.private, chromium: process.versions.chrome, tabs: [...win.tabs.values()].map(publicTab), activeID: win.activeID, splitID: win.splitID, splitRatio: win.splitRatio,
    spaces: library.data.spaces.map(({ id, name, color, customColor }) => ({ id, name, color, customColor })), activeSpaceID: win.spaceID,
    favorites: library.data.favorites, folders: win.private ? [] : library.space(win.spaceID)?.folders || [], bookmarks: win.private ? [] : library.space(win.spaceID)?.bookmarks || [],
    allBookmarks: library.data.spaces.flatMap(s => s.bookmarks.map(b => ({ ...b, spaceID: s.id }))),
    settings: { ...library.settings, dataDirectory: userData }, downloads: [...downloads.values()].filter(d => d.private ? d.windowID === win.id : !win.private).map(({ item, ...record }) => record), warning: library.warning,
    capture: win.capture ? { tabID: win.capture.tabID, origin: win.capture.origin, username: win.capture.username } : null, little: !!win.little, translation: win.tabs.get(win.activeID)?.translation || null, peek: win.peek ? { url: win.peekURL, title: win.peek.webContents.getTitle(), loading: !win.peek.webContents.isDestroyed() && win.peek.webContents.isLoading() } : null,
    snapshots: win.snapshots || [], vault: vault.status(), passwordSyncUnlocked: passwordSync.unlocked, sidebarVisible: win.sidebarVisible, reader: win.reader, syncAvailable: false, testMode,
    passkeys: [...passkeyRequests.values()].filter(request => request.win === win && !request.wc.isDestroyed()).map(({ id, origin }) => ({ id, origin })),
    focusedPaneID: win.focusedPaneID, find: win.find ? { query: win.find.query, targetID: win.find.targetID, targetKind: win.find.targetKind, matches: win.find.matches, active: win.find.active } : null, httpAuth: win.httpAuth ? publicAuth(win.httpAuth) : null,
    passkeysPlatform: platformPasskeysAvailable
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
  const normalWindows = [...windows].filter(w => !w.private && !w.little && !w.isDestroyed());
  const normal = normalWindows.find(w => w.isFocused()) || normalWindows[0];
  const tabs = normal ? normalWindows.flatMap(w => [...w.tabs.values()]).filter(t => !t.url || isHTTP(t.url)).map(t => ({ id: t.id, spaceID: t.spaceID, url: t.url, title: t.title, pinned: t.pinned })) : library.savedSession?.tabs || [];
  const data = { version: 1, tabs, activeSpaceID: normal?.spaceID || library.savedSession?.activeSpaceID, activeID: normal?.activeID || library.savedSession?.activeID, closed: closedTabs.slice(-30), activeBySpace: normal ? Object.fromEntries(normal.lastActive) : library.savedSession?.activeBySpace || {} };
  core.atomicWrite(library.sessionFile, data); library.savedSession = data;
}
function recordHistory(tab) {
  if (tab.window.private || tab.window.little || !isHTTP(tab.url)) return;
  const entry = { id: core.id(), url: tab.url, title: tab.title, visitedAt: core.now() };
  library.history = [entry, ...(library.history || []).filter(x => x.url !== entry.url)].slice(0, 10000);
  core.atomicWrite(library.historyFile, library.history);
}
function setBounds(view, bounds) { view.setBounds(Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.max(0, Math.round(value))]))); }
function closeDockedDevTools(win, wc = null) {
  if (wc) wc.closeDevTools();
  if (win.devtoolsTarget === wc || !wc) win.devtoolsTarget = null;
  if (!win.devtoolsDock) return;
  win.contentView.removeChildView(win.devtoolsDock);
  if (!win.devtoolsDock.webContents.isDestroyed()) win.devtoolsDock.webContents.close();
  win.devtoolsDock = null;
}
function toggleDevTools(win) {
  const target = commandTarget(win), wc = target.wc;
  if (wc.isDevToolsOpened() || win.devtoolsTarget === wc) { wc.closeDevTools(); closeDockedDevTools(win); win.devtoolsTarget = null; return; }
  if (library.settings.devtoolsMode !== 'right' || target.targetKind !== 'tab') { wc.openDevTools({ mode: 'detach' }); return; }
  closeDockedDevTools(win);
  const dock = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.contentView.addChildView(dock); win.devtoolsDock = dock;
  dock.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dock.webContents.on('will-navigate', event => event.preventDefault());
  dock.webContents.on('destroyed', () => { if (win.devtoolsDock === dock) win.devtoolsDock = null; });
  wc.setDevToolsWebContents(dock.webContents);
  win.devtoolsTarget = wc;
  wc.openDevTools({ mode: 'detach' });
  layout(win);
}
function layout(win) {
  if (win.isDestroyed()) return;
  const [width, height] = win.getContentSize(), side = win.sidebarVisible ? win.sidebarWidth : 0;
  const inset = library.settings.frameInset ? 8 : 0, gap = 8, y = 40 + inset + (win.overlay === 'find' ? 48 : 0);
  const dock = win.devtoolsDock;
  const available = Math.max(0, width - side - inset * 2 - (dock ? Math.round(width * 0.48) : 0)), first = win.tabs.get(win.activeID), second = win.tabs.get(win.splitID);
  // 密码保存提示不遮挡登录跳转；网页继续可见、可交互，避免看起来像卡住。
  const hidden = !!win.overlay && win.overlay !== 'find';
  // 阅读视图占用整块页面区域；此时底层网页保持隐藏，命令只作用于文章本身。
  for (const tab of win.tabs.values()) if (tab.view) tab.view.setVisible(!hidden && !win.reader && !!tab.url && (tab.id === win.activeID || tab.id === win.splitID));
  if (first?.view) setBounds(first.view, { x: side + inset, y, width: second ? (available - gap) * win.splitRatio : available, height: Math.max(0, height - y - inset) });
  if (second?.view) setBounds(second.view, { x: side + inset + (available - gap) * win.splitRatio + gap, y, width: (available - gap) * (1 - win.splitRatio), height: Math.max(0, height - y - inset) });
  if (win.readerView) { setBounds(win.readerView, { x: side + inset, y, width: available, height: Math.max(0, height - y - inset) }); win.readerView.setVisible(!hidden); }
  if (win.peek) { win.peek.setVisible(!hidden); setBounds(win.peek, { x: side + (width - side) * .1, y: height * .1 + 36, width: (width - side) * .8, height: height * .8 - 36 }); }
  if (dock) setBounds(dock, { x: width - inset - Math.round(width * 0.48), y, width: Math.round(width * 0.48), height: Math.max(0, height - y - inset) });
  setBounds(win.shell, { x: 0, y: 0, width, height });
}
function addPageView(win, tab, selected = false) {
  if (!tab.view) return;
  win.contentView.addChildView(tab.view); tab.view.setVisible(selected); tab.view.setBackgroundColor('#ffffffff'); tab.view.setBorderRadius(8);
}
function removePageView(win, tab) { if (!tab.view) return; win.contentView.removeChildView(tab.view); tab.view.setVisible(false); }
function littleWindowOptions(owner) {
  const area = screen.getDisplayMatching(owner.getBounds()).workArea;
  const maxWidth = Math.round(area.width * 0.8), maxHeight = Math.round(area.height * 0.8);
  let height = maxHeight, width = Math.round(height * 560 / 640);
  if (width > maxWidth) { width = maxWidth; height = Math.round(width * 640 / 560); }
  const x = owner.isDestroyed() ? undefined : Math.round(owner.getBounds().x + Math.max(0, (owner.getBounds().width - width) / 2));
  const y = Math.round(area.y + (area.height - height) / 2);
  return { width, height, x, y, minWidth: 360, minHeight: 360, title: 'Arco · 小窗口', titleBarStyle: 'default', backgroundColor: '#dce7f7' };
}
function createWindow(isPrivate = false, url = '', { little = false, owner = null } = {}) {
  const options = little ? littleWindowOptions(owner) : { width: 1280, height: 820, minWidth: 760, minHeight: 500, title: isPrivate ? 'Arco · 无痕窗口' : 'Arco', titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 }, backgroundColor: '#dce7f7' };
  const win = new BaseWindow(options);
  Object.assign(win, { tabs: new Map(), activeID: null, splitID: null, splitRatio: 0.5, focusedPaneID: null, peekFocused: false, find: null, httpAuth: null, httpAuthQueue: [], spaceID: library.data.spaces[0].id, private: isPrivate, little, sidebarVisible: !little, sidebarWidth: library.settings.sidebarWidth, capture: null, peek: null, peekURL: '', peekListeners: null, reader: false, readerView: null, overlay: '', snapshots: [], lastActive: new Map(), partition: isPrivate ? 'arco-private-' + core.id() : normalSession });
  if (isPrivate) setupSession(session.fromPartition(win.partition));
  if (!isPrivate && !little) {
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
  win.on('resize', () => layout(win)); win.on('closed', () => { closeDockedDevTools(win); cancelAuthForWindow(win); clearPasskeyRequests(null, win); for (const tab of win.tabs.values()) if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close(); if (win.readerView && !win.readerView.webContents.isDestroyed()) win.readerView.webContents.close(); win.peek?.webContents.close(); if (!win.shell.webContents.isDestroyed()) win.shell.webContents.close(); for (const [id, owner] of popupOwners) if (owner.window === win) popupOwners.delete(id); for (const [id, d] of downloads) if (d.private && d.windowID === win.id) downloads.delete(id); windows.delete(win); });
  win.on('close', () => { if (!win.private && !win.little) saveSession(); });
  windows.add(win); layout(win);
  if (isPrivate || little) createTab(win, url, { select: true });
  else {
    // 会话恢复只建立记录；未激活的标签页第一次切换过去时才创建渲染进程，避免启动就拉起全部网站。
    for (const saved of library.savedSession.tabs.filter(t => library.space(t.spaceID) && ![...windows].some(w => w !== win && w.tabs.has(t.id)))) createTab(win, saved.url, { ...saved, asleep: true, select: false });
    const active = library.savedSession.activeID && win.tabs.has(library.savedSession.activeID) ? library.savedSession.activeID : [...win.tabs.values()].find(t => t.spaceID === win.spaceID)?.id;
    if (active) selectTab(win, active); else createTab(win, '', { select: true });
  }
  win.show(); sendState(win); return win;
}
// 标签页的渲染进程按需创建：恢复的标签页先只有记录，第一次显示时才创建 WebContentsView。
function mountTab(win, tab, extensionID = '') {
  const view = new WebContentsView({ webPreferences: { partition: win.partition, preload: path.join(__dirname, 'page-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, safeDialogs: true } });
  tab.view = view; attachTab(tab, extensionID);
  if (!win.private) extensionHost.track(view.webContents, win);
  if (tab.url) view.webContents.loadURL(tab.url).catch(() => {});
  return view;
}
function wakeTab(win, tab) { return tab.view || mountTab(win, tab); }
function createTab(win, rawURL, options = {}) {
  if (!win || win.isDestroyed() || (!win.private && !library.space(options.spaceID || win.spaceID))) error('空间不存在');
  const url = rawURL && rawURL !== 'about:blank' ? (options.extensionPage ? extensionHost.url(rawURL, options.extensionID) : core.webURL(rawURL)) : '';
  const id = options.id || core.id(), spaceID = win.private ? win.spaceID : options.spaceID || win.spaceID;
  // Adopt Chromium's child WebContents so window.open keeps its opener, WindowProxy and POST body.
  // An existing WebContentsView is used only when Peek is promoted; it is transferred without another navigation.
  const view = options.view || (options.webContents ? new WebContentsView({ webContents: options.webContents }) : null);
  const tab = { id, spaceID, url, title: options.title || (url ? new URL(url).hostname : '新标签页'), favicon: '', pinned: !!options.pinned, view, window: win, generation: 0 };
  win.tabs.set(id, tab);
  if (view) {
    attachTab(tab, options.extensionID || '');
    if (!win.private) extensionHost.track(view.webContents, win);
    if (options.webContents) view.webContents.once('close', () => { if (!win.isDestroyed()) closeTab(win, id); });
    else if (!options.view && url) view.webContents.loadURL(url).catch(() => {});
  } else if (!options.asleep) mountTab(win, tab, options.extensionID || '');
  if (options.select !== false) selectTab(win, id);
  else if (tab.view) { addPageView(win, tab, false); if (!win.private && win.tabs.has(win.activeID)) extensionHost.select(win.tabs.get(win.activeID).view.webContents); sendState(win); }
  else sendState(win);
  if (!win.private && !win.little) saveSession(); return tab;
}
// window.open(url, name, 'width=..,height=..') 这类弹窗必须保留 window.opener，否则三方登录/支付的 postMessage 回传就断了。
function popupSize(features) {
  const size = key => { const match = String(features || '').match(new RegExp(`${key}=(\\d+)`)); return match ? Number(match[1]) : 0; };
  return { width: Math.max(320, Math.min(1200, size('width') || 520)), height: Math.max(240, Math.min(1000, size('height') || 640)) };
}
function resetFind(win, notify = true) {
  const current = win.find;
  if (current?.wc && !current.wc.isDestroyed()) current.wc.stopFindInPage('clearSelection');
  win.find = null;
  if (notify && !win.isDestroyed()) sendState(win);
}
function noteFindResult(win, wc, result) {
  if (win.find?.wc !== wc || win.find.requestID !== result.requestId) return;
  win.find = { ...win.find, matches: result.matches, active: result.activeMatchOrdinal };
  sendState(win);
}
function pageOpenResponse(win, details, extensionID = '') {
  if (!isHTTP(details.url) && details.url !== 'about:blank') {
    try { if (!extensionID) throw new Error(); extensionHost.url(details.url, extensionID); }
    catch { try { if (ALLOWED_EXTERNAL.has(new URL(details.url).protocol)) confirmExternal(win, details.url); } catch {} return { action: 'deny' }; }
  }
  const response = { action: 'allow', overrideBrowserWindowOptions: { ...popupSize(details.features), titleBarStyle: 'default', autoHideMenuBar: true, minimizable: false, maximizable: false, fullscreenable: false, webPreferences: { session: session.fromPartition(win.partition), preload: path.join(__dirname, 'page-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, safeDialogs: true } } };
  if (details.disposition !== 'new-window') response.createWindow = options => createTab(win, details.url, { webContents: options.webContents, extensionPage: !!extensionID, extensionID, select: details.disposition !== 'background-tab' }).view.webContents;
  return response;
}
function registerWebsitePopup(child, owner) {
  if (!child || child.isDestroyed() || !owner || owner.isDestroyed()) return;
  const wc = child.webContents, id = wc.id;
  trackPasskeyDocument(wc);
  child.setMenu(null);
  popupOwners.set(id, { window: owner, popup: child, partition: owner.partition, private: owner.private });
  child.once('closed', () => popupOwners.delete(id));
  wc.once('destroyed', () => popupOwners.delete(id));
  wc.setWindowOpenHandler(details => pageOpenResponse(owner, details));
  wc.on('did-create-window', nested => registerWebsitePopup(nested, owner));
}
function ownerForWebContents(wc) {
  if (!wc || wc.isDestroyed()) return null;
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    if ([...win.tabs.values()].some(tab => tab.view?.webContents === wc) || win.peek?.webContents === wc) return win;
  }
  const popup = popupOwners.get(wc.id);
  return popup && !popup.window.isDestroyed() && !popup.popup.isDestroyed() ? popup.window : null;
}
function pageURLForWebContents(win, wc) {
  const tab = [...win.tabs.values()].find(tab => tab.view?.webContents === wc);
  if (tab) return tab.url;
  if (win.peek?.webContents === wc) return win.peekURL;
  return wc.getURL();
}
// 通行密钥等待状态：只保存操作状态与真实来源，challenge/credential/assertion/密钥材料从不离开页面。
const passkeyRequests = new Map();
const passkeyDocuments = new WeakMap();
function passkeyOrigin(frame) {
  try { const url = new URL(frame?.url || ''); return ['http:', 'https:'].includes(url.protocol) ? url.origin : ''; } catch { return ''; }
}
function clearPasskeyRequests(wc, win = null) {
  for (const [key, request] of passkeyRequests) {
    if (win ? request.win !== win : request.wc !== wc) continue;
    passkeyRequests.delete(key);
    if (!request.win.isDestroyed() && !request.win.shell.webContents.isDestroyed()) sendState(request.win);
  }
}
// 文档代次：导航后旧文档的请求既不能取消新文档的请求，也不能继续显示在壳层。
function trackPasskeyDocument(wc) {
  if (!wc || wc.isDestroyed() || passkeyDocuments.has(wc)) return;
  passkeyDocuments.set(wc, 0);
  wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    passkeyDocuments.set(wc, (passkeyDocuments.get(wc) || 0) + 1);
    clearPasskeyRequests(wc);
  });
  // Old pagehide/unload handlers can still send UI hints between navigation start and commit.
  wc.on('did-navigate', () => clearPasskeyRequests(wc));
  wc.once('destroyed', () => clearPasskeyRequests(wc));
  wc.on('render-process-gone', () => clearPasskeyRequests(wc));
}
function attachTab(tab, initialExtensionID = '') {
  const wc = tab.view.webContents, win = tab.window;
  trackPasskeyDocument(wc);
  const ownerID = () => {
    if (win.private) return '';
    const source = new URL(wc.getURL() || 'about:blank');
    return source.protocol === 'chrome-extension:' ? source.hostname : source.href === 'about:blank' ? initialExtensionID : '';
  };
  // Little Arc 里的普通链接仍在本窗口导航；只有页面明确要求新窗口时才沿用主窗口的弹窗规则。
  wc.setWindowOpenHandler(details => {
    if (win.little && details.disposition === 'foreground-tab') { wc.loadURL(details.url).catch(() => {}); return { action: 'deny' }; }
    return pageOpenResponse(win, details, ownerID());
  });
  wc.on('did-create-window', child => { const extensionID = ownerID(); if (extensionID) attachExtensionWindow(child, extensionID); else registerWebsitePopup(child, win); });
  const guardNavigation = (event, url) => {
    if (!isHTTP(url)) {
      try { if (ownerID()) { extensionHost.url(url, ownerID()); return; } } catch {}
      event.preventDefault(); try { if (ALLOWED_EXTERNAL.has(new URL(url).protocol)) confirmExternal(win, url); } catch {}
    }
  };
  wc.on('will-navigate', (event, url) => {
    const pending = tab.pendingLittleLink;
    tab.pendingLittleLink = null;
    if (pending && pending.url === url && pending.generation === tab.generation) { event.preventDefault(); openLittleWindow(win, pending.url); return; }
    guardNavigation(event, url);
  });
  wc.on('will-redirect', guardNavigation);
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
  wc.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    if (tab.pendingLittleLink) return;
    tab.url = url; tab.generation = (tab.generation || 0) + 1;
    tab.translation = null;
    // Reader 只属于发起它的标签页：无关后台标签页的导航不能打断正在阅读的文章。
    if (win.reader && win.readerSource?.tabID === tab.id) closeReader(win, false);
    sendState(win);
  });
  wc.on('did-navigate', (_, url) => { tab.loadFailed = false; tab.url = url; sendState(win); if (!win.little) saveSession(); });
  wc.on('did-navigate-in-page', (_, url, isMainFrame) => { if (isMainFrame) { tab.url = url; recordHistory(tab); offerStoreInstall(tab); sendState(win); if (!win.little) saveSession(); } });
  wc.on('page-title-updated', (event, title) => { event.preventDefault(); tab.title = title.slice(0, 1000) || '新标签页'; sendState(win); });
  wc.on('page-favicon-updated', (_, icons) => { tab.favicon = icons[0] || ''; if (!win.private && tab.favicon) adoptFavoriteIcon(tab); sendState(win); });
  wc.on('did-finish-load', () => { tab.url = wc.getURL(); recordHistory(tab); offerStoreInstall(tab); sendState(win); });
  wc.on('did-start-loading', () => sendState(win)); wc.on('did-stop-loading', () => sendState(win));
  wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // Downloads and superseded navigations normally abort.
    tab.loadFailed = true; tab.url = wc.getURL() || tab.url; tab.title = wc.getTitle() || tab.title; sendState(win);
    if (tab.view.getVisible()) win.shell.webContents.send('arco:command', 'navigation-failed');
  });
  wc.on('audio-state-changed', () => sendState(win));
  wc.on('ipc-message', (event, channel, payload) => {
    if (event.senderFrame !== wc.mainFrame || !win.tabs.has(tab.id)) return;
    if (channel === 'arco:page-link') { if (!win.little && library.settings.linkOpenMode === 'little' && typeof payload?.url === 'string' && isHTTP(payload.url)) tab.pendingLittleLink = { url: payload.url, generation: tab.generation }; return; }
    if (channel === 'arco:page-peek') { if (typeof payload?.url === 'string' && isHTTP(payload.url)) openPeek(win, payload.url); return; }
    if (channel === 'arco:page-split') { const other=win.tabs.get(payload?.id);if(other&&other.spaceID===win.spaceID&&other.id!==win.activeID){if(win.splitID)toggleSplit(win);toggleSplit(win,other.id);} return; }
    if (channel !== 'arco:page-password' || win.private) return;
    const origin = safeCaptureOrigin(event.senderFrame.url); if (!origin || payload?.origin !== origin) return;
    if (!payload || typeof payload.password !== 'string' || !payload.password || payload.password.length > 4096 || typeof payload.username !== 'string' || payload.username.length > 1024) return;
    win.capture = { tabID: tab.id, origin, username: payload.username, password: payload.password }; sendState(win);
  });
  wc.on('context-menu', (_, params) => Menu.buildFromTemplate(pageMenu(win, wc, params)).popup());
  // 分屏里点哪一侧就只操作哪一侧：鼠标按下先于页面焦点事件，直接记录实际窗格。
  const visiblePane = () => win.tabs.get(tab.id) === tab && (tab.id === win.activeID || tab.id === win.splitID);
  wc.on('before-mouse-event', (event, mouse) => {
    if (mouse.type !== 'mouseDown' || win.isDestroyed() || !visiblePane()) return;
    if (win.focusedPaneID !== tab.id || win.peekFocused) {
      if (win.find && (win.find.targetKind !== 'tab' || win.find.targetID !== tab.id)) resetFind(win, false);
      win.focusedPaneID = tab.id; win.peekFocused = false; sendState(win);
    }
  });
  wc.on('focus', () => {
    // 后台标签页也可能拿到焦点（脚本、测试驱动）；只有当前可见的窗格才能接管命令目标。
    if (!win.isDestroyed() && visiblePane() && (win.focusedPaneID !== tab.id || win.peekFocused)) {
      if (win.find && (win.find.targetKind !== 'tab' || win.find.targetID !== tab.id)) resetFind(win, false);
      win.focusedPaneID = tab.id; win.peekFocused = false; sendState(win);
    }
  });
  wc.on('found-in-page', (_, result) => noteFindResult(win, wc, result));
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && win.peek) { closePeek(win); event.preventDefault(); }
    else if (pageShortcut(win, input)) event.preventDefault();
  });
}
function extensionBrowser(windowID) {
  const ordinary = [...windows].filter(win => !win.private && !win.little && !win.isDestroyed());
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
  if (!id || !tab.view || tab.view.webContents.isDestroyed()) return;
  tab.view.webContents.executeJavaScript(storeBannerScript(id), true).catch(() => {});
}
async function installFromStore(win, input) {
  if (win.private) error('无痕窗口不能安装扩展');
  const result = await library.installFromStore(input, testMode ? async () => testStoreApproval : async asked => {
    const detail = [`权限：${asked.permissions.join('、') || '无'}`, asked.optional.length ? `可选权限：${asked.optional.join('、')}` : '', '扩展签名、扩展 ID 与包内容已在本机校验。'].filter(Boolean).join('\n');
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
  const previous = win.tabs.get(win.activeID);
  if (previous && previous !== tab && previous.view && !previous.view.webContents.isDestroyed()) { previous.view.webContents.closeDevTools(); closeDockedDevTools(win, previous.view.webContents); }
  resetFind(win, false); closePeek(win); closeReader(win, false);
  for (const other of win.tabs.values()) removePageView(win, other);
  win.activeID = tabID; win.focusedPaneID = tabID; win.peekFocused = false; win.spaceID = tab.spaceID; win.lastActive.set(tab.spaceID,tabID); win.splitID = null;
  if (!tab.view) wakeTab(win, tab);
  addPageView(win, tab, true); if (!win.private) extensionHost.select(tab.view.webContents); layout(win); sendState(win); if (!win.little) saveSession();
  if (!win.overlay) (tab.url ? tab.view.webContents : win.shell.webContents).focus();
}
function switchSpace(win, spaceID) {
  if (!library.space(spaceID) || win.private) error('空间不存在');
  resetFind(win, false); closePeek(win); win.spaceID = spaceID; win.splitID = null;
  const remembered = win.tabs.get(win.lastActive.get(spaceID));
  const tab = remembered?.spaceID === spaceID ? remembered : [...win.tabs.values()].find(t => t.spaceID === spaceID);
  for (const other of win.tabs.values()) removePageView(win, other);
  win.activeID = null;
  if (tab) selectTab(win, tab.id); else createTab(win, '', { select: true });
  broadcast();
}
function closeTab(win, tabID) {
  const tab = win.tabs.get(tabID); if (!tab) return;
  // 关闭 Reader 的来源标签页才退出文章；关闭无关后台标签页不影响阅读。
  if (win.reader && win.readerSource?.tabID === tabID) closeReader(win, false);
  if (win.find?.targetKind === 'tab' && win.find.targetID === tabID) resetFind(win, false);
  const wasActive = win.activeID === tabID; if (tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents.isDevToolsOpened()) { tab.view.webContents.closeDevTools(); closeDockedDevTools(win); }
  win.tabs.delete(tabID); removePageView(win, tab); if (tab.view) tab.view.webContents.close();
  if (!win.private && !win.little && isHTTP(tab.url)) closedTabs.push({ url: tab.url, title: tab.title, spaceID: tab.spaceID, closedAt: core.now() });
  if (win.splitID === tabID) win.splitID = null;
  if (win.focusedPaneID === tabID) win.focusedPaneID = win.activeID && win.tabs.has(win.activeID) ? win.activeID : null;
  if (wasActive) {
    win.activeID = null;
    // 关闭聚焦的次级窗格时，另一个窗格接管为主窗格，而不是跳到空间里第一个标签页。
    const split = win.tabs.get(win.splitID);
    const next = split && split.spaceID === win.spaceID ? split : [...win.tabs.values()].find(t => t.spaceID === win.spaceID);
    if (next) selectTab(win, next.id); else if (win.little) win.close(); else createTab(win, '', { select: true });
  }
  else if (!win.focusedPaneID) win.focusedPaneID = win.activeID;
  sendState(win); if (!win.little) saveSession();
}
function reopenTab(win) { const closed = closedTabs.pop(); if (closed) createTab(win, closed.url, { spaceID: library.space(closed.spaceID)?.id || win.spaceID, title: closed.title, select: true }); }
function toggleSplit(win, tabID) {
  resetFind(win, false);
  if (win.splitID) { const previous = win.tabs.get(win.splitID); if (previous) removePageView(win, previous); win.splitID = null; win.focusedPaneID = win.activeID; }
  else {
    const other = win.tabs.get(tabID || [...win.tabs.values()].find(t => t.spaceID === win.spaceID && t.id !== win.activeID && t.url)?.id);
    if (!other || other.id === win.activeID || other.spaceID !== win.spaceID || !other.url) error('请选择同一空间的另一个网页标签');
    win.splitID = other.id; win.focusedPaneID = win.activeID; if (!other.view) wakeTab(win, other); addPageView(win, other, true);
  }
  layout(win); sendState(win);
}
function openPeek(win, rawURL) {
  const url = core.webURL(rawURL); closePeek(win); resetFind(win, false);
  win.peek = new WebContentsView({ webPreferences: { partition: win.partition, preload: path.join(__dirname, 'page-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, safeDialogs: true } });
  win.contentView.addChildView(win.peek); win.peek.setBorderRadius(14); win.peek.setBackgroundColor('#ffffffff'); win.peekURL = url; win.peekFocused = true;
  const wc = win.peek.webContents;
  const updateURL = next => { win.peekURL = next; sendState(win); };
  const listeners = {
    'before-input-event': (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); closePeek(win); } else if (pageShortcut(win, input)) event.preventDefault(); },
    'will-navigate': (event, next) => { if (!isHTTP(next)) event.preventDefault(); },
    'did-start-loading': () => sendState(win),
    'did-stop-loading': () => sendState(win),
    'did-navigate': (_, next) => updateURL(next),
    'did-navigate-in-page': (_, next, isMainFrame) => { if (isMainFrame) updateURL(next); },
    'page-title-updated': event => { event.preventDefault(); sendState(win); },
    'found-in-page': (_, result) => noteFindResult(win, wc, result),
    focus: () => {
      if (win.isDestroyed() || win.peek?.webContents !== wc) return;
      if (win.find && win.find.targetKind !== 'peek') resetFind(win, false);
      win.peekFocused = true; sendState(win);
    }
  };
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  trackPasskeyDocument(wc);
  for (const [name, listener] of Object.entries(listeners)) if (listener) wc.on(name, listener);
  win.peekListeners = listeners;
  wc.loadURL(url).catch(() => {}); layout(win); sendState(win);
}
function detachPeekListeners(win) {
  const wc = win.peek?.webContents;
  if (wc && win.peekListeners) for (const [name, listener] of Object.entries(win.peekListeners)) if (listener) wc.off(name, listener);
  win.peekListeners = null;
}
function closePeek(win) {
  if (win.peek) {
    if (win.find?.targetKind === 'peek') resetFind(win, false);
    detachPeekListeners(win); win.contentView.removeChildView(win.peek); win.peek.webContents.close();
    win.peek = null; win.peekURL = ''; win.peekFocused = false; sendState(win);
  }
}
function promoteLittleWindow(win) {
  if (!win.little) error('当前窗口不是小窗口');
  const tab = findTab(win), url = tab.view?.webContents.getURL() || tab.url;
  if (!isHTTP(url)) error('请先打开一个网页');
  const owner = win.littleOwner && !win.littleOwner.isDestroyed() ? win.littleOwner : [...windows].find(w => !w.private && !w.little && !w.isDestroyed()) || createWindow(false);
  createTab(owner, url, { spaceID: owner.spaceID, select: true });
  if (owner.isMinimized()) owner.restore();
  owner.focus(); win.close();
}
function promotePeek(win) {
  if (!win.peek) return;
  const view = win.peek, wc = view.webContents, url = wc.getURL() || win.peekURL, title = wc.getTitle();
  if (win.find?.targetKind === 'peek') resetFind(win, false);
  detachPeekListeners(win); win.contentView.removeChildView(view);
  win.peek = null; win.peekURL = ''; win.peekFocused = false;
  createTab(win, url, { view, title, select: true });
}
function showPalette(win) { win.shell.webContents.send('arco:command', 'palette'); }
async function confirmExternal(win, url) {
  const result = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '打开'], defaultId: 0, cancelId: 0, message: '允许打开外部应用？', detail: url.slice(0, 500) });
  if (result.response === 1) await shell.openExternal(url);
}
function findTab(win, id) {
  const focused = win.tabs.get(win.focusedPaneID);
  const visible = focused && (focused.id === win.activeID || focused.id === win.splitID) ? focused.id : win.activeID;
  const requested = id || visible;
  const tab = win.tabs.get(requested); if (!tab) error('标签页不存在'); return tab;
}
// 需要真实渲染进程的命令（导航、前进后退、开发者工具）先唤醒休眠的标签页。
function awakeTab(win, id) { const tab = findTab(win, id); if (!tab.view) wakeTab(win, tab); return tab; }
// 页面命令（查找、缩放、打印、截图、刷新）共用同一个目标：Peek 在最上层，其次是阅读视图，最后是聚焦窗格。
function commandTarget(win) {
  if (win.peek && !win.peek.webContents.isDestroyed()) return { wc: win.peek.webContents, targetKind: 'peek', targetID: 'peek' };
  if (win.reader && win.readerView && !win.readerView.webContents.isDestroyed()) return { wc: win.readerView.webContents, targetKind: 'reader', targetID: 'reader' };
  const tab = findTab(win);
  return { wc: tab.view.webContents, targetKind: 'tab', targetID: tab.id, tab };
}
function runFind(win, query, options = {}) {
  const text = bounded(query, 500);
  if (!text.trim()) { resetFind(win); return null; }
  // Electron 的 findNext=true 表示开始新的查找会话，false 才是继续上一次查询。
  const target = commandTarget(win), requestID = target.wc.findInPage(text, { forward: options.forward !== false, findNext: !options.findNext });
  win.find = { ...target, requestID, query: text, matches: null, active: 0 };
  sendState(win); return requestID;
}
function findAgain(win, forward) { if (win.find?.query) runFind(win, win.find.query, { forward, findNext: true }); }
function publicAuth(request) { return { id: request.id, origin: request.origin, host: request.host, port: request.port, realm: request.realm, proxy: request.proxy, retry: request.retry }; }
function advanceAuthQueue(win) {
  if (win.isDestroyed()) return;
  win.httpAuth = win.httpAuthQueue.find(request => !request.done) || null;
  sendState(win);
}
function finishAuthRequest(request, username, password) {
  if (!request || request.done) return false;
  request.done = true; request.cleanup();
  const win = request.win;
  if (win.httpAuth === request) win.httpAuth = null;
  win.httpAuthQueue = win.httpAuthQueue.filter(item => item !== request);
  try {
    if (typeof username === 'string' && typeof password === 'string') request.callback(username, password);
    else request.callback();
  } finally {
    username = ''; password = '';
    if (!win.isDestroyed()) advanceAuthQueue(win);
  }
  return true;
}
function cancelAuthForWindow(win) {
  for (const request of [...win.httpAuthQueue]) finishAuthRequest(request);
  win.httpAuth = null; win.httpAuthQueue = [];
}
function cancelAuthForWebContents(wc) {
  for (const win of windows) for (const request of [...win.httpAuthQueue]) if (request.wc === wc) finishAuthRequest(request);
}
function queueAuthRequest(win, wc, challenge, callback) {
  if (win.httpAuthQueue.length >= 20) return callback();
  const id = core.id(), request = { id, win, wc, callback, done: false, ...challenge, cleanup: () => {} };
  const cancel = () => finishAuthRequest(request);
  const destroyed = () => cancel();
  const navigated = (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) cancel(); };
  const closed = () => cancel();
  wc.once('destroyed', destroyed); wc.on('did-start-navigation', navigated); win.once('closed', closed);
  request.cleanup = () => { wc.off('destroyed', destroyed); wc.off('did-start-navigation', navigated); win.off('closed', closed); };
  win.httpAuthQueue.push(request);
  if (!win.httpAuth) advanceAuthQueue(win);
}
function handleLogin(event, wc, details, authInfo, callback) {
  event.preventDefault();
  if (!wc || wc.isDestroyed() || !['basic', 'digest'].includes(String(authInfo?.scheme || '').toLowerCase())) return callback();
  const win = ownerForWebContents(wc);
  if (!win) return callback();
  let origin;
  try {
    origin = authInfo.isProxy ? `${details.url ? new URL(details.url).protocol : 'http:'}//${authInfo.host}:${authInfo.port}` : new URL(details.url).origin;
    if (!authInfo.isProxy) {
      const pageURL = pageURLForWebContents(win, wc);
      if (isHTTP(pageURL) && new URL(pageURL).origin !== origin) return callback();
    }
  } catch { return callback(); }
  queueAuthRequest(win, wc, { origin, host: String(authInfo.host || '').slice(0, 255), port: Number(authInfo.port) || 0, realm: String(authInfo.realm || '').slice(0, 500), proxy: !!authInfo.isProxy, retry: details.firstAuthAttempt === false }, callback);
}
function setupSession(ses) {
  ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'gesture-preload.js') });
  const grants = new Set();
  const testGrants = testMode && process.env.ARCO_TEST_PERMISSION_GRANTS ? JSON.parse(process.env.ARCO_TEST_PERMISSION_GRANTS) : [];
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const win = ownerForWebContents(wc);
    let origin; try { origin = core.exactOrigin(details.requestingUrl); } catch { return callback(false); }
    if (!win || origin !== new URL(wc.getURL()).origin || !['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)) return callback(false);
    const key = origin + '|' + permission;
    if (grants.has(key)) return callback(true);
    const testGrant = Array.isArray(testGrants) && testGrants.find(grant => grant?.origin === origin && grant?.permission === permission);
    if (testGrant) { if (testGrant.allow === true) grants.add(key); return callback(testGrant.allow === true); }
    const names = { media: '相机或麦克风', geolocation: '位置', notifications: '通知', 'clipboard-read': '读取剪贴板', 'clipboard-sanitized-write': '写入剪贴板' };
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['拒绝', '本次会话允许'], defaultId: 0, cancelId: 0, message: '允许 ' + origin + ' 使用' + names[permission] + '？' });
    if (choice === 1) grants.add(key); callback(choice === 1);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => { try { return !!wc && !!ownerForWebContents(wc) && grants.has(new URL(origin).origin + '|' + permission); } catch { return false; } });
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (library.settings.trackerBlocking && details.resourceType !== 'mainFrame' && matchesTracker(details.url)) { trackerCount++; return callback({ cancel: true }); }
    callback({});
  });
  ses.on('will-download', (_, item, wc) => {
    const owner = ownerForWebContents(wc);
    if (!owner) { item.cancel(); return; }
    const record = { id: core.id(), windowID: owner.id, private: owner.private, filename: item.getFilename(), path: '', total: item.getTotalBytes(), received: 0, state: 'progressing', startedAt: core.now(), item };
    downloads.set(record.id, record);
    item.on('updated', (_, state) => {
      if (!downloads.has(record.id) || record.failure) return;
      record.received = item.getReceivedBytes(); record.total = item.getTotalBytes(); record.state = item.isPaused() ? 'paused' : state; record.path = item.getSavePath(); broadcast(); dockProgress();
    });
    // 终态监听在设置保存位置之前注册：初始化失败也必须走到确定的终态清理。
    item.once('done', (_, state) => {
      if (!downloads.has(record.id)) { releaseDownloadPath(record.path); return; }
      if (!record.failure) record.state = state;
      record.item = null; record.path = item.getSavePath(); releaseDownloadPath(record.path);
      persistDownloads(); broadcast(); dockProgress();
    });
    // 明确指定保存位置：不弹出阻塞式系统对话框，也不覆盖已有文件。
    const folder = downloadDirectory();
    let savePath = '';
    try {
      savePath = uniqueDownloadPath(folder, record.filename);
      // 保存位置必须留在下载目录内；越界路径直接拒绝。
      if (path.resolve(savePath) !== savePath || !path.resolve(savePath).startsWith(path.resolve(folder) + path.sep)) throw new Error('下载路径无效');
      item.setSavePath(savePath);
      record.path = item.getSavePath();
    } catch {
      // 目录创建/同名序号耗尽/setSavePath 失败：释放已预留的名字，丢掉失效 DownloadItem，广播真实失败状态。
      releaseDownloadPath(savePath);
      record.failure = true; record.state = 'interrupted'; record.item = null; record.path = '';
      item.cancel(); persistDownloads(); broadcast(); return;
    }
    broadcast();
  });
}
// 常驻网站的图标只存地址会被网站的 404/204/防盗链拖死，所以取到字节后存成 data URL；
// 地址失效时再从首页的 <link rel="icon"> 重新解析一次。
// 站点（尤其 Cloudflare 前置的）会按 UA 拦截 Electron 默认 UA，取图标时用去掉 Electron 标记的浏览器 UA。
const iconUserAgent = () => session.fromPartition(normalSession).getUserAgent().replace(/\sElectron\/[\d.]+/i, '');
const iconFetch = (url, init = {}) => session.fromPartition(normalSession).fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': iconUserAgent() } });
const ICON_MAX = 256 * 1024, ICON_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|bmp|avif)$/;
// 有些站点会用 image/* 的内容类型返回错误页，按魔数确认真的是图片，避免把 HTML 缓存成图标。
function looksLikeImage(type, bytes) {
  const head = bytes.subarray(0, 16), text = bytes.subarray(0, 1024).toString('utf8');
  if (type === 'image/png') return head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG';
  if (type === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8;
  if (type === 'image/gif') return head.subarray(0, 3).toString('latin1') === 'GIF';
  if (type === 'image/webp') return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  if (type === 'image/bmp') return head.subarray(0, 2).toString('latin1') === 'BM';
  if (type === 'image/avif') return head.subarray(4, 8).toString('latin1') === 'ftyp';
  if (/x-icon|vnd\.microsoft\.icon/.test(type)) return head[0] === 0 && head[1] === 0 && (head[2] === 1 || head[2] === 2) && head[3] === 0;
  if (type === 'image/svg+xml') return /<svg[\s>]/i.test(text);
  return false;
}
async function iconData(raw) {
  if (typeof raw !== 'string') return '';
  if (/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(raw)) return raw.length <= ICON_MAX * 2 ? raw : '';
  if (!/^https?:\/\//.test(raw)) return '';
  try {
    const response = await iconFetch(raw, { redirect: 'follow', signal: AbortSignal.timeout(6000) });
    if (!response.ok) return '';
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ICON_TYPES.test(type)) return '';
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length && bytes.length <= ICON_MAX && looksLikeImage(type, bytes) ? `data:${type};base64,${bytes.toString('base64')}` : '';
  } catch { return ''; }
}
async function favoriteIcons(favorite) {
  const candidates = [favorite.favicon, new URL(favorite.url).origin + '/favicon.ico'];
  try {
    // 用文档导航的请求头取首页：部分站点（Cloudflare 前置）会按 Sec-Fetch-* 判浏览器请求。
    const response = await iconFetch(favorite.url, { signal: AbortSignal.timeout(6000), headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none', 'Upgrade-Insecure-Requests': '1' } });
    if (response.ok) {
      const html = (await response.text()).slice(0, 512 * 1024);
      for (const tag of html.matchAll(/<link[^>]+rel=["']?[^"'>]*icon[^"'>]*["']?[^>]*>/gi)) {
        const href = tag[0].match(/href=["']([^"']+)["']/i)?.[1];
        if (href) candidates.push(new URL(href, favorite.url).href);
      }
    }
  } catch {}
  return candidates.filter((value, index, all) => value && all.indexOf(value) === index);
}
async function cacheFavoriteIcon(favorite) {
  if (!favorite) return false;
  const stored = library.data.favorites.find(item => item.url === favorite.url);
  if (!stored || stored.favicon?.startsWith('data:image/')) return false;
  for (const candidate of await favoriteIcons(favorite)) {
    const data = await iconData(candidate);
    if (!data) continue;
    if (data !== stored.favicon) library.setFavoriteIcon(favorite.url, data);
    broadcast(); return true;
  }
  return false;
}
// 只修真正加载失败的图标：渲染层报告过失败的常驻网站，在页面自己声明图标（含 data URL）时用最准确的来源重试一次。
const brokenIcons = new Set(), iconAttempts = new Set();
function adoptFavoriteIcon(tab) {
  const favorite = library.data.favorites.find(item => item.url === tab.url && brokenIcons.has(item.id) && !item.favicon?.startsWith('data:'));
  if (!favorite || iconAttempts.has(favorite.id)) return;
  iconAttempts.add(favorite.id);
  cacheFavoriteIcon({ ...favorite, favicon: tab.favicon }).catch(() => {});
}
const CHANNELS = new Set(['open-url', 'overlay', 'password-sync-unlock', 'password-sync-lock', 'password-sync-now', 'move-bookmark', 'tab-action', 'item-menu', 'vault-status', 'navigate', 'new-tab', 'close-tab', 'select-tab', 'switch-space', 'back', 'forward', 'reload', 'stop', 'reopen-tab', 'clear-tabs', 'toggle-split', 'split-ratio', 'peek', 'close-peek', 'peek-to-tab', 'toggle-sidebar', 'sidebar-width', 'add-space', 'update-space', 'remove-space', 'add-bookmark', 'refresh-favorite-icon', 'update-bookmark', 'delete-bookmark', 'add-favorite', 'add-folder', 'update-folder', 'delete-folder', 'import-bookmarks', 'browser-sources', 'migrate-browser-data', 'import-browser', 'chrome-extensions', 'import-chrome-extensions', 'install-extension-store', 'finish-onboarding', 'export-bookmarks', 'connect-sync', 'disconnect-sync', 'sync-now', 'update-settings', 'history-search', 'history-delete', 'little-window', 'little-promote', 'little-close', 'translate', 'history-clear', 'save-page', 'clear-site-data', 'default-browser', 'download-open', 'download-reveal', 'download-cancel', 'download-pause', 'download-resume', 'find', 'find-stop', 'passkey-cancel', 'http-auth-submit', 'http-auth-cancel', 'zoom', 'print', 'pdf', 'devtools', 'screenshot', 'reader', 'private-window', 'open-system-passwords', 'credentials', 'credential-save', 'credential-read', 'credential-delete', 'credential-fill', 'capture-save', 'capture-dismiss', 'generate-password', 'import-passwords', 'export-passwords', 'add-extension', 'remove-extension', 'extension-list', 'extension-toggle', 'extension-popup', 'copy', 'menu', 'confirm-clear']);
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
        // 背景快照只是装饰：等待渲染的页面（例如 401 首帧）不能拖住弹层交互，最多等 400ms。
        if (kind && kind !== 'find' && !win.overlay) {
          const capture = (async () => { for (const tab of win.tabs.values()) if (tab.view?.getVisible()) { try { const image = await tab.view.webContents.capturePage(); snapshots.push({ url: image.toDataURL(), bounds: tab.view.getBounds() }); } catch { /* optional backdrop */ } } })();
          await Promise.race([capture, new Promise(resolve => setTimeout(resolve, 400))]);
        }
        if (generation !== win.overlayGeneration || win.isDestroyed()) return true;
        win.snapshots = kind ? snapshots.slice() : [];
        win.overlay = kind; layout(win); if (kind && kind !== 'capture') win.shell.webContents.focus(); break;
      }
      case 'vault-status': return vault.status();
      case 'history-search': {
        if (testMode && a.gate) await new Promise(resolve => { win.historyGate = resolve; });
        return win.private ? [] : library.history.filter(item => !a.query || `${item.title} ${item.url}`.toLowerCase().includes(bounded(a.query, 500).toLowerCase()));
      }
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
        if (a.action === 'mute' && tab.view) tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted());
        if (a.action === 'pin') { if (!tab.url) error('请先打开网页'); library.addBookmark({ title: tab.title, url: tab.url, spaceID: tab.spaceID }); tab.pinned = true; }
        if (a.action === 'move') { if (!library.space(a.spaceID)) error('空间不存在'); tab.spaceID = a.spaceID; selectTab(win, tab.id); }
        if (a.action === 'reorder') { const entries = [...win.tabs.values()].filter(x => x !== tab); const index = entries.findIndex(x => x.id === a.beforeID); entries.splice(index < 0 ? entries.length : index, 0, tab); win.tabs = new Map(entries.map(x => [x.id, x])); }
        saveSession(); broadcast(); break;
      }
      case 'open-url': { const url = core.webURL(a.url); const existing = [...win.tabs.values()].find(t => t.url === url && t.spaceID === win.spaceID); if (existing) selectTab(win, existing.id); else createTab(win, url); break; }
      // 等待真实导航完成（401 认证等会一直挂到用户处理），但下载/被替换的导航会以错误结束，
      // 那属于 Chromium 的正常结果，不应变成界面错误提示。
      case 'navigate': { const url = core.navigate(bounded(a.input), library.settings.engine); const tab = awakeTab(win, a.tabID); tab.url = url; await tab.view.webContents.loadURL(url).catch(cause => { if (!/ERR_ABORTED|ERR_FAILED/.test(cause?.message || '')) throw cause; }); break; }
      case 'new-tab': if (a.url) createTab(win, a.url, { select: true }); else COMMANDS.newTab.run(win); break;
      case 'close-tab': closeTab(win, bounded(a.id, 128)); break;
      case 'select-tab': selectTab(win, bounded(a.id, 128)); break;
      case 'switch-space': switchSpace(win, bounded(a.id, 128)); break;
      case 'back': awakeTab(win, a.id).view.webContents.navigationHistory.goBack(); break;
      case 'forward': awakeTab(win, a.id).view.webContents.navigationHistory.goForward(); break;
      case 'reload': { const wc = a.id ? awakeTab(win, a.id).view.webContents : commandTarget(win).wc; wc.reload(); break; }
      case 'stop': { const wc = a.id ? awakeTab(win, a.id).view.webContents : commandTarget(win).wc; wc.stop(); break; }
      case 'reopen-tab': reopenTab(win); break;
      case 'clear-tabs': {
        if (win.private) { for (const tab of [...win.tabs.values()].filter(t => t.id !== win.activeID)) closeTab(win, tab.id); break; }
        const keep = new Set(library.space(win.spaceID).bookmarks.map(x => x.url)); for (const tab of [...win.tabs.values()].filter(t => t.spaceID === win.spaceID && !keep.has(t.url) && t.id !== win.activeID)) closeTab(win, tab.id); break;
      }
      case 'toggle-split': toggleSplit(win, a.id); break;
      case 'split-ratio': win.splitRatio = Math.max(0.2, Math.min(0.8, Number(a.ratio) || 0.5)); layout(win); sendState(win); break;
      case 'peek': openPeek(win, bounded(a.url)); break;
      case 'close-peek': closePeek(win); break;
      case 'peek-to-tab': promotePeek(win); break;
      case 'toggle-sidebar': win.sidebarVisible = !win.sidebarVisible; layout(win); sendState(win); break;
      case 'sidebar-width': {
        const width = Math.max(216, Math.min(400, Number(a.width) || 240));
        library.updateSettings(settings => { settings.sidebarWidth = width; });
        for (const window of windows) window.sidebarWidth = width;
        broadcast(); break;
      }
      case 'add-space': { const space = library.addSpace(a.name, a.color); if (a.customColor) library.updateSpace({ id: space.id, customColor: a.customColor }); switchSpace(win, space.id); break; }
      case 'update-space': library.updateSpace(a); broadcast(); break;
      case 'remove-space': { library.removeSpace(a.id); for (const w of windows) { if (w.private) continue; for (const tab of [...w.tabs.values()]) if (!library.space(tab.spaceID)) { removePageView(w, tab); if (tab.view) tab.view.webContents.close(); w.tabs.delete(tab.id); } if (!library.space(w.spaceID)) switchSpace(w, library.data.spaces[0].id); } saveSession(); broadcast(); break; }
      case 'add-bookmark': library.addBookmark({ ...a, spaceID: a.spaceID || win.spaceID }); broadcast(); break;
      case 'update-bookmark': library.updateBookmark(a); broadcast(); break;
      case 'delete-bookmark': library.deleteBookmark(bounded(a.id, 128)); broadcast(); break;
      case 'add-favorite': { const url=core.webURL(a.url), tab=[...win.tabs.values()].find(t=>t.url===url);const item=library.addFavorite({...a,url,favicon:tab?.favicon || ''});broadcast();cacheFavoriteIcon(item).catch(()=>{});return item; }
      case 'refresh-favorite-icon': { const favorite=library.data.favorites.find(x=>x.id===bounded(a.id,128)); if (favorite) { brokenIcons.add(favorite.id); await cacheFavoriteIcon(favorite); } break; }
      case 'add-folder': library.addFolder({ ...a, spaceID: a.spaceID || win.spaceID }); broadcast(); break;
      case 'update-folder': library.updateFolder(a); broadcast(); break;
      case 'delete-folder': library.deleteFolder(bounded(a.id, 128), !!a.removeContents); broadcast(); break;
      case 'import-bookmarks': { const file = a.path || await library.choose('file'); if (file) await library.importFile(file, win.spaceID); broadcast(); break; }
      case 'browser-sources': return browsers.detect();
      case 'migrate-browser-data': {
        if (win.private) error('无痕窗口不能迁移密码或 Cookie');
        if (migrationPending) error('数据迁移正在进行，请稍候');
        const id = bounded(a.id, 200);
        if (!Array.isArray(a.choices) || !a.choices.length || a.choices.some(item => !['passwords', 'cookies'].includes(item))) error('请选择要迁移的数据');
        const accepted = await dialog.showMessageBox(win, { type: 'question', buttons: ['取消', '迁移所选数据'], defaultId: 0, cancelId: 0, message: '将所选浏览器的密码或登录 Cookie 导入 Arco？', detail: '密码将存入本机加密保险库；Cookie 可能让网站在 Arco 中保持登录。已有记录会跳过，原浏览器数据不会修改。随后可能需要批准系统认证及浏览器钥匙串访问。' });
        if (accepted.response !== 1) return null;
        if (migrationPending) error('数据迁移正在进行，请稍候');
        migrationPending = true;
        try { return await browserMigration.migrate(id, a.choices, { vault, cookies: session.fromPartition(normalSession).cookies }); }
        finally { migrationPending = false; }
      }
      case 'import-browser': { const count = await library.importBrowser(bounded(a.id, 200), win.spaceID); broadcast(); return count; }
      case 'chrome-extensions': if (win.private) error('无痕窗口不能管理扩展'); return browsers.chromeExtensions().map(profile => ({ ...profile, extensions: profile.extensions.map(({ source, ...item }) => item) }));
      case 'import-chrome-extensions': if (win.private) error('无痕窗口不能安装扩展'); return await library.importChromeExtensions(bounded(a.profileID, 200), a.ids);
      case 'finish-onboarding': library.updateSettings(settings => { settings.onboarded = true; }); broadcast(); break;
      case 'export-bookmarks': return await library.exportFile(win.spaceID);
      case 'connect-sync': { const folder = testMode && a.path ? bounded(a.path) : await library.choose('directory'); if (folder) { library.updateSettings(settings => { settings.syncFolder = folder; }); passwordSync.lock(); await library.syncNow(); reconcileSpaces(); broadcast(); } break; }
      case 'disconnect-sync': library.updateSettings(settings => { settings.syncFolder = ''; settings.syncStatus = ''; }); passwordSync.lock(); broadcast(); break;
      case 'sync-now': await library.syncNow(); reconcileSpaces(); broadcast(); break;
      case 'update-settings': {
        library.updateSettings(settings => {
          if (a.engine && core.ENGINES[a.engine]) settings.engine = a.engine;
          if (typeof a.trackerBlocking === 'boolean') settings.trackerBlocking = a.trackerBlocking;
          if (['system', 'light', 'dark'].includes(a.theme)) settings.theme = a.theme;
          if (['detach', 'right'].includes(a.devtoolsMode)) settings.devtoolsMode = a.devtoolsMode;
          if (['tab', 'little'].includes(a.linkOpenMode)) settings.linkOpenMode = a.linkOpenMode;
          if (typeof a.frameInset === 'boolean') settings.frameInset = a.frameInset;
        });
        nativeTheme.themeSource = library.settings.theme;
        broadcast(); break;
      }
      case 'history-delete': {
        if (win.private) error('无痕窗口没有历史记录');
        const next = library.history.filter(x => x.id !== a.id);
        core.atomicWrite(library.historyFile, next); library.history = next; broadcast(); break;
      }
      case 'history-clear': {
        if (win.private) error('无痕窗口没有历史记录');
        const span = { hour: 3600e3, day: 86400e3 }[a.range];
        if (!span && a.range !== 'all') error('时间范围无效');
        const cutoff = span ? new Date(Date.now() - span).toISOString() : '';
        const next = cutoff ? library.history.filter(x => x.visitedAt < cutoff) : [];
        // 已关闭标签页没有时间戳；一并清空，避免“恢复关闭的标签页”把刚清掉的网址带回来。
        core.atomicWrite(library.historyFile, next); library.history = next; closedTabs.length = 0; broadcast(); break;
      }
      case 'save-page': { const wc = commandTarget(win).wc; const result = await dialog.showSaveDialog(win, { defaultPath: (wc.getTitle() || 'Arco-Page').replace(/[\/:]/g, '-').slice(0, 100) + '.html', filters: [{ name: '网页', extensions: ['html'] }] }); if (result.filePath) await wc.savePage(result.filePath, 'HTMLComplete'); break; }
      case 'clear-site-data': {
        const wc = commandTarget(win).wc, url = wc.getURL();
        if (!isHTTP(url)) error('当前页面没有网站数据');
        // 只动这个页面所在的会话与来源：存储按 origin 清，Cookie 按“会发给这个地址的”清（含父域 Cookie）。
        await wc.session.clearStorageData({ origin: new URL(url).origin });
        for (const cookie of await wc.session.cookies.get({ url })) await wc.session.cookies.remove(url, cookie.name);
        wc.reload(); break;
      }
      case 'default-browser': if (!app.isPackaged) error('只有打包后的 Arco 才能设为默认浏览器'); app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); break;
      case 'download-open': { const item = allowedDownload(win, a.id); if (item.path && item.state === 'completed') await shell.openPath(item.path); break; }
      case 'download-reveal': { const item = allowedDownload(win, a.id); if (item.path) shell.showItemInFolder(item.path); break; }
      case 'download-cancel': { const item = allowedDownload(win, a.id); if (item.item && ['progressing', 'paused'].includes(item.state)) item.item.cancel(); break; }
      case 'download-pause': { const item = allowedDownload(win, a.id); if (item.item && item.state === 'progressing') { item.item.pause(); item.state = item.item.isPaused() ? 'paused' : item.state; broadcast(); } break; }
      case 'download-resume': { const item = allowedDownload(win, a.id); if (item.item && item.state === 'paused') { item.item.resume(); item.state = 'progressing'; broadcast(); } break; }
      case 'find': runFind(win, a.query, { forward: a.forward !== false, findNext: !!a.findNext }); break;
      case 'find-stop': resetFind(win); break;
      case 'passkey-cancel': {
        // 只取消该窗口、该真实 WebContents 上同一文档的请求；页面内 controller.abort 结束原 Promise。
        const id = bounded(a.id, 128);
        const request = [...passkeyRequests.values()].find(item => item.win === win && item.id === id);
        if (!request) break;
        // 文档代次不符（旧文档的请求）时只丢弃，不下发到新文档。
        if (request.generation !== (passkeyDocuments.get(request.wc) || 0)) { passkeyRequests.delete(request.key); sendState(win); break; }
        passkeyRequests.delete(request.key);
        if (!request.wc.isDestroyed()) request.wc.send('arco:passkey-cancel', { id: request.pageID });
        sendState(win);
        break;
      }
      case 'http-auth-submit': {
        const request = win.httpAuthQueue.find(item => item.id === bounded(a.id, 128));
        if (!request) error('登录请求已结束');
        if (typeof a.username !== 'string' || a.username.length > 1024 || typeof a.password !== 'string' || !a.password || a.password.length > 4096) error('登录信息无效');
        const capture = win.capture;
        finishAuthRequest(request, a.username, a.password);
        if (capture?.tabID === request.tabID) clearCapture(win, capture);
        // 只移除已提交的认证表单；保存密码是独立通知，认证队列的下一项要继续显示。
        if (!win.httpAuth) { win.overlay = ''; win.snapshots = []; layout(win); }
        if (!win.shell.webContents.isDestroyed()) win.shell.webContents.send('arco:command', 'auth-submitted');
        break;
      }
      case 'http-auth-cancel': {
        const request = win.httpAuthQueue.find(item => item.id === bounded(a.id, 128));
        if (request) finishAuthRequest(request); break;
      }
      case 'zoom': { const wc = commandTarget(win).wc; if (a.reset) wc.send('arco:reset-visual-zoom'); wc.setZoomFactor(a.reset ? 1 : Math.max(0.25, Math.min(5, wc.getZoomFactor() + (Number(a.delta) || 0)))); sendState(win); break; }
      case 'print': commandTarget(win).wc.print({}); break;
      case 'pdf': { const result = await dialog.showSaveDialog(win, { defaultPath: 'Arco-Page.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] }); if (result.filePath) fs.writeFileSync(result.filePath, await commandTarget(win).wc.printToPDF({ printBackground: true })); break; }
      case 'devtools': toggleDevTools(win); break;
      case 'screenshot': { const result = await dialog.showSaveDialog(win, { defaultPath: 'Arco-Screenshot.png', filters: [{ name: 'PNG', extensions: ['png'] }] }); if (result.filePath) { const image = await commandTarget(win).wc.capturePage(); fs.writeFileSync(result.filePath, image.toPNG()); } break; }
      case 'reader': {
        if (win.reader) { closeReader(win); return null; }
        const extracted = await readerArticle(win);
        // 提取期间页面可能已经导航、关闭或被替换：旧结果不得覆盖新页面。
        if (win.isDestroyed() || win.tabs.get(extracted.tab.id) !== extracted.tab || (extracted.tab.generation || 0) !== extracted.generation || extracted.wc.isDestroyed() || !isHTTP(extracted.tab.url)) error('页面已变化，已取消阅读视图');
        return openReaderView(win, extracted.article, extracted.tab);
      }
      case 'private-window': createWindow(true); break;
      case 'little-window': return openLittleWindow(win);
      case 'little-promote': return promoteLittleWindow(win);
      case 'little-close': if (win.little) win.close(); break;
      case 'translate': return await translateTab(win);
      case 'open-system-passwords': {
        const failure = await shell.openPath('/System/Applications/Passwords.app');
        if (failure) error(`无法打开 Apple“密码”：${failure}`);
        break;
      }
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
      case 'capture-save': { if (!win.capture) error('没有待保存的密码'); const capture = win.capture; await vault.save({ origin: capture.origin, username: capture.username, password: capture.password }); clearCapture(win, capture); sendState(win); break; }
      case 'capture-dismiss': clearCapture(win, win.capture); sendState(win); break;
      case 'generate-password': return require('node:crypto').randomBytes(24).toString('base64url') + '-A9!';
      case 'import-passwords': {
        if (win.private) error('无痕窗口不能导入密码');
        if (migrationPending) error('数据迁移正在进行，请稍候');
        const file = await library.choose('file'); if (!file) return null;
        if (migrationPending) error('数据迁移正在进行，请稍候');
        migrationPending = true;
        try {
          if (fs.statSync(file).size > 20_000_000) error('CSV 文件过大');
          return await vault.importCredentials(core.parseCSV(fs.readFileSync(file, 'utf8')));
        } finally { migrationPending = false; }
      }
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
  const tab = findTab(win);
  if (!isHTTP(tab.url)) error('请先打开一个网页再使用阅读视图');
  const wc = tab.view.webContents, generation = tab.generation || 0;
  const source = fs.readFileSync(path.join(__dirname, '..', 'resources', 'Readability.js'), 'utf8');
  await wc.executeJavaScript(source + '\n;true', true);
  const article = await wc.executeJavaScript(`(() => { try { const article = new Readability(document.cloneNode(true)).parse(); return article ? {title:article.title,content:article.content,byline:article.byline || '',url:location.href} : null; } catch(e) { return null; } })()`, true);
  if (!article) error('此页面无法生成阅读视图');
  return { article, tab, generation, wc };
}
const READER_CLOSE = 'arco-reader:close';
function readerEscape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// 文章内容来自第三方页面：先去掉脚本、样式和交互元素，CSP 再禁止脚本、表单和框架作为第二道边界。
function readerSanitize(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?(iframe|frame|frameset|object|embed|applet|link|meta|base|form|button|input|select|textarea|svg|math)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}
function readerDocument(article) {
  const title = readerEscape(article.title || '阅读视图');
  const byline = readerEscape(article.byline || (isHTTP(article.url) ? new URL(article.url).hostname : ''));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data:; media-src http: https:; style-src 'unsafe-inline'; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><title>${title}</title><style>:root{color-scheme:light dark}body{margin:0;background:#fbfaf7;color:#232323;font:17px/1.7 -apple-system,"PingFang SC",sans-serif}main{max-width:44rem;margin:0 auto;padding:40px 28px 96px}a{color:#2b5fb4}h1{font-size:2rem;line-height:1.25;margin:22px 0 8px}.byline{color:#6b6b6b;font-size:.9rem;margin:0 0 28px}.back{display:inline-block;font-size:.9rem;text-decoration:none;border:1px solid #d5d2cb;border-radius:999px;padding:6px 14px}img{max-width:100%;height:auto}pre{overflow:auto;background:#f0eee9;padding:12px;border-radius:8px}blockquote{border-left:3px solid #d5d2cb;margin:0;padding-left:16px;color:#555}</style></head><body><main><a class="back" href="${READER_CLOSE}">← 返回网页</a><h1>${title}</h1><p class="byline">${byline}</p><article>${readerSanitize(article.content)}</article></main></body></html>`;
}
function closeReader(win, notify = true) {
  if (!win.reader && !win.readerView) return;
  if (win.find?.targetKind === 'reader') resetFind(win, false);
  const view = win.readerView;
  win.readerView = null; win.reader = false; win.readerSource = null;
  if (view) {
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  if (!win.isDestroyed()) {
    layout(win);
    const tab = win.tabs.get(win.focusedPaneID) || win.tabs.get(win.activeID);
    if (tab && tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus();
    if (notify) sendState(win);
  }
}
function openReaderView(win, article, source = null) {
  closeReader(win, false);
  const view = new WebContentsView({ webPreferences: { partition: win.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.contentView.addChildView(view); view.setBackgroundColor('#fbfaf7ff'); view.setBorderRadius(8);
  win.readerView = view; win.reader = true; win.readerSource = source ? { tabID: source.id, generation: source.generation || 0 } : null;
  const wc = view.webContents;
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape') { event.preventDefault(); closeReader(win); }
    else if (pageShortcut(win, input)) event.preventDefault();
  });
  // 阅读视图只显示这篇文章：内部链接开成普通标签页，其他导航一律不离开文章。
  wc.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url === READER_CLOSE) { closeReader(win); return; }
    if (isHTTP(url)) createTab(win, url, { select: true });
  });
  wc.setWindowOpenHandler(({ url }) => { if (isHTTP(url)) createTab(win, url, { select: true }); return { action: 'deny' }; });
  wc.on('found-in-page', (_, result) => noteFindResult(win, wc, result));
  wc.loadURL('data:text/html;base64,' + Buffer.from(readerDocument(article), 'utf8').toString('base64')).catch(() => {});
  layout(win); sendState(win);
  wc.focus();
  return article;
}
// 页面右键菜单：链接/媒体/选中文字/编辑各自的动作按 Chromium 给出的 params 与 editFlags 启用，扩展的菜单项排在检查元素之前。
const PIP_SCRIPT = `(() => { if (document.pictureInPictureElement) return document.exitPictureInPicture().then(() => true); const videos = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 && !v.disablePictureInPicture); const video = videos.find(v => !v.paused) || videos[0]; return video ? video.requestPictureInPicture().then(() => true) : false; })()`;
function pageMenu(win, wc, params) {
  const template = [], flags = params.editFlags || {}, text = (params.selectionText || '').trim(), separator = { type: 'separator' };
  if (isHTTP(params.linkURL)) template.push(
    { label: '在新标签页打开链接', click: () => createTab(win, params.linkURL, { select: true }) },
    { label: '在 Peek 中预览', click: () => openPeek(win, params.linkURL) },
    { label: '在无痕窗口中打开链接', click: () => createWindow(true, params.linkURL) },
    { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) }, separator);
  const kind = { image: '图像', video: '视频', audio: '音频' }[params.mediaType];
  if (kind && isHTTP(params.srcURL)) template.push(
    { label: `在新标签页打开${kind}`, click: () => createTab(win, params.srcURL, { select: true }) },
    { label: `下载${kind}`, click: () => wc.downloadURL(params.srcURL) },
    ...(params.mediaType === 'image' ? [{ label: '复制图像', click: () => wc.copyImageAt(params.x, params.y) }] : []),
    { label: `复制${kind}地址`, click: () => clipboard.writeText(params.srcURL) });
  if (params.mediaType === 'video') template.push({ label: '画中画', click: () => (params.frame || wc.mainFrame).executeJavaScript(PIP_SCRIPT, true).catch(() => {}) });
  if (kind) template.push(separator);
  if (params.isEditable) template.push({ label: '剪切', role: 'cut', enabled: !!flags.canCut }, { label: '复制', role: 'copy', enabled: !!flags.canCopy }, { label: '粘贴', role: 'paste', enabled: !!flags.canPaste }, { label: '全选', role: 'selectAll', enabled: !!flags.canSelectAll });
  else if (text) template.push({ label: '复制', role: 'copy' });
  if (text) { const engine = core.ENGINES[library.settings.engine] || core.ENGINES.google; template.push({ label: `用 ${engine[0]} 搜索“${text.length > 20 ? text.slice(0, 20) + '…' : text}”`, click: () => createTab(win, engine[1] + encodeURIComponent(text.slice(0, 2000)), { select: true }) }); }
  if (params.isEditable || text) template.push(separator);
  template.push({ label: '后退', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: '前进', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() }, { label: '重新加载', click: () => wc.reload() });
  const extensionItems = extensionHost.contextMenu(wc, params) || [];
  if (extensionItems.length) template.push(separator, ...extensionItems);
  template.push(separator, { label: '检查元素', click: () => wc.inspectElement(params.x, params.y) });
  return template;
}
function closeCurrent(win) { if (win.peek) closePeek(win); else closeTab(win, findTab(win).id); }
// 页面焦点快捷键和原生菜单共用同一张命令表；accelerator 生成菜单项，key/shift 做精确修饰符匹配。
const COMMANDS = {
  newTab: { label: '新建标签页', accelerator: 'CmdOrCtrl+T', run: win => { createTab(win, ''); showPalette(win); } },
  closeTab: { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', run: win => closeCurrent(win) },
  reopenTab: { label: '恢复关闭的标签页', accelerator: 'Shift+CmdOrCtrl+T', run: win => reopenTab(win) },
  palette: { label: '地址与搜索', accelerator: 'CmdOrCtrl+L', run: win => showPalette(win) },
  find: { label: '页内查找', accelerator: 'CmdOrCtrl+F', run: win => win.shell.webContents.send('arco:command', 'find') },
  findNext: { label: '查找下一个', accelerator: 'CmdOrCtrl+G', run: win => findAgain(win, true) },
  findPrevious: { label: '查找上一个', accelerator: 'Shift+CmdOrCtrl+G', run: win => findAgain(win, false) },
  print: { label: '打印', accelerator: 'CmdOrCtrl+P', run: win => commandTarget(win).wc.print({}) }
};
function acceleratorSpec(accelerator) {
  const parts = accelerator.split('+'), key = parts.pop().toLowerCase();
  return { key, shift: parts.includes('Shift'), meta: parts.includes('CmdOrCtrl') };
}
function pageShortcut(win, input) {
  if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return false;
  const key = input.key.toLowerCase();
  for (const command of Object.values(COMMANDS)) {
    const spec = acceleratorSpec(command.accelerator);
    // 精确匹配：Shift+Cmd+W 不关闭标签页，Cmd+Shift+T 才恢复标签页。
    if (spec.meta && spec.key === key && spec.shift === !!input.shift) { command.run(win); return true; }
  }
  return false;
}
function commandItem(win, name) {
  const command = COMMANDS[name];
  return { label: command.label, accelerator: command.accelerator, click: () => command.run(win) };
}
function showAppMenu(win) {
  const active = win.tabs.get(win.activeID), store = win.private ? '' : storeID(active?.url);
  Menu.buildFromTemplate([
    ...(store ? [{ label: '安装此扩展', click: () => installFromStore(win, store).catch(cause => console.error('安装扩展失败:', cause.message)) }, { type: 'separator' }] : []),
    commandItem(win, 'newTab'), commandItem(win, 'closeTab'), commandItem(win, 'reopenTab'), commandItem(win, 'palette'),
    commandItem(win, 'find'), commandItem(win, 'findNext'), commandItem(win, 'findPrevious'),
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
    for(const tab of [...win.tabs.values()])if(!library.space(tab.spaceID)){removePageView(win,tab);if(tab.view)tab.view.webContents.close();win.tabs.delete(tab.id);}
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
  const command = name => ({ label: COMMANDS[name].label, accelerator: COMMANDS[name].accelerator, click: run(COMMANDS[name].run) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label:'文件', submenu:[
      command('newTab'),
      {label:'新建无痕窗口',accelerator:'CmdOrCtrl+Shift+N',click:() => createWindow(true)},
      command('closeTab'),
      command('reopenTab'),
      {label:'关闭窗口',accelerator:'CmdOrCtrl+Shift+W',click:run(w => w.close())},
      command('print')
    ]},
    {role:'editMenu'},
    {label:'浏览',submenu:[
      command('palette'),
      command('find'),
      command('findNext'),
      command('findPrevious'),
      {label:'重新加载',accelerator:'CmdOrCtrl+R',click:run(w => commandTarget(w).wc.reload())},
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
    if(tab.view)template.push({label:tab.view.webContents.isAudioMuted()?'取消静音':'静音标签页',click:()=>{tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted());sendState(win);}});
    template.push({label:'固定为书签',enabled:!!tab.url,click:()=>{library.addBookmark({title:tab.title,url:tab.url,spaceID:tab.spaceID});broadcast();}},
      {label:'添加到常驻网站',enabled:!!tab.url,click:()=>{library.addFavorite({title:tab.title,url:tab.url,favicon:tab.favicon});broadcast();}},
      {label:'移到空间',enabled:!win.private,submenu:library.data.spaces.map(s=>({label:s.name,click:()=>{tab.spaceID=s.id;selectTab(win,tab.id);}}))},
      {label:'复制标签页',enabled:!!tab.url,click:()=>createTab(win,tab.url,{spaceID:tab.spaceID,select:true})},
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
// Only managed, visible page contents can navigate; the shell and background tabs cannot.
ipcMain.on('arco:gesture-navigate', (event, direction) => {
  const wc = event.sender;
  if (!['back', 'forward'].includes(direction) || wc.isDestroyed() || event.senderFrame !== wc.mainFrame) return;
  let owner = null, tab = null;
  for (const win of windows) {
    if (win.isDestroyed() || (win.overlay && win.overlay !== 'find')) continue;
    if (win.peek) { if (win.peek.webContents === wc && win.peek.getVisible()) owner = win; }
    else if (win.readerView) {
      if (win.readerView.webContents === wc && win.readerView.getVisible()) { if (direction === 'back') closeReader(win); return; }
    } else {
      tab = [...win.tabs.values()].find(item => item.view?.webContents === wc && item.view.getVisible() && (item.id === win.activeID || item.id === win.splitID));
      if (tab) owner = win;
    }
    if (owner) break;
  }
  const popup = popupOwners.get(wc.id);
  if (!owner && popup && !popup.popup.isDestroyed() && popup.popup.isVisible()) owner = popup.window;
  if (!owner || owner.isDestroyed()) return;
  const history = wc.navigationHistory;
  if (direction === 'back' ? !history.canGoBack() : !history.canGoForward()) return;
  if (tab) { owner.focusedPaneID = tab.id; owner.peekFocused = false; }
  wc.focus();
  if (direction === 'back') history.goBack(); else history.goForward();
  sendState(owner);
});
// 页面只上报操作状态与 requestID；主进程核实消息所属的页面，通知本身不作为认证成功的证据。
ipcMain.on('arco:passkey-pending', (event, payload) => {
  const wc = event.sender, win = ownerForWebContents(wc), id = payload?.id;
  if (!win || win.isDestroyed() || wc.isDestroyed() || event.senderFrame !== wc.mainFrame) return;
  if (typeof id !== 'string' || !id || id.length > 128) return;
  // Conditional mediation waits silently for field interaction; it is not a modal login request.
  if (payload.conditional === true) return;
  const origin = passkeyOrigin(event.senderFrame);
  if (!origin) return;
  const key = `${wc.id}:${id}`;
  // DOM notifications are untrusted UI hints. Bound their cost and assign shell IDs here,
  // so a page cannot select another page's request for cancellation using a colliding ID.
  if (passkeyRequests.has(key) || [...passkeyRequests.values()].filter(request => request.wc === wc).length >= 8) return;
  passkeyRequests.set(key, { key, win, wc, id: core.id(), pageID: id, origin, generation: passkeyDocuments.get(wc) || 0 });
  sendState(win);
});
// 平台认证器缺失时页面到点会收到 NotSupportedError；这里只负责告诉用户改用密码，5 秒内不重复提示。
ipcMain.on('arco:passkey-unavailable', event => {
  const wc = event.sender, win = ownerForWebContents(wc);
  if (!win || win.isDestroyed() || wc.isDestroyed() || event.senderFrame !== wc.mainFrame) return;
  if (Date.now() - (win.passkeyHintAt || 0) < 5000) return;
  win.passkeyHintAt = Date.now();
  if (!win.shell.webContents.isDestroyed()) win.shell.webContents.send('arco:passkey-unavailable');
});
ipcMain.on('arco:passkey-settled', (event, payload) => {
  const wc = event.sender, id = payload?.id;
  if (wc.isDestroyed() || event.senderFrame !== wc.mainFrame || typeof id !== 'string' || !id || id.length > 128) return;
  const request = passkeyRequests.get(`${wc.id}:${id}`);
  if (!request || request.generation !== (passkeyDocuments.get(wc) || 0) || request.origin !== passkeyOrigin(event.senderFrame)) return;
  passkeyRequests.delete(request.key);
  if (!request.win.isDestroyed()) sendState(request.win);
});

ipcMain.on('arco:page-translate-result', (event, payload) => {
  const wc = event.sender, id = payload?.id;
  if (wc.isDestroyed() || event.senderFrame !== wc.mainFrame || typeof id !== 'string' || !id || id.length > 128) return;
  const request = translationRequests.get(id);
  if (!request || request.wc !== wc) return;
  translationRequests.delete(id); clearTimeout(request.timer);
  if (payload.error) request.reject(new Error(String(payload.error).slice(0, 300)));
  else request.resolve(payload);
});
process.on('unhandledRejection', error => { console.error('Arco 操作失败:', error?.message || '未知错误'); });
app.on('login', handleLogin);
app.whenReady().then(async () => {
  // 双保险：即使 app.exit() 延迟生效，第二个实例也不会创建目录或写入回退书库。
  if (!primaryInstance) return;
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  library = new Library(userData, broadcast); vault = testMode ? new MemoryVault() : new EncryptedVault(userData);
  translator = new Translator();
  if (testMode) translator = {
    async detect(text) { return { source: 'en', text }; },
    async translate(source, texts) { return { texts: texts.map(text => '译:' + text) }; },
    dispose() {}
  };
  loadDownloadRecords();
  passwordSync = new PasswordSync(() => library.settings.syncFolder, library.settings.deviceID);
  setupSession(session.fromPartition(normalSession));
  extensionHost = createExtensionHost({
    userData, ses: session.fromPartition(normalSession),
    isShell(event) { try { return !trustedWindow(event).private; } catch { return false; } },
    attachWindow: attachExtensionWindow,
    createTab: createExtensionTab,
    createWindow: createExtensionWindow,
    selectTab(wc, owner) {
      if (windows.has(owner)) { const tab = [...owner.tabs.values()].find(t => t.view?.webContents === wc); if (tab && owner.activeID !== tab.id) selectTab(owner, tab.id); }
      else if (!owner.isDestroyed()) owner.focus();
    },
    removeTab(wc, owner) {
      if (wc.isDestroyed() || owner.isDestroyed()) return;
      if (windows.has(owner)) { const tab = [...owner.tabs.values()].find(t => t.view?.webContents === wc); if (tab) closeTab(owner, tab.id); }
      else owner.close();
    },
    removeWindow(owner) { if (!owner.isDestroyed()) owner.close(); },
    requestPermissions: async () => false,
  });
  nativeTheme.themeSource = library.settings.theme || 'system';
  installMenu();
  await library.loadExtensions();
  if (![...windows].some(win => !win.private && !win.little)) createWindow(false);
  app.on('activate', () => { if (![...windows].some(w => !w.private && !w.little)) createWindow(false); });
  launched = true; for (const url of pendingURLs.splice(0)) openExternalURL(url);
});
app.on('before-quit', () => { saveSession(); library?.save(); passwordSync?.lock(); translator?.dispose(); vault?.dispose(); });
async function captureComposite(win) {
  const [width,height]=win.getContentSize();
  const base=(await win.shell.webContents.capturePage()).resize({width,height});
  const pixels=base.toBitmap({scaleFactor:1});
  for(const view of [...win.tabs.values()].map(t=>t.view).filter(Boolean).concat(win.peek?[win.peek]:[])) {
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
    if (action === 'views') return [...win.tabs.values()].map(t=>({id:t.id,url:t.url,visible:!!t.view&&t.view.getVisible(),bounds:t.view?t.view.getBounds():null,webContentsID:t.view?t.view.webContents.id:-1}));
    if (action === 'focus-page') { awakeTab(win).view.webContents.focus(); return true; }
    if (action === 'evaluate') return awakeTab(win, payload?.id).view.webContents.executeJavaScript(payload.script, true);
    if (action === 'page-menu') { const template = pageMenu(win, awakeTab(win, payload?.id).view.webContents, payload.params || {}); if (payload.click) template.find(item => item.label === payload.click).click(); return template.map(item => item.label || item.type); }
    if (action === 'windows') return [...windows].map(w => ({ private: w.private, id: w.id, little: !!w.little }));
    if (action === 'devtools-open') return commandTarget(win).wc.isDevToolsOpened() || win.devtoolsTarget === commandTarget(win).wc;
    if (action === 'devtools-contents') { const dock = win.devtoolsDock; return { id: dock?.webContents.id || -1, mode: dock && !dock.webContents.isDestroyed() && win.contentView.children.includes(dock) ? 'right' : 'detach' }; }
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
    if (action === 'arm-save-gate') {
      let release; const pending = new Promise(resolve => { release = resolve; }); const original = vault.save.bind(vault);
      vault.saveWaiting = false; vault.releaseSave = release;
      vault.save = async value => { vault.saveWaiting = true; await pending; vault.save = original; return original(value); };
      return true;
    }
    if (action === 'save-waiting') return !!vault.saveWaiting;
    if (action === 'release-save') { vault.releaseSave?.(); return true; }
    if (action === 'release-history') { win.historyGate?.(); return true; }
    if (action === 'popup-owners') return [...popupOwners.entries()].map(([webContentsID, owner]) => ({ webContentsID, windowID: owner.window.id, partition: owner.partition, private: owner.private, closed: owner.popup.isDestroyed() }));
    if (action === 'store-approval') { testStoreApproval = payload?.allow !== false; return true; }
    if (action === 'auth-queue') return win.httpAuthQueue.map(publicAuth);
    if (action === 'print-target') { const target = commandTarget(win); return { targetKind: target.targetKind, targetID: target.targetID }; }
    if (action === 'press') {
      // 原生等价输入：Playwright 的 CDP 键盘事件不经过 before-input-event，快捷键必须用 sendInputEvent 验证。
      const url = bounded(payload?.url, 65536), key = bounded(payload?.key, 32), modifiers = Array.isArray(payload?.modifiers) ? payload.modifiers.filter(value => ['meta', 'shift', 'control', 'alt'].includes(value)) : [];
      let wc = null;
      for (const tab of win.tabs.values()) if (tab.view && tab.url === url) wc = tab.view.webContents;
      if (!wc && win.peek && win.peekURL === url) wc = win.peek.webContents;
      if (!wc && win.readerView && win.readerView.webContents.getURL() === url) wc = win.readerView.webContents;
      if (!wc) throw new Error('找不到页面目标');
      wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
      return true;
    }
    if (action === 'click') {
      const url = bounded(payload?.url, 65536), x = Math.max(0, Math.min(10000, Number(payload?.x) || 0)), y = Math.max(0, Math.min(10000, Number(payload?.y) || 0));
      let wc = null;
      for (const tab of win.tabs.values()) if (tab.view && tab.url === url) wc = tab.view.webContents;
      if (!wc && win.peek && win.peekURL === url) wc = win.peek.webContents;
      if (!wc) throw new Error('找不到页面目标');
      // 不调用 focus()：这里验证的是“在窗格内按下鼠标”本身是否把命令目标切过去。
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return true;
    }
    throw new Error('Unknown test action');
  });
}
