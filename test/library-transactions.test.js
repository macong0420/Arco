'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const core = require('../src/core');

// Exercise the real persistence code; only the Electron process boundary is substituted.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-transactions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'a'.repeat(32), folder = path.join(root, 'Extensions', id), loaded = new Map();
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture', version: '1.0' }));
  const extensions = {
    getExtension: id => loaded.get(id), getAllExtensions: () => [...loaded.values()],
    async loadExtension(directory) { const extension = { id, path: directory, name: 'Fixture', version: '1.0' }; loaded.set(id, extension); return extension; },
    removeExtension: id => loaded.delete(id)
  };
  const filename = path.join(__dirname, '../src/library.js'), localRequire = createRequire(filename), module = { exports: {} };
  vm.runInThisContext(`(function(require, module, exports, __dirname) { ${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    name => name === 'electron' ? { session: { fromPartition: () => ({ extensions }) } } : localRequire(name), module, module.exports, path.dirname(filename)
  );
  let notifications = 0;
  const library = new module.exports(root, () => { notifications++; });
  library.updateSettings(settings => { settings.extensions = [{ id, storeID: id, path: folder, enabled: true }]; });
  loaded.set(id, { id, path: folder, name: 'Fixture' });
  const snapshot = () => ({ data: structuredClone(library.data), bytes: fs.readFileSync(library.file), notifications });
  const unchanged = before => {
    assert.deepEqual(library.data, before.data); assert.deepEqual(library.settings, before.data.settings);
    assert.deepEqual(fs.readFileSync(library.file), before.bytes); assert.equal(notifications, before.notifications);
  };
  const failWrite = () => t.mock.method(core, 'atomicWrite', () => { throw new Error('disk unavailable'); });
  return { root, id, folder, loaded, extensions, library, snapshot, unchanged, failWrite };
}

test('settings write failure publishes nothing and a later save excludes the rejected mutation', t => {
  const f = fixture(t), before = f.snapshot();
  f.failWrite();
  assert.throws(() => f.library.updateSettings(settings => { settings.theme = 'dark'; settings.sidebarWidth = 333; settings.syncFolder = '/failed'; }), /disk unavailable/);
  f.unchanged(before); t.mock.restoreAll();
  f.library.updateSettings(settings => { settings.theme = 'light'; });
  const saved = JSON.parse(fs.readFileSync(f.library.file));
  assert.equal(saved.settings.theme, 'light'); assert.equal(saved.settings.sidebarWidth, before.data.settings.sidebarWidth);
  assert.equal(saved.settings.syncFolder, before.data.settings.syncFolder);
});

test('extension toggle write failures preserve the loaded instance and the disabled record', async t => {
  const f = fixture(t), before = f.snapshot();
  f.failWrite();
  await assert.rejects(f.library.setExtensionEnabled(f.id, false), /disk unavailable/);
  f.unchanged(before); assert(f.loaded.has(f.id)); assert.equal(f.library.installingExtensions, false);
  t.mock.restoreAll(); await f.library.setExtensionEnabled(f.id, false);
  const disabled = f.snapshot(); assert.equal(f.loaded.has(f.id), false);
  f.failWrite(); await assert.rejects(f.library.setExtensionEnabled(f.id, true), /disk unavailable/);
  f.unchanged(disabled); assert.equal(f.loaded.has(f.id), false); assert.equal(f.library.installingExtensions, false);
  t.mock.restoreAll(); await f.library.setExtensionEnabled(f.id, true);
  assert(f.loaded.has(f.id)); assert.equal(f.library.settings.extensions[0].enabled, true);
});

test('extension deletion keeps the package and running instance until its record commits', async t => {
  const f = fixture(t), before = f.snapshot(), manifest = fs.readFileSync(path.join(f.folder, 'manifest.json'));
  f.failWrite(); await assert.rejects(f.library.removeExtension(f.id), /disk unavailable/);
  f.unchanged(before); assert(f.loaded.has(f.id)); assert.deepEqual(fs.readFileSync(path.join(f.folder, 'manifest.json')), manifest);
  assert.equal(f.library.installingExtensions, false); t.mock.restoreAll();
  await f.library.removeExtension(f.id);
  assert.equal(f.loaded.has(f.id), false); assert.equal(fs.existsSync(f.folder), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.library.file)).settings.extensions, []);
});

test('post-commit extension cleanup failure leaves an explicit warning and the committed removal', async t => {
  const f = fixture(t), remove = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, ...args) => { if (target === f.folder) throw new Error('cleanup unavailable'); return remove(target, ...args); });
  await f.library.removeExtension(f.id);
  assert.equal(f.loaded.has(f.id), false); assert.equal(fs.existsSync(f.folder), true);
  assert.match(f.library.warning, /清理失败/);
  assert.deepEqual(f.library.settings.extensions, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.library.file)).settings.extensions, []);
  t.mock.restoreAll();
});

test('failed local extension registration unloads only its new instance and keeps the user folder', async t => {
  const f = fixture(t);
  f.library.updateSettings(settings => { settings.extensions = []; }); f.loaded.clear();
  f.library.choose = async () => f.folder;
  const before = f.snapshot(); f.failWrite();
  await assert.rejects(f.library.addExtension(), /disk unavailable/);
  f.unchanged(before); assert.equal(f.loaded.has(f.id), false); assert.equal(fs.existsSync(f.folder), true);
  assert.equal(f.library.installingExtensions, false);
});

test('extension mutations reject overlapping installs and release their guard after validation failure', async t => {
  const f = fixture(t); f.library.installingExtensions = true;
  await assert.rejects(f.library.setExtensionEnabled(f.id, false), /正在安装/);
  await assert.rejects(f.library.addExtension(), /正在安装/);
  f.library.installingExtensions = false;
  await assert.rejects(f.library.setExtensionEnabled('missing', false), /不存在/);
  assert.equal(f.library.installingExtensions, false);
});

test('sync final local write failure does not publish merged bookmarks or a new status', async t => {
  const f = fixture(t), cloud = path.join(f.root, 'cloud'); fs.mkdirSync(cloud);
  f.library.updateSettings(settings => { settings.syncFolder = cloud; });
  const remote = structuredClone(f.library.data);
  remote.spaces[0].bookmarks.push(core.stamp({ id: 'remote', title: 'Remote', url: 'https://remote.test/', parentID: null }));
  fs.mkdirSync(path.join(cloud, 'Arco-Library'));
  fs.writeFileSync(path.join(cloud, 'Arco-Library', 'remote.json'), JSON.stringify(remote));
  const before = f.snapshot(), write = core.atomicWrite;
  t.mock.method(core, 'atomicWrite', (file, ...args) => { if (file === f.library.file) throw new Error('disk unavailable'); return write(file, ...args); });
  await assert.rejects(f.library.syncNow(), /disk unavailable/);
  f.unchanged(before); assert.equal(f.library.syncing, false); t.mock.restoreAll();
  await f.library.syncNow(); assert(f.library.space('personal').bookmarks.some(item => item.id === 'remote'));
  assert.match(f.library.settings.syncStatus, /上次同步/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.library.file)).settings, f.library.settings);
});
