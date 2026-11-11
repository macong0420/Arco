'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('./core');
const { ID } = require('./crx');

const LIMIT = 32 * 1024 * 1024;
// 只从这份固定清单里找书签；路径永远不来自界面。
const CHROMIUM = [
  ['chrome', 'Chrome', 'Google/Chrome'],
  ['edge', 'Edge', 'Microsoft Edge'],
  ['brave', 'Brave', 'BraveSoftware/Brave-Browser'],
  ['vivaldi', 'Vivaldi', 'Vivaldi'],
  ['opera', 'Opera', 'com.operasoftware.Opera'],
  ['dia', 'Dia', 'Dia/User Data'],
];
const FIREFOX = [['firefox', 'Firefox', 'Firefox']];
// ARCO_BROWSER_HOME 只用于开发与测试，指向一个假的 home 目录。
const home = () => process.env.ARCO_BROWSER_HOME || os.homedir();
const support = dir => path.join(dir, 'Library', 'Application Support');

function size(file) { try { return fs.statSync(file).size; } catch { return 0; } }
// 权限被拒和不存在要分开：前者要提示授权，后者就是真的没有书签。
function present(dir) { try { fs.statSync(dir); return true; } catch (error) { return error.code !== 'ENOENT' && error.code !== 'ENOTDIR'; } }
function guard(file) {
  const bytes = size(file);
  if (!bytes) { const error = new Error('没有书签文件'); error.missing = true; throw error; }
  if (bytes > LIMIT) throw new Error('书签文件超过 32 MB');
  return file;
}
function permissionError(name) {
  const error = new Error(`macOS 阻止 Arco 读取 ${name} 的数据：在系统设置 → 隐私与安全性 → 完全磁盘访问权限中允许 Arco，然后点「重新检测」；或在 ${name} 中导出书签文件后用「从文件导入」`);
  error.permission = true;
  return error;
}
function chromiumProfiles(root) {
  let order = [], cache = {};
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'))?.profile || {};
    cache = profile.info_cache && typeof profile.info_cache === 'object' ? profile.info_cache : {};
    order = (Array.isArray(profile.profiles_order) ? profile.profiles_order : Object.keys(cache)).filter(name => typeof name === 'string' && /^[\w .-]{1,64}$/.test(name));
  } catch { order = []; }
  if (!order.length) order = ['Default'];
  return order.map(folder => {
    const dir = path.join(root, folder), local = path.join(dir, 'Bookmarks');
    // 开启账号书签同步的 Chrome 只写 AccountBookmarks，不再写 Bookmarks。
    return { folder, dir, label: String(cache[folder]?.name || folder).slice(0, 100), file: size(local) ? local : path.join(dir, 'AccountBookmarks') };
  });
}
function firefoxProfiles(root) {
  let ini = '';
  try { ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8'); } catch { return []; }
  const paths = [], defaults = [];
  let section = '';
  for (const line of ini.split('\n')) {
    const value = line.trim();
    if (value.startsWith('[')) { section = value; continue; }
    const split = value.indexOf('=');
    if (split < 0) continue;
    const key = value.slice(0, split), item = value.slice(split + 1).trim();
    if (section.startsWith('[Install') && key === 'Default') defaults.push(item);
    if (section.startsWith('[Profile') && key === 'Path') paths.push(item);
  }
  return [...defaults, ...paths.filter(item => !defaults.includes(item))]
    .map(item => item.startsWith('/') ? item : path.join(root, item))
    .map(dir => ({ dir, folder: path.basename(dir), label: path.basename(dir).replace(/^[\w]+\./, '').slice(0, 100), file: path.join(dir, 'places.sqlite') }));
}
function readChromium(file) {
  return core.parseChromiumBookmarks(JSON.parse(fs.readFileSync(guard(file), 'utf8')));
}
function readable(file) { try { fs.accessSync(file, fs.constants.R_OK); return true; } catch { return false; } }
function readSafari(file) {
  let xml;
  try {
    xml = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', guard(file)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (cause) {
    if (/没有书签文件|超过/.test(cause.message)) throw cause;
    if (!readable(file)) throw permissionError('Safari');
    throw new Error('Safari 书签文件无法解析');
  }
  return core.parseSafariBookmarks(xml);
}
function readFirefox(file) {
  guard(file);
  // 正在运行的 Firefox 会锁住 places.sqlite，先复制一份到临时目录再只读打开。
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-places-'));
  try {
    for (const suffix of ['', '-wal']) if (size(file + suffix)) fs.copyFileSync(file + suffix, path.join(scratch, 'places.sqlite' + suffix));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(scratch, 'places.sqlite'), { readOnly: true });
    try {
      return core.parseFirefoxTree(db.prepare('SELECT b.id, b.parent, b.type, b.title, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk WHERE b.type IN (1, 2)').all());
    } finally { db.close(); }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
function list(dir = home()) {
  const entries = [];
  for (const [key, name, root] of CHROMIUM) {
    const folder = path.join(support(dir), root);
    if (!fs.existsSync(folder)) continue;
    for (const profile of chromiumProfiles(folder)) if (present(profile.dir)) entries.push({ id: `${key}:${profile.folder}`, name, label: profile.label, kind: 'chromium', file: profile.file });
  }
  for (const [key, name, root] of FIREFOX) {
    const folder = path.join(support(dir), root);
    if (!fs.existsSync(folder)) continue;
    for (const profile of firefoxProfiles(folder)) if (present(profile.dir)) entries.push({ id: `${key}:${profile.folder}`, name, label: profile.label, kind: 'firefox', file: profile.file });
  }
  const safari = path.join(dir, 'Library', 'Safari', 'Bookmarks.plist');
  if (size(safari)) entries.push({ id: 'safari', name: 'Safari', label: 'Safari', kind: 'safari', file: safari });
  const arc = path.join(support(dir), 'Arc', 'StorableSidebar.json');
  if (size(arc)) entries.push({ id: 'arc', name: 'Arc', label: 'Arc', kind: 'arc', file: arc });
  return entries;
}
function read(entry) {
  try {
    if (entry.kind === 'safari') return readSafari(entry.file);
    if (entry.kind === 'firefox') return readFirefox(entry.file);
    return readChromium(entry.file);
  } catch (error) {
    if (error.permission || error.code === 'EPERM' || error.code === 'EACCES') throw permissionError(entry.name);
    throw error;
  }
}
// 给界面用的清单：数量在这里读出来，读不了就带回原因（例如 Safari 缺少完全磁盘访问权限）。
function detect(dir = home()) {
  const found = [];
  for (const entry of list(dir)) {
    let count = 0, note = '';
    if (entry.kind !== 'arc') {
      try { count = read(entry).length; } catch (error) { if (!error.missing) note = error.message; }
    }
    found.push({ id: entry.id, name: entry.name, label: entry.label, kind: entry.kind, count, note });
  }
  return found.sort((a, b) => b.count - a.count);
}
function resolve(id, dir = home()) {
  const entry = list(dir).find(item => item.id === id);
  if (!entry) throw new Error('没有找到这个浏览器的书签');
  return { ...entry, items: entry.kind === 'arc' ? null : read(entry) };
}
// Chrome 的扩展文件按个人资料读取；界面只传资料 ID 与扩展 ID，不接受路径。
function chromeExtensions(dir = home()) {
  const root = path.join(support(dir), 'Google/Chrome');
  if (!present(root)) return [];
  return chromiumProfiles(root).filter(profile => present(profile.dir)).map(profile => {
    const result = { id: `chrome:${profile.folder}`, label: profile.label, extensions: [], note: '' };
    try {
      const settings = {};
      for (const file of ['Preferences', 'Secure Preferences']) {
        try { Object.assign(settings, JSON.parse(fs.readFileSync(path.join(profile.dir, file), 'utf8')).extensions?.settings || {}); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const base = path.join(profile.dir, 'Extensions');
      if (!present(base)) return result;
      for (const id of fs.readdirSync(base).filter(id => ID.test(id))) {
        try {
          const record = settings[id];
          // Chrome 自带的组件扩展不迁移。
          if (record?.location === 5 || record?.location === 10) continue;
          const folder = path.join(base, id);
          const versions = fs.readdirSync(folder).filter(v => /^\d+(?:\.\d+)*(?:_\d+)?$/.test(v)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
          const current = typeof record?.path === 'string' ? path.basename(record.path) : '';
          const version = versions.includes(current) ? current : versions[0];
          if (!version) continue;
          const source = path.join(folder, version);
          if (!fs.realpathSync(source).startsWith(path.join(fs.realpathSync(profile.dir), 'Extensions') + path.sep)) throw new Error('扩展目录包含越界链接');
          const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
          if (!manifest.name || !manifest.version || !manifest.manifest_version) throw new Error('扩展清单不完整');
          let name = manifest.name;
          const key = /^__MSG_(.+)__$/.exec(name)?.[1];
          if (key && /^[\w-]+$/.test(manifest.default_locale || '')) {
            const messages = JSON.parse(fs.readFileSync(path.join(source, '_locales', manifest.default_locale, 'messages.json'), 'utf8'));
            name = messages[key]?.message || name;
          }
          result.extensions.push({ id, name, version: manifest.version, enabled: record?.state === undefined ? !(Array.isArray(record?.disable_reasons) ? record.disable_reasons.length : record?.disable_reasons) : record.state === 1, permissions: [...(manifest.permissions || []), ...(manifest.host_permissions || [])], source });
        } catch (error) {
          result.extensions.push({ id, name: id, error: error.code === 'EPERM' || error.code === 'EACCES' ? permissionError('Chrome').message : error.message });
        }
      }
    } catch (error) { result.note = error.code === 'EPERM' || error.code === 'EACCES' ? permissionError('Chrome').message : `Chrome 扩展读取失败：${error.message}`; }
    return result;
  });
}
module.exports = { detect, resolve, list, chromeExtensions };
