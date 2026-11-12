'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBridge(credentials, extra = {}) {
  let bridge;
  const listeners = new Map();
  const events = [];
  const window = {
    addEventListener(name, listener) {
      const current = listeners.get(name) || [];
      current.push(listener);
      listeners.set(name, current);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    }
  };
  class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    CustomEvent,
    URL,
    console,
    location: { origin: 'https://example.test' },
    navigator: { credentials },
    window,
    document: { addEventListener() {}, querySelectorAll() { return []; } },
    getComputedStyle() { return { visibility: 'visible', opacity: '1' }; },
    DOMException,
    ...extra,
    require(name) {
      assert.equal(name, 'electron');
      return {
        ipcRenderer: { send() {}, on() {} },
        contextBridge: { executeInMainWorld(descriptor) { bridge = descriptor.func; } }
      };
    }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'page-preload.js'), 'utf8');
  new vm.Script(source, { filename: 'page-preload.js' }).runInContext(context);
  assert.equal(typeof bridge, 'function');
  bridge();
  return { events, window };
}

function abortableNative(calls, name) {
  return function (options) {
    if (this !== calls.credentials) throw new TypeError('Illegal invocation');
    calls.push({ name, options });
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(options.signal.reason);
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      calls.resolve = resolve;
    });
  };
}

test('passkey bridge preserves WebIDL dictionaries and delegates create/get to the native receiver', async () => {
  const calls = [];
  const credentials = {};
  calls.credentials = credentials;
  credentials.create = abortableNative(calls, 'create');
  credentials.get = abortableNative(calls, 'get');
  const { events } = loadBridge(credentials);

  const publicKey = { challenge: new Uint8Array([1]) };
  const prototype = {};
  Object.defineProperty(prototype, 'publicKey', { value: publicKey, enumerable: false });
  const options = Object.create(prototype);
  Object.defineProperty(options, 'mediation', { value: 'optional', enumerable: false });
  const result = credentials.create(options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create');
  assert.equal(Object.getPrototypeOf(calls[0].options), options);
  assert.equal(calls[0].options.publicKey, publicKey);
  assert.equal(calls[0].options.mediation, 'optional');
  assert(calls[0].options.signal instanceof AbortSignal);
  calls.resolve('created');
  assert.equal(await result, 'created');
  assert.deepEqual(events.map(event => event.type), ['arco-passkey-pending', 'arco-passkey-settled']);

  assert.throws(() => credentials.get.call({}, { publicKey }), /Illegal invocation/);
});

test('caller abort reason survives signal composition and shell cancel aborts only its request', async () => {
  const calls = [];
  const credentials = {};
  calls.credentials = credentials;
  credentials.create = abortableNative(calls, 'create');
  credentials.get = abortableNative(calls, 'get');
  const { events, window } = loadBridge(credentials);

  const caller = new AbortController();
  const reason = new Error('caller stopped');
  const callerPromise = credentials.get({ publicKey: {}, signal: caller.signal });
  caller.abort(reason);
  await assert.rejects(callerPromise, error => error === reason);

  const shellPromise = credentials.create({ publicKey: {} });
  const pending = events.filter(event => event.type === 'arco-passkey-pending').at(-1);
  window.dispatchEvent(new (events[0].constructor)('arco-passkey-cancel', { detail: { id: pending.detail.id } }));
  await assert.rejects(shellPromise, error => error?.name === 'AbortError');
});

test('conditional and non-publicKey requests pass through unchanged without wait events', async () => {
  const calls = [];
  const credentials = {};
  calls.credentials = credentials;
  credentials.create = abortableNative(calls, 'create');
  credentials.get = function (options) {
    if (this !== credentials) throw new TypeError('Illegal invocation');
    calls.push({ name: 'get', options });
    return Promise.resolve('native-result');
  };
  const { events } = loadBridge(credentials);

  const conditional = Object.create({ publicKey: {} });
  Object.defineProperty(conditional, 'mediation', { value: 'conditional', enumerable: false });
  assert.equal(await credentials.get(conditional), 'native-result');
  assert.equal(calls.at(-1).options, conditional);
  const plain = {};
  assert.equal(await credentials.get(plain), 'native-result');
  assert.equal(calls.at(-1).options, plain);
  assert.equal(events.filter(event => event.type.startsWith('arco-passkey-')).length, 0);
});

test('without a platform authenticator a request that never settles is rejected at the deadline', async () => {
  const calls = [];
  const timers = [];
  const credentials = {};
  calls.credentials = credentials;
  credentials.get = abortableNative(calls, 'get');
  const { events } = loadBridge(credentials, {
    PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false) },
    setTimeout: callback => timers.push(callback),
    clearTimeout: () => {}
  });

  const pending = credentials.get({ publicKey: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'the native request is still tried first');
  assert.equal(timers.length, 1, 'a missing platform authenticator must arm a deadline');
  timers[0]();
  await assert.rejects(pending, error => error?.name === 'NotSupportedError');
  const types = events.map(event => event.type);
  assert.ok(types.includes('arco-passkey-pending'));
  assert.ok(types.includes('arco-passkey-unavailable'));
});

test('a platform authenticator still reaches the native implementation with wait events', async () => {
  const calls = [];
  const timers = [];
  const credentials = {};
  calls.credentials = credentials;
  credentials.create = abortableNative(calls, 'create');
  credentials.get = abortableNative(calls, 'get');
  const { events } = loadBridge(credentials, {
    PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true) },
    setTimeout: callback => timers.push(callback),
    clearTimeout: () => {}
  });

  const pending = credentials.get({ publicKey: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(timers.length, 0, 'an available platform authenticator must not be cut off');
  calls.resolve('assertion');
  assert.equal(await pending, 'assertion');
  assert.deepEqual(events.map(event => event.type), ['arco-passkey-pending', 'arco-passkey-settled']);
});
