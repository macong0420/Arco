'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = path.join(__dirname, '..');
// Uses a disposable profile, fake browser home and localhost; never creates a credential.
const { _electron: electron } = require('playwright');
(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arco-passkey-audit-'));
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Isolated passkey audit</title><h1>Local test only</h1>'); });
  let application;
  const output = { engine: '', baseline: null, configured: null, logs: [] };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://localhost:' + server.address().port + '/';
    application = await electron.launch({ args: [root, '--use-mock-keychain'], env: { ...process.env, ARCO_TEST_MODE: '1', ARCO_USER_DATA_DIR: path.join(scratch, 'profile'), ARCO_BROWSER_HOME: path.join(scratch, 'fake-browser-home') }, timeout: 15000 });
    const shell = await application.firstWindow();
    await shell.waitForFunction(() => !!window.arco && !!document.querySelector('#space-name')?.textContent);
    if (await shell.$('[data-onboarding]')) await shell.click('[data-action="onboard-skip"]');
    await shell.evaluate(url => window.arco.invoke('arco:invoke', { channel: 'navigate', payload: { input: url } }), url);
    let page;
    for (let i = 0; i < 100 && !page; i++) { page = (await application.windows()).find(item => item.url() === url); if (!page) await new Promise(resolve => setTimeout(resolve, 30)); }
    if (!page) throw new Error('local fixture page not found');
    page.on('console', message => output.logs.push(message.text()));
    output.engine = await application.evaluate(({ app }) => ({ electron: process.versions.electron, chromium: process.versions.chrome, configureWebAuthn: typeof app.configureWebAuthn }));
    async function probe() {
      return page.evaluate(async () => {
        const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        const capabilities = typeof PublicKeyCredential.getClientCapabilities === 'function' ? await PublicKeyCredential.getClientCapabilities() : {};
        const controller = new AbortController();
        const started = performance.now();
        const request = navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'localhost', userVerification: 'preferred', timeout: 1000, allowCredentials: [{ type: 'public-key', id: new Uint8Array([9, 8, 7, 6]), transports: ['internal'] }] }, signal: controller.signal }).then(() => ({ status: 'resolved' }), error => ({ status: 'rejected', name: error.name, message: error.message }));
        const result = await Promise.race([request, new Promise(resolve => setTimeout(() => resolve({ status: 'still-pending' }), 2500))]);
        controller.abort(); await request;
        return { available, capabilities, request: result, elapsedMs: Math.round(performance.now() - started) };
      });
    }
    output.baseline = await probe();
    await application.evaluate(({ app }) => app.configureWebAuthn({ platformPasskeys: true }));
    output.configured = await probe();
    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (application) {
      const child = application.process();
      await Promise.race([application.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2500))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
