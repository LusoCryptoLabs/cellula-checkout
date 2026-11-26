// The agent relay as a service: its state in a JSON file, written a moment after each change, on
// 127.0.0.1 behind nginx (which sets X-Real-IP and TLS).
//   RELAY_PORT=8271 RELAY_STATE=/var/lib/agent-relay/state.json node dist/relay.mjs
// Optional: RELAY_ORIGINS (comma separated, the pages allowed from a browser), RELAY_NETWORK
// (testnet, the default, or mainnet).

import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ccc } from '@ckb-ccc/core'
import { relayHandler, type RelayState } from './relay.ts'

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
const port = Number(process.env.RELAY_PORT ?? 8271)
const file = process.env.RELAY_STATE ?? path.join(process.cwd(), 'relay-state.json')
const mainnet = process.env.RELAY_NETWORK === 'mainnet'
const origins = (process.env.RELAY_ORIGINS ?? (mainnet ? 'https://cellula.id' : 'https://testnet.cellula.id'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const state: RelayState = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { agents: {} }
let timer: NodeJS.Timeout | null = null
// Written whole to a file beside it and moved over, so a stop halfway leaves the last good state.
const save = () => {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(`${file}.new`, JSON.stringify(state))
    renameSync(`${file}.new`, file)
  }, 500)
}

const handler = relayHandler({ state, save, client: mainnet ? new ccc.ClientPublicMainnet() : new ccc.ClientPublicTestnet(), origins, addressPrefix: mainnet ? 'ckb' : 'ckt', log })
http.createServer(handler).listen(port, '127.0.0.1', () => log(`agent relay on 127.0.0.1:${port}, ${mainnet ? 'mainnet' : 'testnet'}, pages ${origins.join(' ')}, state ${file}`))
