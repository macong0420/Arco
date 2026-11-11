'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { decrypt, cookieDetails, readDatabase, migrate } = require('../src/browser-migration');
const { MemoryVault } = require('../src/vault');
const core = require('../src/core');
const key = crypto.pbkdf2Sync('fixture key', 'saltysalt', 1003, 16, 'sha1');
function encrypt(value) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from('v10'), cipher.update(value), cipher.final()]);
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-migration-test-'));
  const previous = process.env.ARCO_BROWSER_HOME; process.env.ARCO_BROWSER_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.ARCO_BROWSER_HOME; else process.env.ARCO_BROWSER_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const dir = path.join(home, 'Library/Application Support/Google/Chrome/Default');
  fs.mkdirSync(dir, { recursive: true }); return { home, dir };
}
function cookie(overrides = {}) {
  return { host_key: '.example.test', name: 'session', value: '', path: '/', encrypted_value: encrypt(Buffer.concat([crypto.createHash('sha256').update('.example.test').digest(), Buffer.from('cookie-secret')])), expires_utc: (Date.now() / 1000 + 11644473600 + 3600) * 1e6, has_expires: 1, is_secure: 1, is_httponly: 1, samesite: 1, top_frame_site_key: '', ...overrides };
}

test('macOS Chromium v10 decryption validates host binding, format and UTF-8', () => {
  assert.equal(decrypt(encrypt(' 密码 \n'), key), ' 密码 \n');
  assert.throws(() => decrypt(Buffer.from('v20ciphertext'), key), /不支持/);
  assert.throws(() => decrypt(Buffer.from('v10broken'), key), /解密失败/);
  assert.throws(() => decrypt(encrypt(Buffer.from([255])), key), /编码无效/);
  const row = cookie();
  const actual = cookieDetails(row, 24, key);
  assert.equal(actual.value, 'cookie-secret');
  assert.equal(actual.domain, '.example.test'); assert.equal(actual.httpOnly, true); assert.equal(actual.sameSite, 'lax');
  assert.throws(() => cookieDetails({ ...row, host_key: '.other.test' }, 24, key), /域名校验/);
  assert.equal(cookieDetails(cookie({ expires_utc: 1 }), 24, key), null);
  assert.throws(() => cookieDetails(cookie({ top_frame_site_key: 'https://example.test' }), 24, key), /分区/);
  const hostOnly = cookieDetails(cookie({ host_key: 'example.test', encrypted_value: Buffer.alloc(0), value: 'plain', has_expires: 0 }), 23, key);
  assert.equal(hostOnly.domain, undefined); assert.equal(hostOnly.expirationDate, undefined); assert.equal(hostOnly.value, 'plain');
});

test('SQLite backup reads committed WAL rows without modifying the source data', async t => {
  const { dir } = fixture(t), file = path.join(dir, 'wal.sqlite');
  const db = new DatabaseSync(file); t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE data (value TEXT); INSERT INTO data VALUES (\'committed\')');
  assert.deepEqual(await readDatabase(file, snapshot => snapshot.prepare('SELECT value FROM data').all().map(row => row.value)), ['committed']);
  assert.equal(db.prepare('SELECT count(*) AS total FROM data').get().total, 1);
});

test('migration authenticates, keeps existing credentials/cookies and reports invalid rows without leaking secrets', async t => {
  const { dir } = fixture(t);
  const db = new DatabaseSync(path.join(dir, 'Login Data'));
  db.exec('CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)');
  const insert = db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?)');
  insert.run('https://example.test/login', 'alice', encrypt('source-secret'), 0);
  insert.run('https://new.test/login', 'bob', encrypt(' new-secret '), 0);
  insert.run('javascript:alert(1)', 'bad', encrypt('never-import'), 0);
  insert.run('https://bad.test', 'bad', Buffer.from('v20private-secret'), 0);
  insert.run('https://blocked.test', '', Buffer.alloc(0), 1); db.close();
  const cookieDB = new DatabaseSync(path.join(dir, 'Cookies'));
  cookieDB.exec("CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, path TEXT, encrypted_value BLOB, expires_utc REAL, has_expires INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT)");
  const row = cookie();
  cookieDB.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...Object.values({ host_key: row.host_key, name: row.name, value: row.value, path: row.path, encrypted_value: row.encrypted_value, expires_utc: row.expires_utc, has_expires: row.has_expires, is_secure: row.is_secure, is_httponly: row.is_httponly, samesite: row.samesite, top_frame_site_key: row.top_frame_site_key }));
  cookieDB.close();
  const vault = new MemoryVault(); let auth = 0;
  vault.authenticate = async () => { auth++; };
  await vault.save({ origin: 'https://example.test', username: 'alice', password: 'keep-local' });
  const stored = []; let flushed = false, keyCalls = 0;
  const options = { vault, cookies: { get: async () => stored.map(item => ({ ...item, domain: item.domain || new URL(item.url).hostname })), set: async item => stored.push(item), flushStore: async () => { flushed = true; } }, getKey: async service => { keyCalls++; assert.equal(service, 'Chrome'); return Buffer.from(key); } };
  const result = await migrate('chrome:Default', ['passwords', 'cookies'], options);
  assert.deepEqual({ ...result.passwords, errors: [] }, { imported: 1, skipped: 2, failed: 2, errors: [] });
  assert.equal(result.cookies.imported, 1); assert.equal(stored[0].value, 'cookie-secret');
  assert(flushed); assert(auth >= 1); assert.equal(keyCalls, 1);
  const local = (await vault.exportState()).records;
  assert.equal(local.find(item => item.username === 'alice').password, 'keep-local');
  assert.equal(local.find(item => item.username === 'bob').password, ' new-secret ');
  assert(!JSON.stringify(result).includes('secret'));
  const again = await migrate('chrome:Default', ['passwords', 'cookies'], options);
  assert.equal(again.passwords.imported, 0); assert.equal(again.cookies.skipped, 1); assert.equal(stored.length, 1);
  await assert.rejects(migrate('../../Default', ['passwords'], options), /没有找到/);
  await assert.rejects(migrate('chrome:Default', ['history'], options), /请选择/);
  vault.authenticate = async () => { throw new Error('取消认证'); };
  await assert.rejects(migrate('chrome:Default', ['passwords'], options), /取消认证/);
});

test('keychain denial preserves the vault and CSV imports are atomic and skip duplicates', async t => {
  const { dir } = fixture(t), db = new DatabaseSync(path.join(dir, 'Login Data'));
  db.exec('CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)');
  db.prepare('INSERT INTO logins VALUES (?, ?, ?, 0)').run('https://example.test', 'alice', encrypt('secret')); db.close();
  const vault = new MemoryVault();
  const denied = await migrate('chrome:Default', ['passwords'], { vault, getKey: async () => { throw new Error('钥匙串访问已取消'); } });
  assert.equal(denied.passwords.failed, 1); assert.equal((await vault.list()).length, 0);
  const rows = core.parseCSV('Title,URL,Username,Password,Notes,OTPAuth\nApple,https://example.test/login,alice,"  pass  ",,\nDuplicate,https://example.test,alice,new,,');
  assert.deepEqual(await vault.importCredentials(rows), { imported: 1, skipped: 1 });
  assert.equal((await vault.exportState()).records[0].password, '  pass  ');
  const before = structuredClone(await vault.exportState());
  await assert.rejects(vault.importCredentials([{ origin: 'https://next.test', username: 'next', password: 'ok' }, { origin: 'javascript:bad', password: 'bad' }]));
  assert.deepEqual(await vault.exportState(), before);
});

test('concurrent password import and saves retain every record, and failed writes leave the vault intact', async () => {
  const vault = new MemoryVault();
  const originalPersist = vault.persist.bind(vault);
  vault.persist = async value => { await new Promise(resolve => setTimeout(resolve, 5)); return originalPersist(value); };
  await Promise.all([
    vault.importCredentials([{ origin: 'https://import.test', username: 'import', password: 'imported' }]),
    vault.save({ origin: 'https://save.test', username: 'save', password: 'saved' }),
    vault.save({ origin: 'https://another.test', username: 'another', password: 'saved' }),
  ]);
  assert.equal((await vault.list()).length, 3);
  const before = structuredClone(await vault.exportState());
  vault.persist = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(vault.importCredentials([{ origin: 'https://fail.test', password: 'failure' }]), /disk unavailable/);
  assert.deepEqual(await vault.exportState(), before);
  vault.persist = originalPersist;
  await vault.importCredentials([{ origin: 'https://recovered.test', password: 'recovered' }]);
  assert.equal((await vault.list()).length, 4);
});

test('protected data reports an actionable permission error and never requests its keychain key', async t => {
  const { dir } = fixture(t), file = path.join(dir, 'Login Data');
  fs.writeFileSync(file, 'protected'); fs.chmodSync(file, 0o000);
  let requested = false;
  const result = await migrate('chrome:Default', ['passwords'], { vault: new MemoryVault(), getKey: async () => { requested = true; return Buffer.from(key); } });
  assert.equal(requested, false);
  assert.match(result.passwords.errors.join(''), /完全磁盘访问/);
});
