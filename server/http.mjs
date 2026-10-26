import http from 'node:http';
import { Readable } from 'node:stream';
import worker from '../src/worker.mjs';
import { createAnalysisEncoder, negotiateEncoding } from './analysis-encoding.mjs';
const LIMIT = 3000000;
export function createHttpServer(runtime, { origin, allowLoopback = false } = {}) {
  const canonical = new URL(origin);
  const encoder = createAnalysisEncoder();
  return http.createServer(async (req, res) => {
    try {
      if (
        req.headers.host !== canonical.host &&
        !(
          allowLoopback &&
          ['127.0.0.1', 'localhost', '[::1]'].some((host) =>
            req.headers.host?.startsWith(host + ':')
          )
        )
      ) {
        res.writeHead(421);
        res.end('Invalid host');
        return;
      }
      if (!['GET', 'POST'].includes(req.method)) {
        res.writeHead(405);
        res.end();
        return;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMIT) {
          res.writeHead(413);
          res.end('Request too large');
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      // Trust only the local reverse proxy, never client-supplied Cloudflare headers.
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      headers.set(
        'CF-Connecting-IP',
        local
          ? req.headers['x-real-ip'] || req.socket.remoteAddress
          : req.socket.remoteAddress || 'unknown'
      );
      const target = new URL(req.url, canonical);
      if (target.origin !== canonical.origin) {
        res.writeHead(421);
        res.end('Invalid origin');
        return;
      }
      const request = new Request(target, {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {})
      });
      const response = await worker.fetch(request, runtime.env);
      if (
        response.status === 200 &&
        /^\/api\/v1\/(history\/analysis|jobs\/[a-f0-9]{64}\/analysis)$/.test(target.pathname) &&
        !response.headers.has('Content-Encoding')
      ) {
        const encoding = negotiateEncoding(req.headers['accept-encoding']);
        if (!encoding) {
          res.writeHead(406, { Vary: 'Accept-Encoding', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const body = Buffer.from(await response.arrayBuffer()),
          encoded = await encoder.encode(body, encoding),
          out = Object.fromEntries(response.headers);
        out.vary = [out.vary, 'Accept-Encoding'].filter(Boolean).join(', ');
        out['content-length'] = String(encoded.length);
        if (encoding !== 'identity') out['content-encoding'] = encoding;
        res.writeHead(response.status, out);
        res.end(encoded);
        return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent)
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"error":"服务暂不可用"}');
    }
  });
}
