// The agent's folder is kept to its owner. On Windows the folder is first opened to every account
// (Users, read), as a folder on a second drive inherits it, and then must be the owner's and SYSTEM's alone,
// files already in it, files made later and a file outside it included, and still readable by the
// agent. Elsewhere, the modes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { keepPrivate } from '../src/private-dir.ts'

const USERS = 'S-1-5-32-545'
const SYSTEM = 'S-1-5-18'

/** Who may do anything to it, by SID. */
const sids = (p: string): string[] =>
  execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Acl -LiteralPath '${p}').Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }`], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()

test('on Windows, only the owner and SYSTEM, and the agent still reads its files', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-private-'))
  const dir = path.join(root, 'agent')
  mkdirSync(path.join(dir, 'sub'), { recursive: true })
  // As on a second drive: every account may read what is made here.
  execFileSync('icacls', [root, '/grant', `*${USERS}:(OI)(CI)R`, '/Q'])
  writeFileSync(path.join(dir, 'key'), 'k')
  writeFileSync(path.join(dir, 'sub', 'channel.json'), '{}')
  const lone = path.join(root, 'api.key')
  writeFileSync(lone, 'a')
  assert.ok(sids(path.join(dir, 'key')).includes(USERS), 'control: before, every account may read the key')

  keepPrivate(dir)
  keepPrivate(lone)
  writeFileSync(path.join(dir, 'agent.json'), '{}')

  const me = execFileSync('powershell', ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).trim()
  for (const p of [dir, path.join(dir, 'key'), path.join(dir, 'sub', 'channel.json'), path.join(dir, 'agent.json'), lone])
    assert.deepEqual(sids(p), [me, SYSTEM].sort(), p)
  assert.equal(readFileSync(path.join(dir, 'key'), 'utf8'), 'k')
  assert.equal(readFileSync(path.join(dir, 'sub', 'channel.json'), 'utf8'), '{}')
  assert.equal(readFileSync(lone, 'utf8'), 'a')
})

test('elsewhere, the folder 0700 and its files 0600', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-private-'))
  writeFileSync(path.join(dir, 'key'), 'k', { mode: 0o644 })
  keepPrivate(dir)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(dir, 'key')).mode & 0o777, 0o600)
})
