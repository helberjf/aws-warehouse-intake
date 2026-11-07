import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

/** Fixed asset allowlist: request input never becomes a filesystem path. */
export function registerFrontend(app: FastifyInstance) {
  const assets: Record<string, [string, string]> = {
    '/runtime-config.js': ['../../public/runtime-config.js', 'text/javascript; charset=utf-8'],
    '/preview.js': ['../../public/preview.js', 'text/javascript; charset=utf-8'],
    '/favicon.svg': ['../../public/favicon.svg', 'image/svg+xml'],
    '/demo-barcodes.html': ['../../public/demo-barcodes.html', 'text/html; charset=utf-8'],
    '/demo-barcodes.css': ['../../public/demo-barcodes.css', 'text/css; charset=utf-8'],
    '/': ['../../public/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['../../public/app.js', 'text/javascript; charset=utf-8'],
    '/scanner.js': ['../../public/scanner.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['../../public/styles.css', 'text/css; charset=utf-8'],
    '/vendor/zxing.js': [
      '../../node_modules/@zxing/browser/umd/zxing-browser.min.js',
      'text/javascript; charset=utf-8',
    ],
  };
  for (const [route, [path, contentType]] of Object.entries(assets)) {
    app.get(route, async (_request, reply) => {
      reply.type(contentType);
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
      return readFile(new URL(path, import.meta.url));
    });
  }
}
