// Bundles the shop for a server whose Node runs no TypeScript: dist/shop.mjs, the signer's wasm in
// dist/signer/ (where nodeHost looks for it) and the page in dist/public/.
//   node scripts/build.mjs && SHOP_DIR=... SHOP_KEY_FILE=... node dist/shop.mjs
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
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
rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}signer`, { recursive: true })
await build({
  entryPoints: [`${root}src/server.ts`],
  outfile: `${out}shop.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate', './signer/*'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
})
copySigner(out)
cpSync(`${root}public`, `${out}public`, { recursive: true })
console.log(`built ${out}shop.mjs`)
