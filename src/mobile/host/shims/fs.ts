import { current } from '../runtime.js'
import type { MobileFs } from '../mobileFs.js'
import promises from './fsPromises.js'

type Sync = 'existsSync' | 'statSync' | 'readdirSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'rmSync'

function forward<K extends Sync>(name: K): MobileFs[K] {
  return ((...args: unknown[]) => (current().fs[name] as (...a: unknown[]) => unknown)(...args)) as MobileFs[K]
}

export const existsSync = forward('existsSync')
export const statSync = forward('statSync')
export const readdirSync = forward('readdirSync')
export const readFileSync = forward('readFileSync')
export const writeFileSync = forward('writeFileSync')
export const mkdirSync = forward('mkdirSync')
export const renameSync = forward('renameSync')
export const rmSync = forward('rmSync')
export { promises }

export default {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  promises
}
