// The agent's settings, from its command line or its environment: everything the person decides is
// here, nothing comes from the API. Read in one place so a test can check what is refused. The caps
// and the return address are required: an agent started without them could spend its whole balance,
// and a taken-out balance would stay with the agent's key. Its files are in ~/.cellula-agent unless
// told (`cellula-agent key` makes the key and the API key there).

import { homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { LOOPBACK_HOSTS } from '../../../packages/merchant/src/agent-http.ts'
import { shannonsOf } from '../../../packages/merchant/src/amount.ts'

export type AgentConfig = {
  dir: string
  keyFile: string
  apiKey: string
  /** The person's address the balance goes back to. */
  returnTo: string
  openCkb: number
  perPaymentCkb: string
  totalCkb: string
  port: number
  host: string
  /** /v1/fetch may reach this machine and its network: for testing a seller here. */
  fetchPrivate: boolean
  /** The most in any 24 hours; null: only the other caps. */
  dayCkb: string | null
  /** Sellers' host names and payees' node keys it may pay; null: any. */
  allow: string[] | null
  /** A payment above this waits for the person's approval; null: none waits. */
  approveAboveCkb: string | null
  /** The approvals page's key, made fresh by the agent at each start and printed only there. */
  approvalKey: string
  gateway: string | undefined
  /** The person's wallet address, whose signatures approve and command from the phone; null: no phone. */
  approver: string | null
  /** The relay to the phone (apps/agent-relay), and the page the person keeps. */
  relay: string
  phonePage: string
}

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const NODE_KEY = /^(0x)?0[23][0-9a-f]{64}$/

/**
 * The settings a person can give on the command line, each with the environment variable it stands
 * for. One line that reads the same in bash, PowerShell and cmd, which have no `NAME=value command`
 * in common.
 */
export const FLAGS: Readonly<Record<string, string>> = {
  'return-to': 'AGENT_RETURN_TO',
  'per-payment': 'AGENT_PER_PAYMENT_CKB',
  total: 'AGENT_TOTAL_CKB',
  day: 'AGENT_DAY_CKB',
  'approve-above': 'AGENT_APPROVE_ABOVE_CKB',
  allow: 'AGENT_ALLOW',
  open: 'AGENT_OPEN_CKB',
  dir: 'AGENT_DIR',
  port: 'PORT',
  approver: 'AGENT_APPROVER',
}

/** A setting as the person may have given it: its flag, and the variable it stands for. */
const said = (name: string) => {
  const flag = Object.keys(FLAGS).find((f) => FLAGS[f] === name)
  return flag ? `--${flag} (${name})` : name
}

/**
 * The command on the line (key, run, help, version, or none) and the settings given there, as the
 * environment variables they stand for. A setting on the line wins over the same one in the
 * environment.
 */
export function readArgs(args: string[]): { command: string | undefined; env: Record<string, string> } {
  const options = Object.fromEntries(Object.keys(FLAGS).map((f) => [f, { type: 'string' as const }]))
  let parsed
  try {
    parsed = parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } }, allowPositionals: true })
  } catch (e) {
    // Said in the agent's words: node's own speak of positionals and '--'.
    const flag = /'(-[^' <]+)/.exec(e instanceof Error ? e.message : '')?.[1] ?? ''
    const code = (e as { code?: string }).code
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw new Error(`no setting ${flag}: cellula-agent --help lists them`)
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw new Error(`${flag} needs a value, as in ${flag} 1`)
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  const { values, positionals } = parsed
  if (positionals.length > 1) throw new Error(`one command at a time, not ${positionals.join(' ')}`)
  const env: Record<string, string> = {}
  for (const [flag, name] of Object.entries(FLAGS)) {
    const v = (values as Record<string, unknown>)[flag]
    // Given empty, as `--allow=$SELLERS` with the variable unset gives it, a limit would quietly
    // be off: refused instead.
    if (typeof v === 'string' && !v.trim()) throw new Error(`--${flag} is empty: give it a value, or leave it out`)
    if (typeof v === 'string') env[name] = v
  }
  const command = values.help ? 'help' : values.version ? 'version' : positionals[0]
  return { command, env }
}

/** Where the agent keeps its files unless told: the key, the API key, the channel and payments. */
export const defaultDir = (home = homedir()) => path.join(home, '.cellula-agent')

/** A path as a person writes it: `~/` is their home, as a shell would have read it. */
export function homePath(p: string, home = homedir()): string {
  return p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p
}

/** The agent's files and its API's key, as the run and the commands beside it find them. */
function local(env: Record<string, string | undefined>, read: (file: string) => string, home: string) {
  const dir = env.AGENT_DIR ? homePath(env.AGENT_DIR, home) : defaultDir(home)
  const keyFile = env.AGENT_KEY_FILE ? homePath(env.AGENT_KEY_FILE, home) : path.join(dir, 'key')
  const apiKeyFile = env.AGENT_API_KEY_FILE ? homePath(env.AGENT_API_KEY_FILE, home) : path.join(dir, 'api.key')
  let apiKey = env.AGENT_API_KEY
  if (apiKey === undefined) {
    try {
      apiKey = read(apiKeyFile).trim()
    } catch {
      throw new Error(`no API key at ${apiKeyFile}: run cellula-agent key first, or set AGENT_API_KEY_FILE`)
    }
  }
  if (apiKey.length < 16) throw new Error('AGENT_API_KEY (or AGENT_API_KEY_FILE) must hold a key of 16 characters or more')
  const port = Number(env.PORT ?? 8280)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${said('PORT')} is a port number`)
  const host = env.HOST || '127.0.0.1'
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error(`HOST is ${LOOPBACK_HOSTS.join(', ')}: the API's key goes in plain HTTP, so it stays on this machine`)
  return { dir, keyFile, apiKey, port, host }
}

/** Where `cellula-agent status` and `take-out` find the running agent: its API on this machine, and its key. */
export function readLocal(env: Record<string, string | undefined>, read: (file: string) => string, home = homedir()): { base: string; apiKey: string } {
  const { apiKey, port, host } = local(env, read, home)
  return { base: `http://${host === '::1' ? '[::1]' : host}:${port}`, apiKey }
}

export function readConfig(env: Record<string, string | undefined>, read: (file: string) => string, home = homedir()): AgentConfig {
  const { dir, keyFile, apiKey, port, host } = local(env, read, home)
  const openCkb = Number(env.AGENT_OPEN_CKB ?? 20)
  if (!Number.isInteger(openCkb) || openCkb < 10 || openCkb > 1000) throw new Error(`${said('AGENT_OPEN_CKB')} is a whole number of CKB from 10 to 1,000`)
  const amount = (name: string, what: string) => {
    const v = env[name]
    if (v == null || v === '') throw new Error(`${said(name)} is not set: ${what}`)
    if (!/^\d+(\.\d{1,8})?$/.test(v)) throw new Error(`${said(name)} is a CKB amount, like 0.5`)
    return v
  }
  const perPaymentCkb = amount('AGENT_PER_PAYMENT_CKB', 'the most one payment can be, in CKB')
  const totalCkb = amount('AGENT_TOTAL_CKB', 'the most all payments together can be, in CKB')
  const returnTo = env.AGENT_RETURN_TO
  if (!returnTo) throw new Error(`${said('AGENT_RETURN_TO')} is not set: your testnet address, where a taken-out balance goes`)
  if (!/^ckt1[0-9a-z]+$/.test(returnTo)) throw new Error(`${said('AGENT_RETURN_TO')} is a testnet address (ckt1...)`)
  const fetchPrivate = env.AGENT_FETCH_PRIVATE ?? ''
  if (!['', '0', '1'].includes(fetchPrivate)) throw new Error('AGENT_FETCH_PRIVATE is 1 (fetch on this machine and its network too) or unset')
  const optional = (name: string) => (env[name] ? amount(name, '') : null)
  const dayCkb = optional('AGENT_DAY_CKB')
  const approveAboveCkb = optional('AGENT_APPROVE_ABOVE_CKB')
  if (approveAboveCkb !== null && shannonsOf(approveAboveCkb) >= shannonsOf(perPaymentCkb))
    throw new Error(`${said('AGENT_APPROVE_ABOVE_CKB')} is at or above ${said('AGENT_PER_PAYMENT_CKB')}: no payment would ever wait for you`)
  const allow = env.AGENT_ALLOW
    ? env.AGENT_ALLOW.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : null
  if (allow && !allow.length) throw new Error(`${said('AGENT_ALLOW')} names no seller: leave it out to let it pay any`)
  for (const entry of allow ?? [])
    if (!HOST_NAME.test(entry) && !NODE_KEY.test(entry)) throw new Error(`${said('AGENT_ALLOW')} holds sellers' host names and payees' node keys (66 hex), separated by commas: not ${entry}`)
  const approver = env.AGENT_APPROVER || null
  if (approver !== null && !/^ckt1[0-9a-z]+$/.test(approver)) throw new Error(`${said('AGENT_APPROVER')} is your testnet wallet's address (ckt1...)`)
  for (const [name, v] of [['AGENT_RELAY', env.AGENT_RELAY], ['AGENT_PHONE_PAGE', env.AGENT_PHONE_PAGE]] as const)
    if (v && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v)) throw new Error(`${name} is an https address`)
  const approvalKey = env.AGENT_APPROVAL_KEY ?? ''
  if (approvalKey.length < 16) throw new Error('AGENT_APPROVAL_KEY is made by the agent when it starts: start it with cellula-agent')
  return {
    dir,
    keyFile,
    apiKey,
    returnTo,
    openCkb,
    perPaymentCkb,
    totalCkb,
    port,
    host,
    fetchPrivate: fetchPrivate === '1',
    dayCkb,
    allow: allow?.length ? allow : null,
    approveAboveCkb,
    approvalKey,
    gateway: env.FIBER_GATEWAY,
    approver,
    relay: (env.AGENT_RELAY || 'https://agent-relay.lusocryptolabs.com').replace(/\/$/, ''),
    phonePage: (env.AGENT_PHONE_PAGE || 'https://testnet.cellula.id/agent').replace(/\/$/, ''),
  }
}
