'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const crx = require('../src/crx');
const fixture = require('./crx-fixture');

const keys = fixture.generateKeyPair();
const other = fixture.generateKeyPair();
const ID = keys.id;
const manifest = { manifest_version: 3, name: 'Arco CRX Fixture', version: '1.2.3', description: 'fixture' };
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-crx-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function zipOf(files, root) {
  const source = path.join(root, 'src');
  for (const [name, content] of Object.entries(files)) { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  const zip = path.join(root, 'pack.zip');
  execFileSync('/usr/bin/zip', ['-q', '-r', zip, '.'], { cwd: source });
  return fs.readFileSync(zip);
}
async function serve(t, payload, status = 200) {
  const server = http.createServer((request, response) => { response.writeHead(status); response.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.ARCO_CRX_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { delete process.env.ARCO_CRX_ORIGIN; });
}

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

test('the extension id is the first 16 bytes of the sha256 public key', () => {
  const digest = crypto.createHash('sha256').update(keys.publicKey).digest();
  assert.equal(fixture.keyID(keys.publicKey).toString('hex'), digest.subarray(0, 16).toString('hex'));
  assert.match(ID, /^[a-p]{32}$/);
});

test('CRX3 signatures bind the zip bytes, the expected id and the public key', t => {
  const root = temporary(t), zip = zipOf({ 'manifest.json': JSON.stringify(manifest) }, root);
  const payload = fixture.signedCRX3(zip, keys);
  const verified = crx.verifyCRX(payload, ID);
  assert.equal(verified.zip.toString(), zip.toString());
  assert.deepEqual(verified.publicKey, keys.publicKey, 'the authenticated developer key must be returned, not only the zip');
  // 篡改 zip 的任意字节都会破坏签名。
  const tampered = Buffer.from(payload); tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => crx.verifyCRX(tampered, ID), /签名校验失败/);
  // 期望 ID 与签名公钥不符（商店请求了另一个扩展）。
  assert.throws(() => crx.verifyCRX(payload, other.id), /ID 与签名公钥不匹配/);
  // 签名头里声明的 ID 与公钥摘要不符。
  assert.throws(() => crx.verifyCRX(fixture.signedCRX3(zip, keys, { crxID: fixture.keyID(other.publicKey) }), ID), /ID 与公钥不匹配/);
  // 截断的签名头与缺少签名的包都被拒绝。
  const truncated = Buffer.from(payload); truncated.writeUInt32LE(1024 * 1024, 8);
  assert.throws(() => crx.verifyCRX(truncated, ID), /截断或超出上限/);
  const short = Buffer.alloc(20); short.write('Cr24', 0, 'binary'); short.writeUInt32LE(3, 4); short.writeUInt32LE(64, 8);
  assert.throws(() => crx.verifyCRX(short, ID), /截断或超出上限/);
  assert.throws(() => crx.verifyCRX(Buffer.from('nope-not-a-crx-file'), ID), /不是有效的 crx/);
  // 重复的 signed_header_data 属于歧义字段，必须拒绝。
  const header = fixture.crx3Header(zip, keys);
  const duplicated = fixture.wrap(Buffer.concat([header, fixture.field(10000, fixture.field(1, fixture.keyID(keys.publicKey)))]), zip);
  assert.throws(() => crx.verifyCRX(duplicated, ID), /重复/);
  // 未知字段同样拒绝。
  const unknown = fixture.wrap(Buffer.concat([header, fixture.field(99, Buffer.from('x'))]), zip);
  assert.throws(() => crx.verifyCRX(unknown, ID), /未知字段/);
});

test('CRX2 packages are verified with their own public key before unpacking', t => {
  const root = temporary(t), zip = zipOf({ 'manifest.json': JSON.stringify(manifest) }, root);
  assert.equal(crx.verifyCRX(fixture.signedCRX2(zip, keys), ID).zip.toString(), zip.toString());
  assert.throws(() => crx.verifyCRX(fixture.signedCRX2(zip, keys), other.id), /ID 与签名公钥不匹配/);
  const tampered = fixture.signedCRX2(zip, keys); tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => crx.verifyCRX(tampered, ID), /签名校验失败/);
});

test('download follows the update redirect and install unpacks a genuinely signed extension', async t => {
  const root = temporary(t), target = path.join(root, 'ext');
  const payload = fixture.signedCRX3(zipOf({ 'manifest.json': JSON.stringify(manifest), 'sw.js': 'self.ok = true;', 'icons/16.png': 'png' }, root), keys);
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
  // 商店包没有 manifest.key：安装时必须补上已认证的开发者公钥，Electron 才会加载成同一个 ID。
  const installed = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  assert.equal(installed.key, keys.publicKey.toString('base64'));
  assert.equal(crx.extensionIDFromKey(Buffer.from(installed.key, 'base64')), ID);
  assert.equal(fs.readFileSync(path.join(target, 'sw.js'), 'utf8'), 'self.ok = true;');
  assert.match(seen[0], new RegExp(`x=id%3D${ID}%26uc`));
});

test('an unsigned or wrongly signed package is refused before anything is written', async t => {
  const root = temporary(t), target = path.join(root, 'ext');
  const zip = zipOf({ 'manifest.json': JSON.stringify(manifest) }, root);
  const fakeHead = Buffer.alloc(12); fakeHead.write('Cr24', 0, 'binary'); fakeHead.writeUInt32LE(3, 4); fakeHead.writeUInt32LE(4, 8);
  await serve(t, Buffer.concat([fakeHead, Buffer.from('sig!'), zip]));
  await assert.rejects(() => crx.install(ID, target), /crx/);
  assert.equal(fs.existsSync(target), false);
  await serve(t, fixture.signedCRX3(zip, other));
  await assert.rejects(() => crx.install(ID, target), /ID 与签名公钥不匹配/);
  assert.equal(fs.existsSync(target), false);
});

test('a manifest key that would load the extension under another id is refused', async t => {
  const root = temporary(t), target = path.join(root, 'ext');
  const zip = zipOf({ 'manifest.json': JSON.stringify({ ...manifest, key: other.publicKey.toString('base64') }) }, root);
  await serve(t, fixture.signedCRX3(zip, keys));
  await assert.rejects(() => crx.install(ID, target), /公钥与商店 ID 不一致/);
  assert.equal(fs.existsSync(target), false);
  // 与商店 ID 一致的 key 可以安装。
  const matching = zipOf({ 'manifest.json': JSON.stringify({ ...manifest, key: keys.publicKey.toString('base64') }) }, root);
  await serve(t, fixture.signedCRX3(matching, keys));
  assert.equal((await crx.install(ID, target)).name, 'Arco CRX Fixture');
});

test('an archive that escapes its folder is refused and cleaned up', async t => {
  const root = temporary(t), target = path.join(root, 'ext');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside.txt'), 'secret');
  fs.symlinkSync('../../outside.txt', path.join(root, 'build', 'link'));
  execFileSync('/usr/bin/zip', ['-q', '-y', path.join(root, 'evil.zip'), 'link'], { cwd: path.join(root, 'build') });
  await serve(t, fixture.signedCRX3(fs.readFileSync(path.join(root, 'evil.zip')), keys));
  await assert.rejects(() => crx.install(ID, target), /越界链接/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'secret');
});

test('a package without a usable manifest is refused', async t => {
  const root = temporary(t), target = path.join(root, 'ext');
  await serve(t, fixture.signedCRX3(zipOf({ 'readme.txt': 'nothing here' }, root), keys));
  await assert.rejects(() => crx.install(ID, target), /manifest\.json/);
  assert.equal(fs.existsSync(target), false);
});
