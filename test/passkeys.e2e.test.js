'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const root = path.join(__dirname, '..');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('real WebAuthn stays native while Arco scopes cancellable wait state', { timeout: 60000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-passkeys-profile-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-passkeys-home-'));
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Passkey fixture</title><h1>Passkey fixture</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${server.address().port}`;
  const alternateOrigin = origin.replace('localhost', '127.0.0.1');
  let app = null;

  t.after(async () => {
    if (app) {
      const child = app.process();
      await Promise.race([app.close().catch(() => {}), sleep(2500)]);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  app = await electron.launch({
    args: [root, '--use-mock-keychain'],
    env: { ...process.env, HOME: fakeHome, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: profile },
    timeout: 15000
  });
  let shell = null;
  for (let index = 0; index < 200 && !shell; index++) {
    shell = (await app.windows()).find(page => /shell\.html$/.test(page.url()));
    if (!shell) await sleep(50);
  }
  assert(shell, 'browser shell must be present');
  shell.setDefaultTimeout(8000);
  await shell.waitForFunction(() => !!window.arco && !!document.querySelector('#space-name')?.textContent);
  if (await shell.waitForSelector('[data-onboarding]', { timeout: 2000 }).catch(() => null)) {
    await shell.click('[data-action="onboard-skip"]');
    await shell.waitForFunction(() => !document.querySelector('[data-onboarding]'));
  }

  const invoke = (channel, payload = {}) => shell.evaluate(
    ({ channel, payload }) => window.arco.invoke('arco:invoke', { channel, payload }),
    { channel, payload }
  );
  const inspect = (action, payload = {}) => shell.evaluate(
    ({ action, payload }) => window.arco.invoke('arco:test', { action, payload }),
    { action, payload }
  );
  async function eventually(check, message = 'state did not converge') {
    for (let index = 0; index < 120; index++) {
      if (await check()) return;
      await sleep(50);
    }
    throw new Error(message);
  }
  async function pageFor(url) {
    for (let index = 0; index < 120; index++) {
      const page = (await app.windows()).find(candidate => candidate.url() === url);
      if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
      await sleep(50);
    }
    throw new Error(`missing page ${url}`);
  }

  await invoke('navigate', { input: `${origin}/webauthn` });
  const first = await pageFor(`${origin}/webauthn`);
  const cdp = await app.context().newCDPSession(first);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
  } });

  const registration = await first.evaluate(async () => {
    const publicKey = {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: location.hostname, name: 'Arco test' },
      user: { id: crypto.getRandomValues(new Uint8Array(32)), name: 'alice', displayName: 'Alice' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' }
    };
    const prototype = {};
    Object.defineProperty(prototype, 'publicKey', { value: publicKey, enumerable: false });
    const options = Object.create(prototype);
    Object.defineProperty(options, 'mediation', { value: 'optional', enumerable: false });
    const credential = await navigator.credentials.create(options);
    return { id: credential.id, rawId: [...new Uint8Array(credential.rawId)], type: credential.type };
  });
  assert.equal(registration.type, 'public-key');
  assert(registration.id && registration.rawId.length > 0, 'platform registration must reach the virtual authenticator');

  const assertion = await first.evaluate(async rawId => {
    const credential = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: new Uint8Array(rawId), transports: ['internal'] }],
      userVerification: 'required'
    } });
    return { id: credential.id, type: credential.type };
  }, registration.rawId);
  assert.deepEqual(assertion, { id: registration.id, type: 'public-key' });

  const receiverError = await first.evaluate(async () => {
    try { await navigator.credentials.get.call({}, { publicKey: {} }); return null; }
    catch (error) { return error.name; }
  });
  assert.equal(receiverError, 'TypeError', 'the native illegal-receiver contract must be preserved');

  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
  const callerAbort = await first.evaluate(async rawId => {
    const controller = new AbortController();
    const reason = new DOMException('caller reason', 'AbortError');
    const pending = navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: new Uint8Array(rawId) }]
      },
      signal: controller.signal
    });
    setTimeout(() => controller.abort(reason), 50);
    try { await pending; return null; }
    catch (error) { return { name: error.name, message: error.message, sameReason: error === reason }; }
  }, registration.rawId);
  assert.deepEqual(callerAbort, { name: 'AbortError', message: 'caller reason', sameReason: true });
  await eventually(async () => (await inspect('state')).passkeys.length === 0);

  const conditional = first.evaluate(async () => {
    const controller = new AbortController();
    window.__stopConditional = () => controller.abort();
    try {
      await navigator.credentials.get({
        publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'preferred' },
        mediation: 'conditional', signal: controller.signal
      });
      return 'resolved';
    } catch (error) { return error.name; }
  });
  await sleep(150);
  assert.equal((await inspect('state')).passkeys.length, 0, 'conditional mediation must not show wait UI');
  assert.equal(await shell.locator('#passkey-wait').isHidden(), true);
  await first.evaluate(() => window.__stopConditional());
  assert.equal(await conditional, 'AbortError');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });

  await first.evaluate(() => {
    window.addEventListener('pagehide', () => {
      window.dispatchEvent(new CustomEvent('arco-passkey-pending', { detail: { id: 'late-old-document' } }));
    });
    for (let index = 0; index < 12; index++) {
      window.dispatchEvent(new CustomEvent('arco-passkey-pending', { detail: { id: `forged-${index}` } }));
    }
  });
  await eventually(async () => (await inspect('state')).passkeys.length === 8, 'forged hints must be capped at eight per WebContents');
  await invoke('navigate', { input: `${origin}/after-navigation` });
  await pageFor(`${origin}/after-navigation`);
  await eventually(async () => (await inspect('state')).passkeys.length === 0, 'main-frame navigation must clear wait state');

  await invoke('new-tab', { url: `${alternateOrigin}/second-tab` });
  const second = await pageFor(`${alternateOrigin}/second-tab`);
  await first.evaluate(() => {
    window.__cancelled = [];
    window.addEventListener('arco-passkey-cancel', event => window.__cancelled.push(event.detail.id));
    window.dispatchEvent(new CustomEvent('arco-passkey-pending', { detail: { id: 'same-page-id' } }));
  });
  await second.evaluate(() => {
    window.__cancelled = [];
    window.addEventListener('arco-passkey-cancel', event => window.__cancelled.push(event.detail.id));
    window.dispatchEvent(new CustomEvent('arco-passkey-pending', { detail: { id: 'same-page-id' } }));
  });
  await eventually(async () => (await inspect('state')).passkeys.length === 2);
  const requests = (await inspect('state')).passkeys;
  assert.notEqual(requests[0].id, requests[1].id, 'shell IDs must not collide across tabs');
  const target = requests.find(request => request.origin === origin);
  await invoke('passkey-cancel', { id: target.id });
  await eventually(async () => (await inspect('state')).passkeys.length === 1);
  assert.deepEqual(await first.evaluate(() => window.__cancelled), ['same-page-id']);
  assert.deepEqual(await second.evaluate(() => window.__cancelled), []);
});
