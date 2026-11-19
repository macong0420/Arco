'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const root = path.join(__dirname, '..');

test('MV3 sidePanel and debugger compatibility stays scoped to Arco web tabs', { timeout: 60000 }, async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-extension-compat-'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-extension-fixture-'));
  const selected = path.join(fixture, 'selected.txt'); fs.writeFileSync(selected, 'fixture');
  const fixtureKeys = require('./crx-fixture').generateKeyPair();
  const extension = path.join(data, 'Extensions', fixtureKeys.id); fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Arco Compatibility Fixture', version: '1.0.0', key: fixtureKeys.publicKey.toString('base64'),
    permissions: ['storage', 'sidePanel', 'debugger', 'scripting'], host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'worker.js', type: 'module' },
    action: { default_title: 'Fixture' }, side_panel: { default_path: 'panel.html' }, options_page: 'panel.html', icons: { '16': 'icon.png' },
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }]
  }));
  fs.writeFileSync(path.join(extension, 'worker.js'), `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}); chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message?.type==='probe')reply({ok:true,tabId:sender.tab?.id});}); chrome.action.onClicked.addListener(()=>{});`);
  fs.writeFileSync(path.join(extension, 'content.js'), `document.documentElement.dataset.compatExtension=chrome.runtime.id;`);
  fs.writeFileSync(path.join(extension, 'icon.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(extension, 'panel.html'), `<!doctype html><meta charset="utf-8"><script src="panel.js"></script><h1>Fixture panel</h1>`);
  fs.writeFileSync(path.join(extension, 'panel.js'), `window.runCompat=async()=>{
    const background=await chrome.runtime.sendMessage({type:'probe'});
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const options=await chrome.sidePanel.getOptions({tabId:tab.id});
    const self=await chrome.management.getSelf();
    const injected=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>location.href});
    await chrome.debugger.attach({tabId:tab.id},'1.3');
    const evaluated=await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'6*7',returnByValue:true});
    await chrome.debugger.sendCommand({tabId:tab.id},'DOM.enable');
    const doc=await chrome.debugger.sendCommand({tabId:tab.id},'DOM.getDocument');
    const input=await chrome.debugger.sendCommand({tabId:tab.id},'DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#upload'});
    const object=await chrome.debugger.sendCommand({tabId:tab.id},'DOM.resolveNode',{nodeId:input.nodeId});
    await chrome.debugger.sendCommand({tabId:tab.id},'DOM.setFileInputFiles',{objectId:object.object.objectId,files:[${JSON.stringify(selected)}]});
    const filename=await chrome.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:'document.querySelector("#upload").files[0].name',returnByValue:true});
    await chrome.debugger.detach({tabId:tab.id});
    return {background,tabId:tab.id,windowId:tab.windowId,installType:self.installType,injected:injected[0].result,value:evaluated.result.value,file:filename.result.value,sidePanelPath:options.path};
  };`);
  const server = http.createServer((_request, response) => response.end('<!doctype html><title>Debugger target</title><input id="upload" type="file">'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  let app;
  t.after(async () => {
    const child = app?.process(); await app?.close().catch(() => {});
    if (child?.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(fixture, { recursive: true, force: true });
  });
  app = await electron.launch({ args: [root], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: data }, timeout: 15000 });
  let shell = null;
  for (let i = 0; i < 200 && !shell; i++) { shell = (await app.windows()).find(page => /shell\.html$/.test(page.url())); if (!shell) await new Promise(resolve => setTimeout(resolve, 50)); }
  assert(shell); shell.setDefaultTimeout(8000);
  await shell.waitForFunction(() => !!window.arco);
  if (await shell.$('[data-onboarding]')) { await shell.click('[data-action="onboard-skip"]'); await shell.waitForFunction(() => !document.querySelector('[data-onboarding]')); }
  await shell.evaluate(url => window.arco.invoke('arco:invoke', { channel: 'new-tab', payload: { url } }), origin);
  let page;
  for (let i = 0; i < 100; i++) { page = (await app.windows()).find(candidate => candidate.url() === origin); if (page) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert(page, 'Arco must open the HTTP test page');
  const installed = await shell.evaluate(directory => window.arco.invoke('arco:test', { action: 'extension-install-directory', payload: { directory } }), extension);
  assert.equal(installed.name, 'Arco Compatibility Fixture');
  await page.reload(); await page.waitForFunction(() => !!document.documentElement.dataset.compatExtension);
  const opened = await shell.evaluate(id => window.arco.invoke('arco:test', { action: 'extension-action-click', payload: { id } }), installed.id);
  assert.equal(opened.workerReady, true, JSON.stringify(opened));
  assert.equal(opened.panel, true, JSON.stringify(opened));
  const result = await shell.evaluate(() => window.arco.invoke('arco:test', { action: 'extension-panel-evaluate', payload: { script: 'window.runCompat()' } }));
  assert.equal(result.background.ok, true);
  assert.deepEqual({ ...result, background: { ok: true } }, { background: { ok: true }, tabId: result.tabId, windowId: result.windowId, installType: 'normal', injected: origin, value: 42, file: 'selected.txt', sidePanelPath: 'panel.html' });

  // 用户路径：从地址栏的扩展入口点图标。侧栏是原生视图，扩展面板必须先退出，否则点了看不到任何反应。
  await shell.evaluate(id => window.arco.invoke('arco:test', { action: 'extension-action-click', payload: { id } }), installed.id);
  await shell.click('.address-row [data-extensions-entry]');
  await shell.waitForFunction(id => !!document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`button[id="${id}"]`), installed.id);
  await shell.evaluate(id => document.querySelector('browser-action-list').shadowRoot.querySelector(`button[id="${id}"]`).click(), installed.id);
  await shell.waitForFunction(() => !document.querySelector('#extensions-body'));
  // 侧栏是原生视图，loadURL 是异步的：等导航提交后再断言，避免读到空 URL 的时序抖动。
  let stack = [];
  for (let i = 0; i < 100; i++) {
    stack = await shell.evaluate(() => window.arco.invoke('arco:test', { action: 'native-stack' }));
    if (stack.some(view => view.url.endsWith('/panel.html') && view.visible)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(stack.some(view => view.url.endsWith('/panel.html') && view.visible), JSON.stringify(stack));

  // 只有 onClicked 的扩展：点图标后扩展自己改标题和角标，界面要给出看得见的反馈。
  const clickKeys = require('./crx-fixture').generateKeyPair();
  const clickDir = path.join(fixture, 'click');
  fs.mkdirSync(clickDir, { recursive: true });
  fs.writeFileSync(path.join(clickDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Arco Click Fixture', version: '1.0.0', key: clickKeys.publicKey.toString('base64'),
    permissions: ['storage'], background: { service_worker: 'worker.js' }, action: { default_title: 'Click fixture' }, icons: { '16': 'icon.png' }
  }));
  fs.writeFileSync(path.join(clickDir, 'worker.js'), `chrome.action.onClicked.addListener(async () => {
    const { on } = await chrome.storage.local.get('on');
    await chrome.storage.local.set({ on: !on });
    await chrome.action.setBadgeText({ text: on ? '' : 'ON' });
    await chrome.action.setTitle({ title: on ? 'Click fixture：已关闭' : 'Click fixture：已开启' });
  });`);
  fs.writeFileSync(path.join(clickDir, 'icon.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const clickInstalled = await shell.evaluate(directory => window.arco.invoke('arco:test', { action: 'extension-install-directory', payload: { directory } }), clickDir);
  await shell.click('.address-row [data-extensions-entry]');
  await shell.waitForFunction(id => !!document.querySelector('browser-action-list')?.shadowRoot?.querySelector(`button[id="${id}"]`), clickInstalled.id);
  await shell.evaluate(id => document.querySelector('browser-action-list').shadowRoot.querySelector(`button[id="${id}"]`).click(), clickInstalled.id);
  await shell.waitForFunction(() => /已开启/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 6000 });
  assert.ok(await shell.$('#extensions-body'), '提示条要在扩展面板还开着时出现');
});

test('the store\'s own Add to Chrome button installs through a Chrome-style confirmation', { timeout: 60000 }, async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-store-click-'));
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-store-click-build-'));
  const extension = path.join(build, 'ext');
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Arco Store Click Fixture', version: '1.0.0', permissions: ['storage'], content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }] }));
  fs.writeFileSync(path.join(extension, 'cs.js'), `document.documentElement.dataset.storeClickExtension = chrome.runtime.id;`);
  const zip = path.join(build, 'pack.zip');
  execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], { cwd: extension });
  const keys = require('./crx-fixture').generateKeyPair(), storeID = keys.id;
  const payload = require('./crx-fixture').signedCRX3(fs.readFileSync(zip), keys);
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/x-chrome-extension' }); response.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const storeURL = `https://chromewebstore.google.com/detail/fixture/${storeID}?hl=zh-CN`;
  let app;
  t.after(async () => {
    const child = app?.process(); await app?.close().catch(() => {});
    if (child?.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(build, { recursive: true, force: true });
  });
  app = await electron.launch({ args: [root], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: data, ARCO_CRX_ORIGIN: `http://127.0.0.1:${server.address().port}` }, timeout: 15000 });
  await app.context().route(storeURL, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><title>Fixture Store</title><h1>Fixture</h1><button id="add-to-chrome" disabled>添加至 Chrome</button>' }));
  let shell = null;
  for (let i = 0; i < 200 && !shell; i++) { shell = (await app.windows()).find(page => /shell\.html$/.test(page.url())); if (!shell) await new Promise(resolve => setTimeout(resolve, 50)); }
  assert(shell); shell.setDefaultTimeout(8000);
  await shell.waitForFunction(() => !!window.arco);
  if (await shell.$('[data-onboarding]')) { await shell.click('[data-action="onboard-skip"]'); await shell.waitForFunction(() => !document.querySelector('[data-onboarding]')); }
  await shell.evaluate(url => window.arco.invoke('arco:invoke', { channel: 'new-tab', payload: { url } }), storeURL);
  let page;
  for (let i = 0; i < 100; i++) { page = (await app.windows()).find(candidate => candidate.url() === storeURL); if (page) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert(page, 'Arco must open the store page');
  await page.waitForFunction(() => typeof window.__arcoStoreInstall === 'function');
  // 商店在非 Chrome/未登录时禁用安装按钮；Arco 接管后要恢复它，点击才可能发生。
  await page.waitForFunction(() => document.getElementById('add-to-chrome').disabled === false);
  // 登录页按 UA 判断浏览器：UA 必须是正常 Chrome 形态，不能带 Electron 标记。
  const ua = await page.evaluate(() => navigator.userAgent);
  assert.match(ua, /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(ua, /Electron|Arco/);
  await page.click('#add-to-chrome', { noWaitAfter: true });
  for (let i = 0; i < 100; i++) {
    const state = await shell.evaluate(() => window.arco.invoke('arco:test', { action: 'state' }));
    if (state.settings.extensions.some(item => item.storeID === storeID)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const state = await shell.evaluate(() => window.arco.invoke('arco:test', { action: 'state' }));
  assert.ok(state.settings.extensions.some(item => item.storeID === storeID), 'the store button must install the extension');
  assert.equal(page.url(), storeURL, 'the sentinel navigation must not leave the store page');
  await shell.waitForFunction(() => /已安装/.test(document.querySelector('#toast')?.textContent || ''));
});

test('store extensions update themselves but skip versions that ask for more permissions', { timeout: 60000 }, async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-update-'));
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-update-build-'));
  const keys = require('./crx-fixture').generateKeyPair(), storeID = keys.id;
  const pack = (version, extra = {}) => {
    const dir = path.join(build, 'ext-' + version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Arco Update Fixture', version, ...extra }));
    fs.writeFileSync(path.join(dir, 'cs.js'), `document.documentElement.dataset.updateVersion='${version}';`);
    const zip = path.join(build, `pack-${version}.zip`);
    execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], { cwd: dir });
    return require('./crx-fixture').signedCRX3(fs.readFileSync(zip), keys);
  };
  let payload = pack('1.0.0'), latest = '1.0.0';
  const server = http.createServer((request, response) => {
    if (request.url.includes('response=updatecheck')) { response.setHeader('Content-Type', 'application/xml'); return response.end(`<?xml version="1.0"?><gupdate><app appid="${storeID}" status="ok"><updatecheck status="ok" version="${latest}"/></app></gupdate>`); }
    response.writeHead(200, { 'Content-Type': 'application/x-chrome-extension' }); response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  t.after(async () => {
    const child = app?.process(); await app?.close().catch(() => {});
    if (child?.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(build, { recursive: true, force: true });
  });
  app = await electron.launch({ args: [root], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: data, ARCO_CRX_ORIGIN: `http://127.0.0.1:${server.address().port}` }, timeout: 15000 });
  let shell = null;
  for (let i = 0; i < 200 && !shell; i++) { shell = (await app.windows()).find(page => /shell\.html$/.test(page.url())); if (!shell) await new Promise(resolve => setTimeout(resolve, 50)); }
  assert(shell); shell.setDefaultTimeout(8000);
  await shell.waitForFunction(() => !!window.arco);
  if (await shell.$('[data-onboarding]')) { await shell.click('[data-action="onboard-skip"]'); await shell.waitForFunction(() => !document.querySelector('[data-onboarding]')); }
  const invoke = (channel, payload = {}) => shell.evaluate(({ channel, payload }) => window.arco.invoke('arco:invoke', { channel, payload }), { channel, payload });
  const first = await invoke('install-extension-store', { input: storeID });
  assert.equal(first.version, '1.0.0');
  latest = '2.0.0'; payload = pack('2.0.0');
  const updates = await invoke('check-extension-updates');
  assert.ok(updates.some(item => item.to === '2.0.0'), JSON.stringify(updates));
  const list = await invoke('extension-list');
  assert.equal(list.find(item => item.id === storeID)?.version, '2.0.0');
  latest = '3.0.0'; payload = pack('3.0.0', { permissions: ['notifications'] });
  const skipped = await invoke('check-extension-updates');
  assert.ok(skipped.some(item => item.skipped), JSON.stringify(skipped));
  const after = await invoke('extension-list');
  assert.equal(after.find(item => item.id === storeID)?.version, '2.0.0');
});
