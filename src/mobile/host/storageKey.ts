/**
 * The key saved credentials are sealed with.
 *
 * The key itself is random bytes, held only in the worker's memory. What is
 * kept between launches is that key encrypted under a second one the browser
 * generated as non-extractable — so nothing in storage, read as a file, is a
 * usable key. That is the WebView's nearest thing to the OS keychain Electron's
 * `safeStorage` sits on.
 */

const DB = 'quoth-keys'
const STORE = 'keys'

interface Sealed {
  wrapping: CryptoKey
  iv: Uint8Array<ArrayBuffer>
  data: ArrayBuffer
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB, 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE)
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
}

function get(db: IDBDatabase): Promise<Sealed | undefined> {
  return new Promise((resolve, reject) => {
    const reading = db.transaction(STORE, 'readonly').objectStore(STORE).get('storage')
    reading.onsuccess = () => resolve(reading.result as Sealed | undefined)
    reading.onerror = () => reject(reading.error)
  })
}

function put(db: IDBDatabase, sealed: Sealed): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(sealed, 'storage')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function loadStorageKey(): Promise<Uint8Array> {
  const db = await open()
  try {
    const existing = await get(db)
    if (existing) {
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: existing.iv }, existing.wrapping, existing.data)
      return new Uint8Array(raw)
    }
    const wrapping = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const key = crypto.getRandomValues(new Uint8Array(32))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapping, key)
    await put(db, { wrapping, iv, data })
    return key
  } finally {
    db.close()
  }
}
