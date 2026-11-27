import { describe, it, expect, beforeEach, vi } from 'vitest'
import nodeCrypto from 'node:crypto'
import { Buffer as BrowserBuffer } from 'buffer/index.js'
import { MobileFs, MemoryBlobStore } from '../mobileFs.js'
import { installRuntime, settleShell } from '../runtime.js'
import type { HostToPage, ShellRequest } from '../../protocol.js'
import { addBase64Url } from '../base64url.js'
import { createHash, randomBytes } from './crypto.js'
import { dialog, safeStorage, shell, BrowserWindow, EXPORTS, TEMP, DOCUMENTS } from './electron.js'
import { watch } from './chokidar.js'
import { lookup } from './dns.js'

let fs: MobileFs
/** Each request the host made of the page, answered by whatever the test queued. */
let asked: ShellRequest[]
let answers: unknown[]

beforeEach(async () => {
  fs = await MobileFs.open(new MemoryBlobStore(), { persistent: [], eager: () => true })
  for (const root of [EXPORTS, TEMP, DOCUMENTS]) fs.mkdirSync(root, { recursive: true })
  asked = []
  answers = []
  installRuntime({
    fs,
    init: { native: true, locale: 'en-GB', version: '1.2.3', redirectUri: 'quoth://auth' },
    storageKey: new Uint8Array(32).fill(7),
    post: (message: HostToPage) => {
      if (message.type !== 'shell') return
      asked.push(message.request)
      const value = answers.shift()
      queueMicrotask(() => settleShell(message.id, { ok: true, value: value ?? null }))
    }
  })
})

describe('crypto', () => {
  it.each(['sha256', 'sha1'])('hashes %s the way Node does', (algorithm) => {
    const text = 'The raven kept its own counsel.'
    expect(createHash(algorithm).update(text).digest('hex')).toBe(
      nodeCrypto.createHash(algorithm).update(text).digest('hex')
    )
  })

  it('says so rather than returning a wrong digest for an algorithm it lacks', () => {
    expect(() => createHash('md5')).toThrowError(/md5/)
  })

  it('returns as many random bytes as were asked for', () => {
    expect(randomBytes(32)).toHaveLength(32)
    expect(randomBytes(32).equals(randomBytes(32))).toBe(false)
  })
})

describe('base64url on the browser Buffer', () => {
  addBase64Url(BrowserBuffer as never)

  it('matches Node in both directions', () => {
    // Bytes chosen to produce every character the two alphabets disagree on, and padding.
    const bytes = [251, 255, 254, 62, 63, 250, 1]
    const expected = Buffer.from(bytes).toString('base64url')
    expect(BrowserBuffer.from(bytes).toString('base64url' as never)).toBe(expected)
    expect([...BrowserBuffer.from(expected, 'base64url' as never)]).toEqual(bytes)
  })

  it('leaves the encodings it already had alone', () => {
    expect(BrowserBuffer.from('héllo', 'utf8').toString('hex')).toBe(Buffer.from('héllo', 'utf8').toString('hex'))
  })
})

describe('safeStorage', () => {
  it('seals a secret so that it is not readable in what is stored, and opens it again', () => {
    const sealed = safeStorage.encryptString('refresh-token-value')
    expect(sealed.toString('latin1')).not.toContain('refresh-token-value')
    expect(safeStorage.decryptString(sealed)).toBe('refresh-token-value')
  })

  it('never seals the same secret to the same bytes twice', () => {
    expect(safeStorage.encryptString('same').equals(safeStorage.encryptString('same'))).toBe(false)
  })

  it('refuses bytes that were tampered with', () => {
    const sealed = safeStorage.encryptString('refresh-token-value')
    sealed[sealed.length - 1]! ^= 1
    expect(() => safeStorage.decryptString(sealed)).toThrow()
  })
})

describe('dialog', () => {
  it('puts picked files where the caller can read them by path', async () => {
    answers.push([{ name: 'chapter.docx', bytes: new Uint8Array([1, 2, 3]) }])
    const result = await dialog.showOpenDialog(null, {
      title: 'Import from Word',
      filters: [{ name: 'Word', extensions: ['docx'] }],
      properties: ['openFile', 'multiSelections']
    })
    expect(asked[0]).toMatchObject({ op: 'pickFiles', extensions: ['docx'], multiple: true })
    expect(result.canceled).toBe(false)
    expect([...(fs.readFileSync(result.filePaths[0]!) as Uint8Array)]).toEqual([1, 2, 3])
  })

  it('keeps two picks of the same file name apart', async () => {
    answers.push([{ name: 'a.docx', bytes: new Uint8Array([1]) }], [{ name: 'a.docx', bytes: new Uint8Array([2]) }])
    const first = await dialog.showOpenDialog(null, { properties: ['openFile'] })
    const second = await dialog.showOpenDialog(null, { properties: ['openFile'] })
    expect(first.filePaths[0]).not.toBe(second.filePaths[0])
    expect([...(fs.readFileSync(first.filePaths[0]!) as Uint8Array)]).toEqual([1])
  })

  it('reports a dismissed picker as cancelled', async () => {
    answers.push(null)
    expect(await dialog.showOpenDialog(null, { properties: ['openFile'] })).toEqual({ canceled: true, filePaths: [] })
  })

  it('offers the projects on the device when asked for a folder, and opens the one chosen', async () => {
    fs.mkdirSync(`${DOCUMENTS}/Harbour`)
    fs.writeFileSync(`${DOCUMENTS}/stray.txt`, 'x')
    answers.push({ name: 'Harbour' })
    const result = await dialog.showOpenDialog(null, { title: 'Open project folder', properties: ['openDirectory'] })
    expect(asked[0]).toMatchObject({ op: 'pickFolder', purpose: 'open', existing: ['Harbour'] })
    expect(result.filePaths).toEqual([`${DOCUMENTS}/Harbour`])
  })

  it('creates the folder for a new project from a template', async () => {
    answers.push({ name: 'Thesis' })
    const result = await dialog.showOpenDialog(null, { title: 'New Thesis', properties: ['openDirectory'] })
    expect(asked[0]).toMatchObject({ op: 'pickFolder', purpose: 'create' })
    expect(fs.statSync(result.filePaths[0]!).isDirectory()).toBe(true)
  })

  it('names a save path without asking, under the folder exports are collected from', async () => {
    const result = await dialog.showSaveDialog(null, { defaultPath: 'C:\\Users\\me\\Novel.docx' })
    expect(asked).toEqual([])
    expect(result.filePath.startsWith(`${EXPORTS}/`)).toBe(true)
    expect(result.filePath.endsWith('/Novel.docx')).toBe(true)
    expect(fs.existsSync(result.filePath.slice(0, result.filePath.lastIndexOf('/')))).toBe(true)
  })

  it('answers a message box with the button the person chose', async () => {
    answers.push({ response: 0 })
    const result = await dialog.showMessageBox(null, { message: 'Send key?', buttons: ['Send key', 'Cancel'], cancelId: 1 })
    expect(result.response).toBe(0)
    expect(asked[0]).toMatchObject({ op: 'messageBox', buttons: ['Send key', 'Cancel'], cancelId: 1 })
  })
})

describe('shell and windows', () => {
  it('has no trash, so the caller falls back to deleting', async () => {
    await expect(shell.trashItem('/Documents/Harbour/ch1.pubdoc')).rejects.toThrow()
  })

  it('prints by handing the page the HTML it was loaded with', async () => {
    const window = new BrowserWindow({ show: false })
    await window.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from('<p>Chapter One</p>').toString('base64')}`)
    const done = vi.fn()
    window.webContents.print({}, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true))
    expect(asked[0]).toEqual({ op: 'print', html: '<p>Chapter One</p>' })
  })

  it('turns a PDF export into the print sheet and nothing to save', async () => {
    const window = new BrowserWindow()
    await window.loadURL(`data:text/html;base64,${Buffer.from('<p>x</p>').toString('base64')}`)
    expect(await window.webContents.printToPDF()).toHaveLength(0)
    expect(asked[0]).toMatchObject({ op: 'print' })
  })
})

describe('chokidar', () => {
  it('reports changes under the watched folder and nothing else', async () => {
    fs.mkdirSync(`${DOCUMENTS}/Harbour`)
    fs.mkdirSync(`${DOCUMENTS}/Other`)
    const seen: string[] = []
    const watcher = watch(`${DOCUMENTS}/Harbour`, { ignored: (path) => path.includes('.tmp-') })
    watcher.on('add', (path) => seen.push(`add ${path}`)).on('unlink', (path) => seen.push(`unlink ${path}`))

    fs.writeFileSync(`${DOCUMENTS}/Harbour/ch1.pubdoc`, 'x')
    fs.writeFileSync(`${DOCUMENTS}/Harbour/ch1.pubdoc.tmp-1`, 'x')
    fs.writeFileSync(`${DOCUMENTS}/Other/ch1.pubdoc`, 'x')
    fs.rmSync(`${DOCUMENTS}/Harbour/ch1.pubdoc`)
    await watcher.close()
    fs.writeFileSync(`${DOCUMENTS}/Harbour/after-close.pubdoc`, 'x')

    expect(seen).toEqual([`add ${DOCUMENTS}/Harbour/ch1.pubdoc`, `unlink ${DOCUMENTS}/Harbour/ch1.pubdoc`])
  })
})

describe('dns', () => {
  it('answers with an address the public-host check accepts, since a page cannot resolve one', async () => {
    expect(await lookup('example.com')).toEqual([{ address: '93.184.216.34', family: 4 }])
  })
})
