// Bundles the agent for a machine whose Node runs no TypeScript: dist/agent.mjs, a command with its
// version stamped in, and the signer's wasm in dist/signer/ (where nodeHost looks for it).
//   node scripts/build.mjs && node dist/agent.mjs --help
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
// The channel signer, compiled, is in vendor/fiber-session/signer/ (VENDORED.md). The bundle loads
// it at run time from signer/ beside it, so it is copied there.
const signerFiles = ['cellula_lsp_signer.js', 'cellula_lsp_signer_bg.wasm']
function copySigner(out) {
  const from = `${root}../../vendor/fiber-session/signer/`
  if (signerFiles.every((f) => existsSync(from + f))) {
    for (const f of signerFiles) copyFileSync(from + f, `${out}signer/${f}`)
  } else {
    console.log(`no signer in vendor/fiber-session/signer/: put ${signerFiles.join(' and ')} in ${out}signer/ before running`)
  }
}
const out = `${root}dist/`
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}signer`, { recursive: true })
await build({
  entryPoints: [`${root}src/server.ts`],
  outfile: `${out}agent.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate', './signer/*'],
  define: { __AGENT_VERSION__: JSON.stringify(version) },
  // A published package carries no source comments (they are working notes); names stay readable,
  // and the dependencies' licence comments stay at the end.
  minifyWhitespace: true,
  legalComments: 'eof',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
})
copySigner(out)
console.log(`built ${out}agent.mjs (${version})`)
