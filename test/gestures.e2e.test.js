'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

test('gestures in real Chromium views', { timeout: 60000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-gestures-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>${req.url}</title><body style="margin:0;min-height:2000px"><h1>${req.url}</h1>${req.url === '/article' ? '<article><h1>Readable article</h1>' + '<p>This is a sufficiently long paragraph to extract a real reader article and test native gestures on the isolated document.</p>'.repeat(20) + '</article>' : ''}<div id="scroll" style="position:absolute;top:300px;left:20px;width:300px;height:100px;overflow:auto"><div style="width:2000px;height:80px">Horizontal content</div></div></body>`);
  });
  let app;
  t.after(async () => { if (app) await app.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile }, timeout: 15000 });
  let shell;
  for (let i = 0; i < 150 && !shell; i++) {
    shell = (await app.windows()).find(page => page.url().endsWith('shell.html'));
    if (!shell) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(shell);
  await shell.waitForFunction(() => window.arco && document.querySelector('#space-name')?.textContent);
  await shell.locator('[data-action="onboard-skip"]').click();
  const invoke = (channel, payload = {}, target = shell) => target.evaluate(({ channel, payload }) => window.arco.invoke('arco:invoke', { channel, payload }), { channel, payload });
  const state = () => shell.evaluate(() => window.arco.invoke('arco:test', { action: 'state' }));
  const open = async name => {
    await invoke('new-tab', { url: origin + name });
    for (let i = 0; i < 100; i++) {
      const page = (await app.windows()).find(page => page.url() === origin + name);
      if (page) { await page.waitForLoadState('load'); return page; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Page missing: ' + name);
  };
  const wheel = async (page, deltaX, deltaY = 0, x = 100, y = 100) => {
    const cdp = await app.context().newCDPSession(page);
    try { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }); }
    finally { await cdp.detach(); }
    await new Promise(resolve => setTimeout(resolve, 350));
  };
  const pinch = async target => {
    const cdp = await app.context().newCDPSession(target);
    try { await cdp.send('Input.synthesizePinchGesture', { x: 200, y: 200, scaleFactor: 2, gestureSourceType: 'mouse' }); }
    finally { await cdp.detach(); }
    assert(await target.evaluate(() => visualViewport.scale > 1.1));
  };
  await t.test('new spaces work through the real form and persist', async () => {
    for (const name of ['工作', '学习']) {
      await shell.locator('[data-action="add-space"]').click();
      await shell.locator('#space-form [name="name"]').fill(name);
      await shell.locator('[data-action="submit-space"]').click();
      await shell.waitForFunction(name => document.querySelector('#space-name')?.textContent === name && !document.querySelector('#space-form'), name);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'Library.json'), 'utf8'));
    assert.deepEqual(saved.spaces.map(space => space.name), ['个人', '工作', '学习']);
    const first = saved.spaces[0];
    await invoke('switch-space', { id: first.id });
  });
  await t.test('sidebar horizontal swipes switch adjacent spaces without wrapping', async () => {
    const activeName = async () => { const current = await state(); return current.spaces.find(space => space.id === current.activeSpaceID)?.name; };
    await wheel(shell, 150, 0, 100, 400);
    assert.equal(await activeName(), '个人');
    await wheel(shell, -150, 0, 100, 400);
    assert.equal(await activeName(), '工作');
    await wheel(shell, 150, 0, 100, 400);
    assert.equal(await activeName(), '个人');
    await wheel(shell, -150, 100, 100, 400);
    assert.equal(await activeName(), '个人');
    await shell.locator('#sidebar-scroll').evaluate(node => node.dispatchEvent(new WheelEvent('wheel', { deltaX: -150, bubbles: true, cancelable: true })));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await activeName(), '个人');
  });
  const page = await open('/a');
  await t.test('no history is a harmless no-op', async () => {
    await wheel(page, -150); assert.equal(page.url(), origin + '/a');
    await wheel(page, 150); assert.equal(page.url(), origin + '/a');
  });
  await page.goto(origin + '/b');
  await t.test('baseline Chromium does not provide double-finger history navigation', async () => {
    // Keep an actual native-input baseline: disable only Arco's isolated wheel listener.
    await page.evaluate(() => { window.blockGesture = event => event.stopImmediatePropagation(); window.addEventListener('wheel', window.blockGesture, true); });
    await wheel(page, -150);
    assert.equal(page.url(), origin + '/b');
    await page.evaluate(() => window.removeEventListener('wheel', window.blockGesture, true));
  });
  await t.test('trusted wheel navigates back and forward while synthetic wheel cannot', async () => {
    await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaX: -150 })));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(page.url(), origin + '/b');
    await wheel(page, -150); await page.waitForURL(origin + '/a');
    await wheel(page, 150); await page.waitForURL(origin + '/b');
  });
  await t.test('scroll containers, vertical scrolling and CSS containment retain page control', async () => {
    await page.locator('#scroll').evaluate(node => { node.scrollLeft = 300; });
    await wheel(page, -150, 0, 100, 330);
    assert.equal(page.url(), origin + '/b');
    assert(await page.locator('#scroll').evaluate(node => node.scrollLeft < 300));
    await wheel(page, 0, 150);
    assert.equal(page.url(), origin + '/b');
    await page.evaluate(() => { scrollTo(0, 0); document.documentElement.style.overscrollBehaviorX = 'contain'; });
    await wheel(page, -150);
    assert.equal(page.url(), origin + '/b');
    await page.evaluate(() => { document.documentElement.style.overscrollBehaviorX = 'auto'; });
    await page.evaluate(() => { window.cancelWheel = event => event.preventDefault(); window.addEventListener('wheel', window.cancelWheel, { passive: false }); });
    await wheel(page, -150);
    assert.equal(page.url(), origin + '/b');
    await page.evaluate(() => window.removeEventListener('wheel', window.cancelWheel));
  });
  await t.test('native pinch changes visual scale and reset restores it', async () => {
    await pinch(page);
    await wheel(page, -150);
    assert.equal(page.url(), origin + '/b', 'panning a magnified page must not navigate');
    await invoke('zoom', { reset: true });
    await page.waitForFunction(() => Math.abs(visualViewport.scale - 1) < 0.01);
    assert.equal(await page.evaluate(() => visualViewport.scale), 1);
  });
  await t.test('split gestures act on the receiving pane without clicking it first', async () => {
    const leftID = (await state()).activeID;
    const right = await open('/right-a');
    await right.goto(origin + '/right-b');
    const rightID = (await state()).activeID;
    await invoke('select-tab', { id: leftID });
    await invoke('toggle-split', { id: rightID });
    await wheel(right, -150);
    await right.waitForURL(origin + '/right-a');
    assert.equal(page.url(), origin + '/b');
    assert.equal((await state()).focusedPaneID, rightID);
  });
  await t.test('Peek navigates its own history and promotion preserves one handler', async () => {
    await invoke('peek', { url: origin + '/peek-a' });
    let peek;
    for (let i = 0; i < 100 && !peek; i++) { peek = (await app.windows()).find(p => p.url() === origin + '/peek-a'); if (!peek) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert(peek); await peek.waitForLoadState('load');
    await peek.goto(origin + '/peek-b');
    await wheel(peek, -150); await peek.waitForURL(origin + '/peek-a');
    await invoke('peek-to-tab');
    await wheel(peek, 150); await peek.waitForURL(origin + '/peek-b');
  });
  await t.test('navigation IPC rejects background, shell, invalid-direction and non-main-frame senders', async () => {
    const before = await state();
    await app.evaluate(({ ipcMain, webContents }, origin) => {
      const all = webContents.getAllWebContents();
      const hidden = all.find(wc => wc.getURL() === origin + '/b');
      const shell = all.find(wc => wc.getURL().endsWith('shell.html'));
      const active = all.find(wc => wc.getURL() === origin + '/peek-b');
      for (const [sender, direction, mainFrame] of [[hidden, 'back', true], [shell, 'back', true], [active, 'invalid', true], [active, 'back', false]]) {
        ipcMain.emit('arco:gesture-navigate', { sender, senderFrame: mainFrame ? sender.mainFrame : null }, direction);
      }
    }, origin);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(page.url(), origin + '/b');
    assert.equal((await state()).activeID, before.activeID);
    assert.equal((await state()).tabs.find(tab => tab.id === before.activeID).url, origin + '/peek-b');
  });
  await t.test('reader supports native pinch and right swipe returns to the source page', async () => {
    const article = await open('/article');
    await invoke('reader');
    let reader;
    for (let i = 0; i < 100 && !reader; i++) { reader = (await app.windows()).find(p => p.url().startsWith('data:text/html')); if (!reader) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert(reader); await reader.waitForLoadState('load');
    await wheel(reader, 150); assert.equal((await state()).reader, true);
    await pinch(reader);
    await invoke('zoom', { reset: true });
    await reader.waitForFunction(() => visualViewport.scale === 1);
    await wheel(reader, -150);
    assert.equal((await state()).reader, false);
    assert.equal(article.url(), origin + '/article');
  });
  await t.test('website popups receive gestures independently', async () => {
    const popupPromise = app.waitForEvent('window');
    await page.evaluate(url => window.open(url, 'gesture-popup', 'width=600,height=600'), origin + '/popup-a');
    const popup = await popupPromise; await popup.waitForLoadState('load');
    await popup.goto(origin + '/popup-b');
    await wheel(popup, -150); await popup.waitForURL(origin + '/popup-a');
    await pinch(popup);
    assert.equal(page.url(), origin + '/b');
    await popup.close();
  });
  await t.test('private sessions register the same gestures without changing ordinary tabs', async () => {
    await invoke('private-window');
    let privateShell;
    for (let i = 0; i < 100 && !privateShell; i++) { privateShell = (await app.windows()).find(p => p !== shell && p.url().endsWith('shell.html')); if (!privateShell) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert(privateShell); await privateShell.waitForFunction(() => window.arco && document.querySelector('#space-name')?.textContent);
    await invoke('new-tab', { url: origin + '/private-a' }, privateShell);
    let privatePage;
    for (let i = 0; i < 100 && !privatePage; i++) { privatePage = (await app.windows()).find(p => p.url() === origin + '/private-a'); if (!privatePage) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert(privatePage); await privatePage.waitForLoadState('load');
    await privatePage.goto(origin + '/private-b');
    await wheel(privatePage, -150); await privatePage.waitForURL(origin + '/private-a');
    await pinch(privatePage);
    assert.equal(page.url(), origin + '/b');
  });
});
