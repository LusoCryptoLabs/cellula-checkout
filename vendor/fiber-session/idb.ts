// One IndexedDB store of keys for the browser host: the vault's key, the backup key and the
// access code. CryptoKeys are kept as they are, non-extractable.

function db(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keys')
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
}

export async function idbGet<T>(dbName: string, name: string): Promise<T | undefined> {
  const d = await db(dbName)
  return new Promise((resolve, reject) => {
    const get = d.transaction('keys').objectStore('keys').get(name)
    get.onsuccess = () => resolve(get.result as T | undefined)
    get.onerror = () => reject(get.error)
  })
}

export async function idbPut(dbName: string, name: string, value: unknown) {
  const d = await db(dbName)
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('keys', 'readwrite')
    tx.objectStore('keys').put(value, name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
