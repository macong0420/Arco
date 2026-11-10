'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/core');

test('URL normalization uses HTTPS for domains and HTTP for localhost', () => {
  assert.equal(core.navigate('example.com'), 'https://example.com/');
  assert.equal(core.navigate('localhost:8080/login'), 'http://localhost:8080/login');
  assert.equal(core.navigate('hello world', 'duckduckgo'), 'https://duckduckgo.com/?q=hello%20world');
  assert.throws(() => core.navigate('javascript:alert(1)'));
  assert.throws(() => core.navigate('file:///etc/passwd'));
});
test('exact origins include scheme and effective port', () => {
  const origin = core.exactOrigin('https://example.com/login');
  assert.equal(origin, 'https://example.com');
  assert(core.originAllowed(origin, 'https://example.com/account'));
  assert(!core.originAllowed(origin, 'http://example.com/account'));
  assert(!core.originAllowed(origin, 'https://example.com:444/account'));
  assert(!core.originAllowed(origin, 'https://sub.example.com/account'));
  assert.throws(() => core.exactOrigin('http://example.com/login'));
  assert.equal(core.exactOrigin('http://127.0.0.1:8123/login'), 'http://127.0.0.1:8123');
});
test('atomic JSON preserves malformed original and uses restrictive permissions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Library.json'); fs.writeFileSync(file, '{broken');
  const result = core.loadJSON(file, core.initialLibrary(), core.validateLibrary);
  assert.match(result.warning, /原文件已保留/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert(fs.readdirSync(dir).some(x => x.includes('corrupt-')));
  assert.equal(fs.statSync(fs.readdirSync(dir).filter(x => x.includes('corrupt')).map(x => path.join(dir, x))[0]).mode & 0o777, 0o600);
});
test('record merge applies remote edits and propagates deletion tombstones', () => {
  const local = core.initialLibrary(), remote = structuredClone(local);
  const bookmark = core.stamp({ id: 'bookmark', title: 'Old', url: 'https://example.com/', parentID: null });
  local.spaces[0].bookmarks.push(bookmark); remote.spaces[0].bookmarks.push({ ...bookmark, title: 'New', updatedAt: '2099-01-01T00:00:00.000Z' });
  const merged = core.mergeLibraries(local, remote);
  assert.equal(merged.spaces[0].bookmarks[0].title, 'New');
  merged.tombstones.bookmark = '2099-01-02T00:00:00.000Z';
  const second = core.mergeLibraries(merged, remote);
  assert.equal(second.spaces[0].bookmarks.length, 0);
  assert.equal(second.tombstones.bookmark, '2099-01-02T00:00:00.000Z');
  assert.throws(() => core.mergeLibraries(local, { invalid: true }));
});
test('Chromium and Netscape parsers preserve nested folders and decode entities', () => {
  const chromium = { roots: { bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [{ type: 'folder', name: 'Reading', children: [{ type: 'url', name: 'Example', url: 'https://example.com/' }] }] } } };
  assert.deepEqual(core.parseChromiumBookmarks(chromium)[0].folders, ['Bookmarks bar', 'Reading']);
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Work</H3><DL><p><DT><A HREF="https://example.com/?a=1&amp;b=2">A &amp; B</A></DL><p></DL><p>';
  assert.equal(core.parseNetscape(html)[0].title, 'A & B');
  assert.equal(core.parseNetscape(html)[0].url, 'https://example.com/?a=1&b=2');
  assert.deepEqual(core.parseNetscape(html)[0].folders, ['Work']);
  assert.match(core.netscape(core.parseNetscape(html)), /A &amp; B/);
});
test('CSV import handles quotes and multiline fields and skips bad origins', () => {
  const parsed = core.parseCSV('name,url,username,password\nTest,https://example.com/login,"user,name","p""word"\nTest2,https://example.org/,user,"line1\nline2"\nBad,javascript:alert(1),user,password');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].username, 'user,name'); assert.equal(parsed[0].password, 'p"word');
  assert.equal(parsed[1].password, 'line1\nline2'); assert.equal(parsed[1].origin, 'https://example.org');
});
test('Arc parser reads pinned pages and folder hierarchy from explicit file data', () => {
  const root = { sidebar: { containers: [{ spaces: [{ id: 'space', title: 'Personal', containerIDs: ['pinned', 'root'] }], items: [{ id: 'root', childrenIds: ['folder'] }, { id: 'folder', title: 'Read', childrenIds: ['page'] }, { id: 'page', title: 'Article', data: { tab: { savedURL: 'https://example.com/article' } } }] }] } };
  const spaces = core.parseArcSidebar(root);
  assert.equal(spaces[0].name, 'Personal'); assert.deepEqual(spaces[0].bookmarks[0].folders, ['Read']);
});
test('MemoryVault refuses wrong-origin autofill and preserves exact origins', async () => {
  const { MemoryVault } = require('../src/vault'); const vault = new MemoryVault();
  const credential = await vault.save({ origin: 'http://127.0.0.1:3210/login', username: 'alice', password: 'secret' });
  assert.equal((await vault.fill(credential.id, 'http://127.0.0.1:3210/account')).username, 'alice');
  await assert.rejects(() => vault.fill(credential.id, 'http://127.0.0.1:3211/login'), /来源不匹配/);
  await assert.rejects(() => vault.save({ origin: 'http://example.com', username: 'alice', password: 'secret' }), /HTTP/);
});
