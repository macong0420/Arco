'use strict';
const { ipcRenderer } = require('electron');
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
  if (event.shiftKey && link && /^https?:/.test(link.href)) { event.preventDefault(); event.stopImmediatePropagation(); ipcRenderer.send('arco:page-peek', { url: link.href }); return; }
  const button = event.target.closest?.('button[type="submit"],input[type="submit"]');
  if (button) capture(button.form);
}, true);
document.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('application/x-arco-tab')) event.preventDefault(); });
document.addEventListener('drop', event => {
  if (!event.isTrusted) return;
  const id = event.dataTransfer.getData('application/x-arco-tab');
  if (id) { event.preventDefault(); ipcRenderer.send('arco:page-split', { id }); }
});
