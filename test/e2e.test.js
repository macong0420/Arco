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
  app = await electron.launch({ args: [root], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile }, timeout: 15000 });
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
async function assertEventually(check) { for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('State did not converge'); }
const fixture = '<!doctype html><title>Arco Fixture</title><link rel="icon" href="/ui-icon.svg"><h1>Real Chromium fixture</h1><form action="/welcome"><input name="username" autocomplete="username" value="alice"><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form><a id="peek-link" href="/second">Second page</a>';
test('real app: Chromium, overlays, spaces, split, passwords, private isolation and restart', {timeout:60000}, async t=>{
  server=http.createServer((req,res)=>{
    if(req.url.startsWith('/ui-icon.svg')){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#4e78ca"/><path d="M32 92V60a32 32 0 0 1 64 0v32M44 76h40" fill="none" stroke="white" stroke-width="12"/></svg>');}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(req.url.startsWith('/welcome'))return res.end('<title>Welcome</title><h1>Signed in</h1>');
    if(req.url.startsWith('/second'))return res.end('<title>Second Fixture</title><h1>Second page</h1>');
    if(req.url.startsWith('/oauth-provider'))return res.end('<title>OAuth Provider</title><script>try{if(typeof require!=="undefined"||window.arco)throw new Error("unsafe context");window.opener.postMessage("code=e2e","*")}catch(e){document.title="no-opener"}setTimeout(()=>window.close(),80)</script>');
    if(req.url.startsWith('/oauth-frame'))return res.end('<button id="frame-go">登录</button><script>document.getElementById("frame-go").onclick=()=>window.open("/oauth-provider","auth");window.addEventListener("message",e=>parent.postMessage(e.data,"*"))</script>');
    if(req.url.startsWith('/oauth-start')){
      const mode=new URL(req.url,'http://localhost').searchParams.get('mode');
      const open=mode==='tab'?'window.open("/oauth-provider","auth")':mode==='blank'?'(() => {const p=window.open("","auth");p.location.href="/oauth-provider"})()':'window.open("/oauth-provider","auth","width=420,height=520")';
      return res.end(`<title>OAuth Start</title><button id="go">第三方登录</button><div id="result">waiting</div>${mode==='iframe'||mode==='cross-origin'?`<iframe src="${mode==='cross-origin'?origin.replace('127.0.0.1','localhost'):origin}/oauth-frame"></iframe>`:''}<script>document.getElementById("go").onclick=()=>${open};window.addEventListener("message",e=>{document.getElementById("result").textContent="got:"+e.data})</script>`);
    }
    res.end(fixture);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await close();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});});
  await launch();
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
  await t.test('reader links remove privileged attributes and remain keyboard operable',async()=>{
    await shell.evaluate(url=>{showModal('reader-link-check');document.querySelector('#overlay-root').innerHTML='<section class="panel"><article class="reader-content">'+readerHTML('<a href="/reader-follow" onclick="throw 1" data-action="private-window">Read more</a>',url)+'</article></section>';},origin+'/article');
    const link=shell.locator('.reader-content a');assert.equal(await link.getAttribute('onclick'),null);assert.equal(await link.getAttribute('data-action'),null);
    assert.equal(await link.getAttribute('href'),origin+'/reader-follow');await link.focus();await shell.keyboard.press('Enter');
    await waitState(s=>s.tabs.some(t=>t.url===origin+'/reader-follow'));assert.match(shell.url(),/shell\.html$/);
    assert.equal((await inspect('windows')).length,1);
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
  await t.test('submitted login save, whitespace secret and wrong-origin refusal',async()=>{
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
  fs.writeFileSync(path.join(build,'ext','manifest.json'),JSON.stringify({manifest_version:3,name:'Arco Store Fixture',version:'1.0.0',description:'fixture',icons:{'128':'icon.png'},action:{default_title:'Fixture'},background:{service_worker:'sw.js'},content_scripts:[{matches:['<all_urls>'],js:['cs.js']}]}));
  fs.writeFileSync(path.join(build,'ext','sw.js'),"chrome.action.onClicked.addListener(() => { chrome.windows.create({ url: chrome.runtime.getURL('tool.html'), type: 'popup', width: 420, height: 320 }); });");
  fs.writeFileSync(path.join(build,'ext','tool.html'),'<!doctype html><title>Fixture Tool</title><h1 id="tool">fixture tool</h1>');
  fs.writeFileSync(path.join(build,'ext','icon.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
  fs.writeFileSync(path.join(build,'ext','cs.js'),'document.documentElement.dataset.arcoStore="1";');
  const { execFileSync } = require('node:child_process');
  execFileSync('/usr/bin/zip',['-q','-r',path.join(build,'pack.zip'),'.'],{cwd:path.join(build,'ext')});
  const head=Buffer.alloc(12);head.write('Cr24',0,'binary');head.writeUInt32LE(3,4);head.writeUInt32LE(4,8);
  const payload=Buffer.concat([head,Buffer.from('sig!'),fs.readFileSync(path.join(build,'pack.zip'))]);
  const store=http.createServer((request,response)=>{
    if(request.url.startsWith('/page')){ response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return response.end('<title>Fixture</title><h1>Fixture</h1>'); }
    response.writeHead(200,{'Content-Type':'application/x-chrome-extension'}); response.end(payload);
  });
  await new Promise(resolve=>store.listen(0,'127.0.0.1',resolve));
  const pageOrigin=`http://127.0.0.1:${store.address().port}`;
  let instance=null;
  try{
    instance=await electron.launch({args:[root],env:{...process.env,ARCO_TEST_MODE:'1',ARCO_USER_DATA_DIR:folder,ARCO_CRX_ORIGIN:`http://127.0.0.1:${store.address().port}`},timeout:15000});
    let page=null;
    for(let i=0;i<200&&!page;i++){page=(await instance.windows()).find(p=>/shell\.html$/.test(p.url()));if(!page)await new Promise(r=>setTimeout(r,50));}
    page.setDefaultTimeout(8000);await page.waitForFunction(()=>!!window.arco&&!!document.querySelector('#favorites .favorite-add'));
    if(await page.$('[data-onboarding]')){await page.click('[data-action="onboard-skip"]');await page.waitForFunction(()=>!document.querySelector('[data-onboarding]'));}
    await page.click('[data-action="settings"]');await page.click('[data-settings-section="extensions"]');
    await page.fill('#store-input','https://chromewebstore.google.com/detail/fixture/eimadpbcbfnmbkopoojfekhnkhdbieeh?hl=zh-CN');
    await page.click('[data-action="install-store-input"]');
    await page.waitForFunction(()=>/Arco Store Fixture/.test(document.querySelector('#extension-list')?.textContent||''));
    const state=await page.evaluate(()=>window.arco.invoke('arco:test',{action:'state'}));
    assert.equal(state.settings.extensions.length,1);
    assert.equal(state.settings.extensions[0].storeID,'eimadpbcbfnmbkopoojfekhnkhdbieeh');
    assert(fs.existsSync(path.join(folder,'Extensions','eimadpbcbfnmbkopoojfekhnkhdbieeh','cs.js')));
    await page.fill('#store-input','https://example.com/detail/x/eimadpbcbfnmbkopoojfekhnkhdbieeh');
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
    // 核心链路：点扩展自己的图标 → 它的 chrome.action.onClicked → 它自己的 chrome.windows.create
    await page.waitForFunction(()=>{const list=document.querySelector('browser-action-list');return !!(list&&list.shadowRoot&&list.shadowRoot.querySelector('button'));});
    await page.evaluate(()=>{const list=document.querySelector('browser-action-list');list.shadowRoot.querySelector('button').click();});
    let tool=null;
    await assertEventually(async()=>{tool=(await instance.windows()).find(w=>/\/tool\.html$/.test(w.url()));return !!tool;});
    await tool.waitForSelector('#tool');
    assert.equal(await tool.textContent('#tool'),'fixture tool');
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
