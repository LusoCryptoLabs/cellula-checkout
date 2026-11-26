// Bundles the merchant for a server whose Node runs no TypeScript (session.ts is more than Node
// strips): one .mjs per entry, with the signer's wasm beside it where nodeHost looks for it.
//   node scripts/build.mjs              dist/merchant.mjs (the HTTP service, src/server.ts)
//   node scripts/build.mjs e2e          dist-e2e/e2e.mjs (scripts/e2e.ts)
//   node scripts/build.mjs payer        dist-payer/payer.mjs (scripts/payer.ts)
//   node scripts/build.mjs room         dist-room/room-drill.mjs (scripts/room-drill.ts)
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
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
const which = {
  e2e: { entry: 'scripts/e2e.ts', out: 'dist-e2e/', name: 'e2e.mjs' },
  payer: { entry: 'scripts/payer.ts', out: 'dist-payer/', name: 'payer.mjs' },
  room: { entry: 'scripts/room-drill.ts', out: 'dist-room/', name: 'room-drill.mjs' },
}[process.argv[2]] ?? { entry: 'src/server.ts', out: 'dist/', name: 'merchant.mjs' }
const out = `${root}${which.out}`
rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}signer`, { recursive: true })
await build({
  entryPoints: [`${root}${which.entry}`],
  outfile: `${out}${which.name}`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ws asks for these only when they are installed.
  external: ['bufferutil', 'utf-8-validate', './signer/*'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
})
copySigner(out)
console.log(`built ${out}${which.name}`)
