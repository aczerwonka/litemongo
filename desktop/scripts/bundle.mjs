// Bundles the Electron main process AND the Fastify server into one file, so the
// packaged app needs no node_modules (electron-builder ships only dist/).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.mjs'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: [
    'electron',
    // Optional native/auth add-ons of the mongodb driver; not used by LiteMongo.
    'kerberos', '@mongodb-js/zstd', '@aws-sdk/credential-providers', 'gcp-metadata',
    'snappy', 'socks', 'mongodb-client-encryption',
  ],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
