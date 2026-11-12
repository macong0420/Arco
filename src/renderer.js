'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.arco;
let state = null, modal = '', selectedSuggestion = 0, lastItems = [], toastTimer, browserSources = [], authRequestID = '';
const COLORS = { sky: '#d9e6f7', lavender: '#e5ddf3', rose: '#f2dce4', peach: '#f5e1d5', sand: '#eee6d4', sage: '#e0e6d9', mint: '#d8ebe2', white: '#efefef', graphite: '#555965' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attr = esc;
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const button = (label, action, cls = 'button') => `<button class="${cls}" data-action="${action}">${label}</button>`;
const favicon = (item, fallback = 'globe') => item.favicon && /^https?:\/\//.test(item.favicon) ? `<img src="${attr(item.favicon)}" alt="" data-favicon>` : icon(fallback);
document.addEventListener('error', event => { const img=event.target; if(img instanceof HTMLImageElement && img.hasAttribute('data-favicon')) { const holder=document.createElement('span');holder.innerHTML=icon('globe');img.replaceWith(holder.firstElementChild); } },true);
const hostname = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '新标签页'; } };
const activeTab = () => state?.tabs.find(t => t.id === state.activeID);
function currentSiteHost() {
  const focused = state?.tabs.find(t => t.id === state.focusedPaneID);
  for (const value of [state?.peek?.url, focused?.url, activeTab()?.url]) {
    try { const url = new URL(value); if (url.protocol === 'https:' || url.protocol === 'http:') return url.host; } catch {}
  }
  return '';
}
function systemPasswordsHTML() {
  const host = currentSiteHost();
  return `<div class="notice"><strong>Apple“密码”</strong><p>打开后搜索网站，解锁并复制普通密码或验证码，再回网页粘贴。通行密钥不能复制。${host ? `<br>当前网页：<strong>${esc(host)}</strong>` : ''}</p><button class="button" data-action="open-system-passwords">打开 Apple“密码”</button></div>`;
}
// 页面命令目标与主进程 commandTarget 一致：Peek → 阅读视图 → 聚焦窗格。
const commandTab = () => state?.tabs.find(t => t.id === state.focusedPaneID) || activeTab();
const commandLoading = () => state?.peek ? !!state.peek.loading : state?.reader ? false : !!commandTab()?.loading;
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
  $$('[data-action="reload"]').forEach(button=>{const loading=commandLoading();button.title=loading?'停止加载':'重新加载';button.innerHTML=icon(loading?'close':'reload');});
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
  $('#store-install').hidden = !tab?.store;
  const hasExtensions = (state.settings.extensions || []).length > 0;
  $$('[data-extensions-entry]').forEach(node => { node.hidden = !hasExtensions; });
  $('#download-dot').classList.toggle('active', state.downloads.some(d => d.state === 'progressing'));
  if (state.warning) { toast(state.warning); state.warning = ''; }
  if (state.capture && modal !== 'capture') showModal('capture');
  if (!state.capture && modal === 'capture') closeModal();
  if (state.httpAuth && (modal !== 'http-auth' || authRequestID !== state.httpAuth.id)) showModal('http-auth');
  if (!state.httpAuth && modal === 'http-auth') closeModal();
  if (modal === 'find') {
    const count = $('#find-count');
    if (count) count.textContent = state.find && state.find.matches !== null ? `${state.find.active || 0} / ${state.find.matches}` : '0 / 0';
  }
  if (!state.private && state.settings.onboarded === false && !onboardingShown && !modal) showOnboarding(0);
  if (modal === 'palette') renderSuggestions($('#command-input')?.value || '');
  if (modal === 'overview') renderOverview($('#overview-filter')?.value || '');
  renderPasskeys();
  // 下载面板打开时只更新列表与行状态，不重新调用 showModal/overlay，避免状态循环。
  if (modal === 'downloads') renderDownloads();
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
  const tabs = state.tabs.filter(t => t.spaceID === state.activeSpaceID);
  $('#tabs').innerHTML = tabs.length ? tabs.map(tab => `<div class="sidebar-row ${tab.id === state.activeID ? 'active' : ''} ${tab.id === state.splitID ? 'muted' : ''}" data-tab-row="${attr(tab.id)}" draggable="true"><button data-select-tab="${attr(tab.id)}" style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;text-align:left;min-height:28px">${favicon(tab)}<span>${esc(tab.title || hostname(tab.url))}</span>${tab.muted ? icon('mute') : ''}</button><button class="row-close" data-close-tab="${attr(tab.id)}" title="关闭标签页">${icon('close')}</button></div>`).join('') : '<div class="tab-empty">标签页会出现在这里</div>';
}
function renderSpaces() {
  $('#space-switcher').innerHTML = state.private ? '<span class="pill">不留记录</span>' : state.spaces.map((s, i) => `<button class="space-key ${s.id === state.activeSpaceID ? 'current' : ''}" data-switch-space="${attr(s.id)}" title="${attr(s.name)} · ⌘${i + 1}" style="${s.customColor ? `color:${attr(s.customColor)}` : ''}">${i + 1}</button>`).join('');
}
function panel(title, content, options = {}) {
  return `<section class="panel ${options.class || ''}" role="dialog" aria-modal="true" aria-label="${attr(title)}" ${options.id ? `id="${options.id}"` : ''}><button class="icon panel-close" data-close-modal aria-label="关闭">${icon('close')}</button><h2>${esc(title)}</h2>${content}</section>`;
}
// 通行密钥等待条：只显示真实来源与操作状态，不显示 challenge/凭据/密钥材料。
function renderPasskeys() {
  const node = $('#passkey-wait'); if (!node) return;
  const pending = state?.passkeys || [];
  if (!pending.length) { node.hidden = true; node.innerHTML = ''; return; }
  const unavailable = state.passkeysPlatform === false;
  node.hidden = false;
  node.innerHTML = pending.map(item => `<div class="passkey-row"><div class="grow"><strong>正在等待通行密钥</strong><small>${esc(item.origin)}${unavailable ? ' · 当前版本没有系统通行密钥，请改用安全钥匙、跨设备或密码管理器扩展' : ''}</small></div><button class="button" data-passkey-cancel="${attr(item.id)}">取消</button></div>`).join('');
}
function downloadStatus(record) {
  if (record.state === 'progressing') return `${formatBytes(record.received)} / ${record.total ? formatBytes(record.total) : '未知大小'}`;
  return { completed: '已完成', cancelled: '已取消', interrupted: '已中断' }[record.state] || esc(record.state);
}
function downloadRow(record) {
  const buttons = record.state === 'progressing' ? `<button class="icon" data-download-pause="${attr(record.id)}" title="暂停">${icon('mute')}</button><button class="icon" data-download-cancel="${attr(record.id)}" title="取消">${icon('close')}</button>` : record.state === 'paused' ? `<button class="icon" data-download-resume="${attr(record.id)}" title="继续">${icon('forward')}</button><button class="icon" data-download-cancel="${attr(record.id)}" title="取消">${icon('close')}</button>` : `<button class="icon" data-download-open="${attr(record.id)}" title="打开">${icon('forward')}</button><button class="icon" data-download-reveal="${attr(record.id)}" title="在 Finder 中显示">${icon('folder')}</button>`;
  return `<div class="list-row" data-download-row="${attr(record.id)}"><div class="grow"><strong>${esc(record.filename)}</strong><small data-download-progress>${downloadStatus(record)}</small></div>${buttons}</div>`;
}
function renderDownloads(force = false) {
  const node = $('#download-list'); if (!node || !state) return;
  const list = [...state.downloads].reverse(), signature = list.map(record => record.id + ':' + record.state).join('|');
  // 只有集合/状态变化才重建行和按钮；进度刷新只改文字，不抢焦点也不丢点击。
  if (force || node.dataset.signature !== signature) {
    node.innerHTML = list.length ? list.map(downloadRow).join('') : '<div class="empty">还没有下载</div>';
    node.dataset.signature = signature;
    return;
  }
  [...node.querySelectorAll('[data-download-row]')].forEach((row, index) => {
    const record = list[index], progress = row.querySelector('[data-download-progress]');
    if (record && progress) progress.textContent = downloadStatus(record);
  });
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
  else if (name === 'extensions') { root.innerHTML = panel('扩展', '<div id="extensions-body"><div class="empty">正在读取扩展…</div></div>', { class: 'small', id: 'extensions-panel' }); loadExtensionPanel(); }
  else if (name === 'history') root.innerHTML = panel('浏览历史', `<p class="description">仅记录普通窗口中成功打开的网页。无痕窗口不写入历史。</p><div class="search-field">${icon('search')}<input id="history-filter" placeholder="搜索历史" aria-label="搜索历史"></div><div class="list" id="history-list">${historyHTML()}</div>`, { class: 'wide' });
  else if (name === 'downloads') { root.innerHTML = panel('下载', `<p class="description">查看下载进度，打开文件、在 Finder 中显示或取消下载。</p><div class="list" id="download-list"></div>`, { class: 'wide' }); renderDownloads(true); }
  else if (name === 'overview') root.innerHTML = panel('全部标签页', `<div class="search-field">${icon('search')}<input id="overview-filter" placeholder="筛选标签页" aria-label="筛选标签页"></div><div class="overview-grid" id="overview-grid"></div>`, { class: 'wide' });
  else if (name === 'passwords') {
    const localVault = state.private ? '' : `<section id="arco-passwords"><button class="button" data-action="load-arco-passwords">查看 Arco 保存的密码</button></section>`;
    root.innerHTML = panel('密码', `${systemPasswordsHTML()}${localVault}`, { class: 'wide', id: 'passwords-panel' });
  }
  else if (name === 'find') root.innerHTML = `<section class="panel small find-panel" role="dialog" aria-label="页内查找"><input id="find-input" class="field" placeholder="在页面中查找" aria-label="在页面中查找"><span id="find-count" class="pill">0 / 0</span><button class="icon" data-find="-1" title="上一个">${icon('back')}</button><button class="icon" data-find="1" title="下一个">${icon('forward')}</button><button class="icon" data-action="find-stop" title="关闭">${icon('close')}</button></section>`;
  else if (name === 'http-auth') {
    const request = state.httpAuth; authRequestID = request.id;
    const where = request.proxy ? `代理 ${esc(request.host)}:${esc(request.port)}` : esc(request.origin);
    root.innerHTML = panel(request.proxy ? '登录到代理' : '网站要求登录', `<p class="description">${where}${request.realm ? `（${esc(request.realm)}）` : ''} 要求 HTTP ${request.proxy ? '代理' : 'Basic/Digest'} 登录。凭据只发送给这个请求；Arco 不保存它们。</p><form id="http-auth-form"><input type="hidden" name="id" value="${attr(request.id)}"><label class="field-label">用户名</label><input class="field" name="username" maxlength="1024" autocomplete="username" required><label class="field-label">密码</label><input class="field" name="password" type="password" maxlength="4096" autocomplete="current-password" required><div class="actions">${button('取消', 'http-auth-cancel')}${button('登录', 'http-auth-submit', 'button primary')}</div></form>`, { class: 'small', id: 'http-auth-panel' });
  }
  else if (name === 'edit-bookmark') root.innerHTML = panel('编辑书签', `<form id="edit-bookmark-form"><input type="hidden" name="id" value="${attr(data.id)}"><label class="field-label">名称</label><input class="field" name="title" required maxlength="500" value="${attr(data.title)}"><label class="field-label">网址</label><input class="field" name="url" type="url" required value="${attr(data.url)}"><div class="actions">${button('取消', 'close-modal')}${button('保存', 'submit-edit-bookmark', 'button primary')}</div></form>`, { class: 'small' });
  else if (name === 'peek') root.innerHTML = panel('打开快速预览', `<form id="peek-form"><label class="field-label">网页地址</label><input class="field" name="url" type="url" required value="https://"><div class="actions">${button('取消', 'close-modal')}${button('预览', 'submit-peek', 'button primary')}</div></form>`, { class: 'small' });
  root.querySelectorAll('[data-close-modal]').forEach(el => el.addEventListener('click', closeModal));
  requestAnimationFrame(() => (root.querySelector('input:not([type="hidden"]),button') || root).focus());
  if (name === 'palette') { renderSuggestions(data.value || ''); $('#command-input').select(); }
  if (name === 'overview') renderOverview('');
}
function closeModal(cancelAuth = true) { const closing = modal, authID = authRequestID; if (closing === 'onboarding') call('finish-onboarding'); if (closing === 'find') call('find-stop'); if (closing === 'http-auth' && cancelAuth && authID) call('http-auth-cancel', { id: authID }); modal = ''; authRequestID = ''; $('#overlay-root').hidden = true; $('#overlay-root').innerHTML = ''; call('overlay', { visible: false }); }
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
function formatBytes(bytes) { return bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'; }
function settingsHTML(section) {
  const nav = `<nav class="settings-nav">${[['general', '通用'], ['bookmarks', '书签与导入'], ['sync', '同步'], ['privacy', '隐私与安全'], ['extensions', '扩展'], ['about', '关于 Arco']].map(([key, name]) => `<button data-settings-section="${key}" class="${section === key ? 'active' : ''}">${name}</button>`).join('')}</nav>`;
  let content = '';
  if (section === 'general') content = `<section class="settings-section"><h2>通用</h2><div class="setting-row"><span>搜索引擎<small>地址栏和命令面板使用的搜索服务</small></span><select class="field" id="engine-setting">${[['google', 'Google'], ['duckduckgo', 'DuckDuckGo'], ['bing', 'Bing'], ['baidu', '百度'], ['brave', 'Brave Search']].map(([key, name]) => `<option value="${key}" ${state.settings.engine === key ? 'selected' : ''}>${name}</option>`).join('')}</select></div><div class="setting-row"><span>界面外观<small>窗口色彩同时受当前空间影响</small></span><select class="field" id="theme-setting"><option value="system" ${state.settings.theme === 'system' ? 'selected' : ''}>跟随系统</option><option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>浅色</option><option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>深色</option></select></div><div class="setting-row"><span>网页圆角边框<small>在网页四周保留 8px 空间边框</small></span><button class="switch ${state.settings.frameInset ? 'on' : ''}" data-setting-toggle="frameInset" role="switch" aria-checked="${state.settings.frameInset}"></button></div><div class="setting-row"><span>跟踪器拦截<small>内置 16 个常见跟踪服务域名的主机后缀规则</small></span><button class="switch ${state.settings.trackerBlocking ? 'on' : ''}" data-setting-toggle="trackerBlocking" role="switch" aria-checked="${state.settings.trackerBlocking}"></button></div><h3>页面操作</h3><div class="actions" style="justify-content:flex-start">${button('打印当前页面', 'print')}${button('保存为 PDF', 'pdf')}${button('页面截图', 'screenshot')}${button('开发者工具', 'devtools')}</div><div class="actions" style="justify-content:flex-start">${button('缩小页面', 'zoom-out')}${button('还原缩放', 'zoom-reset')}${button('放大页面', 'zoom-in')}${button('打开快速预览', 'peek-dialog')}</div></section>`;
  if (section === 'bookmarks') content = `<section class="settings-section"><h2>书签与导入</h2><p class="description">收藏磁贴在所有空间共享。固定书签可放入任意层级文件夹，保存在当前空间。</p><div class="actions" style="justify-content:flex-start">${button('添加当前页为书签', 'add-current-bookmark')}${button('添加当前页到收藏', 'add-current-favorite')}${button('新建文件夹', 'folder-dialog')}</div><h3>从浏览器迁移</h3><p class="description">选择本机浏览器个人资料，导入书签，或迁移密码与 Cookie。已有密码及 Cookie 跳过；迁移需要系统授权，部分网站仍需重新登录。读取受保护的浏览器文件需要在 macOS 中允许 Arco 完全磁盘访问。</p><div class="list" id="browser-sources"><div class="empty">正在检测浏览器…</div></div><h3>从文件导入</h3><p class="description">仅读取你明确选择的文件。支持 Netscape HTML、Chromium Bookmarks JSON、Arc StorableSidebar.json（空间名、固定页面及文件夹路径；支持经典与 Arc Sync 侧栏数据）。</p><div class="actions" style="justify-content:flex-start">${button('选择文件导入', 'import-bookmarks', 'button primary')}${button('导出全部书签为 HTML', 'export-bookmarks')}</div><h3>固定书签</h3><div class="list">${state.allBookmarks.length ? state.allBookmarks.map(b => `<div class="list-row">${icon('bookmark')}<div class="grow"><strong>${esc(b.title)}</strong><small>${esc(spaceName(b.spaceID))} · ${esc(b.url)}</small></div><button class="icon" data-edit-bookmark="${attr(b.id)}" title="编辑">${icon('edit')}</button><button class="icon" data-delete-bookmark="${attr(b.id)}" title="删除">${icon('trash')}</button></div>`).join('') : '<div class="empty">还没有固定书签</div>'}</div></section>`;
  if (section === 'sync') content = `<section class="settings-section"><h2>同步</h2><p class="description">选择已由 iCloud Drive、网盘或其他服务同步的文件夹。书签与空间按记录合并，每台设备独立写入快照，删除记录也会同步。</p><div class="setting-row"><span>同步文件夹<small>${esc(state.settings.syncFolder || '尚未连接')}</small></span>${state.settings.syncFolder ? button('断开', 'disconnect-sync') : button('选择文件夹', 'connect-sync', 'button primary')}</div><div class="setting-row"><span>书签与空间<small>${esc(state.settings.syncStatus || '尚未同步')}</small></span>${button('立即同步书签', 'sync-now')}</div><h3>加密密码同步</h3><p class="description">使用相同的同步口令连接其他 Mac。整个密码库经过 scrypt 和 AES-256-GCM 加密，口令不写入磁盘。解锁保持 15 分钟，明文操作仍需要系统认证。</p>${state.passwordSyncUnlocked ? '<div class="actions">' + button('立即同步密码', 'password-sync-now', 'button primary') + button('锁定同步', 'password-sync-lock') + '</div>' : '<form id="password-sync-form"><label class="field-label">同步口令（至少 12 个字符）</label><input name="passphrase" type="password" class="field" autocomplete="off" minlength="12" maxlength="1024" required><div class="actions">' + button('创建或解锁并同步', 'password-sync-submit', 'button primary') + '</div></form>'}<p class="description">密码同步文件包含加密数据；书签文件包含明文网址。本功能使用你自己的同步文件夹，不是 Google Chrome 账号同步或原生 iCloud Keychain。首次连接另一台设备前，请等待网盘文件同步完成。</p></section>`;
  if (section === 'privacy') content = `<section class="settings-section"><h2>隐私与安全</h2><p class="description">网页与浏览器界面相互隔离。网站权限分别询问，打开外部应用前需要你确认。</p><div class="setting-row"><span>Arco 保存的密码<small>密码库在本机加密，密钥由 macOS 钥匙串保护；明文操作要求系统认证</small></span>${button('管理密码', 'passwords')}</div><div class="setting-row"><span>Apple“密码”<small>搜索网站，解锁后复制普通密码或验证码，再回网页粘贴；通行密钥不能复制</small></span>${button('打开 Apple“密码”', 'open-system-passwords')}</div><div class="setting-row"><span>Arco 保险库同步<small>Arco 保存的密码与 Apple“密码”独立存储。如需在其他设备使用，可在同步页配置加密文件夹同步；Apple“密码”的 iCloud 设置由系统管理。</small></span><span class="pill">独立存储</span></div><div class="setting-row"><span>通行密钥（Passkeys）<small>当前版本尚未接通 macOS 系统通行密钥。手动打开 Apple“密码”仅用于复制普通密码或验证码，无法完成通行密钥认证。</small></span><span class="pill">${state.passkeysPlatform ? '可用' : '系统未接通'}</span></div><div class="setting-row"><span>无痕窗口<small>使用独立内存会话，不写历史、密码或会话文件</small></span>${button('新建无痕窗口', 'private-window')}</div><h3>跟踪器规则覆盖</h3><p class="description">当前仅拦截内置 16 个常见跟踪服务域名及其子域名的非主文档网络请求。这不是 EasyList，不声称具有上游约 130,000 条规则，也不替代完整内容拦截器。</p></section>`;
  if (section === 'extensions') content = `<section class="settings-section"><h2>扩展</h2><p class="description">从 Chrome 应用商店安装：粘贴商店链接或 32 位扩展 ID。也可以选择本地解压目录（开发者模式）。</p><div class="form-row"><input id="store-input" class="field" placeholder="https://chromewebstore.google.com/detail/… 或 32 位扩展 ID" maxlength="500" autocomplete="off"><button class="button primary" data-action="install-store-input">从商店安装</button></div><div class="notice">安装通过 Google 官方更新接口下载 crx，先在本机校验签名、扩展 ID 与包内容一致，再解包加载。商店页面自带的“添加至 Chrome”按钮在 Arco 中无效，请用上面的输入框、地址栏右侧的安装按钮，或商店页面顶部的 Arco 安装栏。部分扩展依赖 Electron 未实现的 API（右键菜单、通知、webNavigation 等），功能可能残缺。</div><div class="actions" style="justify-content:flex-start">${button('选择解压扩展目录', 'add-extension')}</div><h3>从 Chrome 迁移扩展</h3><p class="description">复制所选扩展并在 Arco 中安装，保留启用或停用状态。不会迁移扩展账号、API Key 或内部设置，部分 Chrome API 可能不兼容。</p><div id="chrome-extensions" class="list"></div><div id="extension-list" class="list"><div class="empty">正在读取扩展…</div></div></section>`;
  if (section === 'about') content = `<section class="settings-section"><h2>Arco</h2><div class="brand-mark" style="font-size:28px;justify-content:flex-start;margin:20px 0"><span class="arc-symbol" style="width:28px;height:24px"></span><span>Arco</span></div><p class="description">独立 Chromium 桌面浏览器 · Chromium ${esc(state.chromium)}<br>默认窗口 1280 × 820 · 空间、收藏与本地密码</p><p class="description">界面设计参考 Zigzag 的 Arc 风格侧栏及 Apache-2.0 许可实现。Arco 使用自己的名称、A/arc 图标和 wordmark，不隶属于 Arc、Zigzag 或 The Browser Company。</p><p class="description">数据目录：${esc(state.settings.dataDirectory || ' ~/Library/Application Support/Arco')}<br>本地数据使用原子写入；损坏文件会保留备份。密码不会写入文件夹同步或日志。</p><p class="description">详细功能差异、签名与同步说明请查看项目 README 和 NOTICE。</p><div class="actions" style="justify-content:flex-start">${button('重新查看欢迎引导', 'welcome-tour')}</div></section>`;
  return `<div class="settings-layout">${nav}<div>${content}</div></div>`;
}
async function loadCredentials() {
  const section = $('#arco-passwords');
  if (!section || state.private) return;
  section.innerHTML = '<div class="empty">正在读取 Arco 保存的密码…</div>';
  const credentials = await call('credentials');
  if (modal !== 'passwords' || !$('#arco-passwords')) return;
  if (credentials === null) { $('#arco-passwords').innerHTML = button('重试查看 Arco 保存的密码', 'load-arco-passwords'); return; }
  $('#arco-passwords').innerHTML = `<h3>Arco 保存的密码</h3><p class="description">本机加密保险库 · 密钥由 macOS 钥匙串保护。明文显示、复制与导出需要 Touch ID 或系统密码。</p><div class="actions" style="justify-content:flex-start">${button('添加密码', 'new-credential', 'button primary')}${button('生成强密码', 'generate-password')}${button('导入 CSV', 'import-passwords')}${button('导出明文 CSV', 'export-passwords')}</div><div class="notice">仅填充与保存时完全相同的协议、主机和端口，且仅对当前可见标签页操作。普通 HTTP 网站禁止自动填充；localhost 可用于本地测试。</div><div id="credential-list">${credentials.length ? credentials.map(credentialHTML).join('') : '<div class="empty">还没有保存的密码</div>'}</div>`;
}
function credentialHTML(c) { return `<div class="credential">${icon('key')}<div class="grow"><strong>${esc(c.username || '未填写用户名')}</strong><small>${esc(c.origin)}</small></div><button class="button" data-fill-credential="${attr(c.id)}">填充到当前页</button><button class="icon" data-read-credential="${attr(c.id)}" title="显示或复制">${icon('search')}</button><button class="icon" data-delete-credential="${attr(c.id)}" title="删除">${icon('trash')}</button></div>`; }
async function readCredential(id) { const credential = await call('credential-read', { id }); if (!credential) return; showModal('credential-detail', credential); $('#overlay-root').innerHTML = panel('已解锁密码', `<p class="description">${esc(credential.origin)}</p><label class="field-label">用户名</label><input class="field" readonly value="${attr(credential.username)}"><label class="field-label">密码</label><input class="field" type="password" id="revealed-password" readonly value="${attr(credential.password)}"><div class="actions">${button('显示 / 隐藏', 'toggle-password')}${button('复制密码', 'copy-password', 'button primary')}</div>`, { class: 'small' }); }
function showNewCredential() { $('#overlay-root').innerHTML = panel('添加密码', `<form id="credential-form"><label class="field-label">网站来源（协议、主机、端口）</label><input class="field" name="origin" required value="${attr(activeTab()?.url ? new URL(activeTab().url).origin : 'https://')}"><label class="field-label">用户名</label><input class="field" name="username" maxlength="1024"><label class="field-label">密码</label><input class="field" name="password" type="password" required maxlength="4096"><div class="actions">${button('取消', 'passwords')}${button('保存到保险库', 'submit-credential', 'button primary')}</div></form>`, { class: 'small' }); modal = 'new-credential'; }
function extensionsHTML(list) {
  return list.length ? list.map(e => `<div class="list-row">${extensionIconHTML(e)}<div class="grow"><strong>${esc(e.name || e.id)}</strong><small>${e.version ? 'v' + esc(e.version) + ' · ' : ''}${e.enabled ? '已启用' : '已停用'}</small></div><button class="switch ${e.enabled ? 'on' : ''}" data-extension-toggle="${attr(e.id)}" role="switch" aria-checked="${e.enabled}" aria-label="启用或停用 ${attr(e.name || e.id)}"></button><button class="icon" data-remove-extension="${attr(e.id)}" title="移除">${icon('trash')}</button></div>`).join('') : '<div class="empty">还没有安装扩展</div>';
}
function extensionIconHTML(e) { return e.icon && /^data:image\//.test(e.icon) ? `<img class="extension-icon" src="${attr(e.icon)}" alt="">` : icon('tabs'); }
async function loadExtensions() { const node = $('#extension-list'); if (!node) return; const list = await call('extension-list'); if (list && $('#extension-list')) $('#extension-list').innerHTML = extensionsHTML(list); await loadChromeExtensions(); }
async function loadExtensionPanel() {
  const list = await call('extension-list');
  if (!list || !$('#extensions-body')) return;
  const tab = activeTab();
  $('#extensions-body').innerHTML = `<p class="description">点图标执行扩展自己的操作（弹出它自己的界面，或触发它的点击处理）。停用会立即卸载，重新启用时再加载；移除会删除本机文件。</p><browser-action-list partition="persist:arco" tab="${attr(String(tab?.webContentsID ?? -1))}" alignment="bottom left"></browser-action-list><div class="list">${extensionsHTML(list)}</div><div class="actions" style="justify-content:flex-start">${button('从商店安装…', 'open-extensions-settings')}${button('刷新', 'refresh-extensions')}</div>`;
}

async function installStore(input) {
  if (!input) return toast('请先粘贴商店链接或扩展 ID');
  const result = await call('install-extension-store', { input });
  if (!result) return;
  toast(result.already ? '这个扩展已经装好了' : `已安装 ${result.name || '扩展'}`);
  const list = $('#extension-list'); if (list) list.innerHTML = extensionsHTML(result.list);
}
const browserMigrationResults = new Map(), browserMigrationPending = new Set();
async function loadBrowserSources(selector = '#browser-sources') {
  const sources = await call('browser-sources');
  const node = $(selector);
  if (!sources || !node) return;
  browserSources = sources;
  const rows = sources.length ? sources.map(s => {
    const detail = s.note || (s.kind === 'arc' ? 'Arc 的空间、固定页面与文件夹' : s.count ? `${s.count} 个书签` : '没有书签');
    const action = s.count > 0 || s.kind === 'arc' ? `<button class="button" data-import-browser="${attr(s.id)}">导入书签</button>` : '';
    const migration = s.kind === 'chromium' ? `<div class="actions" style="justify-content:flex-start"><label><input type="checkbox" data-migrate-kind="passwords" checked> 密码</label><label><input type="checkbox" data-migrate-kind="cookies"> Cookie / 登录状态</label><button class="button" data-migrate-browser="${attr(s.id)}" ${browserMigrationPending.size ? 'disabled' : ''}>${browserMigrationPending.has(s.id) ? '正在迁移…' : '迁移所选数据'}</button></div><p class="description" role="status">${esc(browserMigrationResults.get(s.id) || '')}</p>` : '';
    return `<div data-migration-profile="${attr(s.id)}"><div class="list-row">${icon('globe')}<div class="grow"><strong>${esc(s.name)}${s.label && s.label !== s.name ? ' · ' + esc(s.label) : ''}</strong><small>${esc(detail)}</small></div>${action}</div>${migration}</div>`;
  }).join('') : '<div class="empty">没有检测到已安装的浏览器。可以在浏览器里导出书签文件，再用「选择文件导入」。</div>';
  node.innerHTML = rows + '<div class="actions" style="justify-content:flex-start"><button class="text-button muted" data-action="refresh-browsers">重新检测</button></div><h3>Safari / Apple「密码」与钥匙串</h3><p class="description">在 Apple「密码」App 中选择「文件 → 导出所有密码」，或在 Safari / Chrome 的密码管理中导出 CSV，再选择下方按钮。导出需要原应用认证，文件包含明文密码，导入后请妥善删除。此入口不读取整个 iCloud 钥匙串，不迁移通行密钥；Safari Cookie 暂不支持直接迁移。</p><button class="button" data-action="import-passwords">选择密码 CSV 导入</button>';
}
const chromeMigrationResults = new Map(), chromeMigrationPending = new Set();
async function loadChromeExtensions() {
  const node = $('#chrome-extensions'); if (!node) return;
  node.textContent = '正在检测 Chrome 扩展…';
  const profiles = await call('chrome-extensions');
  if (!node.isConnected) return;
  if (!profiles) { node.textContent = '检测失败，请重新检测。'; return; }
  node.innerHTML = profiles.length ? profiles.map(profile => `<div data-chrome-profile="${attr(profile.id)}"><h3>Chrome · ${esc(profile.label)}</h3>${profile.note ? `<p class="description">${esc(profile.note)}</p>` : profile.extensions.length ? profile.extensions.map(item => {
    const installed = (state.settings.extensions || []).some(record => record.storeID === item.id);
    return `<div class="list-row"><label class="grow"><input type="checkbox" data-chrome-extension="${attr(item.id)}" ${item.error || installed ? 'disabled' : item.enabled ? 'checked' : ''}> <strong>${esc(item.name)}</strong><small>${esc(item.error || (installed ? '已在 Arco 安装' : `v${item.version} · ${item.enabled ? '已启用' : '已停用'}`))}</small>${!item.error ? `<details><summary>查看权限</summary><small>${esc(item.permissions.join('、') || '无额外权限')}</small></details>` : ''}</label></div>`;
  }).join('') + `<button class="button" data-import-chrome="${attr(profile.id)}" ${chromeMigrationPending.has(profile.id) ? 'disabled' : ''}>${chromeMigrationPending.has(profile.id) ? '正在迁移…' : '迁移所选扩展'}</button><p class="description" data-chrome-result role="status">${esc(chromeMigrationResults.get(profile.id) || '')}</p>` : '<p class="description">没有检测到可迁移的扩展。</p>'}</div>`).join('') : '<p class="description">没有检测到本机 Chrome 个人资料。</p>';
  node.insertAdjacentHTML('beforeend', '<button class="text-button muted" data-action="refresh-chrome-extensions">重新检测</button>');
}
const ONBOARD_STEPS = ['hello', 'bring', 'extensions', 'sites', 'ads', 'ready'];
const ONBOARD_SITES = [['Gmail', 'https://mail.google.com'], ['YouTube', 'https://www.youtube.com'], ['Notion', 'https://www.notion.so'], ['ChatGPT', 'https://chatgpt.com'], ['Claude', 'https://claude.ai'], ['GitHub', 'https://github.com'], ['X', 'https://x.com'], ['Figma', 'https://www.figma.com'], ['Bilibili', 'https://www.bilibili.com'], ['知乎', 'https://www.zhihu.com'], ['小红书', 'https://www.xiaohongshu.com'], ['Spotify', 'https://open.spotify.com']];
const ONBOARD_TITLES = { extensions: ['把 Chrome 扩展带过来', '选择要迁移的扩展，复制到 Arco 并实际安装，保留启用或停用状态。不会迁移扩展账号、API Key 或内部设置；部分 Chrome API 可能不兼容。'], bring: ['把浏览器数据带过来', '从本机浏览器导入书签，选择迁移 Chromium 浏览器的密码与 Cookie；Safari 和 Apple「密码」支持 CSV 密码导入。已有记录跳过，迁移需要系统授权。'], sites: ['固定常用网站', '选中的网站会变成侧栏顶部的常驻磁贴，点一下就打开。'], ads: ['拦截跟踪器？', 'Arco 内置拦截器，只挡内置清单里的跟踪服务域名，页面更快，也少被跟踪。'], ready: ['准备就绪', '选择界面外观，之后随时可以在设置里改。'] };
let onboardingStep = 0, onboardingShown = false;
const pickedSites = new Map();
function onboardingPanel() {
  const step = ONBOARD_STEPS[onboardingStep], last = onboardingStep === ONBOARD_STEPS.length - 1;
  let body;
  if (step === 'hello') body = `<div class="onboard-hello"><div class="brand-mark"><span class="arc-symbol"></span><span>Arco</span></div><h2>给自己一点空间。</h2><p class="description">侧栏放你常用的网站，标签页按空间分组。先花一分钟把它调成你的样子。</p></div>`;
  else if (step === 'bring') body = `<p class="description">${ONBOARD_TITLES.bring[1]}</p><div class="list" id="onboard-sources"><div class="empty">正在检测浏览器…</div></div>`;
  else if (step === 'extensions') body = `<p class="description">${ONBOARD_TITLES.extensions[1]}</p><div class="list" id="chrome-extensions"></div>`;
  else if (step === 'sites') body = `<p class="description">${ONBOARD_TITLES.sites[1]}</p><div class="onboard-sites">${ONBOARD_SITES.map(([name, url]) => `<button class="onboard-site ${pickedSites.has(url) ? 'picked' : ''}" data-onboard-site="${attr(url)}" aria-pressed="${pickedSites.has(url)}">${favicon({ favicon: new URL(url).origin + '/favicon.ico' })}<span>${esc(name)}</span></button>`).join('')}</div>`;
  else if (step === 'ads') body = `<p class="description">${ONBOARD_TITLES.ads[1]}</p><div class="setting-row"><span>拦截跟踪器<small>内置 16 个常见跟踪服务域名，只拦截非主文档请求</small></span><button class="switch ${state.settings.trackerBlocking ? 'on' : ''}" data-onboard-toggle="trackerBlocking" role="switch" aria-checked="${state.settings.trackerBlocking}"></button></div>`;
  else body = `<p class="description">${ONBOARD_TITLES.ready[1]}</p><label class="field-label" for="onboard-theme">界面外观</label><select class="field" id="onboard-theme"><option value="system" ${state.settings.theme === 'system' ? 'selected' : ''}>跟随系统</option><option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>浅色</option><option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>深色</option></select><div class="onboard-keys"><span><kbd>⌘T</kbd> 新标签页</span><span><kbd>⌘L</kbd> 地址栏</span><span><kbd>⌘F</kbd> 页内查找</span><span><kbd>⇧⌘T</kbd> 恢复标签</span><span><kbd>⌘,</kbd> 设置</span></div>`;
  const heading = step === 'hello' ? '' : `<p class="onboard-kicker">第 ${onboardingStep} 步，共 ${ONBOARD_STEPS.length - 1} 步</p><h2>${ONBOARD_TITLES[step][0]}</h2>`;
  const label = onboardingStep === 0 ? '开始' : last ? '完成' : '下一步';
  return `<section class="panel onboard" role="dialog" aria-modal="true" aria-label="欢迎使用 Arco" data-onboarding="${step}"><button class="icon panel-close" data-close-modal aria-label="关闭">${icon('close')}</button>${heading}<div class="onboard-content">${body}</div><div class="onboard-footer"><button class="text-button muted" data-action="onboard-skip">跳过</button><span class="toolbar-spacer"></span>${onboardingStep > 0 ? '<button class="button" data-action="onboard-back">返回</button>' : ''}<button class="button primary" data-action="onboard-next">${label}</button></div></section>`;
}
function showOnboarding(step = 0) {
  onboardingStep = step; onboardingShown = true; modal = 'onboarding';
  call('overlay', { visible: true, kind: 'onboarding' });
  const root = $('#overlay-root'); root.hidden = false; root.dataset.modal = 'onboarding'; root.innerHTML = onboardingPanel();
  root.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
  requestAnimationFrame(() => (root.querySelector('.onboard-footer .button.primary') || root).focus());
  if (ONBOARD_STEPS[step] === 'bring') loadBrowserSources('#onboard-sources');
  if (ONBOARD_STEPS[step] === 'extensions') loadChromeExtensions();
}
const actions = {
  'toggle-sidebar': () => call('toggle-sidebar'), back: () => call('back'), forward: () => call('forward'), reload: () => call(commandLoading() ? 'stop' : 'reload'),
  palette: () => showModal('palette', { value: isBlank() ? '' : activeTab()?.url }), 'new-tab': () => call('new-tab'), 'close-modal': closeModal,
  'clear-tabs': () => call('clear-tabs'), downloads: () => showModal('downloads'), settings: () => showModal('settings'), history: () => showModal('history'),
  passwords: () => showModal('passwords'), overview: () => showModal('overview'), menu: () => call('menu'),
  'load-arco-passwords': loadCredentials,
  'open-system-passwords': async () => { if (await call('open-system-passwords') === true) closeModal(); },
  'add-space': () => showModal('space'), 'toggle-split': () => call('toggle-split'), 'close-split': () => call('toggle-split'),
  'add-current-bookmark': () => { if (!isBlank()) showModal('bookmark'); },
  'add-current-favorite': async () => { const tab = activeTab(); if (!isBlank() && await call('add-favorite', { title: tab.title.slice(0,500), url: tab.url })) toast('常驻网站已保存'); },
  'favorite-dialog': () => showModal('favorite'), 'submit-favorite': () => $('#favorite-form').requestSubmit(),
  'bookmark-dialog': () => showModal('bookmark'), 'folder-dialog': () => showModal('folder'),
  'close-peek': () => call('close-peek'), 'peek-to-tab': () => call('peek-to-tab'), 'peek-dialog': () => showModal('peek'),
  reader: () => call('reader'),
  find: () => showModal('find'), 'find-stop': () => { call('find-stop'); closeModal(); },
  'private-window': () => { closeModal(); call('private-window'); },
  print: () => call('print'), pdf: () => call('pdf'), screenshot: () => call('screenshot'), devtools: () => call('devtools'),
  'zoom-out': () => call('zoom', { delta: -0.1 }), 'zoom-in': () => call('zoom', { delta: 0.1 }), 'zoom-reset': () => call('zoom', { reset: true }),
  'capture-save': async () => { if (await call('capture-save') !== null || !state.capture) { closeModal(); toast('密码已保存到加密保险库'); } }, 'capture-dismiss': () => { call('capture-dismiss'); closeModal(); },
  'http-auth-submit': () => $('#http-auth-form').requestSubmit(), 'http-auth-cancel': closeModal,
  'import-bookmarks': async () => { const result = await call('import-bookmarks'); if (result !== null) { showModal('settings', { section: 'bookmarks' }); toast('导入完成，重复网址已跳过'); } },
  'export-bookmarks': async () => { if (await call('export-bookmarks')) toast('书签已导出为 HTML'); },
  'connect-sync': async () => { await call('connect-sync'); showModal('settings', { section: 'sync' }); }, 'disconnect-sync': async () => { await call('disconnect-sync'); showModal('settings', { section: 'sync' }); },
  'sync-now': async () => { await call('sync-now'); showModal('settings', { section: 'sync' }); },
  'submit-bookmark': () => $('#bookmark-form').requestSubmit(), 'submit-folder': () => $('#folder-form').requestSubmit(), 'submit-space': () => $('#space-form').requestSubmit(),
  'remove-space': async () => { const id=$('#space-form [name="id"]').value;if (await call('confirm-clear', { message: '删除此空间及其固定书签？此操作会通过同步传播。' })) { closeModal(); await call('remove-space', { id }); } },
  'submit-edit-bookmark': () => $('#edit-bookmark-form').requestSubmit(), 'submit-peek': () => $('#peek-form').requestSubmit(),
  'new-credential': showNewCredential, 'submit-credential': () => $('#credential-form').requestSubmit(),
  'generate-password': async () => { const value = await call('generate-password'); if (value && modal === 'passwords') { $('#arco-passwords .notice').innerHTML = `<strong>新生成的密码（尚未保存）</strong><div class="password-generated">${esc(value)}</div><button class="button" data-copy-generated>复制</button>`; $('[data-copy-generated]').onclick = () => { call('copy', { text: value }); toast('已复制，请添加到密码或用于注册'); }; } },
  'import-passwords': async () => { const result = await call('import-passwords'); if (result !== null) { toast(`已导入 ${result.imported} 条密码，跳过 ${result.skipped} 条已有记录`); if (modal === 'passwords') loadCredentials(); } },
  'export-passwords': async () => { if (await call('export-passwords')) toast('明文 CSV 已导出，请尽快安全删除'); },
  'toggle-password': () => { const field = $('#revealed-password'); field.type = field.type === 'password' ? 'text' : 'password'; },
  'copy-password': () => { call('copy', { text: $('#revealed-password').value }); toast('密码已复制，请注意剪贴板安全'); },
  'add-extension': async () => { const value = await call('add-extension'); if (value) { state.settings.extensions.push({ id: value.id, path: value.path, name: value.name }); loadExtensions(); } },
  'install-store': () => { const tab = activeTab(); if (tab?.store) installStore(tab.store); },
  extensions: () => showModal('extensions'),
  'refresh-extensions': () => loadExtensionPanel(),
  'open-extensions-settings': () => { showModal('settings', { section: 'extensions' }); loadExtensions(); },
  'install-store-input': () => installStore($('#store-input')?.value),
  'store-installed': () => { toast('扩展已安装'); if (modal === 'settings') { showModal('settings', { section: 'extensions' }); loadExtensions(); } },
  'password-sync-submit': () => $('#password-sync-form').requestSubmit(),
  'password-sync-lock': async () => { if(await call('password-sync-lock'))showModal('settings',{section:'sync'}); },
  'password-sync-now': async () => { if(await call('password-sync-now')){showModal('settings',{section:'sync'});toast('加密密码同步完成');} },
  'close-toast': () => { $('#toast').hidden = true; },
  'refresh-chrome-extensions': () => loadChromeExtensions(),
  'refresh-browsers': () => loadBrowserSources(modal === 'onboarding' ? '#onboard-sources' : '#browser-sources'),
  'onboard-next': () => { if (onboardingStep >= ONBOARD_STEPS.length - 1) return closeModal(); showOnboarding(onboardingStep + 1); },
  'onboard-back': () => showOnboarding(Math.max(0, onboardingStep - 1)),
  'onboard-skip': () => closeModal(),
  'welcome-tour': () => showOnboarding(0)
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
  if (a.downloadPause) { await call('download-pause', { id: a.downloadPause }); return; }
  if (a.downloadResume) { await call('download-resume', { id: a.downloadResume }); return; }
  if (a.passkeyCancel) return call('passkey-cancel', { id: a.passkeyCancel });
  if (a.importChrome) {
    const group = el.closest('[data-chrome-profile]');
    const ids = [...group.querySelectorAll('[data-chrome-extension]:checked:not(:disabled)')].map(input => input.dataset.chromeExtension);
    if (!ids.length) return toast('请先选择要迁移的扩展');
    chromeMigrationPending.add(a.importChrome);
    el.disabled = true; el.textContent = '正在迁移…';
    const results = await call('import-chrome-extensions', { profileID: a.importChrome, ids });
    chromeMigrationPending.delete(a.importChrome);
    chromeMigrationResults.set(a.importChrome, results ? results.map(item => `${item.name}：${item.error || (item.already ? '已安装，已跳过' : item.enabled ? '已安装并启用' : '已安装，保持停用')}`).join('；') : '迁移未完成，请重试。');
    await loadChromeExtensions();
    const list = await call('extension-list');
    if (list && $('#extension-list')) $('#extension-list').innerHTML = extensionsHTML(list);
    return;
  }
  if (a.migrateBrowser) {
    if (browserMigrationPending.size) return;
    const group = el.closest('[data-migration-profile]');
    const choices = [...group.querySelectorAll('[data-migrate-kind]:checked')].map(input => input.dataset.migrateKind);
    if (!choices.length) return toast('请先选择密码或 Cookie');
    browserMigrationPending.add(a.migrateBrowser);
    document.querySelectorAll('[data-migrate-browser]').forEach(button => { button.disabled = true; });
    el.textContent = '正在迁移…';
    try {
      const result = await call('migrate-browser-data', { id: a.migrateBrowser, choices });
      browserMigrationResults.set(a.migrateBrowser, result ? Object.entries(result).map(([kind, item]) => `${kind === 'passwords' ? '密码' : 'Cookie'}：导入 ${item.imported}，跳过 ${item.skipped}，失败 ${item.failed}${item.errors.length ? '；' + item.errors.join('；') : ''}`).join('。') : '迁移已取消或未完成，可重试');
    } finally {
      browserMigrationPending.delete(a.migrateBrowser);
      if (modal === 'onboarding' && ONBOARD_STEPS[onboardingStep] === 'bring') await loadBrowserSources('#onboard-sources');
      else if (modal === 'settings') await loadBrowserSources();
    }
    return;
  }
  if (a.importBrowser) {
    const count = await call('import-browser', { id: a.importBrowser });
    const source = browserSources.find(s => s.id === a.importBrowser);
    if (count !== null) {
      toast(source?.kind === 'arc' ? `已导入 Arc 的 ${count} 个空间` : count ? `已导入 ${count} 个书签，重复网址已跳过` : '没有新的书签可以导入');
      if (modal === 'onboarding') loadBrowserSources('#onboard-sources'); else showModal('settings', { section: 'bookmarks' });
    }
    return;
  }
  if (a.onboardSite) {
    const url = a.onboardSite;
    if (pickedSites.has(url)) { const id = pickedSites.get(url); pickedSites.delete(url); el.classList.remove('picked'); el.setAttribute('aria-pressed', 'false'); await call('delete-bookmark', { id }); }
    else { const item = await call('add-favorite', { url, title: el.textContent.trim() }); if (item?.id) { pickedSites.set(url, item.id); el.classList.add('picked'); el.setAttribute('aria-pressed', 'true'); } }
    return;
  }
  if (a.onboardToggle) {
    const on = !el.classList.contains('on'); el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on));
    return call('update-settings', { [a.onboardToggle]: on });
  }
  if (a.settingsSection) { showModal('settings', { section: a.settingsSection }); if (a.settingsSection === 'extensions') loadExtensions(); return; }
  if (a.settingToggle) return call('update-settings', { [a.settingToggle]: !state.settings[a.settingToggle] });
  if (a.spaceColor) { $('#space-form [name="color"]').value = a.spaceColor; $$('.swatch').forEach(x => x.classList.toggle('selected', x === el)); return; }
  if (a.fillCredential) { const result = await call('credential-fill', { id: a.fillCredential }); if(result?.count) {closeModal();toast('已填充当前可见登录字段');} else if(result)toast('当前页面没有可见的登录字段'); return; }
  if (a.readCredential) return readCredential(a.readCredential);
  if (a.deleteCredential) { if (await call('confirm-clear', { message: '删除此密码？' })) { await call('credential-delete', { id: a.deleteCredential }); loadCredentials(); } return; }
  if (a.extensionToggle) {
    const on = !el.classList.contains('on');
    const list = await call('extension-toggle', { id: a.extensionToggle, enabled: on });
    if (list) { el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); if ($('#extensions-body')) loadExtensionPanel(); if ($('#extension-list')) $('#extension-list').innerHTML = extensionsHTML(list); }
    return;
  }
  if (a.removeExtension) { await call('remove-extension', { id: a.removeExtension }); state.settings.extensions = state.settings.extensions.filter(e => e.id !== a.removeExtension); loadExtensions(); if ($('#extensions-body')) loadExtensionPanel(); return; }
  if (a.find) { const input = $('#find-input'); if (input?.value) call('find', { query: input.value, forward: Number(a.find) > 0, findNext: true }); return; }
  if (a.copyGenerated !== undefined) return;
});
$('#space-heading').addEventListener('click', () => { if (!state.private) showModal('space', { id: state.activeSpaceID }); });
$('#overlay-root').addEventListener('click', event => { if (event.target === $('#overlay-root') && modal !== 'capture') closeModal(); });
document.addEventListener('submit', async event => {
  event.preventDefault();
  // 表单里有 name="id" 的隐藏字段时，form.id 的命名属性会覆盖 id 属性返回该 input，必须读属性。
  const form = event.target, formID = form.getAttribute('id'), data = Object.fromEntries(new FormData(form));
  if (formID === 'favorite-form') { if(await call('add-favorite',data)!==null){closeModal();toast('常驻网站已保存');} }
  if (formID === 'bookmark-form') { if (await call('add-bookmark', data) !== null) { closeModal(); toast('书签已保存到当前空间'); } }
  if (formID === 'folder-form') { if (await call(data.id ? 'update-folder' : 'add-folder', data) !== null) closeModal(); }
  if (formID === 'space-form') { if (!data.useCustom) data.customColor = ''; else data.customColor = data.customColor || '#d9e6f7'; if (data.id) { if (await call('update-space', data) !== null) closeModal(); } else { if (await call('add-space', data) !== null) closeModal(); } }
  if (formID === 'edit-bookmark-form') { if (await call('update-bookmark', data) !== null) closeModal(); }
  if (formID === 'peek-form') { closeModal(); await call('peek', { url: data.url }); }
  if (formID === 'password-sync-form') { const input=form.elements.passphrase; const passphrase=input.value; input.value=''; if(await call('password-sync-unlock',{passphrase}) && await call('password-sync-now')) {showModal('settings',{section:'sync'});toast('加密密码同步完成');} }
  if (formID === 'credential-form') { if (await call('credential-save', data)) { toast('密码已保存到加密保险库'); showModal('passwords'); } }
  if (formID === 'http-auth-form') {
    const password = data.password; data.password = '';
    const result = await call('http-auth-submit', { id: data.id, username: data.username, password });
    if (result !== null) closeModal(false);
  }
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
  if (event.target.id === 'onboard-theme') call('update-settings', { theme: event.target.value });
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
api.onPasskeyUnavailable(() => toast('Arco 没有可用的系统通行密钥，请改用密码登录'));
document.addEventListener('contextmenu', event => { const tab=event.target.closest('[data-tab-row]'), bookmark=event.target.closest('[data-bookmark-id]'), folder=event.target.closest('[data-folder]'); const item=tab||bookmark||folder;if(!item)return;event.preventDefault();call('item-menu',{kind:tab?'tab':bookmark?'bookmark':'folder',id:tab?.dataset.tabRow||bookmark?.dataset.bookmarkId||folder?.dataset.folder}); });
matchMedia('(prefers-color-scheme:dark)').addEventListener('change', render);
window.addEventListener('beforeunload', () => { if (modal === 'find') call('find-stop'); });
