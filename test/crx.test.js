'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const crx = require('../src/crx');

const ID = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-crx-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function zipOf(files, root) {
  const source = path.join(root, 'src');
  for (const [name, content] of Object.entries(files)) { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  const zip = path.join(root, 'pack.zip');
  execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], { cwd: source });
  return fs.readFileSync(zip);
}
function crxOf(zip, header = Buffer.from('fake-signature-header')) {
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'binary'); head.writeUInt32LE(3, 4); head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, zip]);
}
const manifest = { manifest_version: 3, name: 'Arco CRX Fixture', version: '1.2.3', description: 'fixture' };

test('extension ids come from store links or a bare 32 character id', () => {
  assert.equal(crx.extensionID(ID), ID);
  assert.equal(crx.extensionID(`  ${ID}  `), ID);
  assert.equal(crx.extensionID(`https://chromewebstore.google.com/detail/dark-reader/${ID}?hl=zh-CN`), ID);
  assert.equal(crx.extensionID(`https://chrome.google.com/webstore/detail/dark-reader/${ID}`), ID);
  assert.throws(() => crx.extensionID(''), /商店链接或 32 位扩展 ID/);
  assert.throws(() => crx.extensionID('eimadpbcbfnmbkopoojfekhnkhdbiee'), /商店链接或 32 位扩展 ID/);
  assert.throws(() => crx.extensionID('https://example.com/detail/x/' + ID), /只支持 Chrome 应用商店/);
  assert.throws(() => crx.extensionID('javascript:alert(1)'), /只支持 Chrome 应用商店/);
  assert.throws(() => crx.extensionID('https://chromewebstore.google.com/category/extensions'), /没有找到扩展 ID/);
});

test('CRX3 and CRX2 headers are stripped to the zip payload', () => {
  const zip = Buffer.from('PK\u0003\u0004payload');
  const v3 = crxOf(zip);
  assert.equal(crx.stripCRX(v3).toString(), zip.toString());
  const v2 = Buffer.concat([(() => { const head = Buffer.alloc(16); head.write('Cr24', 0, 'binary'); head.writeUInt32LE(2, 4); head.writeUInt32LE(3, 8); head.writeUInt32LE(4, 12); return head; })(), Buffer.from('key'), Buffer.from('sign'), zip]);
  assert.equal(crx.stripCRX(v2).toString(), zip.toString());
  assert.throws(() => crx.stripCRX(Buffer.from('nope-not-a-crx-file')), /不是有效的 crx/);
  assert.throws(() => crx.stripCRX(Buffer.alloc(20)), /不是有效的 crx/);
});

test('download follows the update redirect and install unpacks a working extension', async t => {
  const root = temporary(t), target = path.join(root, 'ext');
  const payload = crxOf(zipOf({ 'manifest.json': JSON.stringify(manifest), 'sw.js': 'self.ok = true;', 'icons/16.png': 'png' }, root));
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url);
    if (request.url.startsWith('/service/update2/crx')) { response.writeHead(302, { location: '/download/extension.crx' }); return response.end(); }
    if (request.url === '/download/extension.crx') { response.writeHead(200); return response.end(payload); }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.ARCO_CRX_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { delete process.env.ARCO_CRX_ORIGIN; });
  const info = await crx.install(ID, target);
  assert.deepEqual(info, { name: 'Arco CRX Fixture', version: '1.2.3', manifestVersion: 3 });
  assert.equal(fs.readFileSync(path.join(target, 'sw.js'), 'utf8'), 'self.ok = true;');
  assert.match(seen[0], new RegExp(`x=id%3D${ID}%26uc`));
});

test('an archive that escapes its folder is refused and cleaned up', async t => {
  const root = temporary(t), target = path.join(root, 'ext');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside.txt'), 'secret');
  fs.symlinkSync('../../outside.txt', path.join(root, 'build', 'link'));
  execFileSync('/usr/bin/zip', ['-q', '-y', path.join(root, 'evil.zip'), 'link'], { cwd: path.join(root, 'build') });
  const payload = crxOf(fs.readFileSync(path.join(root, 'evil.zip')));
  const server = http.createServer((request, response) => { response.writeHead(200); response.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.ARCO_CRX_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { delete process.env.ARCO_CRX_ORIGIN; });
  await assert.rejects(() => crx.install(ID, target), /越界链接/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'secret');
});

test('a package without a usable manifest is refused', async t => {
  const root = temporary(t), target = path.join(root, 'ext');
  const payload = crxOf(zipOf({ 'readme.txt': 'nothing here' }, root));
  const server = http.createServer((request, response) => { response.writeHead(200); response.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.ARCO_CRX_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { delete process.env.ARCO_CRX_ORIGIN; });
  await assert.rejects(() => crx.install(ID, target), /manifest\.json/);
  assert.equal(fs.existsSync(target), false);
});
