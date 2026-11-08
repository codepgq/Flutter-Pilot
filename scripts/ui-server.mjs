import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const fixtureScript = `window.__messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m)});`;
createServer(async (req, res) => {
  const file =
    req.url === '/webview.js'
      ? 'dist/webview.js'
      : req.url === '/webview.css'
        ? 'dist/webview.css'
        : undefined;
  try {
    if (file) {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/css');
      res.end(await readFile(file));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/webview.css"></head><body><div id="root"></div><script>' +
          fixtureScript +
          '</script><script src="/webview.js"></script></body></html>',
      );
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
}).listen(4179, '127.0.0.1');
