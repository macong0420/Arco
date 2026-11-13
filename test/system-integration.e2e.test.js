'use strict';
// 系统集成入口回归：工具栏三个入口、Little Arc 独立小窗、页面翻译和开发者工具目标。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label = 'state') {
  for (let i = 0; i < 160; i++) { if (await check()) return; await sleep(50); }
  throw new Error('Timed out waiting for ' + label);
}
test('toolbar system integration: translate, Little Arc and developer tools', { timeout: 90000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-system-integration-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/link') return response.end('<title>Link</title><a id="next" href="/next">next</a>');
    if (request.url === '/next') return response.end('<title>Next</title><h1>Next page</h1>');
    response.end('<title>Integration</title><h1>Hello world</h1><p id="body">Translate this visible sentence.</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let app;
  try {
    app = await electron.launch({ args: [root], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile }, timeout: 15000 });
    let shell = null;
    for (let i = 0; i < 200 && !shell; i++) { shell = (await app.windows()).find(page => /shell\.html$/.test(page.url())); if (!shell) await sleep(50); }
    assert(shell, 'shell must be present');
    await shell.waitForFunction(() => !!window.arco && !!document.querySelector('#space-name')?.textContent);
    if (await shell.locator('[data-action="onboard-skip"]').isVisible().catch(() => false)) await shell.click('[data-action="onboard-skip"]');
    const invoke = (channel, payload = {}) => shell.evaluate(({ channel, payload }) => window.arco.invoke('arco:invoke', { channel, payload }), { channel, payload });
    const inspect = (action, payload = {}) => shell.evaluate(({ action, payload }) => window.arco.invoke('arco:test', { action, payload }), { action, payload });
    const activePage = async () => { const state = await inspect('state'); return state.tabs.find(tab => tab.id === state.activeID); };

    await invoke('new-tab', { url: origin + '/' });
    let page;
    await eventually(async () => { page = (await app.windows()).find(candidate => candidate.url() === origin + '/'); return !!page; }, 'fixture page');
    await page.waitForLoadState('domcontentloaded');
    assert.equal(await shell.locator('#page-toolbar [data-action="translate"]').isVisible(), true);
    assert.equal(await shell.locator('#page-toolbar [data-action="little-window"]').isVisible(), true);
    assert.equal(await shell.locator('#page-toolbar [data-action="devtools"]').isVisible(), true);

    await t.test('translate replaces visible text, marks the tab and restores it', async () => {
      const result = await invoke('translate');
      assert.equal(result.source, 'en');
      assert(result.count > 0);
      assert.equal(await page.locator('#body').textContent(), '译:Translate this visible sentence.');
      assert.equal((await inspect('state')).translation.count, result.count);
      assert.equal(await shell.locator('[data-action="translate"]').evaluate(node => node.classList.contains('active')), true);
      assert.equal(await invoke('translate'), null);
      assert.equal(await page.locator('#body').textContent(), 'Translate this visible sentence.');
      assert.equal((await inspect('state')).translation, null);
    });

    await t.test('Little Arc opens a compact separate window and does not alter the main tab', async () => {
      const before = (await inspect('state')).tabs.length;
      const little = await invoke('little-window');
      assert(Number.isInteger(little.id));
      let child = null;
      await eventually(async () => { child = (await app.windows()).find(candidate => candidate !== shell && /shell\.html$/.test(candidate.url())); return !!child; }, 'Little Arc window');
      await child.waitForFunction(() => !!window.arco);
      const childState = await child.evaluate(() => window.arco.invoke('arco:test', { action: 'state' }));
      assert.equal(childState.little, true);
      assert.equal(childState.sidebarVisible, false);
      assert(childState.tabs.some(tab => tab.url === origin + '/'));
      assert.equal((await inspect('state')).tabs.length, before, 'Little Arc must not add a tab to the main window');
      const { size, area } = await app.evaluate(({ BaseWindow, screen }, id) => {
        const win = BaseWindow.getAllWindows().find(item => item.id === id);
        return win ? { size: win.getSize(), area: screen.getDisplayMatching(win.getBounds()).workArea } : {};
      }, little.id);
      assert(size && Math.abs(size[0] / size[1] - 560 / 640) < .02, 'Little Arc must preserve its aspect ratio');
      assert(size[0] <= area.width * .8 + 2 && size[1] <= area.height * .8 + 2, 'Little Arc must fit the work area');
      assert(size[1] > 640, 'Little Arc must use the available work area instead of the old fixed size');
      await child.evaluate(url => window.arco.invoke('arco:invoke', { channel: 'navigate', payload: { input: url } }), origin + '/link');
      let childPage = null;
      await eventually(async () => { childPage = (await app.windows()).find(candidate => candidate.url() === origin + '/link'); return !!childPage; }, 'Little Arc link page');
      await childPage.locator('#next').click({ noWaitAfter: true });
      await child.evaluate(url => window.arco.invoke('arco:invoke', { channel: 'navigate', payload: { input: url } }), origin + '/next');
      await eventually(async () => (await app.windows()).some(candidate => candidate.url() === origin + '/next'), 'Little Arc in-window navigation');
      assert.equal((await app.windows()).filter(candidate => /shell\.html$/.test(candidate.url())).length, 2, 'Little Arc links must stay in the compact window');
      await child.evaluate(() => window.arco.invoke('arco:test', { action: 'close-window' }));
      await eventually(async () => !(await app.windows()).some(candidate => candidate !== shell && /shell\.html$/.test(candidate.url())), 'Little Arc closed');
    });

    await t.test('developer tools target the visible page and can be closed again', async () => {
      await invoke('devtools');
      await eventually(async () => await inspect('devtools-open'), 'detached developer tools');
      await invoke('devtools');
      await eventually(async () => !(await inspect('devtools-open')), 'developer tools closed');
    });

    await t.test('settings switch developer tools to the page right side', async () => {
      await invoke('update-settings', { devtoolsMode: 'right' });
      const activeBefore = await activePage();
      const before = (await inspect('views')).find(view => view.id === activeBefore.id).bounds.width;
      await invoke('devtools');
      await eventually(async () => await inspect('devtools-open'), 'docked developer tools');
      const devtools = await inspect('devtools-contents');
      assert.equal(devtools.mode, 'right', 'DevTools must be owned by the page window, not detached');
      const activeAfter = await activePage();
      const width = (await inspect('views')).find(view => view.id === activeAfter.id).bounds.width;
      assert(width < before, 'page width must shrink for right docked DevTools');
      await invoke('devtools');
      assert.equal((await inspect('devtools-contents')).mode, 'detach');
      await invoke('update-settings', { devtoolsMode: 'detach' });
    });

    await t.test('settings let ordinary links open in Little Arc and embed back as a new tab', async () => {
      await invoke('new-tab', { url: origin + '/link' });
      await eventually(async () => (await app.windows()).some(candidate => candidate.url() === origin + '/link'), 'source link page');
      await invoke('update-settings', { linkOpenMode: 'little' });
      const before = (await inspect('state')).tabs.length;
      const activeLink = await activePage();
      const sourcePage = (await app.windows()).find(candidate => candidate.url() === origin + '/link' || candidate.url() === activeLink.url);
      assert(sourcePage, 'source link target must exist');
      await sourcePage.bringToFront();
      const rect = await sourcePage.locator('#next').boundingBox();
      const cdp = await app.context().newCDPSession(sourcePage);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + 10, y: rect.y + 10, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + 10, y: rect.y + 10, button: 'left', clickCount: 1 });
      await cdp.detach();
      let child = null;
      await eventually(async () => { child = (await app.windows()).find(candidate => candidate !== shell && /shell\.html$/.test(candidate.url())); return !!child; }, 'Little Arc from link click');
      await child.waitForFunction(() => !!window.arco);
      const childState = await child.evaluate(() => window.arco.invoke('arco:test', { action: 'state' }));
      assert.equal(childState.little, true);
      assert(childState.tabs.some(tab => tab.url === origin + '/next'));
      assert.equal((await inspect('state')).tabs.length, before);
      await child.locator('[data-action="little-promote"]').click();
      await eventually(async () => !(await app.windows()).some(candidate => candidate !== shell && /shell\.html$/.test(candidate.url())), 'Little Arc embedded');
      const state = await inspect('state');
      assert.equal(state.tabs.length, before + 1);
      assert(state.tabs.some(tab => tab.url === origin + '/next'));
      const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'Library.json'), 'utf8')).settings;
      assert.equal(persisted.linkOpenMode, 'little');
      await invoke('update-settings', { linkOpenMode: 'tab' });
    });

    assert(requests.includes('/'), 'the fixture must have been loaded');
  } finally {
    if (app) { const child = app.process(); await Promise.race([app.close().catch(() => {}), sleep(2500)]); if (child.exitCode === null) child.kill('SIGTERM'); }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
