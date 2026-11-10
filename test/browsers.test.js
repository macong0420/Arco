'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/core');
const browsers = require('../src/browsers');
const Library = require('../src/library');

function fakeHome(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-browsers-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); }
const support = (home, name) => path.join(home, 'Library', 'Application Support', name);

const safariPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Children</key><array>
  <dict><key>Title</key><string>历史记录</string><key>WebBookmarkIdentifier</key><string>History</string><key>WebBookmarkType</key><string>WebBookmarkTypeProxy</string></dict>
  <dict><key>Children</key><array>
    <dict><key>URIDictionary</key><dict><key>title</key><string>Root &amp; Page</string></dict><key>URLString</key><string>https://root.test/</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>
    <dict><key>Children</key><array>
      <dict><key>URIDictionary</key><dict><key>title</key><string>Nested</string></dict><key>URLString</key><string>https://nested.test/</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>
    </array><key>Sync</key><dict><key>Data</key><data>AAAA////</data><key>Flag</key><true/><key>Count</key><integer>3</integer></dict><key>Title</key><string>Work</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict>
  </array><key>Title</key><string>BookmarksBar</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict>
  <dict><key>Children</key><array><dict><key>URIDictionary</key><dict><key>title</key><string>Reading</string></dict><key>URLString</key><string>https://read.test/</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict></array><key>Title</key><string>com.apple.ReadingList</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict>
</array><key>Title</key><string></string></dict></plist>`;

test('plist reader handles data blobs, booleans, integers and entities', () => {
  const parsed = core.parsePlistXML(safariPlist);
  const bar = parsed.Children[1];
  assert.equal(bar.Title, 'BookmarksBar');
  assert.deepEqual(bar.Children[1].Sync, { Data: null, Flag: true, Count: 3 });
  assert.equal(bar.Children[0].URIDictionary.title, 'Root & Page');
  assert.equal(parsed.Children[0].WebBookmarkIdentifier, 'History');
  assert.throws(() => core.parsePlistXML('<plist version="1.0"></plist>'), /为空/);
});

test('Safari bookmarks keep user folders and drop top containers and Reading List', () => {
  const items = core.parseSafariBookmarks(safariPlist);
  assert.deepEqual(items.map(x => [x.title, x.url, x.folders]), [
    ['Root & Page', 'https://root.test/', []],
    ['Nested', 'https://nested.test/', ['Work']],
  ]);
});

test('Firefox places tree skips browser roots, tag folders and non-web urls', t => {
  const home = fakeHome(t), dir = support(home, 'Firefox');
  write(path.join(dir, 'profiles.ini'), '[Install4F96]\nDefault=Profiles/abc.default-release\nLocked=1\n\n[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n');
  const profile = path.join(dir, 'Profiles', 'abc.default-release');
  fs.mkdirSync(profile, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(profile, 'places.sqlite'));
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT);
    INSERT INTO moz_places VALUES (1,'https://root.test/'),(2,'https://tagged.test/'),(3,'place:sort=8');
    INSERT INTO moz_bookmarks VALUES (1,2,1,NULL,0,'root'),(2,2,1,1,0,'menu'),(3,2,1,1,1,'toolbar'),(4,2,1,1,2,'unfiled'),(5,2,1,1,3,'mobile'),(6,2,1,1,4,'tags');
    INSERT INTO moz_bookmarks VALUES (10,1,1,3,0,'Root Page'),(11,2,NULL,3,1,'Work'),(12,1,2,11,0,'Tagged Page'),(13,1,3,3,2,'Smart');
    INSERT INTO moz_bookmarks VALUES (14,2,NULL,6,0,'tag1'),(15,1,2,14,0,'Only Tagged');`);
  db.close();
  const found = browsers.detect(home);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'firefox:abc.default-release');
  assert.equal(found[0].count, 2);
  assert.deepEqual(browsers.resolve(found[0].id, home).items.map(x => [x.title, x.folders]), [['Root Page', []], ['Tagged Page', ['Work']]]);
});

test('Chromium profiles come from Local State and Safari reports an unreadable file', t => {
  const home = fakeHome(t), chrome = support(home, 'Google/Chrome');
  write(path.join(chrome, 'Local State'), { profile: { info_cache: { Default: { name: '工作' }, 'Profile 1': { name: '个人' } }, profiles_order: ['Default', 'Profile 1'] } });
  fs.mkdirSync(path.join(chrome, 'Default'), { recursive: true });
  write(path.join(chrome, 'Profile 1', 'Bookmarks'), { roots: { bookmark_bar: { type: 'folder', name: '书签栏', children: [
    { type: 'url', name: 'Example', url: 'https://example.com/' },
    { type: 'folder', name: '阅读', children: [{ type: 'url', name: 'Docs', url: 'https://docs.test/' }] },
  ] } } });
  const found = browsers.detect(home);
  assert.equal(found.length, 2);
  const profile = found.find(x => x.id === 'chrome:Profile 1');
  assert.deepEqual([profile.name, profile.label, profile.count, profile.note], ['Chrome', '个人', 2, '']);
  // 装了浏览器但一条书签也没有：仍要列出来，否则用户会以为没检测到。
  assert.deepEqual(found.find(x => x.id === 'chrome:Default'), { id: 'chrome:Default', name: 'Chrome', label: '工作', kind: 'chromium', count: 0, note: '' });

  write(path.join(home, 'Library', 'Safari', 'Bookmarks.plist'), safariPlist);
  const withSafari = browsers.detect(home);
  const safari = withSafari.find(x => x.id === 'safari');
  assert.equal(safari.count, 2);
  fs.rmSync(path.join(home, 'Library', 'Safari', 'Bookmarks.plist'));
  assert(!browsers.detect(home).some(x => x.id === 'safari'));
});

test('Chrome account bookmarks are read when the profile has no Bookmarks file', t => {
  const home = fakeHome(t), chrome = support(home, 'Google/Chrome');
  write(path.join(chrome, 'Local State'), { profile: { info_cache: { 'Profile 1': { name: 'Leo' } }, profiles_order: ['Profile 1'] } });
  const account = { roots: { bookmark_bar: { type: 'folder', name: '书签栏', children: [
    { type: 'url', name: 'Account One', url: 'https://account.one/' },
    { type: 'folder', name: '工作', children: [{ type: 'url', name: 'Account Two', url: 'https://account.two/' }] },
  ] } } };
  write(path.join(chrome, 'Profile 1', 'AccountBookmarks'), account);
  const [entry] = browsers.detect(home);
  assert.deepEqual([entry.id, entry.count, entry.note], ['chrome:Profile 1', 2, '']);
  assert.deepEqual(browsers.resolve(entry.id, home).items.map(x => [x.title, x.folders]), [['Account One', ['书签栏']], ['Account Two', ['书签栏', '工作']]]);
});

test('blocked reads report a permission hint instead of a raw errno', t => {
  const home = fakeHome(t), chrome = support(home, 'Google/Chrome');
  write(path.join(chrome, 'Local State'), { profile: { info_cache: { Default: { name: '工作' } }, profiles_order: ['Default'] } });
  const file = path.join(chrome, 'Default', 'Bookmarks');
  write(file, { roots: { bookmark_bar: { type: 'folder', name: '书签栏', children: [{ type: 'url', name: 'A', url: 'https://a.test/' }] } } });
  fs.chmodSync(file, 0o000);
  const [entry] = browsers.detect(home);
  assert.equal(entry.count, 0);
  assert.match(entry.note, /macOS 阻止 Arco 读取 Chrome 的数据/);
  assert.doesNotMatch(entry.note, /EPERM|EACCES/);
  assert.throws(() => browsers.resolve('chrome:Default', home), /完全磁盘访问权限/);
});

test('importBrowser only accepts detected ids and skips duplicates on a second run', async t => {
  const home = fakeHome(t), chrome = support(home, 'Google/Chrome');
  write(path.join(chrome, 'Local State'), { profile: { info_cache: { 'Profile 1': { name: '个人' } }, profiles_order: ['Profile 1'] } });
  write(path.join(chrome, 'Profile 1', 'Bookmarks'), { roots: { bookmark_bar: { type: 'folder', name: '书签栏', children: [
    { type: 'url', name: 'Example', url: 'https://example.com/' },
    { type: 'folder', name: '阅读', children: [{ type: 'url', name: 'Docs', url: 'https://docs.test/' }] },
  ] } } });
  process.env.ARCO_BROWSER_HOME = home;
  t.after(() => { delete process.env.ARCO_BROWSER_HOME; });
  const library = new Library(path.join(home, 'data'), () => {});
  assert.equal(await library.importBrowser('chrome:Profile 1', 'personal'), 2);
  assert.equal(await library.importBrowser('chrome:Profile 1', 'personal'), 0);
  assert.deepEqual(library.data.spaces[0].folders.map(f => f.name), ['书签栏', '阅读']);
  await assert.rejects(() => library.importBrowser('chrome:../../../../etc/passwd', 'personal'), /没有找到/);
  await assert.rejects(() => library.importBrowser('', 'personal'), /没有找到/);
});
