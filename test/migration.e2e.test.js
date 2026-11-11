'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { _electron: electron } = require('playwright');

test('browser migration UI imports cookies and Apple password CSV, preserves existing data and persists cookies', { timeout: 60000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-migration-ui-'));
  const home = path.join(scratch, 'home'), profile = path.join(scratch, 'arco');
  const chrome = path.join(home, 'Library/Application Support/Google/Chrome/Default');
  fs.mkdirSync(chrome, { recursive: true });
  const db = new DatabaseSync(path.join(chrome, 'Cookies'));
  db.exec("CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc REAL, has_expires INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)");
  db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 1)').run('migration.example.test', 'imported-session', 'fixture-cookie', Buffer.alloc(0), '/', (Date.now() / 1000 + 11644473600 + 3600) * 1e6); db.close();
  const csv = path.join(scratch, 'Apple-passwords.csv');
  fs.writeFileSync(csv, 'Title,URL,Username,Password,Notes,OTPAuth\nApple,https://migration.example.test,alice,"  fixture-pass  ",,');
  let app, page;
  const invoke = (channel, payload = {}) => page.evaluate(({ channel, payload }) => window.arco.invoke('arco:invoke', { channel, payload }), { channel, payload });
  const cookieList = () => app.evaluate(({ session }) => session.fromPartition('persist:arco').cookies.get({ domain: 'migration.example.test' }));
  async function launch() {
    app = await electron.launch({ args: [path.join(__dirname, '..'), '--use-mock-keychain'], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile, ARCO_BROWSER_HOME: home }, timeout: 15000 });
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !!window.arco && !!document.querySelector('#space-name')?.textContent);
  }
  async function close() {
    if (!app) return;
    const child = app.process();
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2500))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    app = null;
  }
  t.after(async () => { await close(); fs.rmSync(scratch, { recursive: true, force: true }); });
  await launch();
  await page.locator('[data-action="onboard-next"]').click();
  const source = page.locator('[data-migration-profile="chrome:Default"]');
  await source.waitFor();
  assert.equal(await source.locator('[data-import-browser]').count(), 0, 'cookie-only profile remains visible');
  assert.match(await page.locator('#onboard-sources').textContent(), /Safari Cookie 暂不支持/);
  await page.locator('[data-action="refresh-browsers"]').click(); await source.waitFor();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  assert.equal(await invoke('migrate-browser-data', { id: 'chrome:Default', choices: ['cookies'] }), null);
  assert.equal((await cookieList()).length, 0);
  await app.evaluate(({ dialog }, csvFile) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [csvFile] });
  }, csv);
  await source.locator('[data-migrate-kind="passwords"]').uncheck();
  await source.locator('[data-migrate-kind="cookies"]').check();
  await source.locator('[data-migrate-browser]').click();
  await source.locator('[role="status"]').filter({ hasText: '导入 1' }).waitFor();
  const cookies = await cookieList();
  assert.equal(cookies.length, 1); assert.equal(cookies[0].value, 'fixture-cookie'); assert.equal(cookies[0].hostOnly, true); assert.equal(cookies[0].httpOnly, true); assert.equal(cookies[0].sameSite, 'lax');
  await source.locator('[data-migrate-kind="passwords"]').uncheck();
  await source.locator('[data-migrate-kind="cookies"]').check();
  await source.locator('[data-migrate-browser]').click();
  await source.locator('[role="status"]').filter({ hasText: '跳过 1' }).waitFor();
  await page.locator('#onboard-sources [data-action="import-passwords"]').click();
  await page.locator('#toast').filter({ hasText: '已导入 1 条密码' }).waitFor();
  const credentials = await invoke('credentials'); assert.equal(credentials.length, 1);
  assert.equal((await invoke('credential-read', { id: credentials[0].id })).password, '  fixture-pass  ');
  assert.deepEqual(await invoke('import-passwords'), { imported: 0, skipped: 1 });
  await invoke('private-window');
  let privatePage;
  for (let i = 0; i < 100 && !privatePage; i++) {
    privatePage = (await app.windows()).find(item => item !== page && /shell\.html$/.test(item.url()));
    if (!privatePage) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(privatePage); await privatePage.waitForFunction(() => !!window.arco);
  await assert.rejects(privatePage.evaluate(() => window.arco.invoke('arco:invoke', { channel: 'migrate-browser-data', payload: { id: 'chrome:Default', choices: ['cookies'] } })), /无痕窗口/);
  await assert.rejects(privatePage.evaluate(() => window.arco.invoke('arco:invoke', { channel: 'import-passwords' })), /无痕窗口/);
  await privatePage.close();
  await page.locator('[data-action="onboard-skip"]').click();
  await close();
  await launch();
  assert.equal((await cookieList())[0].value, 'fixture-cookie');
  await page.evaluate(() => showModal('settings', { section: 'bookmarks' }));
  await page.locator('#browser-sources [data-migrate-browser]').waitFor();
});
