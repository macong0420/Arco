'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-e2e-'));
let app, shell, server, origin;
async function launch() {
  app = await electron.launch({ args: [root], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile, ...(origin ? { ARCO_TEST_PERMISSION_GRANTS: JSON.stringify([{ origin, permission: 'notifications', allow: true }]) } : {}) }, timeout: 15000 });
  shell = null;
  for (let i=0;i<200&&!shell;i++) {
    shell=(await app.windows()).find(page=>/shell\.html$/.test(page.url()));
    if(!shell)await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(shell,'Browser shell must be present'); shell.setDefaultTimeout(8000);
  await shell.waitForFunction(() => !!window.arco && !!document.querySelector('#space-name')?.textContent);
  // 首次启动会弹欢迎引导；下面的用例从浏览器界面开始，先把引导关掉（关闭等于完成）。
  if (await shell.waitForSelector('[data-onboarding]', { timeout: 4000 }).catch(() => null)) {
    await shell.click('[data-action="onboard-skip"]');
    await shell.waitForFunction(() => !document.querySelector('[data-onboarding]'));
  }
}
async function close() {
  if (!app) return;
  const child = app.process();
  await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2500))]);
  if (child.exitCode === null) child.kill('SIGTERM');
  app = null;
}
const invoke = (channel, payload = {}, page = shell) => page.evaluate(({channel,payload}) => window.arco.invoke('arco:invoke',{channel,payload}),{channel,payload});
const inspect = (action,payload={},page=shell) => page.evaluate(({action,payload}) => window.arco.invoke('arco:test',{action,payload}),{action,payload});
async function remote(url) {
  for (let i=0;i<100;i++) {
    const page=(await app.windows()).find(p=>p.url()===url); if(page){page.setDefaultTimeout(8000);await page.waitForLoadState('domcontentloaded');return page;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Missing real Chromium target: '+url);
}
async function waitState(check) { await assertEventually(async()=>check(await inspect('state'))); }
// 页面焦点快捷键必须用原生等价输入验证：Playwright 的 CDP 键盘事件不触发 before-input-event。
const press = (page, key, modifiers = []) => inspect('press', { url: page.url(), key, modifiers });
async function readerPage() {
  for (let i = 0; i < 100; i++) {
    const page = (await app.windows()).find(candidate => candidate.url().startsWith('data:text/html'));
    if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Missing reader view');
}
async function assertEventually(check) { for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('State did not converge'); }
const fixture = '<!doctype html><title>Arco Fixture</title><link rel="icon" href="/ui-icon.svg"><h1>Real Chromium fixture</h1><form action="/welcome"><input name="username" autocomplete="username" value="alice"><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form><a id="peek-link" href="/second">Second page</a>';
test('real app: Chromium, overlays, spaces, split, passwords, private isolation and restart', {timeout:120000}, async t=>{
  const requestCounts=new Map(),authAttempts=[],authChallenges=[],authSuccesses=[];
  const count=request=>requestCounts.set(request.url.split('?')[0],(requestCounts.get(request.url.split('?')[0])||0)+1);
  server=http.createServer((req,res)=>{
    count(req);
    if(req.url.startsWith('/ui-icon.svg')){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#4e78ca"/><path d="M32 92V60a32 32 0 0 1 64 0v32M44 76h40" fill="none" stroke="white" stroke-width="12"/></svg>');}
    if(req.url.startsWith('/fixture.txt')){res.setHeader('Content-Type','text/plain');res.setHeader('Content-Disposition','attachment; filename="arco-popup.txt"');return res.end('popup download fixture');}
    if(req.url.startsWith('/basic-')){
      const path=req.url.split('?')[0];
      const expected={ '/basic-tab':['tab-user','tab-secret'], '/basic-popup':['popup-user','popup-secret'], '/basic-private':['private-user','private-secret'], '/basic-cancel':['never','never'], '/basic-close':['never','never'] }[path];
      // 每个受保护区用独立 realm：Chromium 按 origin+realm 缓存认证，共用 realm 会让“取消”自动重放旧凭据。
      const realm={ '/basic-tab':'Arco tab', '/basic-popup':'Arco popup', '/basic-private':'Arco private', '/basic-cancel':'Arco cancel', '/basic-close':'Arco close' }[path]||'Arco fixture';
      const header=req.headers.authorization||'',decoded=header.startsWith('Basic ')?Buffer.from(header.slice(6),'base64').toString():'';
      const [username,password]=decoded.split(':');authAttempts.push({path,username,password:password?'provided':'',realm});
      if(username!==expected[0]||password!==expected[1]){authChallenges.push({path,username});res.writeHead(401,{'WWW-Authenticate':`Basic realm="${realm}"`,'Content-Type':'text/html; charset=utf-8'});return res.end('<title>Auth Required</title>');}
      authSuccesses.push({path,username});
      res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<title>Authenticated ${username}</title><h1>Authenticated ${username}</h1>`);
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(req.url.startsWith('/welcome'))return res.end('<title>Welcome</title><h1>Signed in</h1>');
    if(req.url.startsWith('/second'))return res.end('<title>Second Fixture</title><h1>Second page</h1>');
    if(req.url.startsWith('/split-left'))return res.end('<title>Split Left</title><body>left unique findtarget</body>');
    if(req.url.startsWith('/split-right'))return res.end('<title>Split Right</title><body><p>right unique findtarget</p><p>right unique findtarget again</p></body>');
    if(req.url.startsWith('/peek-state'))return res.end('<title>Peek A</title><a id="next" href="/peek-next">Next</a>');
    if(req.url.startsWith('/shortcut-target'))return res.end('<title>Shortcut Target</title><h1>Shortcut target</h1>');
    if(req.url.startsWith('/shortcut'))return res.end('<title>Shortcut Fixture</title><a id="peek-link" href="/shortcut-target">Shortcut target</a>');
    if(req.url.startsWith('/peek-next'))return res.end('<title>Peek B</title><input id="peek-field" value=""><script>window.loadedAt=performance.now()</script>');
    if(req.url.startsWith('/reader-invalid'))return res.end('<!doctype html><title></title><body></body>');
    if(req.url.startsWith('/reader-valid'))return res.end('<title>Reader Fixture</title><article><h1>Reader Fixture</h1>'+Array.from({length:12},(_,i)=>`<p>Paragraph ${i} with enough readable article text for Readability extraction.</p>`).join('')+'<p><a id="reader-link" href="/reader-follow" onclick="window.readerScriptRan=true">Read more</a></p></article><script>window.pageScriptRan=true</script>');
    if(req.url.startsWith('/reader-follow'))return res.end('<title>Reader Follow</title><h1>Followed link</h1>');
    if(req.url.startsWith('/popup-owner'))return res.end('<title>Popup Owner</title><button id="open-download">Download popup</button><button id="open-permission">Permission popup</button><button id="open-auth">Auth popup</button><script>document.getElementById("open-download").onclick=()=>window.open("/popup-download","download","width=430,height=530");document.getElementById("open-permission").onclick=()=>window.open("/popup-permission","permission","width=430,height=530");document.getElementById("open-auth").onclick=()=>window.open("/basic-popup","auth","width=430,height=530")</script>');
    if(req.url.startsWith('/popup-download'))return res.end('<title>Popup Download</title><a id="download" href="/fixture.txt" download>Download</a>');
    if(req.url.startsWith('/popup-permission'))return res.end('<title>Popup Permission</title><button id="ask">Ask</button><div id="result">waiting</div><script>document.getElementById("ask").onclick=async()=>{document.getElementById("result").textContent=await Notification.requestPermission()}</script>');
    if(req.url.startsWith('/oauth-provider'))return res.end('<title>OAuth Provider</title><script>try{if(typeof require!=="undefined"||window.arco)throw new Error("unsafe context");window.opener.postMessage("code=e2e","*")}catch(e){document.title="no-opener"}setTimeout(()=>window.close(),80)</script>');
    if(req.url.startsWith('/oauth-frame'))return res.end('<button id="frame-go">登录</button><script>document.getElementById("frame-go").onclick=()=>window.open("/oauth-provider","auth");window.addEventListener("message",e=>parent.postMessage(e.data,"*"))</script>');
    if(req.url.startsWith('/oauth-start')){
      const mode=new URL(req.url,'http://localhost').searchParams.get('mode');
      const open=mode==='tab'?'window.open("/oauth-provider","auth")':mode==='blank'?'(() => {const p=window.open("","auth");p.location.href="/oauth-provider"})()':'window.open("/oauth-provider","auth","width=420,height=520")';
      return res.end(`<title>OAuth Start</title><button id="go">第三方登录</button><div id="result">waiting</div>${mode==='iframe'||mode==='cross-origin'?`<iframe src="${mode==='cross-origin'?origin.replace('127.0.0.1','localhost'):origin}/oauth-frame"></iframe>`:''}<script>document.getElementById("go").onclick=()=>${open};window.addEventListener("message",e=>{document.getElementById("result").textContent="got:"+e.data})</script>`);
    }
    if(req.url.startsWith('/peek-base'))return res.end('<title>Peek Base</title><form><input id="draft" name="draft" value=""></form>');
    if(req.url.startsWith('/peek-target'))return res.end('<title>Peek Target</title><h1>Peek target</h1>');
    if(req.url.startsWith('/slow-page')){setTimeout(()=>res.end('<title>Slow Page</title><h1>Slow page</h1>'),700);return;}
    res.end(fixture);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await close();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});});
  await launch();
  await app.evaluate(({session},directory)=>session.fromPartition('persist:arco').setDownloadPath(directory),profile);
  await t.test('Chromium pages are real isolated targets',async()=>{
    assert.match(await app.evaluate(()=>process.versions.chrome),/^\d+\./);
    await invoke('navigate',{input:origin+'/'}); const page=await remote(origin+'/');
    assert.equal(await page.title(),'Arco Fixture'); assert.equal(await page.evaluate(()=>typeof require),'undefined');
    assert.equal(await page.evaluate(()=>typeof window.arco),'undefined');
    assert.equal((await inspect('views')).filter(x=>x.visible).length,1);
    await page.evaluate(()=>document.cookie='ordinary=normal; SameSite=Lax');
    const iconResult=await shell.evaluate(url=>{const holder=document.createElement('div');holder.innerHTML=favicon({favicon:url})+'<span>Title</span>';document.body.append(holder);holder.querySelector('img').dispatchEvent(new Event('error'));const result={text:holder.textContent,fallback:!!holder.querySelector('svg'),inlineHandlers:holder.querySelectorAll('[onerror]').length};holder.remove();return result;},origin+'/broken-icon.ico');
    assert.deepEqual(iconResult,{text:'Title',fallback:true,inlineHandlers:0});
    await inspect('capture',{name:'loaded-page'});
  });
  await t.test('featureless and initially blank login tabs preserve the native opener',async()=>{
    for(const mode of ['tab','blank','iframe','cross-origin']){
      const url=origin+'/oauth-start?mode='+mode;
      await invoke('new-tab',{url});const page=await remote(url);
      const windowCount=await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows().length);
      if(mode==='iframe'||mode==='cross-origin')await page.frameLocator('iframe').locator('#frame-go').click();else await page.locator('#go').click();
      await assertEventually(async()=>(await page.locator('#result').textContent())==='got:code=e2e');
      await waitState(s=>!s.tabs.some(tab=>tab.url&&new URL(tab.url).pathname==='/oauth-provider'));
      assert.equal(await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows().length),windowCount,'featureless opens stay in tabs');
      const parent=(await inspect('state')).tabs.find(tab=>tab.url===url);
      assert(parent,'the opener must remain open');
      await invoke('close-tab',{id:parent.id});
    }
  });
  await t.test('compact toolbar, collapsed safe area and permanent shortcuts work through the UI',async()=>{
    const rowIcon=shell.locator('#tabs [data-select-tab] img').first();await rowIcon.waitFor();
    const iconSize=await rowIcon.boundingBox();assert.equal(iconSize.width,16);assert.equal(iconSize.height,16);
    assert.equal(await shell.locator('#page-toolbar').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
    assert.equal(await shell.locator('#page-toolbar .icon').first().evaluate(el=>getComputedStyle(el).boxShadow),'none');
    await shell.locator('#space-heading').focus();await shell.keyboard.press('Enter');await shell.locator('#space-form').waitFor({state:'visible'});await shell.keyboard.press('Escape');
    await shell.getByRole('button',{name:'添加常驻网站',exact:true}).click();await shell.locator('#favorite-title').fill('常驻测试');
    assert.equal(await shell.locator('#favorite-url').inputValue(),origin+'/');await shell.getByRole('button',{name:'添加到常驻',exact:true}).click();
    await waitState(s=>s.favorites.some(item=>item.title==='常驻测试'));
    const favorite=shell.locator('[data-favorite-id]');assert.equal(await favorite.count(),1);
    assert.equal(await shell.locator('#favorites').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),3);
    const image=favorite.locator('img');await image.waitFor();const favoriteSize=await image.boundingBox();assert.equal(favoriteSize.width,18);assert.equal(favoriteSize.height,18);
    const firstID=(await inspect('state')).favorites[0].id;await invoke('add-favorite',{title:'重复',url:origin+'/'});assert.equal((await inspect('state')).favorites.length,1);assert.equal((await inspect('state')).favorites[0].id,firstID);
    await invoke('toggle-sidebar');const restore=shell.getByRole('button',{name:'显示侧栏',exact:true});await restore.waitFor({state:'visible'});
    await shell.waitForFunction(()=>Math.abs(document.querySelector('#main').getBoundingClientRect().left)<.5);
    const bounds=await restore.boundingBox();assert(bounds.x>=86,'restore control must clear native traffic lights');
    assert.equal(await shell.locator('#collapsed-navigation').isVisible(),true);
    assert((await inspect('views')).filter(v=>v.visible).every(v=>v.bounds.y>=40));
    await inspect('capture',{name:'ui-sidebar-collapsed'});await restore.click();await waitState(s=>s.sidebarVisible);
    await shell.getByRole('button',{name:'常驻测试',exact:true}).click();assert.equal((await inspect('state')).tabs.length,1,'a shortcut should reuse the open tab');
    await invoke('new-tab');const blank=(await inspect('state')).activeID;
    await invoke('toggle-sidebar');await shell.getByRole('button',{name:'显示侧栏',exact:true}).waitFor({state:'visible'});await inspect('capture',{name:'ui-blank-collapsed'});
    await shell.getByRole('button',{name:'显示侧栏',exact:true}).click();await waitState(s=>s.sidebarVisible);
    await shell.getByRole('button',{name:'添加常驻网站',exact:true}).click();assert.equal(await shell.locator('#favorite-title').inputValue(),'');assert.equal(await shell.locator('#favorite-url').inputValue(),'');
    await shell.locator('#favorite-title').fill('手动常驻');await shell.locator('#favorite-url').fill(origin+'/manual-favorite');await shell.getByRole('button',{name:'添加到常驻',exact:true}).click();
    await waitState(s=>s.favorites.length===2);await invoke('close-tab',{id:blank});await shell.getByRole('button',{name:'常驻测试',exact:true}).click();
    await shell.mouse.move(600,300);await inspect('capture',{name:'ui-favorites'});
  });
  await t.test('command bar hides native views and restores them; page-focused shortcut works',async()=>{
    await inspect('focus-page'); const target=(await inspect('views')).find(x=>x.visible).webContentsID;
    await app.evaluate(({webContents},id)=>{const wc=webContents.fromId(id);wc.sendInputEvent({type:'keyDown',keyCode:'L',modifiers:['meta']});wc.sendInputEvent({type:'keyUp',keyCode:'L',modifiers:['meta']});},target);
    await shell.locator('#command-input').waitFor({state:'visible'});
    await assertEventually(async()=>(await inspect('views')).every(x=>!x.visible));
    await shell.keyboard.press('Escape');
    await assertEventually(async()=>(await inspect('views')).some(x=>x.visible));
  });
  await t.test('reader view strips scripts and handlers, and its links open as ordinary tabs',async()=>{
    await invoke('new-tab',{url:origin+'/reader-valid'}); await remote(origin+'/reader-valid');
    await invoke('reader'); await waitState(s=>s.reader===true);
    const reader=await readerPage();
    assert.equal(await reader.evaluate(()=>window.pageScriptRan),undefined,'page scripts must not run in the reader');
    assert.equal(await reader.evaluate(()=>[...document.querySelectorAll('*')].some(el=>[...el.attributes].some(attribute=>/^on/i.test(attribute.name)))),false,'inline handlers must be removed');
    const before=(await inspect('state')).tabs.length;
    await reader.click('#reader-link');
    await waitState(s=>!s.reader&&s.tabs.length===before+1&&s.tabs.some(tab=>tab.url===origin+'/reader-follow'));
    assert.match(shell.url(),/shell\.html$/);assert.equal((await inspect('windows')).length,1);
  });
  await t.test('Spaces, bookmark persistence and split cleanup',async()=>{
    await invoke('add-space',{name:'工作',color:'lavender'}); await waitState(s=>s.spaces.some(x=>x.name==='工作')&&s.activeSpaceID===s.spaces.find(x=>x.name==='工作').id);
    await invoke('navigate',{input:origin+'/second'}); await invoke('add-bookmark',{title:'持久化书签',url:origin+'/second'});
    await invoke('new-tab',{url:origin+'/login-work'}); await remote(origin+'/login-work');
    await assertEventually(async()=>(await inspect('evaluate',{script:'document.title'}))==='Arco Fixture');
    await invoke('toggle-split'); assert.equal((await inspect('views')).filter(x=>x.visible).length,2);
    await inspect('capture',{name:'split'});
    const active=(await inspect('state')).activeID; await invoke('select-tab',{id:active});
    assert.equal((await inspect('views')).filter(x=>x.visible).length,1);
    const personal=(await inspect('state')).spaces.find(s=>s.name==='个人'),work=(await inspect('state')).spaces.find(s=>s.name==='工作');
    await invoke('switch-space',{id:personal.id});
    const remembered=(await inspect('state')).activeID;
    await invoke('tab-action',{id:remembered,action:'move',spaceID:work.id});
    await invoke('switch-space',{id:personal.id});
    const moved=await inspect('state');
    assert.equal(moved.activeSpaceID,personal.id);
    assert.notEqual(moved.activeID,remembered);
    assert.equal(moved.tabs.find(t=>t.id===moved.activeID).spaceID,personal.id);
    assert.equal(moved.tabs.find(t=>t.id===remembered).spaceID,work.id);
    await invoke('switch-space',{id:work.id});
    await invoke('select-tab',{id:(await inspect('state')).tabs.find(t=>t.url===origin+'/login-work').id});
    const page=await remote(origin+'/login-work'); await page.locator('#peek-link').click({modifiers:['Shift']});
    await waitState(s=>!!s.peek); await invoke('close-peek'); await waitState(s=>!s.peek);
  });
  await t.test('split focus directs page commands and closing the focused secondary restores the primary',async()=>{
    await invoke('new-tab',{url:origin+'/split-left'}); const leftID=(await inspect('state')).activeID; const left=await remote(origin+'/split-left');
    await invoke('new-tab',{url:origin+'/split-right'}); const rightID=(await inspect('state')).activeID; const right=await remote(origin+'/split-right');
    await invoke('toggle-split',{id:leftID}); assert.equal((await inspect('state')).splitID,leftID);
    await inspect('click',{url:right.url(),x:20,y:20}); await waitState(s=>s.focusedPaneID===rightID);
    const before=requestCounts.get('/split-right'); await invoke('reload'); await assertEventually(()=>requestCounts.get('/split-right')>before);
    await invoke('find',{query:'right unique findtarget'}); await waitState(s=>s.find?.targetID===rightID&&s.find.matches===2&&s.find.active===1);
    await press(right,'G',['meta']); await waitState(s=>s.find?.active===2);
    await press(right,'G',['meta','shift']); await waitState(s=>s.find?.active===1);
    await invoke('find',{query:''}); await waitState(s=>!s.find);
    await inspect('click',{url:left.url(),x:20,y:20}); await waitState(s=>s.focusedPaneID===leftID&&s.splitID===leftID);
    await invoke('close-tab',{id:rightID}); await waitState(s=>!s.splitID&&s.focusedPaneID===leftID&&s.activeID===leftID);
    assert.equal((await inspect('views')).filter(x=>x.visible).length,1);
  });
  await t.test('reload and close follow the focused pane and the Peek layer through the real controls',async()=>{
    // Peek 打开时刷新只重载 Peek，被遮住的底层页面保留表单内容。
    await invoke('new-tab',{url:origin+'/peek-base'}); const base=await remote(origin+'/peek-base');
    await base.locator('#draft').fill('keep me');
    await invoke('peek',{url:origin+'/peek-target'}); await remote(origin+'/peek-target');
    // 等壳层自己收到加载完成：加载中的按钮是“停止”，完成后才是“重新加载”。
    await shell.waitForFunction(()=>document.querySelector('[data-action="reload"]').title==='重新加载');
    const peekBefore=requestCounts.get('/peek-target'), baseBefore=requestCounts.get('/peek-base');
    await shell.locator('[data-action="reload"]').first().click();
    await assertEventually(()=>requestCounts.get('/peek-target')>peekBefore);
    assert.equal(requestCounts.get('/peek-base'),baseBefore,'a Peek reload must not reload the hidden page');
    await waitState(s=>!!s.peek);
    assert.equal(await base.locator('#draft').inputValue(),'keep me');
    await invoke('close-peek'); await waitState(s=>!s.peek);
    // 分屏：左侧正在加载、焦点在右侧时，真实刷新按钮仍刷新右侧，而不是向右侧发送 stop。
    await invoke('new-tab',{url:origin+'/split-left'}); const leftID=(await inspect('state')).activeID; await remote(origin+'/split-left');
    await invoke('new-tab',{url:origin+'/split-right'}); const rightID=(await inspect('state')).activeID; await remote(origin+'/split-right');
    await invoke('toggle-split',{id:leftID}); await waitState(s=>s.splitID===leftID);
    await inspect('click',{url:origin+'/split-right',x:20,y:20}); await waitState(s=>s.focusedPaneID===rightID);
    const rightBefore=requestCounts.get('/split-right');
    const navigation=invoke('navigate',{input:origin+'/slow-page',tabID:leftID}).catch(()=>null);
    await waitState(s=>s.tabs.find(tab=>tab.id===leftID)?.loading===true);
    // 左侧加载中、焦点在右侧：真实按钮必须显示“重新加载”（跟聚焦窗格，而不是左侧）。
    await shell.waitForFunction(()=>document.querySelector('[data-action="reload"]').title==='重新加载');
    await shell.locator('[data-action="reload"]').first().click();
    await assertEventually(()=>requestCounts.get('/split-right')>rightBefore);
    await navigation;
    await assertEventually(async()=>(await inspect('evaluate',{id:leftID,script:'document.title'}))==='Slow Page','the loading pane must not be stopped');
    // 统一关闭：焦点在右侧时 ⌘W 关闭右侧窗格，而不是活动的主窗格。
    await inspect('click',{url:origin+'/split-right',x:20,y:20}); await waitState(s=>s.focusedPaneID===rightID);
    await press(await remote(origin+'/split-right'),'W',['meta']);
    await waitState(s=>!s.splitID&&s.activeID===leftID&&!s.tabs.some(tab=>tab.id===rightID));
  });
  await t.test('Reader stays bound to its source tab across unrelated background navigation and close',async()=>{
    await invoke('new-tab',{url:origin+'/reader-valid'}); await remote(origin+'/reader-valid');
    const sourceTab=(await inspect('state')).tabs.find(tab=>tab.url===origin+'/reader-valid');
    await invoke('new-tab',{url:origin+'/reader-follow'}); await remote(origin+'/reader-follow');
    const backgroundTab=(await inspect('state')).tabs.find(tab=>tab.url===origin+'/reader-follow');
    await invoke('select-tab',{id:sourceTab.id}); await waitState(s=>s.activeID===sourceTab.id);
    await invoke('reader'); await waitState(s=>s.reader===true);
    // 无关后台标签页的导航与关闭不能打断文章，文章仍可查找/打印。
    await invoke('navigate',{input:origin+'/reader-follow?background',tabID:backgroundTab.id});
    await waitState(s=>s.reader===true);
    assert.deepEqual(await inspect('print-target'),{targetKind:'reader',targetID:'reader'});
    await invoke('find',{query:'Paragraph 3'}); await waitState(s=>s.find?.targetKind==='reader'&&s.find.matches===1);
    await invoke('find',{query:''}); await waitState(s=>!s.find);
    await invoke('close-tab',{id:backgroundTab.id});
    await waitState(s=>s.reader===true&&!s.tabs.some(tab=>tab.id===backgroundTab.id));
    // 来源标签页导航才退出文章。
    await invoke('navigate',{input:origin+'/reader-valid?moved',tabID:sourceTab.id});
    await waitState(s=>s.reader===false);
    // 来源标签页被关闭也退出文章。
    await invoke('select-tab',{id:sourceTab.id}); await waitState(s=>s.activeID===sourceTab.id);
    await invoke('reader'); await waitState(s=>s.reader===true);
    await invoke('close-tab',{id:sourceTab.id}); await waitState(s=>s.reader===false);
  });
  await t.test('Peek navigation and form state survive promotion without another request',async()=>{
    await invoke('peek',{url:origin+'/peek-state'}); const first=await remote(origin+'/peek-state');
    await first.click('#next'); const second=await remote(origin+'/peek-next');
    await second.locator('#peek-field').fill('kept through promotion');
    const before=requestCounts.get('/peek-next'),loadedAt=await second.evaluate(()=>window.loadedAt);
    await invoke('peek-to-tab'); await waitState(s=>!s.peek&&s.tabs.some(tab=>tab.url===origin+'/peek-next'&&tab.id===s.activeID));
    assert.equal(await second.evaluate(()=>window.loadedAt),loadedAt);
    assert.equal(await second.locator('#peek-field').inputValue(),'kept through promotion');
    assert.equal(requestCounts.get('/peek-next'),before,'promotion must transfer the live WebContents without reloading');
  });
  await t.test('Reader extraction failure stays off and the article itself is the find and print target',async()=>{
    await invoke('new-tab',{url:origin+'/reader-invalid'}); await remote(origin+'/reader-invalid');
    await assert.rejects(()=>invoke('reader'),/无法生成阅读视图/); await waitState(s=>s.reader===false);
    await invoke('navigate',{input:origin+'/reader-valid'}); await remote(origin+'/reader-valid');
    const article=await invoke('reader'); assert.equal(article.title,'Reader Fixture'); await waitState(s=>s.reader===true);
    // 查找和打印必须作用于文章，而不是被隐藏的底层网页。
    assert.deepEqual(await inspect('print-target'),{targetKind:'reader',targetID:'reader'});
    await invoke('find',{query:'Paragraph 3'}); await waitState(s=>s.find?.targetKind==='reader'&&s.find.matches===1);
    await invoke('find',{query:''}); await waitState(s=>!s.find);
    assert.equal((await inspect('views')).every(view=>view.visible===false||!view.url.startsWith(origin)),true,'the underlying page stays hidden while the reader is open');
    await invoke('reader'); await waitState(s=>s.reader===false);
    assert.equal((await inspect('views')).filter(view=>view.visible).length,1);
  });
  await t.test('find targets Peek, reports matches and clears safely',async()=>{
    await invoke('new-tab',{url:origin+'/second'}); await remote(origin+'/second');
    await invoke('find',{query:'Second'}); await waitState(s=>s.find?.targetKind==='tab'&&s.find.matches>0);
    await invoke('peek',{url:origin+'/second'}); await remote(origin+'/second');
    await invoke('find',{query:'Second'}); await waitState(s=>s.find?.targetKind==='peek'&&s.find.matches>0);
    await invoke('find',{query:''}); await waitState(s=>!s.find);
    await invoke('close-peek'); await waitState(s=>!s.peek&&!s.find);
  });
  await t.test('exact shortcut and link modifiers avoid double execution and preserve native clicks',async()=>{
    await invoke('new-tab',{url:origin+'/shortcut'}); const page=await remote(origin+'/shortcut');
    let tabCount=(await inspect('state')).tabs.length;
    await press(page,'T',['meta']); await waitState(s=>s.tabs.length===tabCount+1);
    await invoke('close-tab',{id:(await inspect('state')).activeID});
    await waitState(s=>s.tabs.length===tabCount&&s.tabs.some(tab=>tab.url===origin+'/shortcut'));
    await page.click('#peek-link',{modifiers:['Shift']}); await waitState(s=>!!s.peek);
    const peekPage=await remote(origin+'/shortcut-target'); await press(peekPage,'W',['meta']);
    await waitState(s=>!s.peek&&s.tabs.some(tab=>tab.url===origin+'/shortcut'));
    await page.click('#peek-link',{modifiers:['Shift','Meta']});
    await waitState(s=>!s.peek&&s.tabs.filter(tab=>tab.url===origin+'/shortcut-target').length===1);
    tabCount=(await inspect('state')).tabs.length;
    await page.click('#peek-link',{button:'middle'});
    await waitState(s=>s.tabs.length===tabCount+1&&!s.peek);
  });
  await t.test('a native passkey request stays pending and is cancellable from the shell',async()=>{
    const url=origin.replace('127.0.0.1','localhost')+'/second';
    await invoke('new-tab',{url}); const page=await remote(url), pageOrigin=new URL(url).origin;
    assert.equal(await page.evaluate(()=>typeof PublicKeyCredential),'function','PublicKeyCredential must stay available');
    // 真正的标准 get（rpId/allowCredentials/internal hints）：等待状态送到壳层，界面取消结束原 Promise。
    await page.evaluate(()=>{window.arcoGet={run:options=>{window.arcoGet.outcome=navigator.credentials.get(options).then(()=>({state:'resolved'}),error=>({state:error.name,message:error.message}));}};window.arcoGet.run({publicKey:{challenge:new Uint8Array(16),rpId:'localhost',allowCredentials:[{type:'public-key',id:new Uint8Array(16),transports:['internal']}],timeout:60000}});});
    await waitState(s=>s.passkeys.length===1&&s.passkeys[0].origin===pageOrigin);
    const banner=await shell.locator('#passkey-wait').textContent();
    assert.match(banner,/正在等待通行密钥/); assert.match(banner,/localhost/);
    await shell.click('[data-passkey-cancel]');
    const cancelled=await page.evaluate(()=>window.arcoGet.outcome);
    assert.equal(cancelled.state,'AbortError','the shell cancel must end the original promise');
    await waitState(s=>s.passkeys.length===0);
    assert.equal(await shell.locator('#passkey-wait').isHidden(),true);
    // get 额外带 authenticatorSelection 也不能被 Arco 当成平台限定快速拒绝；调用方 signal 仍可用且不改写。
    const caller=await page.evaluate(async()=>{
      const controller=new AbortController();
      const options=Object.create({publicKey:{challenge:new Uint8Array(16),rpId:'localhost',allowCredentials:[{type:'public-key',id:new Uint8Array(16)}],authenticatorSelection:{authenticatorAttachment:'platform'}}});
      options.signal=controller.signal;
      const outcome=navigator.credentials.get(options).then(()=>({state:'resolved'}),error=>({state:error.name,message:error.message}));
      const started=performance.now();
      while(performance.now()-started<1500){const current=await Promise.race([outcome,new Promise(resolve=>setTimeout(()=>resolve(null),100))]);if(current)return {...current,inherited:!!options.publicKey,waited:true};}
      controller.abort();
      const aborted=await outcome;
      return {...aborted,inherited:!!options.publicKey,waited:false};
    });
    assert.equal(caller.inherited,true,'inherited dictionary properties must reach the native call');
    assert.notEqual(caller.state,'resolved');
    assert.equal(/此版本的 Arco/.test(caller.message||''),false,'get must not be rejected by the create-only platform rule');
    await waitState(s=>s.passkeys.length===0);
    // 导航后旧文档的等待状态必须清除；取消只作用于该文档。
    await page.evaluate(()=>window.arcoGet.run({publicKey:{challenge:new Uint8Array(16),rpId:'localhost',allowCredentials:[{type:'public-key',id:new Uint8Array(16)}],timeout:60000}}));
    await waitState(s=>s.passkeys.length===1);
    await invoke('navigate',{input:url}); await remote(url);
    await waitState(s=>s.passkeys.length===0);
    assert.equal(await shell.locator('#passkey-wait').isHidden(),true);
    // 非 publicKey 的 get 不拦截，也不产生等待状态。
    const plain=await page.evaluate(()=>navigator.credentials.get({}).then(()=>({state:'resolved'}),error=>({state:error.name})));
    assert.notEqual(plain.state,'resolved');
    await waitState(s=>s.passkeys.length===0);
  });
  await t.test('sized popups keep their owner for downloads and scoped permission requests',async()=>{
    await invoke('new-tab',{url:origin+'/popup-owner'}); const owner=await remote(origin+'/popup-owner');
    await owner.click('#open-download'); const downloadPopup=await remote(origin+'/popup-download');
    let owners=await inspect('popup-owners'); assert.equal(owners.length,1); assert.equal(owners[0].private,false);
    await downloadPopup.click('#download'); await waitState(s=>s.downloads.some(item=>item.filename==='arco-popup.txt'&&item.state==='completed'));
    await downloadPopup.close(); await assertEventually(async()=>(await inspect('popup-owners')).length===0);
    await owner.click('#open-permission'); const permissionPopup=await remote(origin+'/popup-permission');
    owners=await inspect('popup-owners'); assert.equal(owners.length,1); assert.equal(owners[0].partition,'persist:arco');
    await permissionPopup.click('#ask'); await assertEventually(async()=>(await permissionPopup.locator('#result').textContent())==='granted');
    await permissionPopup.close(); await assertEventually(async()=>(await inspect('popup-owners')).length===0);
  });
  await t.test('HTTP Basic login submits once, cancels, closes and keeps popup and private owners independent',async()=>{
    await invoke('new-tab',{url:origin+'/basic-tab'});
    await shell.locator('#http-auth-form').waitFor({state:'visible'});
    await shell.locator('#http-auth-form [name="username"]').fill('tab-user');
    await shell.locator('#http-auth-form [name="password"]').fill('tab-secret');
    await shell.getByRole('button',{name:'登录',exact:true}).click();
    const authenticated=await remote(origin+'/basic-tab'); await authenticated.waitForFunction(()=>document.title==='Authenticated tab-user');
    await waitState(s=>!s.httpAuth);
    await invoke('new-tab',{url:origin+'/basic-cancel'});
    await shell.locator('#http-auth-form').waitFor({state:'visible'});
    await shell.getByRole('button',{name:'取消',exact:true}).click(); await waitState(s=>!s.httpAuth);
    await invoke('new-tab',{url:origin+'/basic-close'});
    await shell.locator('#http-auth-form').waitFor({state:'visible'});
    const closingID=(await inspect('state')).activeID; await invoke('close-tab',{id:closingID});
    await waitState(s=>!s.httpAuth); assert.equal((await inspect('auth-queue')).length,0);
    await invoke('new-tab',{url:origin+'/popup-owner'}); const owner=await remote(origin+'/popup-owner');
    // 401 响应提交前弹窗还没有完成导航，Playwright 只在提交后才列出该页面目标。
    await owner.click('#open-auth');
    await shell.locator('#http-auth-form').waitFor({state:'visible'});
    await shell.locator('#http-auth-form [name="username"]').fill('popup-user');
    await shell.locator('#http-auth-form [name="password"]').fill('popup-secret');
    await shell.getByRole('button',{name:'登录',exact:true}).click();
    const popupAuthenticated=await remote(origin+'/basic-popup'); await popupAuthenticated.waitForFunction(()=>document.title==='Authenticated popup-user');
    await popupAuthenticated.close();
    await invoke('private-window'); let privateShell;
    await assertEventually(async()=>{privateShell=(await app.windows()).find(page=>page!==shell&&/shell\.html$/.test(page.url()));return !!privateShell;});
    // 401 导航要等用户提交认证才完成：先启动导航，交互后再 await，避免测试自己卡住。
    const privateNavigation=invoke('navigate',{input:origin+'/basic-private'},privateShell).catch(()=>null);
    await privateShell.locator('#http-auth-form').waitFor({state:'visible'});
    await privateShell.locator('#http-auth-form [name="username"]').fill('private-user');
    await privateShell.locator('#http-auth-form [name="password"]').fill('private-secret');
    await privateShell.getByRole('button',{name:'登录',exact:true}).click();
    const privatePage=await remote(origin+'/basic-private'); await privatePage.waitForFunction(()=>document.title==='Authenticated private-user');
    await privateNavigation;
    const closed=privateShell.waitForEvent('close'); await Promise.all([closed,inspect('close-window',{},privateShell).catch(()=>closed)]);
    // Chromium 会按来源重放已知凭据（浏览器正常行为，不禁用）。真实服务端只应在三处接受登录：
    // 每个导航恰好质询一次（401），取消/关闭后再也没有成功认证，说明回调各完成一次。
    for(const path of ['/basic-tab','/basic-cancel','/basic-close','/basic-popup','/basic-private'])assert.equal(authChallenges.filter(x=>x.path===path).length,1,path+' must be challenged exactly once');
    assert.deepEqual(authSuccesses.map(x=>[x.path,x.username]),[['/basic-tab','tab-user'],['/basic-popup','popup-user'],['/basic-private','private-user']]);
    // 关掉本子测试创建的认证页，避免重启后恢复出新的认证提示影响后续用例。
    for(const tab of (await inspect('state')).tabs.filter(tab=>tab.url&&tab.url.includes('/basic-')))await invoke('close-tab',{id:tab.id});
    await waitState(s=>s.tabs.every(tab=>!tab.url.includes('/basic-')));
  });
  await t.test('submitted login save, whitespace secret and wrong-origin refusal',async()=>{
    // 前面子测试可能留下了别的活动标签页；填充必须针对可见标签页。
    await invoke('select-tab',{id:(await inspect('state')).tabs.find(tab=>tab.url===origin+'/login-work').id});
    const page=await remote(origin+'/login-work');await page.locator('input[type=password]').fill('  test-only-password  ');await page.locator('button[type=submit]').click();
    await shell.locator('[data-action="capture-save"]').waitFor({state:'visible'}); await shell.locator('[data-action="capture-save"]').click();
    await waitState(s=>!s.capture); const credentials=await invoke('credentials');assert.equal(credentials.length,1);
    const wrong=await inspect('fixture-secret',{origin:'http://127.0.0.1:1/',username:'wrong',password:'wrong-secret'});
    await assert.rejects(()=>invoke('credential-fill',{id:wrong}),/来源不匹配/);
    await invoke('navigate',{input:origin+'/login-fill'}); const form=await remote(origin+'/login-fill');
    assert.equal((await invoke('credential-fill',{id:credentials[0].id})).count,1);
    assert.equal(await form.locator('input[type=password]').inputValue(),'  test-only-password  ');
    await form.locator('input[type=password]').fill('');
    const formID=(await inspect('state')).activeID;
    await invoke('new-tab',{url:origin+'/other-tab'}); await remote(origin+'/other-tab');
    await invoke('select-tab',{id:formID}); await inspect('arm-auth-gate');
    const pending=invoke('credential-fill',{id:credentials[0].id});
    try {
      await assertEventually(async()=>inspect('auth-waiting'));
      await invoke('select-tab',{id:(await inspect('state')).tabs.find(t=>t.url===origin+'/other-tab').id});
      await inspect('release-auth');
      await assert.rejects(pending,/拒绝填充/);
      assert.equal(await form.locator('input[type=password]').inputValue(),'');
    } finally { await inspect('release-auth').catch(()=>{}); }
  });
  await t.test('password synchronization is connected through the actual settings UI',async()=>{
    const folder=path.join(profile,'cloud');fs.mkdirSync(folder);
    await invoke('connect-sync',{path:folder});
    await shell.locator('[data-action="settings"]').click();await shell.locator('[data-settings-section="sync"]').click();
    await shell.locator('#password-sync-form [name="passphrase"]').fill('e2e-sync-passphrase-123');
    await shell.locator('[data-action="password-sync-submit"]').click();
    await assertEventually(async()=>fs.existsSync(path.join(folder,'Arco-Password-Devices'))&&fs.readdirSync(path.join(folder,'Arco-Password-Devices')).length>0);
    assert(!fs.readFileSync(path.join(folder,'Arco-Passwords.json'),'utf8').includes('test-only-password'));
    await shell.locator('[data-action="password-sync-lock"]').click();await waitState(s=>!s.passwordSyncUnlocked);
    await shell.keyboard.press('Escape');
  });
  await t.test('private windows are isolated from normal and from later private windows',async()=>{
    async function openPrivate(){await invoke('private-window');let p;await assertEventually(async()=>{p=(await app.windows()).find(p=>p!==shell&&/shell\.html$/.test(p.url()));return !!p;});await p.waitForFunction(()=>!!window.arco);return p;}
    async function closePrivate(p){const closed=p.waitForEvent('close');await Promise.all([closed,inspect('close-window',{},p).catch(()=>closed)]);}
    let privateShell=await openPrivate();await invoke('navigate',{input:origin+'/'},privateShell);
    assert.equal(await inspect('evaluate',{script:'document.cookie'},privateShell),'');
    await inspect('evaluate',{script:"document.cookie='private=only'"},privateShell);
    await assert.rejects(()=>invoke('credential-save',{origin,username:'no',password:'private-secret'},privateShell),/无痕/);
    await closePrivate(privateShell); privateShell=await openPrivate(); await invoke('navigate',{input:origin+'/'},privateShell);
    assert.equal(await inspect('evaluate',{script:'document.cookie'},privateShell),''); await closePrivate(privateShell);
  });
  await t.test('deleting the inherited ordinary space keeps the private page usable',async()=>{
    async function openPrivate(){await invoke('private-window');let p;await assertEventually(async()=>{p=(await app.windows()).find(p=>p!==shell&&/shell\.html$/.test(p.url()));return !!p;});await p.waitForFunction(()=>!!window.arco);return p;}
    async function closePrivate(p){const closed=p.waitForEvent('close');await Promise.all([closed,inspect('close-window',{},p).catch(()=>closed)]);}
    const privateShell=await openPrivate(),pageURL=origin+'/private-keep';
    await invoke('navigate',{input:pageURL},privateShell); await remote(pageURL);
    await inspect('evaluate',{script:"document.cookie='private=kept; SameSite=Lax'"},privateShell);
    const inherited=(await inspect('state',{},privateShell)).activeSpaceID;
    assert.ok((await inspect('state')).spaces.some(s=>s.id!==inherited));
    await invoke('remove-space',{id:inherited});
    assert.equal(await inspect('evaluate',{script:'location.href'},privateShell),pageURL);
    assert.equal(await inspect('evaluate',{script:'document.cookie'},privateShell),'private=kept');
    await invoke('new-tab',{url:origin+'/second'},privateShell); await remote(origin+'/second');
    await invoke('select-tab',{id:(await inspect('state',{},privateShell)).tabs.find(t=>t.url===pageURL).id},privateShell);
    await invoke('clear-tabs',{},privateShell);
    assert.equal(await inspect('evaluate',{script:'document.cookie'},privateShell),'private=kept');
    assert.equal((await inspect('state',{},privateShell)).tabs.some(t=>t.url===origin+'/second'),false);
    await closePrivate(privateShell);
  });
  await t.test('blank and web tabs survive actual quit and relaunch',async()=>{
    await invoke('new-tab'); await inspect('capture',{name:'new-tab'});await invoke('new-tab',{url:origin+'/second'});
    await invoke('new-tab',{url:origin+'/reopen-check'});
    await invoke('close-tab',{id:(await inspect('state')).tabs.find(t=>t.url===origin+'/reopen-check').id});
    await close(); await launch(); const state=await inspect('state');
    assert.equal(state.spaces.find(x=>x.id===state.activeSpaceID).name,'工作');
    assert(state.tabs.some(x=>x.url==='')); assert(state.tabs.some(x=>x.url===origin+'/second'));
    assert.equal(state.tabs.some(x=>x.url===origin+'/reopen-check'),false);
    await invoke('reopen-tab'); await waitState(s=>s.tabs.some(t=>t.url===origin+'/reopen-check'));
    assert.equal(state.allBookmarks.filter(x=>x.title==='持久化书签').length,1);
    assert(state.favorites.some(item=>item.title==='常驻测试'&&item.favicon===origin+'/ui-icon.svg'));
    await shell.getByRole('button',{name:'常驻测试',exact:true}).waitFor({state:'visible'});
    // 三方登录弹窗：window.open 必须是真的弹窗窗口，window.opener 才能收到 postMessage
    await invoke('new-tab',{url:origin+'/oauth-start'});
    const login=await remote(origin+'/oauth-start');
    const popupEvent=app.waitForEvent('window',{timeout:8000}).catch(()=>null);
    await login.click('#go');
    const popup=await popupEvent;
    assert(popup,'window.open must open a real popup window');
    assert.match(popup.url(),/\/oauth-provider/);
    await assertEventually(async()=>(await login.evaluate(()=>document.querySelector('#result').textContent))==='got:code=e2e');
    await shell.locator('[data-action="settings"]').click();await shell.locator('#settings-panel').waitFor();await inspect('capture',{name:'settings'});
  });
});
test('first launch walks the welcome onboarding and never shows it again',{timeout:60000},async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'arco-onboard-'));
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'arco-onboard-home-'));
  const chrome=path.join(home,'Library','Application Support','Google','Chrome');
  fs.mkdirSync(path.join(chrome,'Default'),{recursive:true});
  fs.writeFileSync(path.join(chrome,'Local State'),JSON.stringify({profile:{info_cache:{Default:{name:'默认'}},profiles_order:['Default']}}));
  fs.writeFileSync(path.join(chrome,'Default','Bookmarks'),JSON.stringify({roots:{bookmark_bar:{type:'folder',name:'书签栏',children:[{type:'url',name:'Tour Page',url:'https://tour.test/'}]}}}));
  const activeID = 'a'.repeat(32), disabledID = 'b'.repeat(32), brokenID = 'c'.repeat(32), linkedID = 'd'.repeat(32);
  const extensionRoot = path.join(chrome, 'Default', 'Extensions');
  for (const [id, name, version] of [[activeID, 'Migrated Chrome Extension', '1.0.0'], [disabledID, 'Disabled Chrome Extension', '1.0.0'], [brokenID, 'Broken Chrome Extension', 'invalid'], [linkedID, 'Linked Chrome Extension', '1.0.0']]) {
    const dir = path.join(extensionRoot, id, '1.0.0_0');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name, version, content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'] }] }));
    fs.writeFileSync(path.join(dir, 'cs.js'), `document.documentElement.dataset.${id === disabledID ? 'arcoDisabled' : 'arcoChromeMigration'} = chrome.runtime.id;`);
  }
  fs.symlinkSync(path.join(chrome, 'Local State'), path.join(extensionRoot, linkedID, '1.0.0_0', 'link'));
  fs.writeFileSync(path.join(chrome, 'Default', 'Secure Preferences'), JSON.stringify({ extensions: { settings: { [activeID]: { disable_reasons: [] }, [disabledID]: { disable_reasons: [1] } } } }));
  const site = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Migration Fixture</title><h1>Migration</h1>'); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const siteURL = `http://127.0.0.1:${site.address().port}/`;
  const env={...process.env,ARCO_TEST_MODE:'1',ARCO_USER_DATA_DIR:folder,ARCO_BROWSER_HOME:home};
  async function open(){
    const instance=await electron.launch({args:[root],env,timeout:15000});let page=null;
    for(let i=0;i<200&&!page;i++){page=(await instance.windows()).find(p=>/shell\.html$/.test(p.url()));if(!page)await new Promise(r=>setTimeout(r,50));}
    page.setDefaultTimeout(8000);await page.waitForFunction(()=>!!window.arco&&!!document.querySelector('#favorites .favorite-add'));
    return {instance,page,state:()=>page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}))};
  }
  let first,second;
  try{
    first=await open();const {page,state}=first;
    await page.waitForSelector('[data-onboarding="hello"]');
    assert.match(await page.textContent('[data-onboarding] h2'),/给自己一点空间/);
    await page.click('[data-action="onboard-next"]');
    await page.waitForSelector('[data-onboarding="bring"] #onboard-sources [data-import-browser]');
    await page.click('#onboard-sources [data-import-browser]');
    await assertEventually(async()=>(await state()).allBookmarks.some(x=>x.url==='https://tour.test/'));
    await page.click('[data-action="onboard-next"]');
    await page.waitForSelector('[data-onboarding="extensions"] [data-import-chrome]');
    await page.check(`[data-chrome-extension="${disabledID}"]`);
    await page.click('[data-import-chrome]');
    await page.waitForFunction(() => /已安装并启用/.test(document.querySelector('[data-chrome-result]')?.textContent || ''));
    assert.match(await page.textContent('[data-chrome-result]'), /Disabled Chrome Extension：已安装，保持停用/);
    assert.match(await page.textContent('[data-chrome-result]'), /Broken Chrome Extension：/);
    assert.match(await page.textContent('[data-chrome-result]'), /Linked Chrome Extension：扩展包含符号链接/);
    await page.click('[data-action="onboard-back"]');
    await page.click('[data-action="onboard-next"]');
    await page.waitForFunction(() => /Linked Chrome Extension：扩展包含符号链接/.test(document.querySelector('[data-chrome-result]')?.textContent || ''));
    const records = (await state()).settings.extensions;
    assert.equal(records.length, 2);
    const activeRecord = records.find(record => record.storeID === activeID);
    assert.equal(records.find(record => record.storeID === disabledID).enabled, false);
    assert.equal(fs.existsSync(path.join(folder, 'Extensions', brokenID)), false);
    assert.equal(fs.existsSync(path.join(folder, 'Extensions', linkedID)), false);
    // 重试跳过已有记录，伪造资料或目录逃逸 ID 被拒绝。
    const retry = await invoke('import-chrome-extensions', { profileID: 'chrome:Default', ids: [activeID] }, page);
    assert.equal(retry[0].already, true);
    await invoke('remove-extension', { id: activeRecord.id }, page);
    assert.equal(fs.existsSync(activeRecord.path), false);
    const reimport = await invoke('import-chrome-extensions', { profileID: 'chrome:Default', ids: [activeID] }, page);
    assert.equal(reimport[0].enabled, true);
    await assert.rejects(() => invoke('import-chrome-extensions', { profileID: 'chrome:../../etc', ids: [activeID] }, page), /没有找到/);
    await assert.rejects(() => invoke('import-chrome-extensions', { profileID: 'chrome:Default', ids: ['../../etc'] }, page), /有效的 Chrome 扩展/);
    await page.click('[data-action="onboard-next"]');
    await page.waitForSelector('[data-onboarding="sites"] .onboard-site');
    await page.click('[data-onboard-site="https://github.com"]');
    await assertEventually(async()=>(await state()).favorites.some(x=>x.url==='https://github.com/'));
    await page.click('[data-action="onboard-next"]');
    await page.waitForSelector('[data-onboard-toggle="trackerBlocking"]');
    await page.click('[data-onboard-toggle="trackerBlocking"]');
    await assertEventually(async()=>(await state()).settings.trackerBlocking===false);
    await page.click('[data-action="onboard-next"]');
    await page.waitForSelector('#onboard-theme');
    await page.selectOption('#onboard-theme','dark');
    await assertEventually(async()=>(await state()).settings.theme==='dark');
    await page.click('[data-action="onboard-next"]');
    await page.waitForFunction(()=>!document.querySelector('[data-onboarding]'));
    await assertEventually(async()=>(await state()).settings.onboarded===true);
    await invoke('new-tab', { url: siteURL }, page);
    let migratedPage;
    await assertEventually(async () => { migratedPage = (await first.instance.windows()).find(p => p.url() === siteURL); return !!migratedPage; });
    await migratedPage.waitForFunction(() => !!document.documentElement.dataset.arcoChromeMigration);
    assert.equal(await migratedPage.evaluate(() => document.documentElement.dataset.arcoChromeMigration), activeRecord.id);
    assert.equal(await migratedPage.evaluate(() => document.documentElement.dataset.arcoDisabled), undefined);
    await first.instance.close().catch(()=>{});first=null;
    // 删除源浏览器目录，证明 Arco 使用自己的副本，重启后仍实际注入网页。
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    second=await open();
    await new Promise(r=>setTimeout(r,500));
    assert.equal(await second.page.$('[data-onboarding]'),null,'onboarding must not come back on the second launch');
    assert((await second.state()).settings.theme==='dark');
    let restored;
    await assertEventually(async () => { restored = (await second.instance.windows()).find(p => p.url() === siteURL); return !!restored; });
    await restored.waitForFunction(() => !!document.documentElement.dataset.arcoChromeMigration);
    assert.equal(await restored.evaluate(() => document.documentElement.dataset.arcoChromeMigration), activeRecord.id);
    const list = await invoke('extension-list', {}, second.page);
    assert.equal(list.find(item => item.id === activeRecord.id).enabled, true);
    assert.equal(list.filter(item => !item.enabled).length, 1);
  } finally {
    await first?.instance.close().catch(()=>{});await second?.instance.close().catch(()=>{});
    await new Promise(resolve => site.close(resolve));
    fs.rmSync(folder,{recursive:true,force:true});fs.rmSync(home,{recursive:true,force:true});
  }
});
test('a Chrome Web Store package installs through the settings UI',{timeout:60000},async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'arco-store-'));
  const build=fs.mkdtempSync(path.join(os.tmpdir(),'arco-store-build-'));
  fs.mkdirSync(path.join(build,'ext'),{recursive:true});
  fs.writeFileSync(path.join(build,'ext','manifest.json'),JSON.stringify({manifest_version:3,name:'Arco Store Fixture',version:'1.0.0',description:'fixture',icons:{'128':'icon.png'},action:{default_title:'Fixture'},options_page:'options.html',background:{service_worker:'sw.js'},content_scripts:[{matches:['<all_urls>'],js:['cs.js']}]}));
  fs.writeFileSync(path.join(build,'ext','sw.js'),"chrome.action.onClicked.addListener(() => { chrome.windows.create({ url: chrome.runtime.getURL('tool.html'), type: 'popup', width: 420, height: 320 }); });");
  fs.writeFileSync(path.join(build,'ext','tool.html'),'<!doctype html><title>Fixture Tool</title><h1 id="tool">fixture tool</h1><button id="options">Options</button><a id="own-tab" href="next.html" target="_blank">New extension tab</a><script src="tool.js"></script>');
  fs.writeFileSync(path.join(build,'ext','tool.js'), 'document.getElementById("options").onclick = () => chrome.runtime.openOptionsPage();');
  fs.writeFileSync(path.join(build,'ext','options.html'),'<!doctype html><title>Fixture Options</title><h1 id="options-page">Extension options</h1><a id="own-link" href="next.html">Next</a><a id="new-link" href="next.html" target="_blank">New tab</a>');
  fs.writeFileSync(path.join(build,'ext','next.html'),'<!doctype html><title>Fixture Next</title><h1 id="next-page">Next extension page</h1>');
  fs.writeFileSync(path.join(build,'ext','icon.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
  fs.writeFileSync(path.join(build,'ext','cs.js'),'document.documentElement.dataset.arcoStore = chrome.runtime.id;');
  const { execFileSync } = require('node:child_process');
  execFileSync('/usr/bin/zip',['-q','-r',path.join(build,'pack.zip'),'.'],{cwd:path.join(build,'ext')});
  // 商店 fixture 也必须是真签名包：Arco 只接受签名、期望 ID 与 zip 字节绑定一致的 crx。
  const fixtureKeys=require('./crx-fixture').generateKeyPair();
  const storeID=fixtureKeys.id;
  const payload=require('./crx-fixture').signedCRX3(fs.readFileSync(path.join(build,'pack.zip')),fixtureKeys);
  const store=http.createServer((request,response)=>{
    if(request.url.startsWith('/page')){ response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return response.end('<title>Fixture</title><h1>Fixture</h1>'); }
    response.writeHead(200,{'Content-Type':'application/x-chrome-extension'}); response.end(payload);
  });
  await new Promise(resolve=>store.listen(0,'127.0.0.1',resolve));
  const pageOrigin=`http://127.0.0.1:${store.address().port}`;
  const launchEnv={...process.env,ARCO_TEST_MODE:'1',ARCO_USER_DATA_DIR:folder,ARCO_CRX_ORIGIN:`http://127.0.0.1:${store.address().port}`};
  let instance=null;
  try{
    instance=await electron.launch({args:[root],env:launchEnv,timeout:15000});
    let page=null;
    for(let i=0;i<200&&!page;i++){page=(await instance.windows()).find(p=>/shell\.html$/.test(p.url()));if(!page)await new Promise(r=>setTimeout(r,50));}
    page.setDefaultTimeout(8000);await page.waitForFunction(()=>!!window.arco&&!!document.querySelector('#favorites .favorite-add'));
    if(await page.$('[data-onboarding]')){await page.click('[data-action="onboard-skip"]');await page.waitForFunction(()=>!document.querySelector('[data-onboarding]'));}
    await page.click('[data-action="settings"]');await page.click('[data-settings-section="extensions"]');
    await page.fill('#store-input',`https://chromewebstore.google.com/detail/fixture/${storeID}?hl=zh-CN`);
    await page.click('[data-action="install-store-input"]');
    await page.waitForFunction(()=>/Arco Store Fixture/.test(document.querySelector('#extension-list')?.textContent||''));
    const state=await page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}));
    assert.equal(state.settings.extensions.length,1);
    assert.equal(state.settings.extensions[0].storeID,storeID);
    assert.equal(state.settings.extensions[0].id,storeID,'the loaded extension id must equal the requested store id');
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'Extensions',storeID,'manifest.json'),'utf8')).key,fixtureKeys.publicKey.toString('base64'),'the authenticated developer key must be written when the package omits manifest.key');
    assert(fs.existsSync(path.join(folder,'Extensions',storeID,'cs.js')));
    await page.fill('#store-input',`https://example.com/detail/x/${storeID}`);
    await page.click('[data-action="install-store-input"]');
    await page.waitForFunction(()=>/只支持 Chrome 应用商店/.test(document.querySelector('#toast')?.textContent||''));
    // 工具栏的扩展入口（空白标签页不显示工具栏，先打开一个网页）：图标栏 + 启用/停用
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelector('#overlay-root')?.hidden);
    await page.evaluate(o=>window.arco.invoke('arco:invoke',{channel:'new-tab',payload:{url:o}}),pageOrigin+'/page');
    await page.waitForSelector('.address-row [data-extensions-entry]:not([hidden])');
    await page.click('.address-row [data-extensions-entry]');
    await page.waitForFunction(()=>/Arco Store Fixture/.test(document.querySelector('#extensions-body')?.textContent||''));
    // 图标栏由兼容库的 <browser-action-list> 渲染，不再是手写磁贴
    await page.waitForSelector('browser-action-list');
    await page.click('[data-extension-toggle]');
    await page.waitForFunction(()=>/已停用/.test(document.querySelector('#extensions-body')?.textContent||''));
    assert.equal((await page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}))).settings.extensions[0].enabled,false);
    await page.click('[data-extension-toggle]');
    await page.waitForFunction(()=>/已启用/.test(document.querySelector('#extensions-body')?.textContent||''));
    const reenabled=await page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}));
    assert.equal(reenabled.settings.extensions[0].enabled,true);
    assert.equal(reenabled.settings.extensions[0].id,storeID,'re-enabling must keep the requested id');
    // 核心链路：点扩展自己的图标 → 它的 chrome.action.onClicked → 它自己的 chrome.windows.create
    await page.waitForFunction(()=>{const list=document.querySelector('browser-action-list');return !!(list&&list.shadowRoot&&list.shadowRoot.querySelector('button'));});
    await page.waitForFunction(()=>{const button=document.querySelector('browser-action-list')?.shadowRoot?.querySelector('button');return button?.style.backgroundImage.includes('crx:');});
    assert.notEqual(await page.evaluate(()=>getComputedStyle(document.querySelector('browser-action-list').shadowRoot.querySelector('button')).backgroundImage),'none','The actual painted icon must survive the outer ::part styles');
    await page.locator('browser-action-list').locator('button').hover();
    assert.notEqual(await page.evaluate(()=>getComputedStyle(document.querySelector('browser-action-list').shadowRoot.querySelector('button')).backgroundImage),'none','Hover must preserve the painted icon');
    await page.evaluate(()=>{const list=document.querySelector('browser-action-list');list.shadowRoot.querySelector('button').click();});
    let tool=null;
    await assertEventually(async()=>{tool=(await instance.windows()).find(w=>/\/tool\.html$/.test(w.url()));return !!tool;});
    await tool.waitForSelector('#tool');
    assert.equal(await tool.textContent('#tool'),'fixture tool');
    await tool.click('#options');
    let optionsPage;
    await assertEventually(async()=>{optionsPage=(await instance.windows()).find(w=>/\/options\.html$/.test(w.url()));return !!optionsPage;});
    await optionsPage.waitForSelector('#options-page');
    await page.waitForFunction(()=>document.querySelector('#overlay-root').hidden);
    await optionsPage.click('#new-link');
    let nextPage;
    await assertEventually(async()=>{nextPage=(await instance.windows()).find(w=>/\/next\.html$/.test(w.url()));return !!nextPage;});
    await nextPage.waitForSelector('#next-page');
    await optionsPage.click('#own-link');
    await optionsPage.waitForSelector('#next-page');
    const created = await tool.evaluate(()=>chrome.tabs.create({url:chrome.runtime.getURL('options.html')}));
    await assertEventually(()=>instance.evaluate(({webContents},id)=>webContents.fromId(id)?.getURL().endsWith('/options.html'),created.id));
    const beforeBlocked = (await page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}))).tabs.length;
    assert.equal(await tool.evaluate(()=>chrome.tabs.create({url:'file:///etc/passwd'})), undefined);
    assert.equal(await tool.evaluate(()=>chrome.tabs.create({url:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/private.html'})), undefined);
    assert.equal((await page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}))).tabs.length, beforeBlocked);
    // 同样验证兼容库创建的 action.default_popup；它不是 windows.create 的工具窗口。
    await tool.evaluate(()=>chrome.action.setPopup({popup:'tool.html'}));
    await tool.evaluate(()=>window.close());
    await page.click('.address-row [data-extensions-entry]');
    await page.waitForFunction(()=>!!document.querySelector('browser-action-list')?.shadowRoot?.querySelector('button'));
    await page.evaluate(()=>document.querySelector('browser-action-list').shadowRoot.querySelector('button').click());
    let popup;
    await assertEventually(async()=>{popup=(await instance.windows()).find(w=>/\/tool\.html$/.test(w.url()));return !!popup;});
    await popup.waitForSelector('#own-tab');
    await popup.click('#own-tab');
    await assertEventually(async()=>{const current=await page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}));return current.tabs.filter(tab=>/\/next\.html$/.test(tab.url)).length===3;});
    await page.waitForFunction(()=>document.querySelector('#overlay-root').hidden);
    const ordinaryPage = (await instance.windows()).find(w=>w.url()===pageOrigin+'/page');
    assert.equal(await ordinaryPage.evaluate(()=>document.documentElement.dataset.arcoStore),storeID,'chrome.runtime.id must equal the requested store id');
    assert.equal(await ordinaryPage.evaluate(url=>!!window.open(url), tool.url()), false, 'Ordinary websites must not open private extension pages');
    // 重启后仍是同一身份：manifest.key 已固定，实际 chrome.runtime.id 等于请求 ID。
    await instance.close().catch(()=>{}); instance=null;
    instance=await electron.launch({args:[root],env:launchEnv,timeout:15000});
    page=null;
    for(let i=0;i<200&&!page;i++){page=(await instance.windows()).find(p=>/shell\.html$/.test(p.url()));if(!page)await new Promise(r=>setTimeout(r,50));}
    page.setDefaultTimeout(8000);await page.waitForFunction(()=>!!window.arco&&!!document.querySelector('#space-name')?.textContent);
    const restarted=await page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}));
    assert.equal(restarted.settings.extensions.length,1);
    assert.equal(restarted.settings.extensions[0].id,storeID,'restart must keep the requested id');
    const restartedList=await page.evaluate(()=>window.arco.invoke('arco:invoke',{channel:'extension-list'}));
    assert.equal(restartedList.find(item=>item.id===storeID)?.enabled,true);
    await page.evaluate(o=>window.arco.invoke('arco:invoke',{channel:'new-tab',payload:{url:o}}),pageOrigin+'/page');
    const restored=(await instance.windows()).find(w=>w.url()===pageOrigin+'/page');
    await restored.waitForFunction(()=>!!document.documentElement.dataset.arcoStore);
    assert.equal(await restored.evaluate(()=>document.documentElement.dataset.arcoStore),storeID,'chrome.runtime.id must stay the requested store id after restart');
  } finally {
    await instance?.close().catch(()=>{});
    await new Promise(resolve=>store.close(resolve));
    fs.rmSync(folder,{recursive:true,force:true});fs.rmSync(build,{recursive:true,force:true});
  }
});
test('failed protected loads do not let shutdown replace Session bytes',{timeout:30000},async()=>{
  async function boot(folder,failFile){
    const child=await electron.launch({args:[root],env:{...process.env,ARCO_TEST_MODE:'1',ARCO_USER_DATA_DIR:folder,ARCO_FAIL_BACKUP:failFile},timeout:15000});
    for(let i=0;i<100&&!fs.existsSync(path.join(folder,'Library.json'));i++) await new Promise(r=>setTimeout(r,50));
    assert.equal(fs.existsSync(path.join(folder,'Library.json')),true);
    const proc=child.process();
    await Promise.race([child.close().catch(()=>{}),new Promise(r=>setTimeout(r,2500))]);
    if(proc.exitCode===null) proc.kill('SIGTERM');
  }
  const sessionDir=fs.mkdtempSync(path.join(os.tmpdir(),'arco-session-'));
  const session=path.join(sessionDir,'Session.json');
  const sessionBytes=JSON.stringify({version:1,tabs:[{id:'tab-1',spaceID:'personal',url:'https://example.com/session-case',title:'Keep',pinned:false}],activeSpaceID:'personal',activeID:'tab-1',closed:[{url:'https://example.com/closed-session',title:'Closed',spaceID:'personal'}]},null,2);
  fs.writeFileSync(session,sessionBytes);fs.writeFileSync(session,'{broken');
  await boot(sessionDir,'Session.json');
  assert.equal(fs.readFileSync(session,'utf8'),'{broken');
  assert.match(fs.readFileSync(path.join(sessionDir,'Library.json'),'utf8'),/deviceID/);
  const historyDir=fs.mkdtempSync(path.join(os.tmpdir(),'arco-history-'));
  const historySession=path.join(historyDir,'Session.json');
  const historyBytes=JSON.stringify({version:1,tabs:[{id:'tab-1',spaceID:'personal',url:'https://example.com/history-case',title:'Keep',pinned:false}],activeSpaceID:'personal',activeID:'tab-1',closed:[]},null,2);
  fs.writeFileSync(historySession,historyBytes);fs.writeFileSync(path.join(historyDir,'History.json'),'{broken');
  await boot(historyDir,'History.json');
  assert.equal(fs.readFileSync(historySession,'utf8'),historyBytes);
  assert.match(fs.readFileSync(path.join(historyDir,'Library.json'),'utf8'),/deviceID/);
  fs.rmSync(sessionDir,{recursive:true,force:true});fs.rmSync(historyDir,{recursive:true,force:true});
});

test('failed protected reopen in the same process keeps Session bytes on shutdown',{timeout:30000},async t=>{
  for(const failure of ['Session.json','History.json']) {
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'arco-reopen-failure-'));let instance;
    try {
      instance=await electron.launch({args:[root],env:{...process.env,ARCO_TEST_MODE:'1',ARCO_USER_DATA_DIR:folder,ARCO_FAIL_BACKUP:failure},timeout:15000});
      const page=await instance.firstWindow();await page.waitForFunction(()=>!!window.arco);
      await instance.evaluate(({BaseWindow})=>{for(const win of BaseWindow.getAllWindows())win.close();});
      const sessionFile=path.join(folder,'Session.json');
      const protectedBytes=failure==='Session.json'?'{broken-reopened-session':JSON.stringify({version:1,tabs:[{id:'new-protected-tab',spaceID:'personal',url:'https://example.test/not-loaded',title:'Preserve',pinned:false}],activeSpaceID:'personal',activeID:'new-protected-tab',closed:[]},null,2);
      fs.writeFileSync(sessionFile,protectedBytes);
      if(failure==='History.json')fs.writeFileSync(path.join(folder,'History.json'),'{broken-reopened-history');
      const error=await instance.evaluate(({app})=>{try{app.emit('activate');return '';}catch(error){return error.message;}});
      assert.match(error,/停止写入/);
      const proc=instance.process();await Promise.race([instance.close().catch(()=>{}),new Promise(r=>setTimeout(r,2500))]);if(proc.exitCode===null)proc.kill('SIGTERM');instance=null;
      assert.equal(fs.readFileSync(sessionFile,'utf8'),protectedBytes,failure+' failure must not allow a later shutdown write');
    } finally {
      if(instance){const proc=instance.process();await Promise.race([instance.close().catch(()=>{}),new Promise(r=>setTimeout(r,2500))]);if(proc.exitCode===null)proc.kill('SIGTERM');}
      fs.rmSync(folder,{recursive:true,force:true});
    }
  }
});
