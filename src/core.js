'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENGINES = {
  google: ['Google', 'https://www.google.com/search?q='],
  duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q='],
  bing: ['Bing', 'https://www.bing.com/search?q='],
  baidu: ['百度', 'https://www.baidu.com/s?wd='],
  brave: ['Brave Search', 'https://search.brave.com/search?q=']
};
function webURL(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('地址无效');
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    url.hash = url.hash;
    return url.href;
  } catch { throw new Error('仅支持有效的 HTTP 或 HTTPS 地址'); }
}
function navigate(input, engine = 'google') {
  if (typeof input !== 'string' || !input.trim() || input.length > 8192) throw new Error('请输入网址或搜索内容');
  const text = input.trim();
  if (/^https?:/i.test(text)) return webURL(text);
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^localhost:\d+/i.test(text)) throw new Error('仅支持 HTTP 或 HTTPS 地址');
  if (!/\s/.test(text) && /^(localhost(:\d+)?([/?#]|$)|\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)|\[[a-f\d:]+\](:\d+)?([/?#]|$)|[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]|$))/i.test(text)) {
    return webURL((text.startsWith('localhost') ? 'http://' : 'https://') + text);
  }
  return (ENGINES[engine] || ENGINES.google)[1] + encodeURIComponent(text);
}
function exactOrigin(value, { allowInsecure = false } = {}) {
  const url = new URL(webURL(value));
  if (!allowInsecure && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('非安全 HTTP 网站不能保存或填充密码');
  return url.origin;
}
function originAllowed(saved, current) {
  try { return exactOrigin(saved, { allowInsecure: true }) === exactOrigin(current); } catch { return false; }
}
function id() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function text(value, max = 500) {
  if (typeof value !== 'string' || value.length > max) throw new Error('输入内容无效');
  return value.trim();
}
// 密码是少数不能 trim 的字段：首尾空格属于用户输入的密码本体。
function secret(value, max = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new Error('密码内容无效');
  return value;
}
function stamp(value) { return { ...value, updatedAt: value.updatedAt || now() }; }
function initialLibrary() {
  const space = stamp({ id: 'personal', name: '个人', color: 'sky', customColor: '', bookmarks: [], folders: [] });
  return { version: 1, spaces: [space], favorites: [], tombstones: {}, settings: { engine: 'google', sidebarWidth: 240, frameInset: true, trackerBlocking: true, theme: 'system', syncFolder: '', syncStatus: '', extensions: [] }, updatedAt: now() };
}
function validRecord(record) {
  return record && typeof record.id === 'string' && !['__proto__','constructor','prototype'].includes(record.id) && /^[\w-]{1,128}$/.test(record.id) && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt));
}
const PASTEL = ['sky', 'lavender', 'rose', 'peach', 'sand', 'sage', 'mint', 'white', 'graphite'];
// 远端是共享文件夹里的不可信数据：逐字段白名单校验，拒绝任何协议/循环/越界输入，防脏数据进渲染层。
function validateLibrary(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.spaces) || !data.spaces.length || !Array.isArray(data.favorites) || !data.settings || typeof data.settings !== 'object' || !data.tombstones || typeof data.tombstones !== 'object') throw new Error('书库格式不正确');
  if (data.spaces.length > 200 || data.favorites.length > 20000 || Object.keys(data.tombstones).length > 100000) throw new Error('书库记录数量超出限制');
  for (const space of data.spaces) {
    if (!validRecord(space) || typeof space.name !== 'string' || !space.name.length || space.name.length > 100 || !Array.isArray(space.bookmarks) || !Array.isArray(space.folders)) throw new Error('空间格式不正确');
    if (!PASTEL.includes(space.color) || (space.customColor && !/^#[\da-f]{6}$/i.test(space.customColor))) throw new Error('空间颜色无效');
    if (space.bookmarks.length > 20000 || space.folders.length > 5000) throw new Error('空间记录数量超出限制');
    for (const item of space.bookmarks) if (!validRecord(item) || typeof item.title !== 'string' || item.title.length > 500) throw new Error('书签格式不正确'); else item.url = webURL(item.url);
    for (const item of space.folders) if (!validRecord(item) || typeof item.name !== 'string' || !item.name.length || item.name.length > 100) throw new Error('文件夹格式不正确');
    const folderMap = new Map(space.folders.map(f => [f.id, f]));
    for (const item of [...space.bookmarks, ...space.folders]) if (item.parentID && !folderMap.has(item.parentID)) throw new Error('文件夹上级无效');
    for (const item of space.folders) if (hasCycle(space.folders, item, folderMap)) throw new Error('文件夹层级存在循环或超过 64 层');
  }
  for (const item of data.favorites) if (!validRecord(item) || typeof item.title !== 'string' || item.title.length > 500) throw new Error('收藏格式不正确'); else item.url = webURL(item.url);
  for (const value of Object.values(data.tombstones)) if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('删除记录格式不正确');
  const seen = new Set();
  for (const item of [...data.spaces, ...data.favorites, ...data.spaces.flatMap(s => [...s.bookmarks, ...s.folders])]) {
    if (seen.has(item.id) || (item.order !== undefined && (!Number.isInteger(item.order) || item.order < 0 || item.order > 100000))) throw new Error('书库包含重复记录或无效顺序');
    seen.add(item.id);
  }
  if (typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('书库时间戳无效');
  return data;
}
function hasCycle(folders, start, byID = new Map(folders.map(f => [f.id, f]))) {
  const seen = new Set(); let node = start;
  while (node?.parentID) { if (seen.has(node.id) || seen.size >= 64) return true; seen.add(node.id); node = byID.get(node.parentID); }
  return false;
}
function recordMap(library) {
  const records = new Map();
  for (const [order, item] of library.favorites.entries()) records.set(item.id, { kind: 'favorites', value: { order, ...item } });
  for (const [order, space] of library.spaces.entries()) {
    const { bookmarks, folders, ...metadata } = space;
    records.set(space.id, { kind: 'spaces', value: { order, ...metadata } });
    for (const [index, item] of bookmarks.entries()) records.set(item.id, { kind: 'bookmarks', value: { order: index, ...item }, parent: space.id });
    for (const [index, item] of folders.entries()) records.set(item.id, { kind: 'folders', value: { order: index, ...item }, parent: space.id });
  }
  return records;
}
function mergeLibraries(local, remote) {
  validateLibrary(local); validateLibrary(remote);
  const a = recordMap(local), b = recordMap(remote), tombstones = {};
  for (const key of new Set([...Object.keys(local.tombstones), ...Object.keys(remote.tombstones)]))
    Object.defineProperty(tombstones, key, { value: [local.tombstones[key], remote.tombstones[key]].filter(Boolean).sort().pop(), enumerable: true });
  const winners = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(key), right = b.get(key);
    const choice = !left ? right : !right ? left : left.value.updatedAt !== right.value.updatedAt
      ? (left.value.updatedAt > right.value.updatedAt ? left : right)
      : (JSON.stringify(canonicalRecord(left)) < JSON.stringify(canonicalRecord(right)) ? left : right);
    if (!tombstones[key] || tombstones[key] < choice.value.updatedAt) winners.push(choice);
  }
  winners.sort((x, y) => (x.value.order || 0) - (y.value.order || 0) || x.value.id.localeCompare(y.value.id));
  const result = { version: 1, settings: { ...local.settings }, updatedAt: now(), tombstones,
    spaces: winners.filter(x => x.kind === 'spaces').map(x => ({ ...x.value, bookmarks: [], folders: [] })), favorites: [] };
  for (const entry of winners) {
    if (entry.kind === 'favorites') result.favorites.push({ ...entry.value });
    else if (entry.kind !== 'spaces') {
      const space = result.spaces.find(x => x.id === entry.parent);
      if (space) space[entry.kind].push({ ...entry.value });
    }
  }
  for (const space of result.spaces) {
    const ids = new Set(space.folders.map(x => x.id));
    for (const item of [...space.bookmarks, ...space.folders]) if (item.parentID && !ids.has(item.parentID)) item.parentID = null;
    // Concurrent moves can form a cycle even when each device's tree is valid.
    const byID = new Map(space.folders.map(f => [f.id, f]));
    for (const folder of [...space.folders].sort((x, y) => x.id.localeCompare(y.id))) if (hasCycle(space.folders, folder, byID)) folder.parentID = null;
  }
  if (!result.spaces.length) result.spaces.push({ ...initialLibrary().spaces[0], id: 'arco-recovered', updatedAt: new Date(Math.max(0, ...Object.values(tombstones).map(Date.parse)) + 1).toISOString() });
  return validateLibrary(result);
}
function canonicalRecord(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalRecord);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalRecord(value[key])]));
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(temporary, file); }
  catch (error) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(temporary); } catch {} throw error; }
}
function loadJSON(file, fallback, validate = x => x) {
  if (!fs.existsSync(file)) { atomicWrite(file, fallback); return { data: fallback, warning: '' }; }
  try { return { data: validate(JSON.parse(fs.readFileSync(file, 'utf8'))), warning: '' }; }
  catch (error) {
    const kept = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, kept, fs.constants.COPYFILE_EXCL); fs.chmodSync(kept, 0o600); }
    catch { throw new Error(`无法读取且无法备份 ${path.basename(file)}，已停止写入以保护原文件`); }
    return { data: fallback, warning: `无法读取 ${path.basename(file)}，原文件已保留为 ${path.basename(kept)}：${error.message}` };
  }
}
function reorder(list, time = now()) {
  for (let index = 0; index < list.length; index++) if (list[index].order !== index) { list[index].order = index; list[index].updatedAt = time; }
}
function deleteRecords(library, ids) {
  const gone = new Set(ids), time = now();
  library.favorites = library.favorites.filter(x => !gone.has(x.id));
  for (const space of library.spaces) { space.bookmarks = space.bookmarks.filter(x => !gone.has(x.id)); space.folders = space.folders.filter(x => !gone.has(x.id)); }
  reorder(library.favorites, time);
  for (const space of library.spaces) { reorder(space.bookmarks, time); reorder(space.folders, time); }
  for (const key of gone) library.tombstones[key] = time;
  library.updatedAt = time;
}
function decodeEntities(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (_, key) => {
    if (key[0] === '#') return String.fromCodePoint(parseInt(key.slice(key[1]?.toLowerCase() === 'x' ? 2 : 1), key[1]?.toLowerCase() === 'x' ? 16 : 10) || 32);
    return entities[key.toLowerCase()] ?? `&${key};`;
  }).trim();
}
function parseChromiumBookmarks(value) {
  const root = typeof value === 'string' ? JSON.parse(value) : value;
  if (!root.roots || typeof root.roots !== 'object') throw new Error('不是 Chromium 书签文件');
  const result = [];
  function walk(node, folders = []) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url' && node.url) {
      try { result.push({ id: id(), title: text(node.name || node.url, 500), url: webURL(node.url), folders, updatedAt: now() }); } catch {}
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, node.type === 'folder' ? [...folders, text(node.name || '文件夹', 100)] : folders);
  }
  for (const key of ['bookmark_bar', 'other', 'synced']) walk(root.roots[key]);
  return result;
}
function parseNetscape(html) {
  if (typeof html !== 'string' || !/<!doctype\s+netscape-bookmark-file-1|<dl>/i.test(html)) throw new Error('不是 Netscape HTML 书签文件');
  const result = [], folders = [], tokens = html.match(/<\/dl\b[^>]*>|<h3\b[^>]*>[\s\S]*?<\/h3>|<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const token of tokens) {
    if (/^<\/dl/i.test(token)) { folders.pop(); continue; }
    const h3 = token.match(/^<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (h3) { folders.push(decodeEntities(h3[1]).slice(0, 100) || '文件夹'); continue; }
    const a = token.match(/^<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const href = a[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!href) continue;
    try { result.push({ id: id(), title: decodeEntities(a[2]).slice(0, 500) || '书签', url: webURL(decodeEntities(href[1] || href[2] || href[3])), folders: [...folders], updatedAt: now() }); } catch {}
  }
  return result;
}
function netscape(items) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n'];
  const root = [], seen = new Map();
  for (const item of items) {
    let list = root, path = '';
    for (const name of item.folders || []) {
      path = path ? `${path}\0${name}` : name;
      if (!seen.has(path)) { const children = []; list.push({ name, children }); seen.set(path, children); }
      list = seen.get(path);
    }
    list.push(item);
  }
  const emit = (list, depth) => {
    for (const entry of list) {
      if (entry.children) {
        lines.push(`${'    '.repeat(depth)}<DT><H3>${esc(entry.name)}</H3>\n${'    '.repeat(depth)}<DL><p>\n`);
        emit(entry.children, depth + 1);
        lines.push(`${'    '.repeat(depth)}</DL><p>`);
      } else lines.push(`${'    '.repeat(depth)}<DT><A HREF="${esc(entry.url)}">${esc(entry.title)}</A>`);
    }
  };
  emit(root, 1);
  lines.push('</DL><p>\n');
  return lines.join('\n');
}
function parseCSV(input) {
  if (typeof input !== 'string' || input.length > 20_000_000) throw new Error('CSV 文件过大或无效');
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && !field) quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some(Boolean)) rows.push(row); row = []; }
    else field += c;
  }
  if (quoted) throw new Error('CSV 引号不完整');
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift()?.map(x => x.trim().toLowerCase().replace(/^\ufeff/, '')) || [];
  const at = (...names) => head.findIndex(x => names.includes(x));
  const ui = at('url', 'login_uri', 'origin_url'), ni = at('username', 'login_username'), pi = at('password', 'login_password'), ti = at('name', 'title');
  if (ui < 0 || ni < 0 || pi < 0) throw new Error('无法识别密码 CSV 列名');
  return rows.map(cols => {
    const password = cols[pi] || '';
    if (!password || password.length > 4096) return null;
    try { return { id: id(), origin: exactOrigin(cols[ui], { allowInsecure: true }), username: (cols[ni] || '').slice(0, 1024), password, title: (cols[ti] || '').slice(0, 500), updatedAt: now() }; } catch { return null; }
  }).filter(Boolean);
}
function parseArcSidebar(root) {
  if (typeof root === 'string') root = JSON.parse(root);
  const copies = [...(root?.sidebar?.containers || [])].filter(x => x && (x.items || x.spaces));
  for (const synced of [root?.sidebarSyncState, root?.firebaseSyncState?.syncData]) if (synced) {
    const container = synced.container?.value || synced.container || {};
    copies.push({ items: synced.items || [], spaces: synced.spaceModels || [], ordered: container.orderedSpaceIDs || synced.orderedSpaceIDs || [], topAppsContainerIDs: container.topAppsContainerIDs || synced.topAppsContainerIDs || [] });
  }
  if (!copies.length) throw new Error('不是 Arc StorableSidebar.json');
  const unwrap = x => x?.value && !x.id ? x.value : x;
  const items = new Map(), spaces = new Map(), top = new Set();
  copies.sort((x,y) => (x.items?.length || 0) - (y.items?.length || 0));
  for (const copy of copies) {
    for (const value of copy.items || []) { const node=unwrap(value);if(node?.id)items.set(node.id,node); }
    for (const value of copy.spaces || []) { const node=unwrap(value);if(node?.id&&(node.title||node.containerIDs))spaces.set(node.id,node); }
    for (const value of copy.topAppsContainerIDs || []) if(typeof value==='string')top.add(value);
  }
  const richest=copies[copies.length-1], ordered=(richest.ordered || []).filter(x=>spaces.has(x));
  function pages(itemID, folders=[], seen=new Set(), depth=0) {
    if (seen.has(itemID) || folders.length > 64 || depth > 64) return [];
    const node=items.get(itemID);if(!node)return [];seen=new Set(seen).add(itemID);
    if(node.data?.tab?.savedURL) {
      try {return [{id:id(),title:text(node.title || node.data.tab.savedTitle || node.data.tab.savedURL,500),url:webURL(node.data.tab.savedURL),folders,updatedAt:now()}];}catch{return [];}
    }
    const next=node.data?.splitView ? folders : [...folders,String(node.title || '文件夹').slice(0,100)];
    return (node.childrenIds || []).flatMap(child=>pages(child,next,seen,depth+1));
  }
  const result=(ordered.length?ordered:[...spaces.keys()]).map(key=>{
    const space=spaces.get(key), ids=space.containerIDs || [];let pinned;
    for(let i=0;i<ids.length-1;i++)if(ids[i]==='pinned'||(typeof ids[i]==='object'&&ids[i]?.pinned!==undefined))pinned=ids[i+1];
    const bookmarks=(items.get(pinned)?.childrenIds || []).flatMap(child=>pages(child));
    const rgb=space.customInfo?.windowTheme?.primaryColorPalette?.midTone;
    const customColor=rgb&&['red','green','blue'].every(k=>typeof rgb[k]==='number')?'#'+['red','green','blue'].map(k=>Math.round(Math.max(0,Math.min(1,rgb[k]))*255).toString(16).padStart(2,'0')).join(''):'';
    return {id:id(),name:String(space.title || '空间').slice(0,100),color:'sky',customColor,bookmarks,folders:[],updatedAt:now()};
  });
  result.favorites=[...top].flatMap(key=>(items.get(key)?.childrenIds || []).flatMap(child=>pages(child))).map(x=>({...x,folders:[]}));
  return result;
}
module.exports = { ENGINES, webURL, navigate, exactOrigin, originAllowed, id, now, text, secret, stamp, initialLibrary, validateLibrary, mergeLibraries, atomicWrite, loadJSON, reorder, deleteRecords, parseChromiumBookmarks, parseNetscape, netscape, parseCSV, parseArcSidebar };
