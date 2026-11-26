// The npm package `cellula-agent`, made in apps/agent/npm/ from a fresh build: the bundle, the
// signer, NPM.md as its README and the repository's licence. Nothing else goes in: no sources.
//   node scripts/pack.mjs && cd npm && npm pack --dry-run      (the person runs npm publish there)
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = `${root}npm/`
execFileSync(process.execPath, [`${root}scripts/build.mjs`], { stdio: 'inherit' })
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(`${root}dist`, `${out}dist`, { recursive: true })
copyFileSync(`${root}NPM.md`, `${out}README.md`)
copyFileSync(`${root}../../LICENSE`, `${out}LICENSE`)
writeFileSync(
  `${out}package.json`,
  `${JSON.stringify(
    {
      name: 'cellula-agent',
      version,
      description: "An AI agent's own Fiber balance on the CKB test network: it pays APIs (HTTP 402) within limits you set, and waits for your approval above an amount.",
      type: 'module',
      bin: { 'cellula-agent': 'dist/agent.mjs' },
      files: ['dist', 'README.md', 'LICENSE'],
      engines: { node: '>=20' },
      license: 'MIT',
      homepage: 'https://testnet.cellula.id/agent',
      keywords: ['fiber', 'ckb', 'nervos', 'x402', 'http-402', 'ai-agent', 'agent-payments', 'mcp', 'payments', 'testnet'],
    },
    null,
    2,
  )}\n`,
)
console.log(`npm package cellula-agent ${version} in ${out}`)
