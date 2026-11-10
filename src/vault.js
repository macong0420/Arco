'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const core = require('./core');
function validateCredential(value) {
  if (!value || typeof value !== 'object') throw new Error('密码记录无效');
  if (value.username !== undefined && (typeof value.username !== 'string' || value.username.length > 1024)) throw new Error('用户名无效');
  return { id: value.id ? core.text(value.id, 128) : core.id(), origin: core.exactOrigin(value.origin, { allowInsecure: true }),
    username: value.username || '', password: core.secret(value.password), title: core.text(value.title || '', 500), updatedAt: value.updatedAt || core.now() };
}
function validateVault(value) {
  if (!value || !Array.isArray(value.records) || value.records.length > 20000 || !value.tombstones || typeof value.tombstones !== 'object' || Array.isArray(value.tombstones)) throw new Error('密码保险库格式无效');
  const ids = new Set();
  for (const record of value.records) {
    const checked = validateCredential(record);
    if (!/^[\w-]{1,128}$/.test(checked.id) || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)) || ids.has(checked.id)) throw new Error('密码记录无效');
    ids.add(checked.id);
  }
  if (Object.entries(value.tombstones).some(([id, date]) => !/^[\w-]{1,128}$/.test(id) || typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) throw new Error('密码删除记录无效');
  return value;
}
function metadata({ password, ...record }) { return record; }
class NativeAuthenticator {
  constructor() { this.child = null; this.waiting = new Map(); this.buffer = ''; }
  start() {
    if (this.child && !this.child.killed) return;
    const { app } = require('electron');
    const file = app.isPackaged ? path.join(process.resourcesPath, 'native', 'ArcoVault') : path.join(__dirname, '..', 'native', 'ArcoVault');
    if (!fs.existsSync(file)) throw new Error('系统认证辅助程序尚未构建，请运行 npm run build:native');
    this.child = spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      for (let end; (end = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line), request = this.waiting.get(response.requestID);
          if (request) { this.waiting.delete(response.requestID); clearTimeout(request.timer); response.ok ? request.resolve(response) : request.reject(new Error(response.error || '系统认证失败')); }
        } catch { this.fail(new Error('系统认证返回无效响应')); }
      }
    });
    this.child.on('error', () => this.fail(new Error('无法启动系统认证辅助程序')));
    this.child.on('exit', () => { this.fail(new Error('系统认证辅助程序已退出')); this.child = null; });
  }
  fail(error) { for (const request of this.waiting.values()) { clearTimeout(request.timer); request.reject(error); } this.waiting.clear(); }
  call(action) {
    this.start(); const requestID = core.id();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(requestID); reject(new Error('系统认证超时，请重试')); }, action === 'status' ? 5000 : 120000);
      this.waiting.set(requestID, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ action, requestID }) + '\n', error => { if (error) { clearTimeout(timer); this.waiting.delete(requestID); reject(new Error('系统认证连接中断')); } });
    });
  }
  dispose() { this.fail(new Error('保险库已关闭')); this.child?.kill(); this.child = null; }
}
class MemoryVault {
  constructor() { this.state = { records: [], tombstones: {} }; }
  async persist(value) { this.state = validateVault(value); }
  async load() { return this.state; }
  async list() { return (await this.load()).records.map(metadata); }
  async save(value) {
    const state = await this.load();
    core.exactOrigin(value.origin);
    const origin = core.exactOrigin(value.origin), username = value.username || '';
    const previous = state.records.find(record => (value.id && record.id === value.id) || (record.origin === origin && record.username === username));
    const identity = crypto.createHash('sha256').update(JSON.stringify([origin, username])).digest('hex');
    const record = validateCredential({ ...value, id: previous?.id || identity, updatedAt: core.now() });
    const next = { records: state.records.filter(x => x.id !== record.id).concat(record), tombstones: { ...state.tombstones } };
    delete next.tombstones[record.id]; await this.persist(next); return metadata(record);
  }
  async authenticate() { return true; }
  async read(id) { await this.authenticate(); const record = (await this.load()).records.find(x => x.id === id); if (!record) throw new Error('没有找到此密码'); return { ...record }; }
  async fill(id, origin) { const item = (await this.load()).records.find(x => x.id === id); if (!item || !core.originAllowed(item.origin, origin)) throw new Error('来源不匹配，已拒绝填充'); return this.read(id); }
  async remove(id) { await this.authenticate(); const state = await this.load(); await this.persist({ records: state.records.filter(x => x.id !== id), tombstones: { ...state.tombstones, [id]: core.now() } }); }
  async exportState() { await this.authenticate(); return structuredClone(await this.load()); }
  async importState(value) { await this.persist(validateVault(structuredClone(value))); }
  status() { return { backend: '测试内存保险库', nativeICloud: false }; }
  dispose() { this.state = { records: [], tombstones: {} }; }
}
class EncryptedVault extends MemoryVault {
  constructor(directory) { super(); this.file = path.join(directory, 'Vault.json'); this.loaded = false; this.auth = new NativeAuthenticator(); this.unlockedUntil = 0; }
  async load() {
    if (this.loaded) return this.state;
    const { safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS 钥匙串加密不可用，密码操作已停止');
    if (fs.existsSync(this.file)) {
      const stored = core.loadJSON(this.file, null, value => { if (value?.version !== 1 || typeof value.ciphertext !== 'string') throw new Error('保险库文件无效'); return value; });
      if (stored.warning || !stored.data) throw new Error(stored.warning || '无法读取保险库');
      try { this.state = validateVault(JSON.parse(safeStorage.decryptString(Buffer.from(stored.data.ciphertext, 'base64')))); }
      catch { throw new Error('无法解密本机密码保险库，已保留原文件'); }
    }
    this.loaded = true; return this.state;
  }
  async persist(value) {
    const next = validateVault(value), { safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS 钥匙串加密不可用，未保存密码');
    const ciphertext = safeStorage.encryptString(JSON.stringify(next)).toString('base64');
    core.atomicWrite(this.file, { version: 1, ciphertext }); this.state = next; this.loaded = true;
  }
  async authenticate() { if (Date.now() >= this.unlockedUntil) { await this.auth.call('authenticate'); this.unlockedUntil = Date.now() + 60000; } return true; }
  async importState(value) { await this.authenticate(); await super.importState(value); }
  status() { return { backend: '本机加密保险库 · 密钥由 macOS 钥匙串保护', nativeICloud: false }; }
  dispose() { this.auth.dispose(); this.unlockedUntil = 0; this.loaded = false; super.dispose(); }
}
module.exports = { MemoryVault, EncryptedVault, NativeAuthenticator, validateVault, validateCredential };
