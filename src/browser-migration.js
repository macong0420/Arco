'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify, TextDecoder } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const browsers = require('./browsers');
const core = require('./core');
const { validateCredential } = require('./vault');

const SERVICES = { chrome: 'Chrome', edge: 'Microsoft Edge', brave: 'Brave', vivaldi: 'Vivaldi', opera: 'Opera', dia: 'Dia' };
function readableFile(file) {
  try { fs.accessSync(file, fs.constants.R_OK); return true; }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    if (['EPERM', 'EACCES'].includes(error.code)) throw new Error('macOS 阻止读取浏览器数据：请在系统设置 → 隐私与安全性 → 完全磁盘访问权限中允许 Arco，再重试');
    throw new Error('浏览器数据文件无法读取');
  }
}
function profile(id) {
  const entry = browsers.list().find(item => item.id === id && item.kind === 'chromium');
  if (!entry) throw new Error('没有找到可迁移的浏览器个人资料，请重新检测');
  return { ...entry, dir: path.dirname(entry.file), service: SERVICES[id.split(':')[0]] };
}
async function keychainKey(service) {
  let result;
  try { result = await execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', `${service} Safe Storage`], { timeout: 120000, maxBuffer: 65536 }); }
  catch { throw new Error('未能读取浏览器的钥匙串密钥：请允许系统访问提示，取消后可重试；也可从原浏览器导出密码 CSV'); }
  // security adds one newline; spaces in the actual secret are significant.
  return crypto.pbkdf2Sync(result.stdout.replace(/\r?\n$/, ''), 'saltysalt', 1003, 16, 'sha1');
}
function decrypt(value, key, host) {
  const bytes = Buffer.from(value || []);
  if (!bytes.length) return '';
  if (bytes.subarray(0, 3).toString() !== 'v10') throw new Error('此浏览器使用了暂不支持的加密格式，请从原浏览器导出密码');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let clear;
  try { clear = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]); }
  catch { throw new Error('浏览器数据解密失败，原数据未修改'); }
  if (host !== undefined) {
    const digest = crypto.createHash('sha256').update(host).digest();
    if (clear.length < 32 || !crypto.timingSafeEqual(clear.subarray(0, 32), digest)) throw new Error('Cookie 域名校验失败');
    clear = clear.subarray(32);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(clear); }
  catch { throw new Error('浏览器数据编码无效'); }
}
async function readDatabase(file, read) {
  const { DatabaseSync, backup } = require('node:sqlite');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-migration-'));
  fs.chmodSync(scratch, 0o700);
  let source, db;
  try {
    // SQLite backup includes committed WAL data while the source browser is open.
    source = new DatabaseSync(file, { readOnly: true, timeout: 3000 });
    const copy = path.join(scratch, 'snapshot.sqlite');
    await backup(source, copy);
    fs.chmodSync(copy, 0o600);
    source.close(); source = null;
    db = new DatabaseSync(copy, { readOnly: true });
    return read(db);
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code) || /authorization denied|unable to open database/i.test(error.message)) throw new Error('无法读取浏览器数据：请在系统设置 → 隐私与安全性 → 完全磁盘访问权限中允许 Arco，再重试');
    throw error;
  } finally { db?.close(); source?.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
}
function cookieDetails(row, version, key, now = Date.now() / 1000) {
  if (row.top_frame_site_key || row.is_partitioned) throw new Error('分区 Cookie 暂不迁移');
  const domain = row.host_key;
  if (typeof domain !== 'string' || !domain || /[\s/:?#@]/.test(domain) || typeof row.name !== 'string' || !row.path?.startsWith('/')) throw new Error('Cookie 格式无效');
  const expirationDate = Number(row.expires_utc) / 1e6 - 11644473600;
  if (row.has_expires && (!Number.isFinite(expirationDate) || expirationDate <= now)) return null;
  const value = row.encrypted_value?.length ? decrypt(row.encrypted_value, key, version >= 24 ? domain : undefined) : row.value;
  if (typeof value !== 'string') throw new Error('Cookie 内容无效');
  const url = new URL(`${row.is_secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}`);
  const cookie = { url: url.origin + row.path, name: row.name, value, path: row.path, secure: !!row.is_secure, httpOnly: !!row.is_httponly, sameSite: ({ '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' })[row.samesite] || 'unspecified' };
  if (domain.startsWith('.')) cookie.domain = domain;
  if (row.has_expires) cookie.expirationDate = expirationDate;
  return cookie;
}
async function migrate(id, choices, { vault, cookies, getKey = keychainKey }) {
  if (!Array.isArray(choices) || !choices.length || choices.some(item => !['passwords', 'cookies'].includes(item))) throw new Error('请选择要迁移的数据');
  const entry = profile(id), result = {};
  await vault.authenticate();
  let key;
  const obtainKey = async () => key || (key = await getKey(entry.service));
  try {
    for (const kind of new Set(choices)) {
      const summary = result[kind] = { imported: 0, skipped: 0, failed: 0, errors: [] };
      const report = message => { if (!summary.errors.includes(message) && summary.errors.length < 5) summary.errors.push(message); };
      let rows, version = 0;
      try {
        let file = path.join(entry.dir, kind === 'passwords' ? 'Login Data' : 'Network/Cookies');
        if (!readableFile(file)) {
          if (kind === 'cookies') file = path.join(entry.dir, 'Cookies');
          if (!readableFile(file)) { report('没有找到本地数据文件'); continue; }
        }
        rows = await readDatabase(file, db => {
          if (kind === 'cookies') {
            version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value);
            if (!Number.isInteger(version) || version < 1) throw new Error('Cookie 数据库版本无效');
            return db.prepare('SELECT * FROM cookies LIMIT 100001').all();
          }
          return db.prepare('SELECT origin_url, username_value, password_value, blacklisted_by_user FROM logins LIMIT 20001').all();
        });
        if (rows.length > (kind === 'passwords' ? 20000 : 100000)) throw new Error('数据量超过本次迁移上限');
        if (rows.some(row => Buffer.from((kind === 'passwords' ? row.password_value : row.encrypted_value) || []).subarray(0, 3).toString() === 'v10')) await obtainKey();
      } catch (error) { summary.failed = rows?.length || 0; report(error.message); continue; }
      if (kind === 'passwords') {
        const records = [];
        for (const row of rows) {
          if (row.blacklisted_by_user || !row.password_value?.length) { summary.skipped++; continue; }
          try {
            records.push(validateCredential({ origin: core.exactOrigin(row.origin_url), username: row.username_value, password: decrypt(row.password_value, key), title: '' }));
          } catch (error) { summary.failed++; report(error.message); }
        }
        // One atomic encrypted write; existing credentials always win.
        const imported = await vault.importCredentials(records);
        summary.imported = imported.imported; summary.skipped += imported.skipped;
      } else {
        const existing = new Set((await cookies.get({})).map(item => JSON.stringify([item.domain, item.path, item.name])));
        for (const row of rows) {
          try {
            const cookie = cookieDetails(row, version, key);
            const identity = JSON.stringify([row.host_key, row.path, row.name]);
            if (!cookie || existing.has(identity)) { summary.skipped++; continue; }
            await cookies.set(cookie); existing.add(identity); summary.imported++;
          } catch (error) { summary.failed++; report(/Cookie|格式|解密|编码/.test(error.message) ? error.message : 'Cookie 无法写入，已跳过'); }
        }
        await cookies.flushStore();
      }
    }
    return result;
  } finally { key?.fill(0); }
}
module.exports = { migrate, decrypt, cookieDetails, readDatabase };
