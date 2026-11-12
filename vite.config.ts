import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 开发期资产代理：绕过 3D Tiles / PLY 服务器没有 CORS 的限制。
 *
 *   /__proxy/https/host.com/path/tileset.json
 *     → https://host.com/path/tileset.json
 *
 * tileset.json 里的相对路径（content.uri）会按同一条代理规则继续解析，
 * 所以整棵瓦片树都能被透明代理，不需要改写文件内容。
 * 生产环境请在瓦片服务器上直接放开 Access-Control-Allow-Origin。
 */
function assetProxy(): Plugin {
  return {
    name: 'dsh-asset-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/__proxy/')) {
          next();
          return;
        }
        const target = url.slice('/__proxy/'.length).replace(/^([a-z]+)\//i, '$1://');
        try {
          const upstream = await fetch(target, { redirect: 'follow' });
          const buf = Buffer.from(await upstream.arrayBuffer());
          res.statusCode = upstream.status;
          res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
          res.setHeader('access-control-allow-origin', '*');
          res.setHeader('cache-control', 'no-store');
          res.end(buf);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`proxy error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    },
  };
}

/**
 * 本地真实模型目录：`models/` 不进 dist、不进小程序包，
 * 只在本机开发/预览时通过 /models/ 提供，方便反复调你的模型。
 */
function modelsDir(): Plugin {
  const root = path.join(process.cwd(), 'models');
  return {
    name: 'dsh-models',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/models/')) return next();
        const file = path.join(process.cwd(), decodeURIComponent(url));
        if (!file.startsWith(root)) return next();
        fs.readFile(file, (err, buf) => {
          if (err) {
            res.statusCode = 404;
            res.end('404');
            return;
          }
          const ext = path.extname(file);
          res.setHeader('content-type', ext === '.json' ? 'application/json' : 'application/octet-stream');
          res.setHeader('cache-control', 'no-cache');
          res.end(buf);
        });
      });
    },
  };
}

// 让构建产物可以直接被 WebView / 小程序 web-view 以相对路径托管（可放在任意子目录）。
export default defineConfig({
  base: './',
  plugins: [assetProxy(), modelsDir()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 4096,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: 'index.html',
        pc: 'pc.html',
      },
      output: {
        manualChunks: undefined,
        entryFileNames: 'assets/app.[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5178,
    strictPort: true,
  },
});
