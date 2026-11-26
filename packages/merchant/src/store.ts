// A JSON file written whole, to a temporary name and renamed into place, one write at a time:
// a crash leaves the old file or the new one, never half of one.

import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'

export class JsonFile<T> {
  file: string
  value: T
  private writing: Promise<void> = Promise.resolve()

  constructor(file: string, empty: () => T) {
    this.file = file
    this.value = existsSync(file) ? { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) } : empty()
  }

  /** Writes the value as it is when this write's turn comes. */
  save(): Promise<void> {
    const run = this.writing.then(async () => {
      // Its owner's alone (on POSIX; on Windows the folder's rights apply): payments and receipts.
      await writeFile(`${this.file}.tmp`, JSON.stringify(this.value, null, 1), { mode: 0o600 })
      await rename(`${this.file}.tmp`, this.file)
    })
    this.writing = run.catch(() => {})
    return run
  }
}
