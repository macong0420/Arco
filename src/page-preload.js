'use strict';
const { ipcRenderer, contextBridge } = require('electron');
// Isolated world: page scripts cannot see or call this IPC bridge.
const visible = element => {
  if (!element || element.type === 'hidden' || element.disabled || element.readOnly) return false;
  const box = element.getBoundingClientRect(), style = getComputedStyle(element);
  return box.width >= 8 && box.height >= 8 && style.visibility === 'visible' && Number(style.opacity) >= 0.1 &&
    (!element.checkVisibility || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
};
const fields = form => [...(form || document).querySelectorAll('input')].filter(visible);
const capture = form => {
  const inputs = fields(form), passwords = inputs.filter(input => input.type === 'password' && input.value);
  if (!passwords.length || passwords[0].value.length > 4096) return;
  const index = inputs.indexOf(passwords[0]);
  const users = inputs.slice(0, index).filter(input => ['text', 'email', 'tel', ''].includes(input.type) && input.value);
  const user = users.find(input => /username|email/i.test(input.autocomplete || '')) || users.at(-1);
  const username = (user?.value || '').slice(0, 1024);
  const password = passwords[0].value;
  ipcRenderer.send('arco:page-password', { username, password, origin: location.origin });
};
document.addEventListener('submit', event => { if (event.isTrusted) capture(event.target); }, true);
document.addEventListener('click', event => {
  if (!event.isTrusted) return;
  const link = event.target.closest?.('a[href]');
  if (link && event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.defaultPrevented && (!link.target || link.target === '_self') && !link.hasAttribute('download') && /^https?:/.test(link.href)) {
    const target = new URL(link.href), sameDocument = target.hash && target.origin === location.origin && target.pathname === location.pathname && target.search === location.search;
    if (!sameDocument) ipcRenderer.send('arco:page-link', { url: target.href });
  }
  if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && link && /^https?:/.test(link.href)) { event.preventDefault(); event.stopImmediatePropagation(); ipcRenderer.send('arco:page-peek', { url: link.href }); return; }
  const button = event.target.closest?.('button[type="submit"],input[type="submit"]');
  if (button) capture(button.form);
}, true);
document.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('application/x-arco-tab')) event.preventDefault(); });
document.addEventListener('drop', event => {
  if (!event.isTrusted) return;
  const id = event.dataTransfer.getData('application/x-arco-tab');
  if (id) { event.preventDefault(); ipcRenderer.send('arco:page-split', { id }); }
});

// 翻译只处理当前文档可见文字。节点列表和原文留在隔离世界；页面脚本无法读取翻译 IPC。
const translation = { nodes: [], original: [] };
const translationText = () => {
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim() || !node.parentElement) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest('script,style,noscript,textarea,input,select,option,[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
      const box = node.parentElement.getBoundingClientRect(), style = getComputedStyle(node.parentElement);
      return box.width > 0 && box.height > 0 && style.visibility === 'visible' && Number(style.opacity) > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [], texts = [];
  for (let node; (node = walker.nextNode());) {
    const value = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (value.length > 2000) continue;
    nodes.push(node); texts.push(value);
    if (nodes.length >= 500) break;
  }
  return { nodes, texts };
};
ipcRenderer.on('arco:page-translate', (_event, payload) => {
  const id = payload?.id;
  if (typeof id !== 'string' || !id || id.length > 128) return;
  if (payload.action === 'extract') {
    translation.nodes = []; translation.original = [];
    const found = translationText();
    translation.nodes = found.nodes; translation.original = found.texts;
    ipcRenderer.send('arco:page-translate-result', { id, texts: found.texts });
  } else if (payload.action === 'apply' && Array.isArray(payload.texts) && payload.texts.length === translation.nodes.length) {
    payload.texts.forEach((text, index) => { if (typeof text === 'string' && text.length <= 4000) translation.nodes[index].nodeValue = text; });
    ipcRenderer.send('arco:page-translate-result', { id, applied: translation.nodes.length });
  } else if (payload.action === 'restore') {
    translation.original.forEach((text, index) => { if (translation.nodes[index]?.isConnected) translation.nodes[index].nodeValue = text; });
    translation.nodes = []; translation.original = [];
    ipcRenderer.send('arco:page-translate-result', { id, restored: true });
  } else ipcRenderer.send('arco:page-translate-result', { id, error: '翻译操作无效' });
});

// 标准 publicKey create/get 仍交给 Chromium 做原生校验和认证器选择：页面世界里只叠加一个可取消的
// AbortController（保留调用方自己的 signal 与 abort reason），并把“等待/结束”状态用无凭据的
// DOM 事件交给隔离世界。challenge、credential、assertion 与密钥材料从不跨到壳层。
const passkeyBridge = () => {
  const credentials = navigator.credentials;
  if (!credentials || credentials.__arcoPasskeyBridge) return;
  const controllers = new Map();
  // Electron 没配置平台认证器时，Chromium 对 publicKey 请求既不 resolve 也不 reject，网站只能一直转圈。
  // 先问一次平台认证器：没有就给它一个期限，到点主动中止并按规范拒绝，让网站回退到密码登录。
  const platformAvailable = () => {
    try { return Promise.resolve(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).then(value => value === true, () => true); }
    catch { return null; }
  };
  const unavailableTimeout = 3000;
  const announceUnavailable = () => { try { window.dispatchEvent(new CustomEvent('arco-passkey-unavailable')); } catch {} };
  const announce = (name, id, conditional = false) => { try { window.dispatchEvent(new CustomEvent(name, { detail: { id, conditional } })); } catch {} };
  window.addEventListener('arco-passkey-cancel', event => {
    const id = event.detail?.id;
    const controller = typeof id === 'string' ? controllers.get(id) : null;
    if (controller) controller.abort();
  });
  for (const name of ['create', 'get']) {
    const original = credentials[name];
    if (typeof original !== 'function') continue;
    const request = function (options, timeoutMs) {
      const controller = new AbortController();
      const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      // WebIDL dictionary members may be inherited or non-enumerable. Inherit from the exact caller object and
      // override only signal; Object.assign/spread would silently drop those members.
      const next = Object.create(options);
      Object.defineProperty(next, 'signal', { value: signal, configurable: true });
      controllers.set(id, controller);
      announce('arco-passkey-pending', id, false);
      let pending;
      try { pending = Reflect.apply(original, this, [next]); }
      catch (error) { controllers.delete(id); announce('arco-passkey-settled', id); throw error; }
      const settled = Promise.resolve(pending).finally(() => { controllers.delete(id); announce('arco-passkey-settled', id); });
      if (!timeoutMs) return settled;
      let timer;
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DOMException('Passkeys are not available in this browser.', 'NotSupportedError'));
          controller.abort();
          announceUnavailable();
        }, timeoutMs);
      });
      return Promise.race([settled, deadline]).finally(() => clearTimeout(timer));
    };
    const wrapped = function (options) {
      if (!options || !options.publicKey) return Reflect.apply(original, this, [options]);
      const conditional = name === 'get' && options.mediation === 'conditional';
      // Conditional mediation is passive and may live for the whole document. It must not show a blocking wait UI.
      if (conditional) return Reflect.apply(original, this, [options]);
      const available = platformAvailable();
      return available ? available.then(ok => Reflect.apply(request, this, [options, ok ? 0 : unavailableTimeout])) : Reflect.apply(request, this, [options, 0]);
    };
    try { credentials[name] = wrapped; } catch { try { Object.defineProperty(credentials, name, { value: wrapped, configurable: true }); } catch {} }
  }
  // Chromium 静态声明支持平台通行密钥，网站据此显示登录入口；没有平台认证器时把这两项改成真实情况。
  try {
    const capabilities = PublicKeyCredential.getClientCapabilities;
    if (typeof capabilities === 'function') {
      PublicKeyCredential.getClientCapabilities = function () {
        const value = Promise.resolve(Reflect.apply(capabilities, this, arguments));
        const available = platformAvailable();
        if (!available) return value;
        return Promise.all([value, available]).then(([result, ok]) => ok ? result : { ...result, passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: false });
      };
    }
  } catch {}
  Object.defineProperty(credentials, '__arcoPasskeyBridge', { value: true });
};
// 同步在页面世界安装：早于页面自己的脚本，且不向页面暴露任何 IPC。
try { contextBridge.executeInMainWorld({ func: passkeyBridge }); } catch {}
window.addEventListener('arco-passkey-pending', event => { const id = event.detail?.id; if (typeof id === 'string' && id && id.length <= 128) ipcRenderer.send('arco:passkey-pending', { id, conditional: event.detail?.conditional === true }); });
window.addEventListener('arco-passkey-settled', event => { const id = event.detail?.id; if (typeof id === 'string' && id && id.length <= 128) ipcRenderer.send('arco:passkey-settled', { id }); });
window.addEventListener('arco-passkey-unavailable', () => ipcRenderer.send('arco:passkey-unavailable'));
ipcRenderer.on('arco:passkey-cancel', (_event, payload) => {
  const id = payload?.id;
  if (typeof id === 'string' && id && id.length <= 128) window.dispatchEvent(new CustomEvent('arco-passkey-cancel', { detail: { id } }));
});
