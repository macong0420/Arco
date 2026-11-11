'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { dialog, shell, app, session, safeStorage } = require('electron');
const core = require('./core');
const browsers = require('./browsers');
const crx = require('./crx');
function requiredName(value, max = 100) { const name = core.text(value, max); if (!name) throw new Error('名称不能为空'); return name; }
// 扩展图标从磁盘读成 data URL：界面 CSP 不放行 file://。
function extensionIcon(directory, manifest) {
  const icons = manifest?.icons && typeof manifest.icons === 'object' ? manifest.icons : {};
  const chosen = ['128', '48', '32', '16'].map(key => icons[key]).find(value => typeof value === 'string' && /\.(png|jpe?g|svg|webp)$/i.test(value));
  if (!chosen) return '';
  const file = path.resolve(directory, chosen);
  if (!file.startsWith(path.resolve(directory) + path.sep)) return '';
  try {
    if (fs.statSync(file).size > 512 * 1024) return '';
    const type = { svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[path.extname(file).slice(1).toLowerCase()] || 'image/png';
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch { return ''; }
}

class Library {
  constructor(userData, notify) {
    this.file = path.join(userData, 'Library.json'); this.sessionFile = path.join(userData, 'Session.json'); this.historyFile = path.join(userData, 'History.json'); this.notify = notify;
    const fresh = !fs.existsSync(this.file);
    const loaded = core.loadJSON(this.file, core.initialLibrary(), core.validateLibrary);
    this.data = loaded.data; this.warning = loaded.warning;
    this.settings = { ...core.initialLibrary().settings, ...this.data.settings };
    // 只有全新安装才弹首次引导；已有数据的升级用户已经用过了，不再打扰。
    if (typeof this.settings.onboarded !== 'boolean') this.settings.onboarded = fresh;
    if (!/^[\w-]{1,128}$/.test(this.settings.deviceID || '')) this.settings.deviceID = core.id();
    this.settings.sidebarWidth = Math.max(216, Math.min(400, Number(this.settings.sidebarWidth) || 240));
    this.data.settings = this.settings;
    this.syncing = false;
  }
  save() { core.atomicWrite(this.file, this.data); }
  change() { this.data.updatedAt = core.now(); this.save(); this.notify(); }
  commit(mutate) {
    const next = structuredClone(this.data), result = mutate(next);
    next.settings = this.settings; core.validateLibrary(next); this.data = next; this.change(); return result;
  }
  space(spaceID) { return this.data.spaces.find(x => x.id === spaceID); }
  addSpace(name, color = 'sky') {
    return this.commit(data => {
      const item = core.stamp({ id: core.id(), name: name === undefined || name === null || name === '' ? `空间 ${data.spaces.length + 1}` : requiredName(name, 100), color, customColor: '', bookmarks: [], folders: [] });
      data.spaces.push(item); core.reorder(data.spaces); return item;
    });
  }
  updateSpace(value) {
    return this.commit(data => {
      const space = data.spaces.find(x => x.id === value.id); if (!space) throw new Error('空间不存在');
      if (value.name !== undefined) space.name = requiredName(value.name, 100);
      if (value.color !== undefined) { if (!['sky', 'lavender', 'rose', 'peach', 'sand', 'sage', 'mint', 'white', 'graphite'].includes(value.color)) throw new Error('颜色无效'); space.color = value.color; space.customColor = ''; }
      if (value.customColor !== undefined) { if (value.customColor && !/^#[\da-f]{6}$/i.test(value.customColor)) throw new Error('自定义颜色无效'); space.customColor = value.customColor; }
      space.updatedAt = core.now(); return space;
    });
  }
  removeSpace(spaceID) {
    this.commit(data => {
      if (data.spaces.length < 2) throw new Error('至少保留一个空间');
      const space = data.spaces.find(x => x.id === spaceID); if (!space) throw new Error('空间不存在');
      core.deleteRecords(data, [spaceID, ...space.bookmarks.map(x => x.id), ...space.folders.map(x => x.id)]);
      data.spaces = data.spaces.filter(x => x.id !== spaceID); core.reorder(data.spaces);
    });
  }
  addBookmark(value) {
    return this.commit(data => {
      const space = data.spaces.find(x => x.id === value.spaceID); if (!space) throw new Error('空间不存在');
      if (value.parentID && !space.folders.some(x => x.id === value.parentID)) throw new Error('文件夹不存在');
      const item = core.stamp({ id: core.id(), title: core.text(value.title || value.url, 500), url: core.webURL(value.url), parentID: value.parentID || null });
      space.bookmarks.push(item); core.reorder(space.bookmarks); return item;
    });
  }
  updateBookmark(value) {
    return this.commit(data => {
      for (const space of data.spaces) {
        const item = space.bookmarks.find(x => x.id === value.id);
        if (item) { if (value.title !== undefined) item.title = core.text(value.title, 500); if (value.url !== undefined) item.url = core.webURL(value.url); if (value.parentID !== undefined) item.parentID = value.parentID; item.updatedAt = core.now(); return item; }
      }
      throw new Error('书签不存在');
    });
  }
  deleteBookmark(bookmarkID) { this.commit(data => { core.deleteRecords(data, [bookmarkID]); }); }
  addFavorite(value) {
    return this.commit(data => {
      const url = core.webURL(value.url), existing = data.favorites.find(item => item.url === url);
      if (existing) return existing;
      const title = core.text(value.title || new URL(url).hostname, 500) || new URL(url).hostname;
      const suppliedIcon = typeof value.favicon === 'string' && /^https?:\/\//.test(value.favicon) ? core.webURL(value.favicon) : '';
      const item = core.stamp({ id: core.id(), title, url, favicon: suppliedIcon || new URL(url).origin + '/favicon.ico' });
      data.favorites.push(item); core.reorder(data.favorites); return item;
    });
  }
  addFolder(value) {
    return this.commit(data => {
      const space = data.spaces.find(x => x.id === value.spaceID); if (!space) throw new Error('空间不存在');
      if (value.parentID && !space.folders.some(x => x.id === value.parentID)) throw new Error('上级文件夹不存在');
      const item = core.stamp({ id: core.id(), name: requiredName(value.name, 100), parentID: value.parentID || null, open: true });
      space.folders.push(item); core.reorder(space.folders); return item;
    });
  }
  updateFolder(value) {
    return this.commit(data => {
      for (const space of data.spaces) {
        const folder = space.folders.find(x => x.id === value.id); if (!folder) continue;
        if (value.name !== undefined) folder.name = requiredName(value.name, 100);
        if (value.open !== undefined) folder.open = !!value.open;
        if (value.parentID !== undefined) {
          if (value.parentID === folder.id || this.descendants(space, folder.id).includes(value.parentID)) throw new Error('不能将文件夹移入自身');
          if (value.parentID && !space.folders.some(x => x.id === value.parentID)) throw new Error('上级文件夹不存在');
          folder.parentID = value.parentID;
        }
        folder.updatedAt = core.now(); return folder;
      }
      throw new Error('文件夹不存在');
    });
  }
  descendants(space, folderID) { const found = [], queue = [folderID]; while (queue.length) { const parent = queue.shift(); for (const f of space.folders.filter(x => x.parentID === parent)) { found.push(f.id); queue.push(f.id); } } return found; }
  deleteFolder(folderID, removeContents = false) {
    this.commit(data => {
      for (const space of data.spaces) {
        const folder = space.folders.find(x => x.id === folderID); if (!folder) continue;
        const children = this.descendants(space, folderID);
        if (removeContents) core.deleteRecords(data, [folderID, ...children, ...space.bookmarks.filter(x => [folderID, ...children].includes(x.parentID)).map(x => x.id)]);
        else { for (const b of space.bookmarks) if (b.parentID === folderID) { b.parentID = folder.parentID; b.updatedAt = core.now(); } for (const f of space.folders) if (f.parentID === folderID) { f.parentID = folder.parentID; f.updatedAt = core.now(); } core.deleteRecords(data, [folderID]); }
        return;
      }
      throw new Error('文件夹不存在');
    });
  }
  appendBookmarks(data, items, spaceID, favorite = false) {
    const space = data.spaces.find(x => x.id === spaceID); if (!space && !favorite) throw new Error('空间不存在');
    const folderIDs = new Map((space?.folders || []).map(f => [String(f.parentID || '') + '\0' + f.name, f.id])); let count = 0;
    if (!Array.isArray(items) || items.length > 20000) throw new Error('本次导入超过 20000 条，未保存任何更改');
    for (const entry of items) {
      if (favorite) { if (!data.favorites.some(x => x.url === entry.url)) { data.favorites.push(core.stamp({ id: core.id(), title: entry.title, url: entry.url })); count++; } continue; }
      if (space.bookmarks.some(x => x.url === entry.url)) continue;
      let parentID = null;
      for (const name of entry.folders || []) {
        const key = `${parentID || ''}\0${name}`;
        if (!folderIDs.has(key)) { const folder = core.stamp({ id: core.id(), name, parentID, open: true }); space.folders.push(folder); folderIDs.set(key, folder.id); }
        parentID = folderIDs.get(key);
      }
      space.bookmarks.push(core.stamp({ id: core.id(), title: entry.title, url: entry.url, parentID })); count++;
    }
    if (favorite) core.reorder(data.favorites); else { core.reorder(space.bookmarks); core.reorder(space.folders); }
    return count;
  }
  appendSpaces(data, items) {
    if (!Array.isArray(items) || items.length > 200) throw new Error('本次导入超过 200 个空间，未保存任何更改');
    for (const space of items) {
      let existing = data.spaces.find(x => x.name === space.name);
      if (!existing) {
        existing = core.stamp({ id: core.id(), name: space.name === undefined || space.name === null || space.name === '' ? `空间 ${data.spaces.length + 1}` : requiredName(space.name, 100), color: space.color || 'sky', customColor: '', bookmarks: [], folders: [] });
        if (space.customColor) { if (!/^#[\da-f]{6}$/i.test(space.customColor)) throw new Error('自定义颜色无效'); existing.customColor = space.customColor; }
        data.spaces.push(existing);
      }
      this.appendBookmarks(data, space.bookmarks || [], existing.id, false);
    }
    core.reorder(data.spaces); return items.length;
  }
  importBookmarks(items, spaceID, favorite = false) { return this.commit(data => this.appendBookmarks(data, items, spaceID, favorite)); }
  importSpaces(items) { return this.commit(data => this.appendSpaces(data, items)); }
  async choose(type) {
    const properties = type === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'];
    const result = await dialog.showOpenDialog({ properties, filters: type === 'file' ? [{ name: '书签或密码', extensions: ['json', 'html', 'csv'] }] : undefined });
    return result.canceled ? null : result.filePaths[0];
  }
  async importFile(file, spaceID) {
    if (!file || !path.isAbsolute(file)) throw new Error('请选择文件');
    if(fs.statSync(file).size > 32*1024*1024)throw new Error('导入文件超过 32 MB');
    const raw = fs.readFileSync(file, 'utf8'); const ext = path.extname(file).toLowerCase();
    if (ext === '.html') return this.importBookmarks(core.parseNetscape(raw), spaceID);
    const json = JSON.parse(raw);
    if (json.sidebar || json.sidebarSyncState || json.firebaseSyncState) {
      const spaces = core.parseArcSidebar(json);
      return this.commit(data => { this.appendBookmarks(data, spaces.favorites || [], spaceID, true); return this.appendSpaces(data, spaces); });
    }
    return this.importBookmarks(core.parseChromiumBookmarks(json), spaceID);
  }
  async importBrowser(id, spaceID) {
    const entry = browsers.resolve(String(id || ''));
    if (entry.kind === 'arc') return this.importFile(entry.file, spaceID);
    return this.importBookmarks(entry.items, spaceID);
  }
  async importChromeExtensions(profileID, ids) {
    if (this.installingExtensions) throw new Error('扩展正在安装，请稍候');
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string' || !crx.ID.test(id))) throw new Error('请选择有效的 Chrome 扩展（最多 200 个）');
    const profile = browsers.chromeExtensions().find(profile => profile.id === profileID);
    if (!profile) throw new Error('没有找到这个 Chrome 个人资料');
    if (profile.note) throw new Error(profile.note);
    const ses = session.fromPartition('persist:arco'), results = [];
    this.installingExtensions = true;
    try {
      for (const storeID of new Set(ids)) {
        const item = profile.extensions.find(item => item.id === storeID);
        const known = (this.settings.extensions || []).find(record => record.storeID === storeID);
        let directory, loaded;
        try {
          if (!item || item.error) throw new Error(item?.error || 'Chrome 中没有找到这个扩展');
          if (known) {
            if (known.enabled !== false && !ses.extensions.getExtension(known.id)) await ses.extensions.loadExtension(known.path, { allowFileAccess: false });
            results.push({ id: storeID, name: item.name, already: true }); continue;
          }
          const destination = path.join(path.dirname(this.file), 'Extensions', storeID);
          if (fs.existsSync(destination)) throw new Error('目标目录已存在，未覆盖，请先移除旧扩展再重试');
          directory = destination;
          fs.cpSync(item.source, directory, { recursive: true, force: false, errorOnExist: true, filter: source => {
            if (fs.lstatSync(source).isSymbolicLink()) throw new Error('扩展包含符号链接，无法迁移');
            return true;
          } });
          loaded = await ses.extensions.loadExtension(directory, { allowFileAccess: false });
          if (!ses.extensions.getExtension(loaded.id)) throw new Error('扩展未能加载');
          if (!item.enabled) ses.extensions.removeExtension(loaded.id);
          this.settings.extensions = [...(this.settings.extensions || []), { id: loaded.id, path: directory, storeID, enabled: item.enabled }];
          this.change();
          results.push({ id: storeID, name: loaded.name, version: loaded.version, enabled: item.enabled });
        } catch (error) {
          if (loaded) { ses.extensions.removeExtension(loaded.id); this.settings.extensions = this.settings.extensions.filter(record => record.id !== loaded.id); }
          if (directory) fs.rmSync(directory, { recursive: true, force: true });
          results.push({ id: storeID, name: item?.name || storeID, error: error.message });
        }
      }
    } finally { this.installingExtensions = false; }
    return results;
  }
  async exportFile(spaceID) {
    const result = await dialog.showSaveDialog({ defaultPath: 'Arco-Bookmarks.html', filters: [{ name: 'HTML 书签', extensions: ['html'] }] });
    if (result.canceled || !result.filePath) return false;
    const items = [...this.data.favorites.map(x => ({ ...x, folders: ['共享收藏'] })), ...this.data.spaces.flatMap(space => space.bookmarks.map(item => {
      const folders = []; let folder = space.folders.find(x => x.id === item.parentID);
      while (folder) { folders.unshift(folder.name); folder = space.folders.find(x => x.id === folder.parentID); }
      return { ...item, folders: [space.name, ...folders] };
    }))];
    fs.writeFileSync(result.filePath, core.netscape(items), { mode: 0o600 }); return true;
  }
  moveBookmark(value) {
    this.commit(data => {
      const target = data.spaces.find(x => x.id === value.spaceID); if (!target) throw new Error('空间不存在');
      if (value.parentID && !target.folders.some(x => x.id === value.parentID)) throw new Error('文件夹不存在');
      const from = data.spaces.find(s => s.bookmarks.some(x => x.id === value.id)); if (!from) throw new Error('书签不存在');
      const item = from.bookmarks.find(x => x.id === value.id); from.bookmarks = from.bookmarks.filter(x => x.id !== item.id);
      const index = target.bookmarks.findIndex(x => x.id === value.beforeID); target.bookmarks.splice(index < 0 ? target.bookmarks.length : index, 0, item);
      item.parentID = value.parentID || null; item.updatedAt = core.now();
      core.reorder(from.bookmarks); core.reorder(target.bookmarks);
    });
  }
  async syncNow() {
    if (this.syncing) throw new Error('正在同步');
    const folder = this.settings.syncFolder;
    if (!folder || !path.isAbsolute(folder) || !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error('请先选择有效的同步文件夹');
    this.syncing = true;
    try {
      const directory = path.join(folder, 'Arco-Library'), legacy = path.join(folder, 'Arco-Library.json');
      let next = structuredClone(this.data);
      const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(x => /^[\w-]{1,128}\.json$/.test(x)).map(x => path.join(directory, x)) : [];
      if (fs.existsSync(legacy)) files.push(legacy);
      if (files.length > 500) throw new Error('同步设备记录过多');
      for (const file of files.sort()) {
        try {
          if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('文件过大');
          next = core.mergeLibraries(next, core.validateLibrary(JSON.parse(fs.readFileSync(file, 'utf8'))));
        } catch (error) { throw new Error('同步文件损坏，已停止且未覆盖：' + error.message); }
      }
      next.settings = this.settings;
      core.atomicWrite(path.join(directory, this.settings.deviceID + '.json'), { ...next, settings: {} });
      core.atomicWrite(this.file, next); this.data = next;
      this.settings.syncStatus = '上次同步：' + new Date().toLocaleString('zh-CN'); this.change();
      return this.settings.syncStatus;
    } finally { this.syncing = false; }
  }
  async extensionList() {
    const result = [];
    for (const extension of this.settings.extensions || []) {
      try {
        const loaded = session.fromPartition('persist:arco').extensions.getExtension(extension.id);
        result.push({ id: extension.id, path: extension.path, name: loaded?.name || path.basename(extension.path), version: loaded?.version || '', icon: extensionIcon(extension.path, loaded?.manifest), enabled: !!loaded });
      } catch { result.push({ ...extension, enabled: false }); }
    }
    return result;
  }
  async setExtensionEnabled(extensionID, enabled) {
    const record = (this.settings.extensions || []).find(x => x.id === extensionID);
    if (!record) throw new Error('扩展不存在');
    const ses = session.fromPartition('persist:arco');
    if (enabled) { if (!ses.extensions.getExtension(extensionID)) await ses.extensions.loadExtension(record.path, { allowFileAccess: false }); }
    else ses.extensions.removeExtension(extensionID);
    record.enabled = !!enabled; this.change(); return await this.extensionList();
  }
  async loadExtensions() {
    for (const extension of this.settings.extensions || []) {
      if (extension.enabled === false) continue;
      try { if (fs.existsSync(path.join(extension.path, 'manifest.json'))) await session.fromPartition('persist:arco').extensions.loadExtension(extension.path, { allowFileAccess: false }); } catch (error) { this.settings.syncStatus = `扩展 ${path.basename(extension.path)} 加载失败：${error.message}`; }
    }
  }
  async addExtension() {    const folder = await this.choose('directory'); if (!folder) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    if (!manifest.manifest_version || !manifest.name) throw new Error('不是有效的解压扩展');
    const extension = await session.fromPartition('persist:arco').extensions.loadExtension(folder, { allowFileAccess: false });
    this.settings.extensions = [...(this.settings.extensions || []).filter(x => x.id !== extension.id), { id: extension.id, path: folder }]; this.change(); return extension;
  }
  async removeExtension(extensionID) {
    if (this.installingExtensions) throw new Error('扩展正在安装，请稍候');
    this.installingExtensions = true;
    try {
      const record = (this.settings.extensions || []).find(record => record.id === extensionID);
      session.fromPartition('persist:arco').extensions.removeExtension(extensionID);
      if (record?.storeID && crx.ID.test(record.storeID) && record.path === path.join(path.dirname(this.file), 'Extensions', record.storeID)) fs.rmSync(record.path, { recursive: true, force: true });
      this.settings.extensions = (this.settings.extensions || []).filter(x => x.id !== extensionID); this.change();
    } finally { this.installingExtensions = false; }
  }
  async installFromStore(input, approve = async () => true) {
    if (this.installingExtensions) throw new Error('扩展正在安装，请稍候');
    this.installingExtensions = true;
    try {
      const storeID = crx.extensionID(input);
      const known = (this.settings.extensions || []).find(x => x.storeID === storeID);
      if (known && session.fromPartition('persist:arco').extensions.getExtension(known.id)) return { id: known.id, name: '', already: true };
      const directory = path.join(path.dirname(this.file), 'Extensions', storeID);
      const manifest = await crx.install(storeID, directory);
      // Arco 不校验扩展签名，安装前必须让使用者看到它要什么权限。
      const full = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      const asked = { name: manifest.name, version: manifest.version, permissions: [...(full.permissions || []), ...(full.host_permissions || [])], optional: [...(full.optional_permissions || []), ...(full.optional_host_permissions || [])] };
      if (!(await approve(asked))) { fs.rmSync(directory, { recursive: true, force: true }); return { cancelled: true }; }
      const extension = await session.fromPartition('persist:arco').extensions.loadExtension(directory, { allowFileAccess: false });
      this.settings.extensions = [...(this.settings.extensions || []).filter(x => x.id !== extension.id), { id: extension.id, path: directory, storeID }]; this.change();
      return { id: extension.id, name: extension.name || manifest.name, version: manifest.version, already: false };
    } finally { this.installingExtensions = false; }
  }
}
module.exports = Library;
