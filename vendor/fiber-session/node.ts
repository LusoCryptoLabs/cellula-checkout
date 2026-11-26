// The server host: values in one JSON file, written whole and renamed into place, and a signer
// that is always there (a merchant's purse). No passkey: the file is the channel,
// so it sits where the server keeps its other keys. One process per file; nothing here stops a
// second one, which could sign twice.

import { readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Host, Store } from './host.ts'

export type NodeHostOptions = {
  /** The channel's state, invoices and secrets, in the clear. */
  file: string
  /** What starting over means for this server; by default the process exits for its supervisor. */
  restart?: () => void
}

// One signer module per process. The wasm glue keeps only the last instance it made, and checks for
// one only before it awaits, so sessions starting together in one process (the load test's tenants,
// a server with several purses) each made one and then read the wrong memory: seen 2026-10-23,
// "RuntimeError: memory access out of bounds" in the signer, five tenants to a process.
let signerReady: Promise<void> | undefined

export function nodeHost(options: NodeHostOptions): Host {
  const { file } = options
  let values: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  let writing: Promise<void> = Promise.resolve()
  // One write at a time, each of the values as they are when its turn comes.
  const flush = () => {
    const run = writing.then(async () => {
      await writeFile(`${file}.tmp`, JSON.stringify(values, null, 1))
      await rename(`${file}.tmp`, file)
    })
    writing = run.catch(() => {})
    return run
  }

  const store: Store = {
    async get(name) {
      return values[name]
    },
    async set(name, value) {
      values = { ...values, [name]: value }
      await flush()
    },
    async remove(name) {
      const { [name]: _, ...rest } = values
      values = rest
      await flush()
    },
    async move(from, to) {
      const { [from]: value, ...rest } = values
      values = value === undefined ? rest : { ...rest, [to]: value }
      await flush()
    },
    async names(prefix) {
      return Object.keys(values).filter((k) => k.startsWith(prefix))
    },
  }

  return {
    store,
    presence: {
      onAway() {},
      onBack() {},
      visible: () => true,
      beacon(url, body) {
        void fetch(url, { method: 'POST', body }).catch(() => {})
      },
      async holdScreen() {},
    },
    acquire: async () => ({ held: true, release() {} }),
    restart: options.restart ?? (() => process.exit(75)),
    initSigner: (init) =>
      (signerReady ??= readFile(fileURLToPath(new URL('./signer/cellula_lsp_signer_bg.wasm', import.meta.url))).then(async (wasm) => {
        await init({ module_or_path: wasm })
      }).catch((e) => {
        signerReady = undefined // a failed load is tried again by the next session
        throw e
      })),
  }
}

/** Read back what a store file holds, for tools and tests. */
export const readStore = async (file: string): Promise<Record<string, string>> => JSON.parse(await readFile(file, 'utf8'))
