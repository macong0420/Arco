'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Apple Translation 只能从签名辅助程序里调用。页面文字仅通过 stdin/stdout 在本机进程间传递。
class Translator {
  constructor() { this.child = null; this.buffer = ''; this.waiting = new Map(); }
  start() {
    if (this.child && !this.child.killed) return;
    const { app } = require('electron');
    const file = app.isPackaged ? path.join(process.resourcesPath, 'native', 'ArcoTranslate') : path.join(__dirname, '..', 'native', 'ArcoTranslate');
    if (!fs.existsSync(file)) throw new Error('本机翻译辅助程序尚未构建，请运行 npm run build:native');
    this.child = spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      for (let end; (end = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let response;
        try { response = JSON.parse(line); } catch { this.fail(new Error('翻译返回了无效响应')); continue; }
        const request = this.waiting.get(response.requestID);
        if (!request) continue;
        this.waiting.delete(response.requestID); clearTimeout(request.timer);
        response.ok ? request.resolve(response) : request.reject(new Error(String(response.error || '翻译失败')));
      }
    });
    this.child.on('error', () => this.fail(new Error('无法启动本机翻译')));
    this.child.on('exit', () => { this.fail(new Error('本机翻译已退出')); this.child = null; });
  }
  fail(error) { for (const request of this.waiting.values()) { clearTimeout(request.timer); request.reject(error); } this.waiting.clear(); }
  call(action, fields = {}, timeout = 120000) {
    this.start();
    const requestID = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(requestID); reject(new Error('翻译超时')); }, timeout);
      this.waiting.set(requestID, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ action, requestID, ...fields }) + '\n', error => {
        if (!error) return;
        clearTimeout(timer); this.waiting.delete(requestID); reject(new Error('翻译连接中断'));
      });
    });
  }
  detect(text) { return this.call('detect', { text }, 30000); }
  translate(source, texts) { return this.call('translate', { source, texts }); }
  dispose() { this.fail(new Error('翻译已关闭')); this.child?.kill(); this.child = null; }
}

module.exports = { Translator };
