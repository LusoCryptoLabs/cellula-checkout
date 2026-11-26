// The agent's folder holds its key, its API key and its channel's sealed state: only its owner may
// read it. On Windows a file's mode means nothing, and a folder outside the home inherits "Users:
// read" (seen on a second drive, 2026-11-01, where every account on the machine could read the key), so the
// access list is set to its owner and SYSTEM, inherited by what is made in it later. Elsewhere the
// folder is made 0700 and a file 0600.

import { execFileSync } from 'node:child_process'
import { chmodSync, readdirSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'

/** SYSTEM, by its SID: its name is translated on a Windows in another language. */
const SYSTEM = '*S-1-5-18'

export function keepPrivate(target: string, platform: string = process.platform): void {
  const folder = statSync(target).isDirectory()
  if (platform !== 'win32') {
    chmodSync(target, folder ? 0o700 : 0o600)
    if (folder) for (const f of readdirSync(target)) if (statSync(path.join(target, f)).isFile()) chmodSync(path.join(target, f), 0o600)
    return
  }
  const domain = process.env.USERDOMAIN
  const me = domain ? `${domain}\\${userInfo().username}` : userInfo().username
  const icacls = (args: string[]) => execFileSync('icacls', [...args, '/Q'], { stdio: 'ignore', windowsHide: true })
  // Only the owner and SYSTEM, what came from the folder above dropped, and handed on to what is
  // made in it ((OI)(CI), for a folder only).
  const inherit = folder ? '(OI)(CI)' : ''
  icacls([target, '/inheritance:r', '/grant:r', `${me}:${inherit}F`, `${SYSTEM}:${inherit}F`])
  // What is in it already takes the folder's list. Not /T on the line above: it put the folder's
  // flags on the files and left them readable by nobody, the agent included (seen 2026-11-01).
  if (folder && readdirSync(target).length) icacls([path.join(target, '*'), '/reset', '/T'])
}
