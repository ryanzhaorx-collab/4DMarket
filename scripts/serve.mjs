#!/usr/bin/env node
/** 零依赖静态服务器：用于真机预览 / 小程序 web-view 联调（默认 5178 端口）。 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.join(projectRoot, 'dist');
const modelsRoot = path.join(projectRoot, 'models');
const port = Number(process.env.PORT ?? 5178);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.splat': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

if (!fs.existsSync(root)) {
  console.error(`[serve] 未找到 ${root}，请先执行 npm run build`);
  process.exit(1);
}

/** /__proxy/https/host/path → https://host/path（与本机开发服务器同一套规则，方便真机联调） */
async function handleProxy(raw, res) {
  const target = raw.slice('/__proxy/'.length).replace(/^([a-z]+)\//i, '$1://');
  try {
    const upstream = await fetch(target, { redirect: 'follow' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`proxy error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

http
  .createServer((req, res) => {
    const rawUrl = (req.url ?? '').split('?')[0];
    if (rawUrl.startsWith('/models/')) {
      const file = path.join(projectRoot, decodeURIComponent(rawUrl));
      if (!file.startsWith(modelsRoot)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404).end('404');
          return;
        }
        res.writeHead(200, {
          'content-type': path.extname(file) === '.json' ? 'application/json' : 'application/octet-stream',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        });
        res.end(buf);
      });
      return;
    }
    if ((req.url ?? '').startsWith('/__proxy/')) {
      handleProxy(decodeURIComponent(req.url ?? ''), res);
      return;
    }
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(root, url === '/' ? 'index.html' : url);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag }).end();
        return;
      }
      fs.readFile(file, (err2, buf) => {
        if (err2) {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
          etag,
          'access-control-allow-origin': '*',
        });
        res.end(buf);
      });
    });
  })
  .listen(port, '0.0.0.0', () => {
    console.log(`[serve] http://127.0.0.1:${port}  (LAN: http://<本机IP>:${port})`);
  });
