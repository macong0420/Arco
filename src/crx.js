'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

// Chrome 扩展 ID 只由 a-p 组成，32 位。
const ID = /^[a-p]{32}$/;
const LIMIT = 128 * 1024 * 1024;
const STORE = /(^|\.)(chromewebstore\.google\.com|chrome\.google\.com)$/;
const CRX_ORIGIN = () => process.env.ARCO_CRX_ORIGIN || 'https://clients2.google.com';

function extensionID(value) {
  const input = String(value || '').trim();
  if (ID.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入 Chrome 应用商店链接或 32 位扩展 ID'); }
  if (url.protocol !== 'https:' || !STORE.test(url.hostname)) throw new Error('只支持 Chrome 应用商店的链接');
  const last = url.pathname.split('/').filter(Boolean).pop() || '';
  if (!ID.test(last)) throw new Error('链接里没有找到扩展 ID');
  return last;
}
// Chrome 自己的更新协议：按 ID 取 crx，未签名校验由调用方决定。
function updateURL(id) {
  return `${CRX_ORIGIN()}/service/update2/crx?response=redirect&prodversion=${process.versions.chrome || '120.0.0.0'}&acceptformat=crx3&x=id%3D${id}%26uc`;
}
function fetch(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('下载重定向次数过多'));
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 60000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(fetch(new URL(response.headers.location, url).href, redirects + 1));
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`下载扩展失败（HTTP ${response.statusCode}）`)); }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) { request.destroy(); reject(new Error('扩展文件超过 128 MB')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => { request.destroy(); reject(new Error('下载扩展超时')); });
    request.on('error', reject);
  });
}
function download(id) { return fetch(updateURL(extensionID(id))); }
// CRX2: magic, version, key 长度, 签名长度, key, 签名, zip。CRX3: magic, version, 头长度, 签名头, zip。
function stripCRX(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.subarray(0, 4).toString('binary') !== 'Cr24') throw new Error('不是有效的 crx 文件');
  const version = buffer.readUInt32LE(4);
  if (version === 3) { const start = 12 + buffer.readUInt32LE(8); if (start >= buffer.length) throw new Error('crx 文件已损坏'); return buffer.subarray(start); }
  if (version === 2) { const start = 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12); if (start >= buffer.length) throw new Error('crx 文件已损坏'); return buffer.subarray(start); }
  throw new Error('不支持的 crx 版本');
}
function inside(root, target) { const base = path.resolve(root) + path.sep; return path.resolve(target).startsWith(base); }
// ditto 是 macOS 自带的解包工具，不需要引入 zip 依赖。
function unpack(zip, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(os.tmpdir(), `arco-crx-${process.pid}-${crypto.randomBytes(6).toString('hex')}.zip`);
  fs.writeFileSync(file, zip, { mode: 0o600 });
  const refuse = reason => { fs.rmSync(directory, { recursive: true, force: true }); throw new Error(reason); };
  try { execFileSync('/usr/bin/ditto', ['-x', '-k', file, directory], { stdio: 'ignore' }); }
  catch { refuse('扩展包解压失败'); }
  finally { fs.rmSync(file, { force: true }); }
  // 包内容来自第三方：拒绝任何指向目标目录之外的路径或链接。
  for (const entry of fs.readdirSync(directory, { recursive: true })) {
    const target = path.join(directory, entry);
    if (!inside(directory, target)) refuse('扩展包包含越界路径，已拒绝安装');
    let stats; try { stats = fs.lstatSync(target); } catch { continue; }
    if (!stats.isSymbolicLink()) continue;
    let real; try { real = fs.realpathSync(target); } catch { refuse('扩展包包含越界链接，已拒绝安装'); }
    if (!inside(directory, real)) refuse('扩展包包含越界链接，已拒绝安装');
  }
}
function manifestOf(directory) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')); }
  catch { throw new Error('扩展包里没有有效的 manifest.json'); }
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !manifest.manifest_version) throw new Error('扩展的 manifest.json 不完整');
  return { name: manifest.name, version: manifest.version, manifestVersion: manifest.manifest_version };
}
// 下载、剥头、解包、校验；调用方负责选择目录并在失败后清理。
async function install(id, directory) {
  const buffer = await download(id);
  fs.rmSync(directory, { recursive: true, force: true });
  try { unpack(stripCRX(buffer), directory); return manifestOf(directory); }
  catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
module.exports = { extensionID, updateURL, download, stripCRX, unpack, install, ID };
