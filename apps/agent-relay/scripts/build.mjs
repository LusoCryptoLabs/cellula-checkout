// Bundles the relay for a server whose Node runs no TypeScript: dist/relay.mjs.
//   node scripts/build.mjs && RELAY_STATE=... node dist/relay.mjs
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = `${root}dist/`
rmSync(out, { recursive: true, force: true })
await build({
  entryPoints: [`${root}src/server.ts`],
  outfile: `${out}relay.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
})
console.log(`built ${out}relay.mjs`)
