'use strict';
// Zigzag 对齐项回归：系统外链、页面右键菜单、按范围清历史、按站清数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright');
const root = path.join(__dirname, '..');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label) {
  for (let i = 0; i < 160; i++) { if (await check()) return; await sleep(50); }
  throw new Error('Timed out waiting for ' + label);
}
const invoke = (shell, channel, payload = {}) => shell.evaluate(({ channel, payload }) => window.arco.invoke('arco:invoke', { channel, payload }), { channel, payload });
const inspect = (shell, action, payload = {}) => shell.evaluate(({ action, payload }) => window.arco.invoke('arco:test', { action, payload }), { action, payload });

test('external links, page menu, history ranges and per-site data', { timeout: 90000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-parity-'));
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<title>${req.url}</title><a href="/linked">link</a>`); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, a = `http://localhost:${port}`, b = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile };
  let app;
  try {
    // 冷启动：命令行里的网址在窗口就绪后打开。
    app = await electron.launch({ args: [root, a + '/cold'], env, timeout: 15000 });
    let shell = null;
    for (let i = 0; i < 200 && !shell; i++) { shell = (await app.windows()).find(page => /shell\.html$/.test(page.url())); if (!shell) await sleep(50); }
    assert(shell, 'shell must be present');
    await shell.waitForFunction(() => !!window.arco && !!document.querySelector('#space-name')?.textContent);
    if (await shell.waitForSelector('[data-onboarding]', { timeout: 3000 }).catch(() => null)) await shell.click('[data-action="onboard-skip"]');
    const state = () => inspect(shell, 'state');
    const tabAt = async url => (await state()).tabs.find(tab => tab.url === url);
    await eventually(async () => (await tabAt(a + '/cold')) && (await state()).activeID === (await tabAt(a + '/cold')).id, 'cold-start link');

    // 热启动：第二个实例把网址交给已运行的实例后退出，非 http 参数被忽略。
    const second = spawn(require('electron'), [root, b + '/warm', 'file:///etc/passwd'], { env, stdio: 'ignore' });
    await new Promise(resolve => second.once('exit', resolve));
    await eventually(() => tabAt(b + '/warm'), 'second-instance link');
    assert(!(await state()).tabs.some(tab => tab.url.startsWith('file:')), 'only web links are accepted');

    // 右键菜单：链接、选中文字、可编辑区域按 params 给出对应动作，检查元素在最后。
    const cold = (await tabAt(a + '/cold')).id;
    const link = await inspect(shell, 'page-menu', { id: cold, params: { linkURL: a + '/linked', selectionText: 'hello', editFlags: {} } });
    for (const label of ['在新标签页打开链接', '在 Peek 中预览', '在无痕窗口中打开链接', '复制链接地址', '复制', '后退', '前进', '重新加载']) assert(link.includes(label), label);
    assert(link.some(label => /^用 .+ 搜索“hello”$/.test(label)), 'search selection');
    assert.equal(link.at(-1), '检查元素');
    const editable = await inspect(shell, 'page-menu', { id: cold, params: { isEditable: true, editFlags: { canPaste: true } } });
    for (const label of ['剪切', '复制', '粘贴', '全选']) assert(editable.includes(label), label);
    const media = await inspect(shell, 'page-menu', { id: cold, params: { mediaType: 'video', srcURL: a + '/v.mp4' } });
    for (const label of ['在新标签页打开视频', '下载视频', '复制视频地址', '画中画']) assert(media.includes(label), label);
    assert(!media.includes('复制图像'));
    await inspect(shell, 'page-menu', { id: cold, params: { linkURL: a + '/linked' }, click: '在无痕窗口中打开链接' });
    await eventually(async () => (await inspect(shell, 'windows')).some(win => win.private), 'private window from link');
    await inspect(shell, 'page-menu', { id: cold, params: { linkURL: a + '/linked' }, click: '在新标签页打开链接' });
    await eventually(() => tabAt(a + '/linked'), 'link in new tab');

    // 按站清数据：只清当前网站，另一个来源的存储和 Cookie 保留。
    const warm = (await tabAt(b + '/warm')).id;
    const seed = `localStorage.setItem('k','v');document.cookie='c=1;path=/;max-age=3600';true`;
    const read = `JSON.stringify([localStorage.getItem('k'),document.cookie])`;
    for (const id of [cold, warm]) { await inspect(shell, 'evaluate', { id, script: seed }); assert.equal(await inspect(shell, 'evaluate', { id, script: read }), '["v","c=1"]'); }
    await invoke(shell, 'select-tab', { id: cold });
    await invoke(shell, 'clear-site-data');
    await eventually(async () => (await inspect(shell, 'evaluate', { id: cold, script: read }).catch(() => '')) === '[null,""]', 'site data cleared');
    assert.equal(await inspect(shell, 'evaluate', { id: warm, script: read }), '["v","c=1"]', 'other sites keep their data');

    // 按范围清历史：写盘后发布，无效范围拒绝，已关闭标签页不能把网址带回来。
    await eventually(async () => (await state()).history.length >= 3, 'history recorded');
    await assert.rejects(invoke(shell, 'history-clear', { range: 'bogus' }));
    await invoke(shell, 'close-tab', { id: (await tabAt(a + '/linked')).id });
    await invoke(shell, 'history-clear', { range: 'hour' });
    assert.deepEqual((await state()).history, []);
    const files = fs.readdirSync(profile).filter(name => /history/i.test(name));
    assert(files.length, 'history file exists');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, files[0]), 'utf8')), []);
    const before = (await state()).tabs.length;
    await invoke(shell, 'reopen-tab');
    assert.equal((await state()).tabs.length, before, 'closed tabs are forgotten with the history');
  } finally {
    if (app) { const child = app.process(); await Promise.race([app.close().catch(() => {}), sleep(2500)]); if (child.exitCode === null) child.kill('SIGKILL'); }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
