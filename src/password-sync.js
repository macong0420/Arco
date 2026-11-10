'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, id } = require('./core');
const { validateVault } = require('./vault');
const KDF = { N: 16384, r: 8, p: 1, keylen: 32 };
function canonical(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function later(a, b) { return !b || a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && JSON.stringify(canonical(a)) < JSON.stringify(canonical(b))); }
function mergeCredentials(local, remote) {
  validateVault(local); validateVault(remote);
  const tombstones = Object.fromEntries([...new Set([...Object.keys(local.tombstones), ...Object.keys(remote.tombstones)])].sort().map(key => [key, [local.tombstones[key], remote.tombstones[key]].filter(Boolean).sort().pop()]));
  const records = new Map();
  for (const record of [...local.records, ...remote.records]) if (later(record, records.get(record.id))) records.set(record.id, record);
  return validateVault({ records: [...records.values()].filter(x => !tombstones[x.id] || tombstones[x.id] < x.updatedAt).sort((a, b) => a.id.localeCompare(b.id)), tombstones });
}
function readJSON(file) {
  if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('密码同步文件过大，已停止同步');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('密码同步文件已损坏，已停止且未覆盖'); }
}
class PasswordSync {
  constructor(folderProvider, deviceID = id()) { this.folderProvider = folderProvider; this.deviceID = deviceID; this.key = null; this.salt = null; this.until = 0; this.folder = ''; }
  get file() { return path.join(this.folderProvider(), 'Arco-Passwords.json'); }
  get unlocked() { return !!this.key && Date.now() < this.until && this.folder === this.folderProvider(); }
  lock() { this.key?.fill(0); this.key = null; this.salt = null; this.until = 0; this.folder = ''; }
  loadFile() { return fs.existsSync(this.file) ? this.validateEnvelope(readJSON(this.file)) : null; }
  validateEnvelope(value) {
    if (value?.version !== 1 || !value.kdf || Object.keys(KDF).some(key => value.kdf[key] !== KDF[key]) || ['salt', 'iv', 'tag', 'ciphertext'].some(key => typeof value[key] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value[key]))) throw new Error('密码同步加密格式无效');
    if (Buffer.from(value.salt, 'base64').length !== 16 || Buffer.from(value.iv, 'base64').length !== 12 || Buffer.from(value.tag, 'base64').length !== 16) throw new Error('密码同步加密参数无效');
    return value;
  }
  unlock(passphrase) {
    this.lock();
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('同步口令至少需要 12 个字符');
    if (!this.folderProvider() || !fs.statSync(this.folderProvider()).isDirectory()) throw new Error('请先选择有效的同步文件夹');
    const existing = this.loadFile(), salt = existing ? Buffer.from(existing.salt, 'base64') : crypto.randomBytes(16);
    const key = crypto.scryptSync(passphrase, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
    try { if (existing) this.decrypt(key, existing); } catch (error) { key.fill(0); throw error; }
    this.key = key; this.salt = salt; this.until = Date.now() + 15 * 60 * 1000; this.folder = this.folderProvider(); return true;
  }
  decrypt(key, value) {
    const envelope = this.validateEnvelope(value);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from('Arco password sync v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return validateVault(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')));
    } catch { throw new Error('同步口令不正确，或密码同步文件已被篡改/损坏'); }
  }
  requireUnlocked() { if (!this.unlocked) { this.lock(); throw new Error('请先解锁密码同步'); } }
  readRemote() {
    this.requireUnlocked(); const root = this.loadFile(); let result = { records: [], tombstones: {} };
    if (!root) return result;
    if (root.salt !== this.salt.toString('base64')) throw new Error('同步保险库已更换，请重新解锁');
    result = this.decrypt(this.key, root);
    const folder = path.join(this.folder, 'Arco-Password-Devices');
    if (fs.existsSync(folder)) {
      const files = fs.readdirSync(folder).filter(name => /^[\w-]{1,128}\.json$/.test(name));
      if (files.length > 500) throw new Error('同步设备记录过多，已停止同步');
      for (const file of files.sort()) {
        const envelope = this.validateEnvelope(readJSON(path.join(folder, file)));
        if (envelope.salt !== root.salt) throw new Error('同步设备记录不属于此保险库');
        result = mergeCredentials(result, this.decrypt(this.key, envelope));
      }
    }
    return result;
  }
  encrypt(state) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('Arco password sync v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(validateVault(state))), cipher.final()]);
    return { version: 1, kdf: KDF, salt: this.salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
  write(state) {
    this.requireUnlocked(); validateVault(state);
    if (!fs.existsSync(this.file)) {
      const temporary = this.file + '.' + id() + '.tmp';
      atomicWrite(temporary, this.encrypt({ records: [], tombstones: {} }));
      try { fs.linkSync(temporary, this.file); } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { fs.unlinkSync(temporary); }
    }
    this.readRemote(); // Never overwrite a locked, replaced or corrupted remote vault.
    // Each device owns one snapshot, so two devices never overwrite one another's edits.
    atomicWrite(path.join(this.folder, 'Arco-Password-Devices', this.deviceID + '.json'), this.encrypt(state));
  }
}
module.exports = { PasswordSync, mergeCredentials, canonical, later };
