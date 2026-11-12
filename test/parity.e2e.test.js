'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const root = path.join(__dirname, '..');

test('bookmarked URLs keep each live tab visible and independently closable', { timeout: 60000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-parity-'));
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<title>Same URL</title><label>Draft <input id="draft"></label>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/same`;
  let app = null;

  async function launch() {
    app = await electron.launch({
      args: [root],
      env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile },
      timeout: 15000
    });
    let shell = null;
    for (let index = 0; index < 200 && !shell; index++) {
      shell = (await app.windows()).find(page => /shell\.html$/.test(page.url()));
      if (!shell) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(shell, 'browser shell must be present');
    shell.setDefaultTimeout(8000);
    await shell.waitForFunction(() => !!window.arco && !!document.querySelector('#space-name')?.textContent);
    if (await shell.waitForSelector('[data-onboarding]', { timeout: 2000 }).catch(() => null)) {
      await shell.click('[data-action="onboard-skip"]');
      await shell.waitForFunction(() => !document.querySelector('[data-onboarding]'));
    }
    return shell;
  }

  async function close() {
    if (!app) return;
    const process = app.process();
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2500))]);
    if (process.exitCode === null) process.kill('SIGTERM');
    app = null;
  }

  const invoke = (shell, channel, payload = {}) => shell.evaluate(
    ({ channel, payload }) => window.arco.invoke('arco:invoke', { channel, payload }),
    { channel, payload }
  );
  const inspect = (shell, action, payload = {}) => shell.evaluate(
    ({ action, payload }) => window.arco.invoke('arco:test', { action, payload }),
    { action, payload }
  );
  async function eventually(check) {
    for (let index = 0; index < 120; index++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('state did not converge');
  }

  t.after(async () => {
    await close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });

  let shell = await launch();
  await invoke(shell, 'navigate', { input: url });
  await invoke(shell, 'new-tab', { url });
  await eventually(async () => (await inspect(shell, 'state')).tabs.filter(tab => tab.url === url).length === 2);
  let state = await inspect(shell, 'state');
  const [first, second] = state.tabs.filter(tab => tab.url === url);
  await inspect(shell, 'evaluate', { id: first.id, script: 'document.querySelector("#draft").value="first"' });
  await inspect(shell, 'evaluate', { id: second.id, script: 'document.querySelector("#draft").value="second"' });
  await invoke(shell, 'add-bookmark', { title: 'Same URL bookmark', url });

  await eventually(async () => await shell.locator('#tabs [data-tab-row]').count() === 2);
  assert.equal(await shell.locator(`#tabs [data-tab-row="${first.id}"]`).count(), 1);
  assert.equal(await shell.locator(`#tabs [data-tab-row="${second.id}"]`).count(), 1);
  assert.equal((await inspect(shell, 'state')).bookmarks.filter(bookmark => bookmark.url === url).length, 1);

  await shell.locator(`#tabs [data-tab-row="${first.id}"]`).hover();
  await shell.locator(`#tabs [data-close-tab="${first.id}"]`).click();
  await eventually(async () => !(await inspect(shell, 'state')).tabs.some(tab => tab.id === first.id));
  assert.equal(await inspect(shell, 'evaluate', { id: second.id, script: 'document.querySelector("#draft").value' }), 'second');
  state = await inspect(shell, 'state');
  assert.equal(state.bookmarks.filter(bookmark => bookmark.url === url).length, 1);
  assert.equal(await shell.locator(`#tabs [data-tab-row="${second.id}"]`).count(), 1);

  await invoke(shell, 'new-tab', { url });
  await eventually(async () => (await inspect(shell, 'state')).tabs.filter(tab => tab.url === url).length === 2);
  await close();

  shell = await launch();
  await eventually(async () => (await inspect(shell, 'state')).tabs.filter(tab => tab.url === url).length === 2);
  assert.equal(await shell.locator('#tabs [data-tab-row]').count(), 2);
  state = await inspect(shell, 'state');
  assert.equal(state.bookmarks.filter(bookmark => bookmark.url === url).length, 1);
});
