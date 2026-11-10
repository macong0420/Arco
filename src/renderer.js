'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.arco;
let state = null, modal = '', selectedSuggestion = 0, lastItems = [], toastTimer, browserSources = [];
const COLORS = { sky: '#d9e6f7', lavender: '#e5ddf3', rose: '#f2dce4', peach: '#f5e1d5', sand: '#eee6d4', sage: '#e0e6d9', mint: '#d8ebe2', white: '#efefef', graphite: '#555965' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attr = esc;
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const button = (label, action, cls = 'button') => `<button class="${cls}" data-action="${action}">${label}</button>`;
const favicon = (item, fallback = 'globe') => item.favicon && /^https?:\/\//.test(item.favicon) ? `<img src="${attr(item.favicon)}" alt="" data-favicon>` : icon(fallback);
document.addEventListener('error', event => { const img=event.target; if(img instanceof HTMLImageElement && img.hasAttribute('data-favicon')) { const holder=document.createElement('span');holder.innerHTML=icon('globe');img.replaceWith(holder.firstElementChild); } },true);
const hostname = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '新标签页'; } };
const activeTab = () => state?.tabs.find(t => t.id === state.activeID);
const space = () => state?.spaces.find(s => s.id === state.activeSpaceID);
async function call(channel, payload = {}, showErrors = true) {
  try { return await api.invoke('arco:invoke', { channel, payload }); }
  catch (error) { if (showErrors) toast(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return null; }
}
function toast(message) { if (!message) return; const node = $('#toast'); node.textContent = message; node.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 4200); }
function isBlank() { const tab = activeTab(); return !tab || !tab.url || tab.url === 'about:blank'; }
function render() {
  if (!state) return;
  const currentSpace = space() || state.spaces[0], baseColor = currentSpace?.customColor || COLORS[currentSpace?.color] || COLORS.sky;
  const dark = state.settings.theme === 'dark' || (state.settings.theme === 'system' && matchMedia('(prefers-color-scheme:dark)').matches) || currentSpace?.color === 'graphite' || (currentSpace?.customColor && [1,3,5].map(i=>parseInt(baseColor.slice(i,i+2),16)).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)<100);
  const color = dark ? 'color-mix(in oklab, ' + baseColor + ' 20%, #15171c)' : baseColor;
  document.body.style.setProperty('--frame', color); document.body.style.background = color;
  $('#page-snapshots').innerHTML = (state.snapshots || []).map(s => `<img alt="" src="${attr(s.url)}" style="position:absolute;left:${s.bounds.x}px;top:${s.bounds.y}px;width:${s.bounds.width}px;height:${s.bounds.height}px;border-radius:8px">`).join('');
  document.body.dataset.theme = dark ? 'dark' : 'light';
  $('#sidebar').classList.toggle('hidden', !state.sidebarVisible); $('#sidebar').style.width = state.settings.sidebarWidth + 'px';
  $('#main').classList.toggle('full', !state.sidebarVisible); $('#main').style.left = state.sidebarVisible ? state.settings.sidebarWidth + 'px' : '0px';
  const tab = activeTab();
  $('#new-tab').hidden = !isBlank() || !!state.capture;
  $('#domain').textContent = tab?.url && !isBlank() ? hostname(tab.url) + (new URL(tab.url).port ? ':' + new URL(tab.url).port : '') : '搜索或输入地址';
  const insecure = tab?.url?.startsWith('http:');
  $('#security-icon').innerHTML = icon(insecure ? 'warning' : tab?.url?.startsWith('https:') ? 'lock' : 'globe');
  $('#security-icon').title = insecure ? '此连接不安全' : tab?.url?.startsWith('https:') ? 'HTTPS 连接' : '';
  $$('[data-action="back"]').forEach(button=>{button.disabled=!tab?.canBack;}); $$('[data-action="forward"]').forEach(button=>{button.disabled=!tab?.canForward;});
  $$('[data-action="reload"]').forEach(button=>{button.title=tab?.loading?'停止加载':'重新加载';button.innerHTML=icon(tab?.loading?'close':'reload');});
  $('#space-name').textContent = state.private ? '无痕窗口' : currentSpace?.name || '个人';
  $('#space-heading').setAttribute('aria-label',state.private?'无痕窗口':'编辑空间：'+(currentSpace?.name||'个人'));
  renderFavorites(); renderPinned(); renderTabs(); renderSpaces();
  $('#page-toolbar').hidden = isBlank() && !state.capture && state.sidebarVisible; $('#second-toolbar').hidden = !state.splitID;
  $('#toolbar-sidebar-toggle').hidden=state.sidebarVisible; $('#collapsed-navigation').hidden=state.sidebarVisible; $('#toolbar-utility').hidden=!state.sidebarVisible; $('#collapsed-menu').hidden=state.sidebarVisible;
  $('#toolbar-address').hidden=state.sidebarVisible||isBlank()||!!state.splitID; $('#toolbar-domain').textContent=tab?.url?new URL(tab.url).host:''; $('#toolbar-address').title=tab?.url||'';
  $$('#page-toolbar [data-action="add-current-bookmark"],#page-toolbar [data-action="reader"],#page-toolbar [data-action="find"]').forEach(button=>{button.disabled=isBlank();});
  if (state.splitID) { const other = state.tabs.find(t => t.id === state.splitID); $('#second-title').textContent = other?.title || ''; $('#second-toolbar').style.left = (state.splitRatio * 100) + '%'; $('.page-toolbar').style.right = ((1 - state.splitRatio) * 100) + '%'; $('#split-resizer').classList.add('active'); $('#split-resizer').style.left = (state.splitRatio * 100) + '%'; }
  else { $('.page-toolbar').style.right = '0px'; $('#split-resizer').classList.remove('active'); }
  $('#peek-toolbar').hidden = !state.peek; $('#peek-title').textContent = state.peek?.title || state.peek?.url || '';
  $('#download-dot').classList.toggle('active', state.downloads.some(d => d.state === 'progressing'));
  if (state.warning) { toast(state.warning); state.warning = ''; }
  if (state.capture && modal !== 'capture') showModal('capture');
  if (!state.capture && modal === 'capture') closeModal();
  if (modal === 'palette') renderSuggestions($('#command-input')?.value || '');
  if (modal === 'overview') renderOverview($('#overview-filter')?.value || '');
}
function renderFavorites() {
  const root=$('#favorites');root.style.display=state.private?'none':'grid';
  if(state.private){root.innerHTML='';return;}
  root.innerHTML=state.favorites.map(item=>{
    const live=state.tabs.find(tab=>tab.url===item.url)?.favicon;
    const image={favicon:item.favicon||live||new URL(item.url).origin+'/favicon.ico'};
    return `<div class="favorite ${activeTab()?.url===item.url?'active':''}" data-favorite-id="${attr(item.id)}" title="${attr(item.title)}"><button class="favorite-link" data-open-url="${attr(item.url)}" aria-label="${attr(item.title)}">${favicon(image)}</button><button class="remove-favorite" data-remove-favorite="${attr(item.id)}" aria-label="移除常驻网站：${attr(item.title)}">${icon('close')}</button></div>`;
  }).join('')+`<button class="favorite-add" data-action="favorite-dialog" aria-label="添加常驻网站" title="添加常驻网站">${icon('plus')}<span>添加</span></button>`;
}
function bookmarkRows(items, depth = 0) {
  return items.map(item => `<div class="sidebar-row ${activeTab()?.url === item.url ? 'active' : ''}" draggable="true" data-bookmark-id="${attr(item.id)}" style="padding-left:${5 + depth * 10}px"><button data-open-url="${attr(item.url)}" style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;text-align:left;min-height:28px">${icon('bookmark')}<span>${esc(item.title)}</span></button><button class="row-close" data-delete-bookmark="${attr(item.id)}" title="删除书签">${icon('close')}</button></div>`).join('');
}
function renderPinned() {
  if (state.private) { $('#pinned').innerHTML = ''; return; }
  const folders = state.folders, rootBookmarks = state.bookmarks.filter(b => !b.parentID), rootFolders = folders.filter(f => !f.parentID);
  const html = [bookmarkRows(rootBookmarks)];
  function renderFolder(folder, depth) {
    const children = folders.filter(f => f.parentID === folder.id), pages = state.bookmarks.filter(b => b.parentID === folder.id);
    return `<div class="sidebar-row folder-row ${folder.open === false ? 'closed' : ''}" draggable="true" data-folder="${attr(folder.id)}"><button data-toggle-folder="${attr(folder.id)}" style="display:flex;align-items:center;gap:7px;flex:1;min-width:0;text-align:left;min-height:28px">${icon('chevron', 'chevron')}${icon('folder')}<span>${esc(folder.name)}</span></button><div class="row-actions"><button data-new-subfolder="${attr(folder.id)}" title="新建子文件夹">${icon('plus')}</button><button data-delete-folder="${attr(folder.id)}" title="删除文件夹">${icon('trash')}</button></div></div>${folder.open === false ? '' : `<div class="folder-children">${bookmarkRows(pages, depth)}${children.map(child => renderFolder(child, depth + 1)).join('')}</div>`}`;
  }
  html.push(rootFolders.map(f => renderFolder(f, 0)).join(''));
  html.push(`<div style="display:flex;padding:3px 5px;gap:4px"><button class="text-button muted" data-action="bookmark-dialog">＋ 书签</button><button class="text-button muted" data-action="folder-dialog">＋ 文件夹</button></div>`);
  $('#pinned').innerHTML = html.join('');
}
function renderTabs() {
  const pinned = new Set(state.bookmarks.map(b => b.url));
  const tabs = state.tabs.filter(t => t.spaceID === state.activeSpaceID && !pinned.has(t.url));
  $('#tabs').innerHTML = tabs.length ? tabs.map(tab => `<div class="sidebar-row ${tab.id === state.activeID ? 'active' : ''} ${tab.id === state.splitID ? 'muted' : ''}" data-tab-row="${attr(tab.id)}" draggable="true"><button data-select-tab="${attr(tab.id)}" style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;text-align:left;min-height:28px">${favicon(tab)}<span>${esc(tab.title || hostname(tab.url))}</span>${tab.muted ? icon('mute') : ''}</button><button class="row-close" data-close-tab="${attr(tab.id)}" title="关闭标签页">${icon('close')}</button></div>`).join('') : '<div class="tab-empty">标签页会出现在这里</div>';
}
function renderSpaces() {
  $('#space-switcher').innerHTML = state.private ? '<span class="pill">不留记录</span>' : state.spaces.map((s, i) => `<button class="space-key ${s.id === state.activeSpaceID ? 'current' : ''}" data-switch-space="${attr(s.id)}" title="${attr(s.name)} · ⌘${i + 1}" style="${s.customColor ? `color:${attr(s.customColor)}` : ''}">${i + 1}</button>`).join('');
}
function panel(title, content, options = {}) {
  return `<section class="panel ${options.class || ''}" role="dialog" aria-modal="true" aria-label="${attr(title)}" ${options.id ? `id="${options.id}"` : ''}><button class="icon panel-close" data-close-modal aria-label="关闭">${icon('close')}</button><h2>${esc(title)}</h2>${content}</section>`;
}
function showModal(name, data = {}) {
  modal = name; lastItems = []; call('overlay', { visible: true, kind: name });
  const root = $('#overlay-root'); root.hidden = false; root.dataset.modal = name;
  if (name === 'palette') root.innerHTML = `<section class="panel command-panel" role="dialog" aria-label="命令面板"><div class="search-field">${icon('search')}<input id="command-input" autocomplete="off" placeholder="搜索或输入地址" aria-label="搜索或输入地址" value="${attr(data.value || '')}"><kbd>esc</kbd></div><div class="suggestions" id="suggestions"></div></section>`;
  else if (name === 'capture') root.innerHTML = panel('保存此密码？', `<p class="description">只有你确认后，Arco 才会将密码写入本机加密保险库。</p><div class="credential-origin">${icon('key')} ${esc(state.capture.origin)}</div><p>${esc(state.capture.username || '未填写用户名')}</p><div class="actions">${button('不保存', 'capture-dismiss')}${button('保存密码', 'capture-save', 'button primary')}</div>`, { class: 'small capture-panel' });
  else if (name === 'favorite') root.innerHTML=panel('添加常驻网站',`<p class="description">显示在所有空间顶部，点一下即可打开。</p><form id="favorite-form"><label class="field-label" for="favorite-title">名称</label><input id="favorite-title" class="field" name="title" maxlength="500" placeholder="网站名称" value="${attr((data.title||(isBlank()?'':activeTab()?.title)||'').slice(0,500))}"><label class="field-label" for="favorite-url">网址</label><input id="favorite-url" class="field" name="url" type="url" required maxlength="8192" placeholder="https://example.com" value="${attr(data.url||activeTab()?.url||'')}"><div class="actions">${button('取消','close-modal')}${button('添加到常驻','submit-favorite','button primary')}</div></form>`,{class:'small'});
  else if (name === 'bookmark') root.innerHTML = panel('添加书签', `<form id="bookmark-form"><label class="field-label">名称</label><input class="field" name="title" required maxlength="500" value="${attr(data.title || activeTab()?.title || '')}"><label class="field-label">网址</label><input class="field" name="url" type="url" required maxlength="8192" value="${attr(data.url || activeTab()?.url || '')}"><label class="field-label">放入文件夹</label><select class="field" name="parentID"><option value="">空间顶层</option>${state.folders.map(f => `<option value="${attr(f.id)}">${esc(f.name)}</option>`).join('')}</select><div class="actions">${button('取消', 'close-modal')}${button('添加书签', 'submit-bookmark', 'button primary')}</div></form>`, { class: 'small' });
  else if (name === 'folder') root.innerHTML = panel(data.id ? '重命名文件夹' : '新建文件夹', `<form id="folder-form"><input type="hidden" name="id" value="${attr(data.id || '')}"><input type="hidden" name="parentID" value="${attr(data.parentID || '')}"><label class="field-label">名称</label><input class="field" name="name" required maxlength="100" autofocus value="${attr(data.name || '')}" placeholder="例如：阅读、工作"><div class="actions">${button('取消', 'close-modal')}${button('新建文件夹', 'submit-folder', 'button primary')}</div></form>`, { class: 'small' });
  else if (name === 'space') {
    const editing = data.id ? state.spaces.find(s => s.id === data.id) : null;
    root.innerHTML = panel(editing ? '编辑空间' : '新建空间', `<form id="space-form"><input type="hidden" name="id" value="${attr(editing?.id || '')}"><label class="field-label">空间名称</label><input class="field" name="name" required maxlength="100" value="${attr(editing?.name || `空间 ${state.spaces.length + 1}`)}"><label class="field-label">空间颜色</label><div class="swatches">${Object.entries(COLORS).map(([key, color]) => `<button type="button" class="swatch ${(editing?.color || 'sky') === key ? 'selected' : ''}" data-space-color="${key}" style="background:${color}" aria-label="${key}"></button>`).join('')}</div><input type="hidden" name="color" value="${attr(editing?.color || 'sky')}"><label class="field-label">自定义颜色（可选）</label><input class="field" name="customColor" type="color" value="${attr(editing?.customColor || '#d9e6f7')}"><label><input type="checkbox" name="useCustom" ${editing?.customColor ? 'checked' : ''}> 使用自定义颜色</label><div class="actions">${editing && state.spaces.length > 1 ? button('删除空间', 'remove-space', 'button danger left') : ''}${button('取消', 'close-modal')}${button(editing ? '保存' : '创建空间', 'submit-space', 'button primary')}</div></form>`, { class: 'small' });
  }
  else if (name === 'settings') { root.innerHTML = panel('设置', settingsHTML(data.section || 'general'), { class: 'wide', id: 'settings-panel' }); if ((data.section || 'general') === 'bookmarks') loadBrowserSources(); }
  else if (name === 'history') root.innerHTML = panel('浏览历史', `<p class="description">仅记录普通窗口中成功打开的网页。无痕窗口不写入历史。</p><div class="search-field">${icon('search')}<input id="history-filter" placeholder="搜索历史" aria-label="搜索历史"></div><div class="list" id="history-list">${historyHTML()}</div>`, { class: 'wide' });
  else if (name === 'downloads') root.innerHTML = panel('下载', `<p class="description">查看下载进度，打开文件、在 Finder 中显示或取消下载。</p><div class="list">${state.downloads.length ? [...state.downloads].reverse().map(d => `<div class="list-row"><div class="grow"><strong>${esc(d.filename)}</strong><small>${d.state === 'progressing' ? `${formatBytes(d.received)} / ${d.total ? formatBytes(d.total) : '未知大小'}` : { completed: '已完成', cancelled: '已取消', interrupted: '已中断' }[d.state] || esc(d.state)}</small></div>${d.state === 'progressing' ? `<button class="icon" data-download-cancel="${attr(d.id)}" title="取消">${icon('close')}</button>` : `<button class="icon" data-download-open="${attr(d.id)}" title="打开">${icon('forward')}</button><button class="icon" data-download-reveal="${attr(d.id)}" title="在 Finder 中显示">${icon('folder')}</button>`}</div>`).join('') : '<div class="empty">还没有下载</div>'}</div>`, { class: 'wide' });
  else if (name === 'overview') root.innerHTML = panel('全部标签页', `<div class="search-field">${icon('search')}<input id="overview-filter" placeholder="筛选标签页" aria-label="筛选标签页"></div><div class="overview-grid" id="overview-grid"></div>`, { class: 'wide' });
  else if (name === 'passwords') { root.innerHTML = panel('密码', '<div class="empty">正在读取密码列表…</div>', { class: 'wide', id: 'passwords-panel' }); loadCredentials(); }
  else if (name === 'find') root.innerHTML = `<section class="panel small find-panel" role="dialog" aria-label="页内查找"><input id="find-input" class="field" placeholder="在页面中查找" aria-label="在页面中查找"><button class="icon" data-find="-1" title="上一个">${icon('back')}</button><button class="icon" data-find="1" title="下一个">${icon('forward')}</button><button class="icon" data-action="find-stop" title="关闭">${icon('close')}</button></section>`;
  else if (name === 'reader') root.innerHTML = panel(data.title || '阅读视图', `<p class="description">${esc(data.byline || activeTab()?.url || '')}</p><article class="reader-content">${readerHTML(data.content || '', data.url)}</article><div class="actions">${button('返回网页', 'reader-close', 'button primary')}</div>`, { id: 'reader-modal' });
  else if (name === 'edit-bookmark') root.innerHTML = panel('编辑书签', `<form id="edit-bookmark-form"><input type="hidden" name="id" value="${attr(data.id)}"><label class="field-label">名称</label><input class="field" name="title" required maxlength="500" value="${attr(data.title)}"><label class="field-label">网址</label><input class="field" name="url" type="url" required value="${attr(data.url)}"><div class="actions">${button('取消', 'close-modal')}${button('保存', 'submit-edit-bookmark', 'button primary')}</div></form>`, { class: 'small' });
  else if (name === 'peek') root.innerHTML = panel('打开快速预览', `<form id="peek-form"><label class="field-label">网页地址</label><input class="field" name="url" type="url" required value="https://"><div class="actions">${button('取消', 'close-modal')}${button('预览', 'submit-peek', 'button primary')}</div></form>`, { class: 'small' });
  root.querySelectorAll('[data-close-modal]').forEach(el => el.addEventListener('click', closeModal));
  requestAnimationFrame(() => (root.querySelector('input:not([type="hidden"]),button') || root).focus());
  if (name === 'palette') { renderSuggestions(data.value || ''); $('#command-input').select(); }
  if (name === 'overview') renderOverview('');
}
function closeModal() { if (modal === 'reader') call('reader'); if (modal === 'find') call('find-stop'); modal = ''; $('#overlay-root').hidden = true; $('#overlay-root').innerHTML = ''; call('overlay', { visible: false }); }
function commandItems(query) {
  const q = query.toLowerCase().trim(), items = [];
  for (const tab of state.tabs) if (!q || `${tab.title} ${tab.url}`.toLowerCase().includes(q)) items.push({ title: tab.title, subtitle: '打开的标签页 · ' + hostname(tab.url), icon: 'tabs', tabID: tab.id });
  for (const bookmark of state.allBookmarks) if (!q || `${bookmark.title} ${bookmark.url}`.toLowerCase().includes(q)) items.push({ title: bookmark.title, subtitle: '书签 · ' + hostname(bookmark.url), icon: 'bookmark', url: bookmark.url });
  for (const item of state.history) if (q && `${item.title} ${item.url}`.toLowerCase().includes(q)) items.push({ title: item.title, subtitle: '历史 · ' + hostname(item.url), icon: 'history', url: item.url });
  if (query.trim()) items.push({ title: query, subtitle: '转到地址或搜索', icon: 'search', input: query });
  else items.push({ title: '输入网址或搜索内容', subtitle: '按回车打开', icon: 'search', disabled: true });
  const seen = new Set(); return items.filter(x => { const key = x.tabID || x.url || x.input || x.title; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 9);
}
function renderSuggestions(query) {
  if (!$('#suggestions')) return;
  lastItems = commandItems(query); selectedSuggestion = Math.min(selectedSuggestion, Math.max(0, lastItems.length - 1));
  $('#suggestions').innerHTML = lastItems.map((item, i) => `<button class="suggestion ${i === selectedSuggestion ? 'selected' : ''}" data-suggestion="${i}" ${item.disabled ? 'disabled' : ''}>${icon(item.icon)}<span class="suggestion-text">${esc(item.title)}</span><span class="kind">${esc(item.subtitle)}</span></button>`).join('');
}
async function chooseSuggestion(index) {
  const item = lastItems[index]; if (!item || item.disabled) return;
  closeModal(); selectedSuggestion = 0;
  if (item.tabID) await call('select-tab', { id: item.tabID });
  else if (item.url) await call('new-tab', { url: item.url });
  else if (item.input) await call('navigate', { input: item.input });
}
function historyHTML(query = '') {
  const list = state.history.filter(x => `${x.title} ${x.url}`.toLowerCase().includes(query.toLowerCase())).slice(0, 300);
  return list.length ? list.map(x => `<div class="list-row">${icon('history')}<button class="grow" data-open-url="${attr(x.url)}" style="text-align:left"><strong>${esc(x.title)}</strong><small>${esc(x.url)} · ${new Date(x.visitedAt).toLocaleString('zh-CN')}</small></button><button class="icon" data-history-delete="${attr(x.id)}" title="删除">${icon('trash')}</button></div>`).join('') : '<div class="empty">没有匹配的浏览历史</div>';
}
function renderOverview(query) {
  if (!$('#overview-grid')) return;
  const tabs = state.tabs.filter(t => `${t.title} ${t.url} ${spaceName(t.spaceID)}`.toLowerCase().includes(query.toLowerCase()));
  $('#overview-grid').innerHTML = tabs.length ? tabs.map(t => `<button class="overview-card" data-select-tab="${attr(t.id)}">${favicon(t)}<strong>${esc(t.title)}</strong><small>${esc(spaceName(t.spaceID))} · ${esc(hostname(t.url))}</small></button>`).join('') : '<div class="empty">没有匹配的标签页</div>';
}
function spaceName(id) { return state.spaces.find(s => s.id === id)?.name || ''; }
function readerHTML(content, baseURL) {
  const parsed=new DOMParser().parseFromString(content,'text/html');
  parsed.querySelectorAll('script,style,iframe,object,embed,form,button,input,select,textarea,link,meta,svg,math').forEach(x=>x.remove());
  for(const node of parsed.body.querySelectorAll('*')) {
    for(const attribute of [...node.attributes])if(!['href','src','alt','title','colspan','rowspan'].includes(attribute.name))node.removeAttribute(attribute.name);
    for(const key of ['href','src'])if(node.hasAttribute(key)) {
      try {const url=new URL(node.getAttribute(key),baseURL);if(!['http:','https:'].includes(url.protocol))throw Error();if(key==='href'){node.setAttribute('href',url.href);node.setAttribute('data-open-url',url.href);node.setAttribute('role','link');node.setAttribute('tabindex','0');}else node.setAttribute(key,url.href);}catch{node.removeAttribute(key);}
    }
  }
  return parsed.body.innerHTML;
}
function formatBytes(bytes) { return bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'; }
function settingsHTML(section) {
  const nav = `<nav class="settings-nav">${[['general', '通用'], ['bookmarks', '书签与导入'], ['sync', '同步'], ['privacy', '隐私与安全'], ['extensions', '扩展'], ['about', '关于 Arco']].map(([key, name]) => `<button data-settings-section="${key}" class="${section === key ? 'active' : ''}">${name}</button>`).join('')}</nav>`;
  let content = '';
  if (section === 'general') content = `<section class="settings-section"><h2>通用</h2><div class="setting-row"><span>搜索引擎<small>地址栏和命令面板使用的搜索服务</small></span><select class="field" id="engine-setting">${[['google', 'Google'], ['duckduckgo', 'DuckDuckGo'], ['bing', 'Bing'], ['baidu', '百度'], ['brave', 'Brave Search']].map(([key, name]) => `<option value="${key}" ${state.settings.engine === key ? 'selected' : ''}>${name}</option>`).join('')}</select></div><div class="setting-row"><span>界面外观<small>窗口色彩同时受当前空间影响</small></span><select class="field" id="theme-setting"><option value="system" ${state.settings.theme === 'system' ? 'selected' : ''}>跟随系统</option><option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>浅色</option><option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>深色</option></select></div><div class="setting-row"><span>网页圆角边框<small>在网页四周保留 8px 空间边框</small></span><button class="switch ${state.settings.frameInset ? 'on' : ''}" data-setting-toggle="frameInset" role="switch" aria-checked="${state.settings.frameInset}"></button></div><div class="setting-row"><span>跟踪器拦截<small>内置 16 个常见跟踪服务域名的主机后缀规则</small></span><button class="switch ${state.settings.trackerBlocking ? 'on' : ''}" data-setting-toggle="trackerBlocking" role="switch" aria-checked="${state.settings.trackerBlocking}"></button></div><h3>页面操作</h3><div class="actions" style="justify-content:flex-start">${button('打印当前页面', 'print')}${button('保存为 PDF', 'pdf')}${button('页面截图', 'screenshot')}${button('开发者工具', 'devtools')}</div><div class="actions" style="justify-content:flex-start">${button('缩小页面', 'zoom-out')}${button('还原缩放', 'zoom-reset')}${button('放大页面', 'zoom-in')}${button('打开快速预览', 'peek-dialog')}</div></section>`;
  if (section === 'bookmarks') content = `<section class="settings-section"><h2>书签与导入</h2><p class="description">收藏磁贴在所有空间共享。固定书签可放入任意层级文件夹，保存在当前空间。</p><div class="actions" style="justify-content:flex-start">${button('添加当前页为书签', 'add-current-bookmark')}${button('添加当前页到收藏', 'add-current-favorite')}${button('新建文件夹', 'folder-dialog')}</div><h3>从浏览器导入</h3><p class="description">直接读取本机已安装浏览器的书签，导入到当前空间「${esc(space()?.name || '')}」：保留文件夹层级，重复网址跳过，不读取密码、历史、Cookie 或登录状态。Safari 的书签文件受 macOS 保护，需要授予完全磁盘访问权限。</p><div class="list" id="browser-sources"><div class="empty">正在检测浏览器…</div></div><h3>从文件导入</h3><p class="description">仅读取你明确选择的文件。支持 Netscape HTML、Chromium Bookmarks JSON、Arc StorableSidebar.json（空间名、固定页面及文件夹路径；支持经典与 Arc Sync 侧栏数据）。</p><div class="actions" style="justify-content:flex-start">${button('选择文件导入', 'import-bookmarks', 'button primary')}${button('导出全部书签为 HTML', 'export-bookmarks')}</div><h3>固定书签</h3><div class="list">${state.allBookmarks.length ? state.allBookmarks.map(b => `<div class="list-row">${icon('bookmark')}<div class="grow"><strong>${esc(b.title)}</strong><small>${esc(spaceName(b.spaceID))} · ${esc(b.url)}</small></div><button class="icon" data-edit-bookmark="${attr(b.id)}" title="编辑">${icon('edit')}</button><button class="icon" data-delete-bookmark="${attr(b.id)}" title="删除">${icon('trash')}</button></div>`).join('') : '<div class="empty">还没有固定书签</div>'}</div></section>`;
  if (section === 'sync') content = `<section class="settings-section"><h2>同步</h2><p class="description">选择已由 iCloud Drive、网盘或其他服务同步的文件夹。书签与空间按记录合并，每台设备独立写入快照，删除记录也会同步。</p><div class="setting-row"><span>同步文件夹<small>${esc(state.settings.syncFolder || '尚未连接')}</small></span>${state.settings.syncFolder ? button('断开', 'disconnect-sync') : button('选择文件夹', 'connect-sync', 'button primary')}</div><div class="setting-row"><span>书签与空间<small>${esc(state.settings.syncStatus || '尚未同步')}</small></span>${button('立即同步书签', 'sync-now')}</div><h3>加密密码同步</h3><p class="description">使用相同的同步口令连接其他 Mac。整个密码库经过 scrypt 和 AES-256-GCM 加密，口令不写入磁盘。解锁保持 15 分钟，明文操作仍需要系统认证。</p>${state.passwordSyncUnlocked ? '<div class="actions">' + button('立即同步密码', 'password-sync-now', 'button primary') + button('锁定同步', 'password-sync-lock') + '</div>' : '<form id="password-sync-form"><label class="field-label">同步口令（至少 12 个字符）</label><input name="passphrase" type="password" class="field" autocomplete="off" minlength="12" maxlength="1024" required><div class="actions">' + button('创建或解锁并同步', 'password-sync-submit', 'button primary') + '</div></form>'}<p class="description">密码同步文件包含加密数据；书签文件包含明文网址。本功能使用你自己的同步文件夹，不是 Google Chrome 账号同步或原生 iCloud Keychain。首次连接另一台设备前，请等待网盘文件同步完成。</p></section>`;
  if (section === 'privacy') content = `<section class="settings-section"><h2>隐私与安全</h2><p class="description">网页与浏览器界面相互隔离。网站权限分别询问，打开外部应用前需要你确认。</p><div class="setting-row"><span>密码存储<small>密码库在本机加密，密钥由 macOS 钥匙串保护；明文操作要求系统认证</small></span>${button('管理密码', 'passwords')}</div><div class="setting-row"><span>iCloud Keychain<small>当前构建未配置受支持的 Apple Developer 签名与同步 entitlement，原生同步不可用，请使用同步页的加密密码同步，绝不声称已启用云同步</small></span><span class="pill">本地</span></div><div class="setting-row"><span>无痕窗口<small>使用独立内存会话，不写历史、密码或会话文件</small></span>${button('新建无痕窗口', 'private-window')}</div><h3>跟踪器规则覆盖</h3><p class="description">当前仅拦截内置 16 个常见跟踪服务域名及其子域名的非主文档网络请求。这不是 EasyList，不声称具有上游约 130,000 条规则，也不替代完整内容拦截器。</p></section>`;
  if (section === 'extensions') content = `<section class="settings-section"><h2>扩展</h2><p class="description">选择本地解压的扩展目录。Arco 会记住安装位置并在下次启动时加载。</p><div class="notice">仅支持部分 Chromium 扩展，暂不支持 Chrome 应用商店安装、Chrome 账号同步和 1Password 桌面集成。</p><div class="actions" style="justify-content:flex-start">${button('选择解压扩展目录', 'add-extension', 'button primary')}</div><div id="extension-list" class="list"><div class="empty">正在读取扩展…</div></div></section>`;
  if (section === 'about') content = `<section class="settings-section"><h2>Arco</h2><div class="brand-mark" style="font-size:28px;justify-content:flex-start;margin:20px 0"><span class="arc-symbol" style="width:28px;height:24px"></span><span>Arco</span></div><p class="description">独立 Chromium 桌面浏览器 · Chromium ${esc(state.chromium)}<br>默认窗口 1280 × 820 · 空间、收藏与本地密码</p><p class="description">界面设计参考 Zigzag 的 Arc 风格侧栏及 Apache-2.0 许可实现。Arco 使用自己的名称、A/arc 图标和 wordmark，不隶属于 Arc、Zigzag 或 The Browser Company。</p><p class="description">数据目录：${esc(state.settings.dataDirectory || ' ~/Library/Application Support/Arco')}<br>本地数据使用原子写入；损坏文件会保留备份。密码不会写入文件夹同步或日志。</p><p class="description">详细功能差异、签名与同步说明请查看项目 README 和 NOTICE。</p></section>`;
  return `<div class="settings-layout">${nav}<div>${content}</div></div>`;
}
async function loadCredentials() {
  const credentials = await call('credentials');
  if (modal !== 'passwords' || !credentials) return;
  $('#passwords-panel').innerHTML = `<h2>密码</h2><p class="description">本机加密保险库 · 密钥由 macOS 钥匙串保护。明文显示、复制与导出需要 Touch ID 或系统密码。</p><div class="actions" style="justify-content:flex-start">${button('添加密码', 'new-credential', 'button primary')}${button('生成强密码', 'generate-password')}${button('导入 CSV', 'import-passwords')}${button('导出明文 CSV', 'export-passwords')}</div><div class="notice">仅填充与保存时完全相同的协议、主机和端口，且仅对当前可见标签页操作。普通 HTTP 网站禁止自动填充；localhost 可用于本地测试。</div><div id="credential-list">${credentials.length ? credentials.map(credentialHTML).join('') : '<div class="empty">还没有保存的密码</div>'}</div>`;
}
function credentialHTML(c) { return `<div class="credential">${icon('key')}<div class="grow"><strong>${esc(c.username || '未填写用户名')}</strong><small>${esc(c.origin)}</small></div><button class="button" data-fill-credential="${attr(c.id)}">填充到当前页</button><button class="icon" data-read-credential="${attr(c.id)}" title="显示或复制">${icon('search')}</button><button class="icon" data-delete-credential="${attr(c.id)}" title="删除">${icon('trash')}</button></div>`; }
async function readCredential(id) { const credential = await call('credential-read', { id }); if (!credential) return; showModal('credential-detail', credential); $('#overlay-root').innerHTML = panel('已解锁密码', `<p class="description">${esc(credential.origin)}</p><label class="field-label">用户名</label><input class="field" readonly value="${attr(credential.username)}"><label class="field-label">密码</label><input class="field" type="password" id="revealed-password" readonly value="${attr(credential.password)}"><div class="actions">${button('显示 / 隐藏', 'toggle-password')}${button('复制密码', 'copy-password', 'button primary')}</div>`, { class: 'small' }); }
function showNewCredential() { $('#overlay-root').innerHTML = panel('添加密码', `<form id="credential-form"><label class="field-label">网站来源（协议、主机、端口）</label><input class="field" name="origin" required value="${attr(activeTab()?.url ? new URL(activeTab().url).origin : 'https://')}"><label class="field-label">用户名</label><input class="field" name="username" maxlength="1024"><label class="field-label">密码</label><input class="field" name="password" type="password" required maxlength="4096"><div class="actions">${button('取消', 'passwords')}${button('保存到保险库', 'submit-credential', 'button primary')}</div></form>`, { class: 'small' }); modal = 'new-credential'; }
async function loadExtensions() { const node = $('#extension-list'); if (!node) return; const extensions = state.settings.extensions || []; node.innerHTML = extensions.length ? extensions.map(e => `<div class="list-row">${icon('tabs')}<div class="grow"><strong>${esc(e.name || e.id)}</strong><small>${esc(e.path)}</small></div><button class="button danger" data-remove-extension="${attr(e.id)}">移除</button></div>`).join('') : '<div class="empty">没有已添加的扩展</div>'; }
async function loadBrowserSources() {
  const sources = await call('browser-sources');
  if (!sources || !$('#browser-sources')) return;
  browserSources = sources;
  const rows = sources.length ? sources.map(s => {
    const detail = s.note || (s.kind === 'arc' ? 'Arc 的空间、固定页面与文件夹' : s.count ? `${s.count} 个书签` : '没有书签');
    const action = s.count > 0 || s.kind === 'arc' ? `<button class="button" data-import-browser="${attr(s.id)}">导入</button>` : '';
    return `<div class="list-row">${icon('globe')}<div class="grow"><strong>${esc(s.name)}${s.label && s.label !== s.name ? ' · ' + esc(s.label) : ''}</strong><small>${esc(detail)}</small></div>${action}</div>`;
  }).join('') : '<div class="empty">没有检测到已安装的浏览器。可以在浏览器里导出书签文件，再用上方「选择文件导入」。</div>';
  $('#browser-sources').innerHTML = rows + '<div class="actions" style="justify-content:flex-start"><button class="text-button muted" data-action="refresh-browsers">重新检测</button></div>';
}
const actions = {
  'toggle-sidebar': () => call('toggle-sidebar'), back: () => call('back'), forward: () => call('forward'), reload: () => call(activeTab()?.loading ? 'stop' : 'reload'),
  palette: () => showModal('palette', { value: isBlank() ? '' : activeTab()?.url }), 'new-tab': () => call('new-tab'), 'close-modal': closeModal,
  'clear-tabs': () => call('clear-tabs'), downloads: () => showModal('downloads'), settings: () => showModal('settings'), history: () => showModal('history'),
  passwords: () => showModal('passwords'), overview: () => showModal('overview'), menu: () => call('menu'),
  'add-space': () => showModal('space'), 'toggle-split': () => call('toggle-split'), 'close-split': () => call('toggle-split'),
  'add-current-bookmark': () => { if (!isBlank()) showModal('bookmark'); },
  'add-current-favorite': async () => { const tab = activeTab(); if (!isBlank() && await call('add-favorite', { title: tab.title.slice(0,500), url: tab.url })) toast('常驻网站已保存'); },
  'favorite-dialog': () => showModal('favorite'), 'submit-favorite': () => $('#favorite-form').requestSubmit(),
  'bookmark-dialog': () => showModal('bookmark'), 'folder-dialog': () => showModal('folder'),
  'close-peek': () => call('close-peek'), 'peek-to-tab': () => call('peek-to-tab'), 'peek-dialog': () => showModal('peek'),
  reader: async () => { const article = await call('reader'); if (article) showModal('reader', article); }, 'reader-close': closeModal,
  find: () => showModal('find'), 'find-stop': () => { call('find-stop'); closeModal(); },
  'private-window': () => { closeModal(); call('private-window'); },
  print: () => call('print'), pdf: () => call('pdf'), screenshot: () => call('screenshot'), devtools: () => call('devtools'),
  'zoom-out': () => call('zoom', { delta: -0.1 }), 'zoom-in': () => call('zoom', { delta: 0.1 }), 'zoom-reset': () => call('zoom', { reset: true }),
  'capture-save': async () => { if (await call('capture-save') !== null || !state.capture) { closeModal(); toast('密码已保存到加密保险库'); } }, 'capture-dismiss': () => { call('capture-dismiss'); closeModal(); },
  'import-bookmarks': async () => { const result = await call('import-bookmarks'); if (result !== null) { showModal('settings', { section: 'bookmarks' }); toast('导入完成，重复网址已跳过'); } },
  'export-bookmarks': async () => { if (await call('export-bookmarks')) toast('书签已导出为 HTML'); },
  'connect-sync': async () => { await call('connect-sync'); showModal('settings', { section: 'sync' }); }, 'disconnect-sync': async () => { await call('disconnect-sync'); showModal('settings', { section: 'sync' }); },
  'sync-now': async () => { await call('sync-now'); showModal('settings', { section: 'sync' }); },
  'submit-bookmark': () => $('#bookmark-form').requestSubmit(), 'submit-folder': () => $('#folder-form').requestSubmit(), 'submit-space': () => $('#space-form').requestSubmit(),
  'remove-space': async () => { const id=$('#space-form [name="id"]').value;if (await call('confirm-clear', { message: '删除此空间及其固定书签？此操作会通过同步传播。' })) { closeModal(); await call('remove-space', { id }); } },
  'submit-edit-bookmark': () => $('#edit-bookmark-form').requestSubmit(), 'submit-peek': () => $('#peek-form').requestSubmit(),
  'new-credential': showNewCredential, 'submit-credential': () => $('#credential-form').requestSubmit(),
  'generate-password': async () => { const value = await call('generate-password'); if (value && modal === 'passwords') { $('#passwords-panel .notice').innerHTML = `<strong>新生成的密码（尚未保存）</strong><div class="password-generated">${esc(value)}</div><button class="button" data-copy-generated>复制</button>`; $('[data-copy-generated]').onclick = () => { call('copy', { text: value }); toast('已复制，请添加到密码或用于注册'); }; } },
  'import-passwords': async () => { const count = await call('import-passwords'); if (count !== null) { toast(`已导入 ${count} 条密码`); loadCredentials(); } },
  'export-passwords': async () => { if (await call('export-passwords')) toast('明文 CSV 已导出，请尽快安全删除'); },
  'toggle-password': () => { const field = $('#revealed-password'); field.type = field.type === 'password' ? 'text' : 'password'; },
  'copy-password': () => { call('copy', { text: $('#revealed-password').value }); toast('密码已复制，请注意剪贴板安全'); },
  'add-extension': async () => { const value = await call('add-extension'); if (value) { state.settings.extensions.push({ id: value.id, path: value.path, name: value.name }); loadExtensions(); } },
  'password-sync-submit': () => $('#password-sync-form').requestSubmit(),
  'password-sync-lock': async () => { if(await call('password-sync-lock'))showModal('settings',{section:'sync'}); },
  'password-sync-now': async () => { if(await call('password-sync-now')){showModal('settings',{section:'sync'});toast('加密密码同步完成');} },
  'close-toast': () => { $('#toast').hidden = true; },
  'refresh-browsers': () => loadBrowserSources()
};
document.addEventListener('click', async event => {
  const el = event.target.closest('button,[data-action],[data-close-modal],[data-open-url]'); if (!el) return;
  if (el.dataset.closeModal !== undefined) return closeModal();
  const a = el.dataset;
  if (a.action && actions[a.action]) { event.preventDefault(); return actions[a.action](); }
  if (a.openUrl) { event.preventDefault(); closeModal(); return call('open-url', { url: a.openUrl }); }
  if (a.selectTab) { closeModal(); return call('select-tab', { id: a.selectTab }); }
  if (a.closeTab) return call('close-tab', { id: a.closeTab });
  if (a.switchSpace) return call('switch-space', { id: a.switchSpace });
  if (a.removeFavorite) return call('delete-bookmark', { id: a.removeFavorite });
  if (a.deleteBookmark) return call('delete-bookmark', { id: a.deleteBookmark });
  if (a.editBookmark) { const item = state.allBookmarks.find(x => x.id === a.editBookmark); if (item) showModal('edit-bookmark', item); return; }
  if (a.toggleFolder) { const folder = state.folders.find(f => f.id === a.toggleFolder); return call('update-folder', { id: a.toggleFolder, open: folder.open === false }); }
  if (a.newSubfolder) return showModal('folder', { parentID: a.newSubfolder });
  if (a.deleteFolder) return call('delete-folder', { id: a.deleteFolder });
  if (a.suggestion !== undefined) return chooseSuggestion(Number(a.suggestion));
  if (a.historyDelete) { await call('history-delete', { id: a.historyDelete }); $('#history-list').innerHTML = historyHTML($('#history-filter')?.value || ''); return; }
  if (a.downloadOpen) return call('download-open', { id: a.downloadOpen });
  if (a.downloadReveal) return call('download-reveal', { id: a.downloadReveal });
  if (a.downloadCancel) return call('download-cancel', { id: a.downloadCancel });
  if (a.importBrowser) {
    const count = await call('import-browser', { id: a.importBrowser });
    const source = browserSources.find(s => s.id === a.importBrowser);
    if (count !== null) { showModal('settings', { section: 'bookmarks' }); toast(source?.kind === 'arc' ? `已导入 Arc 的 ${count} 个空间` : count ? `已导入 ${count} 个书签，重复网址已跳过` : '没有新的书签可以导入'); }
    return;
  }
  if (a.settingsSection) { showModal('settings', { section: a.settingsSection }); if (a.settingsSection === 'extensions') loadExtensions(); return; }
  if (a.settingToggle) return call('update-settings', { [a.settingToggle]: !state.settings[a.settingToggle] });
  if (a.spaceColor) { $('#space-form [name="color"]').value = a.spaceColor; $$('.swatch').forEach(x => x.classList.toggle('selected', x === el)); return; }
  if (a.fillCredential) { const result = await call('credential-fill', { id: a.fillCredential }); if(result?.count) {closeModal();toast('已填充当前可见登录字段');} else if(result)toast('当前页面没有可见的登录字段'); return; }
  if (a.readCredential) return readCredential(a.readCredential);
  if (a.deleteCredential) { if (await call('confirm-clear', { message: '删除此密码？' })) { await call('credential-delete', { id: a.deleteCredential }); loadCredentials(); } return; }
  if (a.removeExtension) { await call('remove-extension', { id: a.removeExtension }); state.settings.extensions = state.settings.extensions.filter(e => e.id !== a.removeExtension); loadExtensions(); return; }
  if (a.find) { const input = $('#find-input'); if (input?.value) call('find', { query: input.value, forward: Number(a.find) > 0, findNext: true }); return; }
  if (a.copyGenerated !== undefined) return;
});
$('#space-heading').addEventListener('click', () => { if (!state.private) showModal('space', { id: state.activeSpaceID }); });
$('#overlay-root').addEventListener('click', event => { if (event.target === $('#overlay-root') && modal !== 'capture') closeModal(); });
document.addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  if (event.target.id === 'favorite-form') { if(await call('add-favorite',data)!==null){closeModal();toast('常驻网站已保存');} }
  if (event.target.id === 'bookmark-form') { if (await call('add-bookmark', data) !== null) { closeModal(); toast('书签已保存到当前空间'); } }
  if (event.target.id === 'folder-form') { if (await call(data.id ? 'update-folder' : 'add-folder', data) !== null) closeModal(); }
  if (event.target.id === 'space-form') { if (!data.useCustom) data.customColor = ''; else data.customColor = data.customColor || '#d9e6f7'; if (data.id) { if (await call('update-space', data) !== null) closeModal(); } else { if (await call('add-space', data) !== null) closeModal(); } }
  if (event.target.id === 'edit-bookmark-form') { if (await call('update-bookmark', data) !== null) closeModal(); }
  if (event.target.id === 'peek-form') { closeModal(); await call('peek', { url: data.url }); }
  if (event.target.id === 'password-sync-form') { const input=event.target.elements.passphrase; const passphrase=input.value; input.value=''; if(await call('password-sync-unlock',{passphrase}) && await call('password-sync-now')) {showModal('settings',{section:'sync'});toast('加密密码同步完成');} }
  if (event.target.id === 'credential-form') { if (await call('credential-save', data)) { toast('密码已保存到加密保险库'); showModal('passwords'); } }
});
document.addEventListener('input', event => {
  if (event.target.id === 'command-input') { selectedSuggestion = 0; renderSuggestions(event.target.value); }
  if (event.target.id === 'history-filter') $('#history-list').innerHTML = historyHTML(event.target.value);
  if (event.target.id === 'overview-filter') renderOverview(event.target.value);
  if (event.target.id === 'find-input') call('find', { query: event.target.value });
});
document.addEventListener('change', event => {
  if (event.target.id === 'engine-setting') call('update-settings', { engine: event.target.value });
  if (event.target.id === 'theme-setting') call('update-settings', { theme: event.target.value });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (modal === 'capture') call('capture-dismiss'); if (state.peek) call('close-peek'); closeModal(); return; }
  if (modal === 'palette') {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); selectedSuggestion = (selectedSuggestion + (event.key === 'ArrowDown' ? 1 : -1) + lastItems.length) % lastItems.length; renderSuggestions($('#command-input').value); }
    if (event.key === 'Enter') { event.preventDefault(); chooseSuggestion(selectedSuggestion); }
  }
  if (modal === 'find' && event.key === 'Enter') { event.preventDefault(); const value = $('#find-input').value; if (value) call('find', { query: value, forward: !event.shiftKey, findNext: true }); }
});
function resizeStart(type, event) {
  event.preventDefault(); const start = type === 'sidebar' ? state.settings.sidebarWidth : state.splitRatio, startX = event.clientX;
  const move = e => { if (type === 'sidebar') { const width = Math.max(216, Math.min(400, start + e.clientX - startX)); $('#sidebar').style.width = width + 'px'; $('#main').style.left = width + 'px'; } else { const ratio = Math.max(.2, Math.min(.8, e.clientX / innerWidth)); $('#split-resizer').style.left = ratio * 100 + '%'; } };
  const up = async e => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (type === 'sidebar') await call('sidebar-width', { width: start + e.clientX - startX }); else { const side = state.sidebarVisible ? state.settings.sidebarWidth : 0; await call('split-ratio', { ratio: (e.clientX - side) / (innerWidth - side) }); } };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
}
$('#sidebar-resizer').addEventListener('pointerdown', e => resizeStart('sidebar', e)); $('#split-resizer').addEventListener('pointerdown', e => resizeStart('split', e));
let dragged = null;
document.addEventListener('dragstart', event => {
  const tab=event.target.closest('[data-tab-row]'), bookmark=event.target.closest('[data-bookmark-id]'), folder=event.target.closest('[data-folder]');
  if(!tab&&!bookmark&&!folder)return;
  dragged={kind:tab?'tab':bookmark?'bookmark':'folder',id:tab?.dataset.tabRow||bookmark?.dataset.bookmarkId||folder?.dataset.folder};
  event.dataTransfer.setData('text/plain',JSON.stringify(dragged));if(tab)event.dataTransfer.setData('application/x-arco-tab',dragged.id);
});
document.addEventListener('dragend',()=>{dragged=null;$('#favorites').classList.remove('drop-target');});
document.addEventListener('dragover',event=>{if(dragged){event.preventDefault();$('#favorites').classList.toggle('drop-target',!!event.target.closest('#favorites'));}});
document.addEventListener('drop',async event=>{
  if(!dragged)return;event.preventDefault();const move=dragged;dragged=null;$('#favorites').classList.remove('drop-target');
  if(event.target.closest('#favorites')) { const item=move.kind==='tab'?state.tabs.find(t=>t.id===move.id):state.allBookmarks.find(b=>b.id===move.id);if(item?.url)await call('add-favorite',{title:item.title.slice(0,500),url:item.url});return; }
  const targetTab=event.target.closest('[data-tab-row]')?.dataset.tabRow, targetBookmark=event.target.closest('[data-bookmark-id]')?.dataset.bookmarkId;
  const targetFolder=event.target.closest('[data-folder]')?.dataset.folder, targetSpace=event.target.closest('[data-switch-space]')?.dataset.switchSpace;
  if(move.kind==='tab') {
    if(targetSpace)await call('tab-action',{id:move.id,action:'move',spaceID:targetSpace});
    else if(targetTab&&targetTab!==move.id)await call(event.altKey?'toggle-split':'tab-action',event.altKey?{id:move.id}:{id:move.id,action:'reorder',beforeID:targetTab});
    else if(event.target.closest('#main'))await call('toggle-split',{id:move.id});
  } else if(move.kind==='bookmark') {
    if(targetBookmark===move.id)return;
    const parentID=targetFolder||state.bookmarks.find(x=>x.id===targetBookmark)?.parentID||null;
    await call('move-bookmark',{id:move.id,spaceID:targetSpace||state.activeSpaceID,parentID,beforeID:targetBookmark});
  } else if(move.kind==='folder'&&targetFolder!==move.id)await call('update-folder',{id:move.id,parentID:targetFolder||null});
});
api.onState(value => { state = value; render(); });
api.onCommand(command => { if (actions[command]) actions[command](); });
api.onEditBookmark(item => showModal('edit-bookmark', item));
api.onEditFolder(item => showModal('folder', item));
document.addEventListener('contextmenu', event => { const tab=event.target.closest('[data-tab-row]'), bookmark=event.target.closest('[data-bookmark-id]'), folder=event.target.closest('[data-folder]'); const item=tab||bookmark||folder;if(!item)return;event.preventDefault();call('item-menu',{kind:tab?'tab':bookmark?'bookmark':'folder',id:tab?.dataset.tabRow||bookmark?.dataset.bookmarkId||folder?.dataset.folder}); });
matchMedia('(prefers-color-scheme:dark)').addEventListener('change', render);
window.addEventListener('beforeunload', () => { if (modal === 'find') call('find-stop'); });
