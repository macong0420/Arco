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
// CRX3 签名覆盖 "CRX3 SignedData\0" + 长度 + SignedData + 完整 zip 字节；CRX2 签名直接覆盖 zip。
const CRX3_MAGIC = Buffer.from('CRX3 SignedData\0', 'binary');
const MAX_HEADER = 1024 * 1024;
function keyID(publicKey) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length < 32 || publicKey.length > 8192) throw new Error('扩展公钥无效');
  return crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
}
function extensionIDFromKey(publicKey) {
  let id = '';
  for (const byte of keyID(publicKey)) id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  return id;
}
// 手写 protobuf 读取：只接受已知的长度字段，拒绝截断、溢出、重复和未知字段。
function readVarint(buffer, offset, limit) {
  let value = 0, shift = 0, index = offset;
  while (index < limit) {
    const byte = buffer[index++];
    if (shift > 28) throw new Error('crx 签名头包含无效的变长整数');
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, offset: index };
    shift += 7;
  }
  throw new Error('crx 签名头已截断');
}
function readFields(buffer) {
  const fields = new Map(); let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset, buffer.length); offset = tag.offset;
    const field = Math.floor(tag.value / 8), wire = tag.value % 8;
    if (wire !== 2) throw new Error('crx 签名头字段类型无效');
    const length = readVarint(buffer, offset, buffer.length); offset = length.offset;
    const end = offset + length.value;
    if (!Number.isSafeInteger(length.value) || end > buffer.length) throw new Error('crx 签名头已截断');
    if (fields.has(field)) throw new Error('crx 签名头包含重复字段');
    fields.set(field, buffer.subarray(offset, end)); offset = end;
  }
  return fields;
}
function parseProof(buffer) {
  const fields = readFields(buffer);
  for (const field of fields.keys()) if (field !== 1 && field !== 2) throw new Error('crx 签名头包含未知字段');
  const publicKey = fields.get(1), signature = fields.get(2);
  if (!publicKey || !signature) throw new Error('crx 签名头缺少公钥或签名');
  return { publicKey, signature };
}
function parseSignedData(buffer) {
  const fields = readFields(buffer);
  for (const field of fields.keys()) if (field !== 1) throw new Error('crx 签名数据包含未知字段');
  const crxID = fields.get(1);
  if (!crxID || crxID.length !== 16) throw new Error('crx 签名中的扩展 ID 无效');
  return crxID;
}
function parseCRX3Header(header) {
  const proofs = []; let signedHeaderData = null, offset = 0;
  while (offset < header.length) {
    const tag = readVarint(header, offset, header.length); offset = tag.offset;
    const field = Math.floor(tag.value / 8), wire = tag.value % 8;
    if (wire !== 2) throw new Error('crx 签名头字段类型无效');
    const length = readVarint(header, offset, header.length); offset = length.offset;
    const end = offset + length.value;
    if (!Number.isSafeInteger(length.value) || end > header.length) throw new Error('crx 签名头已截断');
    const value = header.subarray(offset, end); offset = end;
    if (field === 2 || field === 3) proofs.push(parseProof(value));
    else if (field === 10000) { if (signedHeaderData) throw new Error('crx 签名头包含重复的签名数据'); signedHeaderData = value; }
    else throw new Error('crx 签名头包含未知字段');
  }
  if (!proofs.length) throw new Error('crx 文件没有签名');
  if (!signedHeaderData) throw new Error('crx 文件缺少签名数据');
  return { proofs, signedHeaderData };
}
// 校验期望 ID、公钥摘要、签名和 zip 字节绑定，返回已通过校验的 zip 与认证过的开发者公钥。失败时不会写任何文件。
function verifyCRX(buffer, expectedID) {
  if (!ID.test(String(expectedID || ''))) throw new Error('扩展 ID 无效');
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.subarray(0, 4).toString('binary') !== 'Cr24') throw new Error('不是有效的 crx 文件');
  const version = buffer.readUInt32LE(4);
  if (version === 3) {
    const headerSize = buffer.readUInt32LE(8), headerEnd = 12 + headerSize;
    if (!headerSize || headerSize > MAX_HEADER || headerEnd >= buffer.length) throw new Error('crx 文件头已截断或超出上限');
    const { proofs, signedHeaderData } = parseCRX3Header(buffer.subarray(12, headerEnd)), zip = buffer.subarray(headerEnd);
    const signedID = parseSignedData(signedHeaderData);
    const length = Buffer.alloc(4); length.writeUInt32LE(signedHeaderData.length);
    const signed = Buffer.concat([CRX3_MAGIC, length, signedHeaderData, zip]);
    let matched = null;
    for (const proof of proofs) {
      if (extensionIDFromKey(proof.publicKey) !== expectedID) continue;
      let key;
      try { key = crypto.createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' }); }
      catch { throw new Error('crx 签名公钥无效'); }
      if (!['rsa', 'ec'].includes(key.asymmetricKeyType)) throw new Error('crx 签名使用了不支持的公钥类型');
      if (!crypto.verify('sha256', signed, key, proof.signature)) throw new Error('扩展签名校验失败');
      if (!signedID.equals(keyID(proof.publicKey))) throw new Error('扩展签名中的 ID 与公钥不匹配');
      matched = Buffer.from(proof.publicKey); break;
    }
    if (!matched) throw new Error('扩展 ID 与签名公钥不匹配');
    return { zip, publicKey: matched };
  }
  if (version === 2) {
    const keyLength = buffer.readUInt32LE(8), signatureLength = buffer.readUInt32LE(12), start = 16 + keyLength + signatureLength;
    if (!keyLength || !signatureLength || keyLength > MAX_HEADER || signatureLength > MAX_HEADER || start >= buffer.length) throw new Error('crx 文件头已截断或超出上限');
    const publicKey = buffer.subarray(16, 16 + keyLength), signature = buffer.subarray(16 + keyLength, start), zip = buffer.subarray(start);
    if (extensionIDFromKey(publicKey) !== expectedID) throw new Error('扩展 ID 与签名公钥不匹配');
    let key;
    try { key = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' }); }
    catch { throw new Error('crx 签名公钥无效'); }
    if (!crypto.verify('sha1', zip, key, signature)) throw new Error('扩展签名校验失败');
    return { zip, publicKey: Buffer.from(publicKey) };
  }
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
function manifestOf(directory, expectedID, publicKey) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')); }
  catch { throw new Error('扩展包里没有有效的 manifest.json'); }
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !manifest.manifest_version) throw new Error('扩展的 manifest.json 不完整');
  if (!Buffer.isBuffer(publicKey) || extensionIDFromKey(publicKey) !== expectedID) throw new Error('签名公钥与商店 ID 不一致');
  // manifest 的 key 决定 Electron 加载时使用的扩展 ID：只能来自已验证的签名公钥，不能凭 manifest 自报身份。
  if (manifest.key !== undefined) {
    if (typeof manifest.key !== 'string' || !manifest.key) throw new Error('扩展包声明的公钥无效');
    let declared;
    try { declared = Buffer.from(manifest.key, 'base64'); crypto.createPublicKey({ key: declared, format: 'der', type: 'spki' }); }
    catch { throw new Error('扩展包声明的公钥无效'); }
    if (extensionIDFromKey(declared) !== expectedID) throw new Error('扩展包声明的公钥与商店 ID 不一致，已拒绝安装');
  }
  // 商店包常常不声明 key；缺失时补上已认证的开发者公钥，否则 Electron 会按解压目录生成另一个 ID。
  const canonical = publicKey.toString('base64');
  if (manifest.key !== canonical) {
    manifest.key = canonical;
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return { name: manifest.name, version: manifest.version, manifestVersion: manifest.manifest_version };
}
// 下载 → 校验签名/ID/公钥/zip → 解包 → 用已认证公钥固定 manifest 身份；任一步失败都不留下安装目录。
async function install(id, directory) {
  const storeID = extensionID(id);
  const buffer = await download(storeID);
  const { zip, publicKey } = verifyCRX(buffer, storeID);
  fs.rmSync(directory, { recursive: true, force: true });
  try { unpack(zip, directory); return manifestOf(directory, storeID, publicKey); }
  catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
module.exports = { extensionID, updateURL, download, verifyCRX, unpack, install, extensionIDFromKey, ID };
