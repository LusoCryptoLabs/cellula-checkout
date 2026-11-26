// The agent's settings: what the person decides is read from its command line or its environment,
// and a setting that would loosen the agent by mistake is refused at start.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readArgs, readConfig, readLocal } from '../src/config.ts'

const PERSON = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqgx5lf4pczpamsfam48evs0c8nvwqqa59qapt46f'
const base = { AGENT_DIR: '/tmp/agent', AGENT_KEY_FILE: '/tmp/agent/key', AGENT_API_KEY: 'k'.repeat(32), AGENT_PER_PAYMENT_CKB: '1', AGENT_TOTAL_CKB: '10', AGENT_RETURN_TO: PERSON, AGENT_APPROVAL_KEY: 'p'.repeat(48) }
const none = () => {
  throw new Error('no file')
}

test('the defaults: 20 CKB in the channel, on 127.0.0.1:8280, fetching the public internet only', () => {
  const c = readConfig(base, none)
  assert.deepEqual(
    { openCkb: c.openCkb, host: c.host, port: c.port, fetchPrivate: c.fetchPrivate },
    { openCkb: 20, host: '127.0.0.1', port: 8280, fetchPrivate: false },
  )
})

test('its files are in ~/.cellula-agent unless told, and ~ is the home in any path', () => {
  const home = path.join(path.sep, 'home', 'p')
  const dir = path.join(home, '.cellula-agent')
  const files: Record<string, string> = { [path.join(dir, 'api.key')]: `${'a'.repeat(64)}\n`, [path.join(home, 'keys', 'api')]: 'b'.repeat(64) }
  const read = (f: string) => {
    if (!(f in files)) throw new Error(`no file ${f}`)
    return files[f]!
  }
  const { AGENT_DIR: _d, AGENT_KEY_FILE: _k, AGENT_API_KEY: _a, ...plain } = base
  const c = readConfig(plain, read, home)
  assert.deepEqual({ dir: c.dir, keyFile: c.keyFile, apiKey: c.apiKey }, { dir, keyFile: path.join(dir, 'key'), apiKey: 'a'.repeat(64) })
  const told = readConfig({ ...plain, AGENT_DIR: '~/agent', AGENT_KEY_FILE: '~/keys/agent', AGENT_API_KEY_FILE: '~/keys/api' }, read, home)
  assert.deepEqual({ dir: told.dir, keyFile: told.keyFile, apiKey: told.apiKey }, { dir: path.join(home, 'agent'), keyFile: path.join(home, 'keys', 'agent'), apiKey: 'b'.repeat(64) })
  assert.throws(() => readConfig(plain, none, home), /run cellula-agent key first/, 'no API key yet')
})

test('the caps and the return address are required', () => {
  for (const name of ['AGENT_PER_PAYMENT_CKB', 'AGENT_TOTAL_CKB', 'AGENT_RETURN_TO']) {
    const env: Record<string, string> = { ...base }
    delete env[name]
    assert.throws(() => readConfig(env, none), new RegExp(`--[a-z-]+ \\(${name}\\) is not set`), name)
    assert.throws(() => readConfig({ ...base, [name]: '' }, none), new RegExp(`--[a-z-]+ \\(${name}\\) is not set`), `${name} empty`)
  }
})

// The line PowerShell, cmd and bash hand the agent alike: no shell sets a variable for one command
// the same way, so the settings ride on the line.
const LINE = ['--return-to', PERSON, '--per-payment', '1', '--total=10', '--day', '2', '--approve-above', '0.5', '--allow', 'api.example.com', '--open', '30', '--dir', '~/agent', '--port', '8281']

test('the settings on the command line stand for the environment variables', () => {
  const { command, env } = readArgs(LINE)
  assert.equal(command, undefined)
  assert.deepEqual(env, {
    AGENT_RETURN_TO: PERSON,
    AGENT_PER_PAYMENT_CKB: '1',
    AGENT_TOTAL_CKB: '10',
    AGENT_DAY_CKB: '2',
    AGENT_APPROVE_ABOVE_CKB: '0.5',
    AGENT_ALLOW: 'api.example.com',
    AGENT_OPEN_CKB: '30',
    AGENT_DIR: '~/agent',
    PORT: '8281',
  })
  const home = path.join(path.sep, 'home', 'p')
  const c = readConfig({ AGENT_API_KEY: 'k'.repeat(32), AGENT_APPROVAL_KEY: 'p'.repeat(48), ...env }, none, home)
  assert.deepEqual(
    { returnTo: c.returnTo, per: c.perPaymentCkb, total: c.totalCkb, day: c.dayCkb, above: c.approveAboveCkb, allow: c.allow, open: c.openCkb, dir: c.dir, port: c.port },
    { returnTo: PERSON, per: '1', total: '10', day: '2', above: '0.5', allow: ['api.example.com'], open: 30, dir: path.join(home, 'agent'), port: 8281 },
  )
  // A command anywhere on the line, and help and version as flags.
  assert.equal(readArgs(['key', '--dir', '~/agent']).command, 'key')
  assert.equal(readArgs(['--dir', '~/agent', 'key']).command, 'key')
  assert.equal(readArgs(['--help']).command, 'help')
  assert.equal(readArgs(['-v']).command, 'version')
})

test("the phone: the person's wallet named with --approver, the relay and page on https only", () => {
  const off = readConfig(base, none)
  assert.equal(off.approver, null, 'no phone unless asked')
  assert.equal(off.relay, 'https://agent-relay.lusocryptolabs.com')
  assert.equal(off.phonePage, 'https://testnet.cellula.id/agent')
  const { env } = readArgs(['--approver', PERSON])
  assert.equal(readConfig({ ...base, ...env }, none).approver, PERSON)
  assert.throws(() => readConfig({ ...base, AGENT_APPROVER: 'ckb1qmainnetaddress' }, none), /--approver \(AGENT_APPROVER\) is your testnet wallet's address/)
  assert.throws(() => readConfig({ ...base, AGENT_RELAY: 'http://relay.example' }, none), /AGENT_RELAY is an https address/)
  assert.throws(() => readConfig({ ...base, AGENT_PHONE_PAGE: 'javascript:alert(1)' }, none), /AGENT_PHONE_PAGE is an https address/)
  assert.equal(readConfig({ ...base, AGENT_RELAY: 'https://relay.example/' }, none).relay, 'https://relay.example', 'a trailing slash dropped')
})

test('status and take-out find the running agent with no caps given', () => {
  const home = path.join(path.sep, 'home', 'p')
  const read = (f: string) => {
    if (f !== path.join(home, '.cellula-agent', 'api.key')) throw new Error(`no file ${f}`)
    return `${'a'.repeat(64)}\n`
  }
  assert.deepEqual(readLocal({}, read, home), { base: 'http://127.0.0.1:8280', apiKey: 'a'.repeat(64) })
  assert.deepEqual(readLocal({ PORT: '8281', HOST: '::1' }, read, home), { base: 'http://[::1]:8281', apiKey: 'a'.repeat(64) })
  assert.throws(() => readLocal({}, none, home), /run cellula-agent key first/)
  assert.throws(() => readLocal({ HOST: '0.0.0.0' }, read, home), /HOST is/)
})

test('a line the agent cannot read is refused, not guessed', () => {
  assert.throws(() => readArgs(['--per-paymnt', '1']), /^Error: no setting --per-paymnt: cellula-agent --help lists them$/, 'a misspelt setting')
  assert.throws(() => readArgs(['--total']), /^Error: --total needs a value, as in --total 1$/, 'a setting with no value')
  assert.throws(() => readArgs(['--total', '-1']), /^Error: --total needs a value/, 'a value that reads as a flag')
  assert.throws(() => readArgs(['key', 'run']), /one command/, 'two commands')
  // Empty, as `--allow=$SELLERS` gives it with the variable unset: a limit is not quietly off.
  for (const flag of ['--allow=', '--approve-above=', '--day=', '--day= ']) assert.throws(() => readArgs([flag]), /is empty: give it a value, or leave it out/, flag)
  assert.throws(() => readConfig({ ...base, AGENT_ALLOW: ' , ' }, none), /--allow \(AGENT_ALLOW\) names no seller/, 'a list of nothing')
  // A missing cap is told by its flag, the way the person gave the others.
  assert.throws(() => readConfig({ ...base, AGENT_TOTAL_CKB: '' }, none), /--total \(AGENT_TOTAL_CKB\) is not set/)
})

test('caps and the return address as the person writes them', () => {
  const c = readConfig({ ...base, AGENT_PER_PAYMENT_CKB: '0.5', AGENT_TOTAL_CKB: '10', AGENT_OPEN_CKB: '50' }, none)
  assert.equal(c.perPaymentCkb, '0.5')
  assert.equal(c.totalCkb, '10')
  assert.equal(c.openCkb, 50)
  assert.equal(c.returnTo, PERSON)
  const { AGENT_API_KEY: _, ...noKey } = base
  assert.equal(readConfig({ ...noKey, AGENT_API_KEY_FILE: '/k' }, () => `${'f'.repeat(20)}\n`).apiKey, 'f'.repeat(20), 'the API key from a file')
})

test('the API stays on this machine; fetching inside it is the person\'s choice', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) assert.equal(readConfig({ ...base, HOST: host }, none).host, host)
  for (const host of ['0.0.0.0', '192.168.1.20', '::', 'agent.example.com']) assert.throws(() => readConfig({ ...base, HOST: host }, none), /HOST is/, host)
  assert.equal(readConfig({ ...base, AGENT_FETCH_PRIVATE: '1' }, none).fetchPrivate, true)
  assert.equal(readConfig({ ...base, AGENT_FETCH_PRIVATE: '0' }, none).fetchPrivate, false)
  assert.throws(() => readConfig({ ...base, AGENT_FETCH_PRIVATE: 'true' }, none), /AGENT_FETCH_PRIVATE/)
})

test('the 24-hour cap, the allowed sellers and payees, and the approval amount are optional', () => {
  const none_ = readConfig(base, none)
  assert.deepEqual({ day: none_.dayCkb, allow: none_.allow, above: none_.approveAboveCkb }, { day: null, allow: null, above: null })
  const key = '02' + 'ab'.repeat(32)
  const c = readConfig({ ...base, AGENT_DAY_CKB: '2', AGENT_ALLOW: ' API.example.com, 0x' + key + ',', AGENT_APPROVE_ABOVE_CKB: '0.5' }, none)
  assert.equal(c.dayCkb, '2')
  assert.deepEqual(c.allow, ['api.example.com', `0x${key}`])
  assert.equal(c.approveAboveCkb, '0.5')
  assert.throws(() => readConfig({ ...base, AGENT_APPROVE_ABOVE_CKB: '1' }, none), /no payment would ever wait/, 'at the per-payment cap')
  assert.throws(() => readConfig({ ...base, AGENT_ALLOW: 'https://api.example.com/x' }, none), /AGENT_ALLOW/, 'a URL, not a host')
  for (const bad of ['api..example.com', 'api example.com', '*.example.com']) assert.throws(() => readConfig({ ...base, AGENT_ALLOW: bad }, none), /AGENT_ALLOW/, bad)
  assert.throws(() => readConfig({ ...base, AGENT_DAY_CKB: 'two' }, none), /AGENT_DAY_CKB/)
  const { AGENT_APPROVAL_KEY: _, ...noApprovalKey } = base
  assert.throws(() => readConfig(noApprovalKey, none), /AGENT_APPROVAL_KEY/)
})

test('settings that would loosen the agent by mistake are refused', () => {
  const refused = (env: Record<string, string>) => assert.throws(() => readConfig({ ...base, ...env }, none), Error, JSON.stringify(env))
  refused({ AGENT_API_KEY: 'short' })
  refused({ AGENT_PER_PAYMENT_CKB: 'one' })
  refused({ AGENT_TOTAL_CKB: '-1' })
  refused({ AGENT_TOTAL_CKB: '1.123456789' })
  refused({ AGENT_RETURN_TO: 'ckb1qmainnetaddress' })
  refused({ AGENT_OPEN_CKB: '5' })
  refused({ AGENT_OPEN_CKB: '2000' })
})
