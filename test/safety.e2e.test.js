'use strict';
// Phase-1 安全与数据基础回归：实例锁、扩展重装事务、下载基础。
// 可单独运行：node --test test/safety.e2e.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const crxFixture = require('./crx-fixture');
const root = path.join(__dirname, '..');
const electronBinary = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function assertEventually(check, label = 'state') {
  for (let i = 0; i < 160; i++) { if (await check()) return; await sleep(50); }
  throw new Error('Timed out waiting for ' + label);
}
async function launch(profile, env = {}) {
  const app = await electron.launch({ args: [root], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile, ...env }, timeout: 15000 });
  running.add(app);
  let shell = null;
  for (let i = 0; i < 200 && !shell; i++) { shell = (await app.windows()).find(page => /shell\.html$/.test(page.url())); if (!shell) await sleep(50); }
  assert(shell, 'Browser shell must be present');
  shell.setDefaultTimeout(8000);
  await shell.waitForFunction(() => !!window.arco && !!document.querySelector('#space-name')?.textContent);
  if (await shell.waitForSelector('[data-onboarding]', { timeout: 3000 }).catch(() => null)) {
    await shell.click('[data-action="onboard-skip"]');
    await shell.waitForFunction(() => !document.querySelector('[data-onboarding]'));
  }
  return { app, shell };
}
const running = new Set();
async function close(app) {
  if (!app) return;
  running.delete(app);
  const child = app.process();
  await Promise.race([app.close().catch(() => {}), sleep(2000)]);
  if (child.exitCode === null) child.kill('SIGTERM');
  await sleep(800);
  if (child.exitCode === null) child.kill('SIGKILL');
}
// 测试异常退出时也不留下 Electron 进程。
process.on('exit', () => { for (const app of running) { try { app.process().kill('SIGKILL'); } catch {} } });
const invoke = (shell, channel, payload = {}, page = shell) => page.evaluate(({ channel, payload }) => window.arco.invoke('arco:invoke', { channel, payload }), { channel, payload });
const inspect = (shell, action, payload = {}, page = shell) => page.evaluate(({ action, payload }) => window.arco.invoke('arco:test', { action, payload }), { action, payload });

test('a second instance on the same data directory exits without writing', { timeout: 60000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-lock-'));
  let first = null;
  try {
    first = await launch(profile);
    const libraryFile = path.join(profile, 'Library.json');
    await assertEventually(() => fs.existsSync(libraryFile), 'Library.json');
    await invoke(first.shell, 'add-bookmark', { title: 'Lock fixture', url: 'https://lock.test/' });
    const libraryBytes = fs.readFileSync(libraryFile);
    const sessionFile = path.join(profile, 'Session.json');
    const sessionBytes = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile) : null;
    // 第二个进程使用同一个数据目录：必须在读取/写入资料前退出。
    const child = spawn(electronBinary, [root], { env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile }, stdio: 'ignore' });
    const exit = await new Promise(resolve => {
      child.once('exit', code => resolve(code));
      setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 15000);
    });
    assert.equal(exit, 0, 'the second instance must exit cleanly instead of writing');
    assert.deepEqual(fs.readFileSync(libraryFile), libraryBytes, 'Library.json must not be rewritten by the second instance');
    if (sessionBytes) assert.deepEqual(fs.readFileSync(sessionFile), sessionBytes, 'Session.json must not be rewritten');
    const state = await inspect(first.shell, 'state');
    assert(state.allBookmarks.some(item => item.title === 'Lock fixture'), 'the first instance must keep working');
    // 不同数据目录的第二个实例仍然可以启动（测试隔离与并行开发）。
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-lock-other-'));
    const second = await launch(other);
    assert.equal((await inspect(second.shell, 'state')).private, false);
    await close(second.app);
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    await close(first?.app);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('failed settings writes do not leak theme, sidebar or sync mutations into memory or later saves', { timeout: 60000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-settings-'));
  const syncFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-settings-sync-'));
  const failureMarker = path.join(profile, 'fail-library-write'), libraryFile = path.join(profile, 'Library.json');
  let instance = null;
  try {
    const launched = await launch(profile, { ARCO_FAIL_LIBRARY_WRITE: failureMarker });
    instance = launched.app;
    const shell = launched.shell;
    const failWithoutChange = async (channel, payload, check) => {
      const before = fs.readFileSync(libraryFile);
      fs.writeFileSync(failureMarker, '1');
      await assert.rejects(() => invoke(shell, channel, payload), /disk unavailable/);
      fs.rmSync(failureMarker);
      assert.deepEqual(fs.readFileSync(libraryFile), before, channel + ' must leave Library.json unchanged');
      check((await inspect(shell, 'state')).settings);
    };

    const initial = (await inspect(shell, 'state')).settings;
    await failWithoutChange('update-settings', { theme: 'dark' }, settings => assert.equal(settings.theme, initial.theme));
    await invoke(shell, 'update-settings', { theme: 'dark' });
    assert.equal((await inspect(shell, 'state')).settings.theme, 'dark', 'a later successful save must contain only the requested theme change');

    const width = (await inspect(shell, 'state')).settings.sidebarWidth;
    await failWithoutChange('sidebar-width', { width: 333 }, settings => assert.equal(settings.sidebarWidth, width));
    await invoke(shell, 'sidebar-width', { width: 333 });
    assert.equal((await inspect(shell, 'state')).settings.sidebarWidth, 333, 'a later successful sidebar save must not inherit the rejected mutation');

    await invoke(shell, 'connect-sync', { path: syncFolder });
    const connected = (await inspect(shell, 'state')).settings.syncFolder;
    assert.equal(connected, syncFolder);
    await failWithoutChange('disconnect-sync', {}, settings => assert.equal(settings.syncFolder, connected));
    await invoke(shell, 'disconnect-sync');
    assert.equal((await inspect(shell, 'state')).settings.syncFolder, '', 'a successful disconnect after the failure must persist cleanly');
  } finally {
    await close(instance);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(syncFolder, { recursive: true, force: true });
  }
});

test('reinstalling a disabled store extension keeps the old package on cancel, bad signatures, load and write failures', { timeout: 90000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-reinstall-'));
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-reinstall-build-'));
  const keys = crxFixture.generateKeyPair(), storeID = keys.id;
  const pack = (version, content, extra = {}) => {
    const dir = path.join(build, 'ext-' + version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Reinstall Fixture', version, action: { default_title: 'Fixture' }, content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'] }], ...extra }));
    fs.writeFileSync(path.join(dir, 'cs.js'), `document.documentElement.dataset.arcoExt = chrome.runtime.id + ':${content}';`);
    const zip = path.join(build, 'pack-' + version + '.zip');
    execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], { cwd: dir });
    return fs.readFileSync(zip);
  };
  let payload = crxFixture.signedCRX3(pack('1.0.0', 'v1'), keys);
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/page')) { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end('<title>Extension Page</title><p>page</p>'); }
    response.writeHead(200); response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const failureMarker = path.join(profile, 'fail-library-write'), cleanupMarker = path.join(profile, 'fail-backup-cleanup');
  const launchEnv = { ARCO_CRX_ORIGIN: origin, ARCO_FAIL_LIBRARY_WRITE: failureMarker, ARCO_FAIL_BACKUP_CLEANUP: cleanupMarker };
  let instance = null;
  try {
    const launched = await launch(profile, launchEnv);
    instance = launched.app;
    const shell = launched.shell;
    const installedPath = path.join(profile, 'Extensions', storeID);
    const hashOf = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const first = await invoke(shell, 'install-extension-store', { input: storeID });
    assert.equal(first.version, '1.0.0');
    assert.equal(first.enabled, true);
    assert.equal(first.id, storeID, 'a signed package without manifest.key must load under the requested id');
    assert.equal(JSON.parse(fs.readFileSync(path.join(installedPath, 'manifest.json'), 'utf8')).key, keys.publicKey.toString('base64'), 'the authenticated developer key must be written');
    const v1Hash = hashOf(path.join(installedPath, 'cs.js'));
    // 停用记录写盘失败：内存记录、运行态和重启状态都必须保持启用。
    fs.writeFileSync(failureMarker, '1');
    await assert.rejects(() => invoke(shell, 'extension-toggle', { id: first.id, enabled: false }), /disk unavailable/);
    fs.rmSync(failureMarker);
    let state = await inspect(shell, 'state');
    assert.equal(state.settings.extensions[0].enabled, true);
    assert.equal((await invoke(shell, 'extension-list')).find(item => item.id === storeID).enabled, true);
    await invoke(shell, 'extension-toggle', { id: first.id, enabled: false });
    assert.equal((await inspect(shell, 'state')).settings.extensions[0].enabled, false);
    // 坏签名：拒绝且旧包、旧记录、停用状态都不变。
    const bad = Buffer.from(payload); bad[bad.length - 1] ^= 0xff;
    payload = bad;
    await assert.rejects(() => invoke(shell, 'install-extension-store', { input: storeID }), /签名校验失败/);
    assert.equal(hashOf(path.join(installedPath, 'cs.js')), v1Hash);
    state = await inspect(shell, 'state');
    assert.equal(state.settings.extensions.length, 1);
    assert.equal(state.settings.extensions[0].enabled, false);
    assert.deepEqual(fs.readdirSync(path.join(profile, 'Extensions')), [storeID], 'no staging or backup leftovers');
    // 正确的新版本：替换文件但保留停用状态。
    payload = crxFixture.signedCRX3(pack('2.0.0', 'v2'), keys);
    const second = await invoke(shell, 'install-extension-store', { input: storeID });
    assert.equal(second.version, '2.0.0');
    assert.equal(second.id, storeID);
    assert.equal(second.reinstalled, true);
    assert.equal(second.enabled, false);
    assert.match(fs.readFileSync(path.join(installedPath, 'cs.js'), 'utf8'), /':v2';$/);
    const v2Hash = hashOf(path.join(installedPath, 'cs.js'));
    // 取消批准：新包不生效，旧包字节不变。
    payload = crxFixture.signedCRX3(pack('3.0.0', 'v3'), keys);
    await inspect(shell, 'store-approval', { allow: false });
    const cancelled = await invoke(shell, 'install-extension-store', { input: storeID });
    assert.equal(cancelled.cancelled, true);
    assert.equal(hashOf(path.join(installedPath, 'cs.js')), v2Hash);
    assert.deepEqual(fs.readdirSync(path.join(profile, 'Extensions')), [storeID], 'cancel must not leave staging files');
    await inspect(shell, 'store-approval', { allow: true });
    // 真实 Electron 加载失败（manifest 无效）：回滚，旧包、旧记录与停用状态不变。
    payload = crxFixture.signedCRX3(pack('4.0.0', 'v4', { content_security_policy: "script-src 'self'" }), keys);
    await assert.rejects(() => invoke(shell, 'install-extension-store', { input: storeID }), /Invalid value/);
    assert.equal(hashOf(path.join(installedPath, 'cs.js')), v2Hash);
    state = await inspect(shell, 'state');
    assert.equal(state.settings.extensions.length, 1);
    assert.equal(state.settings.extensions[0].enabled, false);
    assert.equal(state.settings.extensions[0].id, storeID);
    assert.deepEqual(fs.readdirSync(path.join(profile, 'Extensions')), [storeID], 'a failed load must not leave staging or backup files');
    // 最终 Library 写盘失败：回滚，旧包、旧记录与后续重开都保持。
    payload = crxFixture.signedCRX3(pack('5.0.0', 'v5'), keys);
    fs.writeFileSync(failureMarker, '1');
    await assert.rejects(() => invoke(shell, 'install-extension-store', { input: storeID }), /disk unavailable/);
    fs.rmSync(failureMarker);
    assert.equal(hashOf(path.join(installedPath, 'cs.js')), v2Hash);
    state = await inspect(shell, 'state');
    assert.equal(state.settings.extensions.length, 1);
    assert.equal(state.settings.extensions[0].enabled, false);
    assert.deepEqual(fs.readdirSync(path.join(profile, 'Extensions')), [storeID], 'a failed library write must not leave staging or backup files');
    // 成功提交后旧备份清理失败：保留备份并给出可读提示，不回滚、不删除有效新包。
    payload = crxFixture.signedCRX3(pack('6.0.0', 'v6'), keys);
    fs.writeFileSync(cleanupMarker, '1');
    const committed = await invoke(shell, 'install-extension-store', { input: storeID });
    fs.rmSync(cleanupMarker);
    assert.equal(committed.version, '6.0.0');
    assert.equal(committed.id, storeID);
    assert.match(fs.readFileSync(path.join(installedPath, 'cs.js'), 'utf8'), /':v6';$/);
    state = await inspect(shell, 'state');
    assert.match(state.warning, /备份清理失败/);
    assert(fs.readdirSync(path.join(profile, 'Extensions')).some(name => name.includes('.backup-')), 'the old backup is kept when cleanup fails');
    // 重新启用证明替换后的包真的能加载，且页面里 chrome.runtime.id 等于请求 ID。
    const list = await invoke(shell, 'extension-toggle', { id: committed.id, enabled: true });
    assert.equal(list.find(item => item.id === storeID).enabled, true);
    // 删除记录写盘失败时，尚未卸载运行态，也不能删除已安装包。
    fs.writeFileSync(failureMarker, '1');
    await assert.rejects(() => invoke(shell, 'remove-extension', { id: committed.id }), /disk unavailable/);
    fs.rmSync(failureMarker);
    assert.equal((await invoke(shell, 'extension-list')).find(item => item.id === storeID).enabled, true);
    assert.match(fs.readFileSync(path.join(installedPath, 'cs.js'), 'utf8'), /':v6';$/);
    assert.equal((await inspect(shell, 'state')).settings.extensions.some(item => item.id === storeID), true);
    await invoke(shell, 'new-tab', { url: origin + '/page' });
    await assertEventually(async () => (await inspect(shell, 'state')).tabs.some(tab => tab.url === origin + '/page'), 'extension page');
    const pageTab = (await inspect(shell, 'state')).tabs.find(tab => tab.url === origin + '/page');
    await assertEventually(async () => (await inspect(shell, 'evaluate', { id: pageTab.id, script: 'document.documentElement.dataset.arcoExt' })) === storeID + ':v6', 'chrome.runtime.id in the page');
    // 重启后身份与状态保持。
    await close(instance); instance = null;
    const again = await launch(profile, launchEnv);
    instance = again.app;
    const restartedList = await invoke(again.shell, 'extension-list');
    assert.equal(restartedList.length, 1);
    assert.equal(restartedList[0].id, storeID);
    assert.equal(restartedList[0].enabled, true);
    await invoke(again.shell, 'extension-toggle', { id: storeID, enabled: false });
    assert.equal((await invoke(again.shell, 'extension-list'))[0].enabled, false);
    await invoke(again.shell, 'extension-toggle', { id: storeID, enabled: true });
    assert.equal((await invoke(again.shell, 'extension-list'))[0].enabled, true);
  } finally {
    await close(instance);
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(build, { recursive: true, force: true });
  }
});

test('downloads save without a blocking dialog, pause and resume, and never persist private metadata', { timeout: 90000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-downloads-'));
  const server = http.createServer((request, response) => {
    const url = request.url.split('?')[0];
    if (url === '/file.txt') { response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="arco-file.txt"' }); return response.end('download fixture'); }
    if (url === '/private.txt') { response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="arco-private.txt"' }); return response.end('private fixture'); }
    if (url === '/slow.bin') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="arco-slow.bin"', 'Content-Length': String(10 * 1024) });
      let sent = 0;
      const timer = setInterval(() => { if (sent >= 10) { clearInterval(timer); response.end(); return; } response.write(Buffer.alloc(1024, 65)); sent++; }, 150);
      request.on('close', () => clearInterval(timer));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<title>Downloads</title><p>downloads</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloadsFile = path.join(profile, 'Downloads.json');
  const downloadDir = path.join(profile, 'Downloads');
  let first = null, second = null;
  try {
    first = await launch(profile);
    await invoke(first.shell, 'new-tab', { url: origin + '/file.txt' });
    await assertEventually(async () => (await inspect(first.shell, 'state')).downloads.some(item => item.filename === 'arco-file.txt' && item.state === 'completed'), 'completed download');
    let state = await inspect(first.shell, 'state');
    const record = state.downloads.find(item => item.filename === 'arco-file.txt');
    assert(record.path.startsWith(downloadDir + path.sep), 'downloads must land in the app download directory: ' + record.path);
    assert.equal(fs.readFileSync(record.path, 'utf8'), 'download fixture');
    // 同名下载不覆盖已有文件。
    await invoke(first.shell, 'new-tab', { url: origin + '/file.txt' });
    await assertEventually(async () => (await inspect(first.shell, 'state')).downloads.filter(item => item.filename === 'arco-file.txt' && item.state === 'completed').length === 2, 'second download');
    state = await inspect(first.shell, 'state');
    const paths = state.downloads.filter(item => item.filename === 'arco-file.txt').map(item => item.path);
    assert.equal(new Set(paths).size, 2, 'same-name downloads must not overwrite each other');
    assert(paths.some(item => / \(1\)\.txt$/.test(item)));
    // 暂停/恢复：暂停后进度不再增长，恢复后完成。
    await invoke(first.shell, 'new-tab', { url: origin + '/slow.bin' });
    await assertEventually(async () => (await inspect(first.shell, 'state')).downloads.some(item => item.filename === 'arco-slow.bin' && item.state === 'progressing'), 'slow download starts');
    state = await inspect(first.shell, 'state');
    const slow = state.downloads.find(item => item.filename === 'arco-slow.bin');
    await invoke(first.shell, 'download-pause', { id: slow.id });
    await assertEventually(async () => (await inspect(first.shell, 'state')).downloads.find(item => item.id === slow.id)?.state === 'paused', 'paused state');
    const pausedBytes = (await inspect(first.shell, 'state')).downloads.find(item => item.id === slow.id).received;
    await sleep(400);
    assert.equal((await inspect(first.shell, 'state')).downloads.find(item => item.id === slow.id).received, pausedBytes, 'a paused download must not keep receiving bytes');
    await invoke(first.shell, 'download-resume', { id: slow.id });
    await assertEventually(async () => (await inspect(first.shell, 'state')).downloads.find(item => item.id === slow.id)?.state === 'completed', 'resumed download completes');
    const slowRecord = (await inspect(first.shell, 'state')).downloads.find(item => item.id === slow.id);
    assert.equal(fs.statSync(slowRecord.path).size, 10 * 1024);
    // 真实界面：面板一直打开，暂停→出现继续→恢复→完成，进度文字会更新。
    await first.shell.click('[data-action="downloads"]');
    await first.shell.locator('#download-list').waitFor({ state: 'visible' });
    await invoke(first.shell, 'new-tab', { url: origin + '/slow.bin' });
    await assertEventually(async () => (await first.shell.locator('[data-download-pause]').count()) > 0, 'pause button');
    const progressBefore = await first.shell.locator('#download-list [data-download-progress]').first().textContent();
    await assertEventually(async () => (await first.shell.locator('#download-list [data-download-progress]').first().textContent()) !== progressBefore, 'progress text update');
    await first.shell.locator('[data-download-pause]').first().click();
    await first.shell.locator('[data-download-resume]').first().waitFor({ state: 'visible' });
    assert.equal(await first.shell.locator('#overlay-root').isVisible(), true, 'the downloads panel stays open while pausing');
    await first.shell.locator('[data-download-resume]').first().click();
    await assertEventually(async () => (await first.shell.locator('#download-list').textContent()).includes('已完成'), 'completed row');
    assert.equal(await first.shell.locator('#overlay-root').isVisible(), true, 'the downloads panel stays open until it is closed');
    await first.shell.keyboard.press('Escape');
    await assertEventually(async () => !(await first.shell.locator('#overlay-root').isVisible()), 'panel closed');
    // 无痕下载只留在内存，不写 Downloads.json。
    await invoke(first.shell, 'private-window');
    let privateShell = null;
    await assertEventually(async () => { privateShell = (await first.app.windows()).find(page => page !== first.shell && /shell\.html$/.test(page.url())); return !!privateShell; }, 'private window');
    await privateShell.waitForFunction(() => !!window.arco);
    await invoke(first.shell, 'navigate', { input: origin + '/private.txt' }, privateShell);
    await assertEventually(async () => (await inspect(first.shell, 'state', {}, privateShell)).downloads.some(item => item.filename === 'arco-private.txt' && item.state === 'completed'), 'private download');
    const persisted = fs.existsSync(downloadsFile) ? fs.readFileSync(downloadsFile, 'utf8') : '';
    assert.equal(persisted.includes('arco-private.txt'), false, 'private downloads must not be persisted');
    assert.equal(persisted.includes('arco-file.txt'), true, 'normal downloads are persisted');
    // 退出整个应用（含无痕窗口）后重启：普通下载历史仍在，无痕下载不会出现，也不会声称可继续传输。
    await close(first.app); first = null;
    second = await launch(profile);
    await assertEventually(async () => (await inspect(second.shell, 'state')).downloads.some(item => item.filename === 'arco-file.txt' && item.state === 'completed'), 'restored download history');
    const restored = (await inspect(second.shell, 'state')).downloads;
    assert.equal(restored.some(item => item.filename === 'arco-private.txt'), false, 'private downloads stay out of restored history');
    assert.equal(restored.some(item => item.state === 'progressing' || item.state === 'paused'), false, 'restart must not claim a resumable in-flight or paused download');
  } finally {
    await close(first?.app);
    await close(second?.app);
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('a download that cannot initialise leaves no false in-progress record and recovers', { timeout: 60000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-download-init-'));
  const sentinel = Buffer.from('sentinel bytes must survive');
  fs.writeFileSync(path.join(profile, 'Downloads'), sentinel);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="arco-init.txt"' });
    response.end('download fixture');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloadsFile = path.join(profile, 'Downloads.json');
  let instance = null;
  try {
    const launched = await launch(profile);
    instance = launched.app;
    await invoke(launched.shell, 'new-tab', { url: origin + '/file.txt' });
    await assertEventually(async () => (await inspect(launched.shell, 'state')).downloads.some(item => item.filename === 'arco-init.txt'), 'failed download record');
    const failed = (await inspect(launched.shell, 'state')).downloads;
    assert.equal(failed.some(item => ['progressing', 'paused'].includes(item.state)), false, 'a failed initialisation must not stay in progress');
    assert.equal(failed.find(item => item.filename === 'arco-init.txt').state, 'interrupted');
    assert.deepEqual(fs.readFileSync(path.join(profile, 'Downloads')), sentinel, 'the sentinel file must not be modified');
    const persisted = fs.existsSync(downloadsFile) ? JSON.parse(fs.readFileSync(downloadsFile, 'utf8')) : [];
    assert.equal(persisted.some(item => ['progressing', 'paused'].includes(item.state)), false, 'persisted records must be terminal');
    // 修好目录后同名下载正常，且没有残留的保留名。
    fs.rmSync(path.join(profile, 'Downloads'));
    await invoke(launched.shell, 'new-tab', { url: origin + '/file.txt' });
    await assertEventually(async () => (await inspect(launched.shell, 'state')).downloads.some(item => item.filename === 'arco-init.txt' && item.state === 'completed'), 'recovered download');
    const completed = (await inspect(launched.shell, 'state')).downloads.find(item => item.filename === 'arco-init.txt' && item.state === 'completed');
    assert.equal(path.basename(completed.path), 'arco-init.txt', 'the reserved name must be released after the failure');
    assert.equal(fs.readFileSync(completed.path, 'utf8'), 'download fixture');
  } finally {
    await close(instance);
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('proxy authentication uses the real login UI, cancels independently and stays per session', { timeout: 90000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-proxy-'));
  const attempts = [];
  const makeProxy = realm => http.createServer((request, response) => {
    const header = String(request.headers['proxy-authorization'] || '');
    const decoded = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : '';
    attempts.push({ realm, decoded });
    if (decoded !== 'proxy-user:proxy-secret') {
      response.writeHead(407, { 'Proxy-Authenticate': `Basic realm="${realm}"`, 'Content-Type': 'text/html; charset=utf-8' });
      return response.end('<title>Proxy Auth</title><h1>Proxy authentication required</h1>');
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<title>Proxy Authenticated</title><h1>Proxy authenticated</h1>');
  });
  const proxy = makeProxy('Arco proxy'), cancelProxy = makeProxy('Arco proxy cancel');
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => cancelProxy.listen(0, '127.0.0.1', resolve));
  const proxyRules = `http=127.0.0.1:${proxy.address().port}`, cancelRules = `http=127.0.0.1:${cancelProxy.address().port}`;
  let instance = null;
  try {
    const launched = await launch(profile);
    instance = launched.app;
    const shell = launched.shell;
    const setProxy = rules => instance.evaluate(({ webContents }, value) => { for (const wc of webContents.getAllWebContents()) { try { wc.session.setProxy({ proxyRules: value }); } catch {} } }, rules);
    await setProxy(proxyRules);
    const navigation = invoke(shell, 'navigate', { input: 'http://arco-proxy.test/page' }).catch(() => null);
    await shell.locator('#http-auth-form').waitFor({ state: 'visible' });
    assert.match(await shell.locator('#http-auth-panel').textContent(), /代理/);
    await shell.locator('#http-auth-form [name="username"]').fill('proxy-user');
    await shell.locator('#http-auth-form [name="password"]').fill('proxy-secret');
    await shell.getByRole('button', { name: '登录', exact: true }).click();
    await navigation;
    await assertEventually(async () => (await inspect(shell, 'evaluate', { script: 'document.title' })) === 'Proxy Authenticated', 'authenticated through the proxy');
    assert(attempts.some(item => item.realm === 'Arco proxy' && item.decoded === 'proxy-user:proxy-secret'), 'the proxy must receive the submitted credentials');
    // 取消分支：不会发出凭据，页面停在 407。
    await setProxy(cancelRules);
    const cancelling = invoke(shell, 'navigate', { input: 'http://arco-proxy-cancel.test/page' }).catch(() => null);
    await shell.locator('#http-auth-form').waitFor({ state: 'visible' });
    await shell.getByRole('button', { name: '取消', exact: true }).click();
    await cancelling;
    assert.equal(attempts.some(item => item.realm === 'Arco proxy cancel' && item.decoded), false, 'cancel must not send proxy credentials');
    await assertEventually(async () => (await inspect(shell, 'evaluate', { script: 'document.title' })) === 'Proxy Auth', 'cancelled proxy page');
    // 独立 session：无痕窗口不复用普通窗口的代理凭据。
    await invoke(shell, 'private-window');
    let privateShell = null;
    await assertEventually(async () => { privateShell = (await instance.windows()).find(page => page !== shell && /shell\.html$/.test(page.url())); return !!privateShell; }, 'private window');
    await privateShell.waitForFunction(() => !!window.arco);
    await setProxy(proxyRules);
    const before = attempts.filter(item => item.realm === 'Arco proxy').length;
    const privateNavigation = invoke(shell, 'navigate', { input: 'http://arco-proxy.test/private' }, privateShell).catch(() => null);
    await privateShell.locator('#http-auth-form').waitFor({ state: 'visible' });
    await privateShell.getByRole('button', { name: '取消', exact: true }).click();
    await privateNavigation;
    await assertEventually(async () => attempts.filter(item => item.realm === 'Arco proxy').length > before, 'the private session must be challenged separately');
    assert.equal(attempts.some(item => item.realm === 'Arco proxy cancel' && item.decoded), false);
    // 普通窗口已认证的代理凭据仍在该 session 内有效。
    await invoke(shell, 'navigate', { input: 'http://arco-proxy.test/again' });
    await assertEventually(async () => (await inspect(shell, 'evaluate', { script: 'document.title' })) === 'Proxy Authenticated', 'normal session keeps its proxy credentials');
  } finally {
    await close(instance);
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => cancelProxy.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
