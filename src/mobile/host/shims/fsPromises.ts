import { current } from '../runtime.js'
import type { MobileFs } from '../mobileFs.js'

type Async = 'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'rm' | 'stat' | 'readdir' | 'realpath'

function forward<K extends Async>(name: K): MobileFs[K] {
  return ((...args: unknown[]) => (current().fs[name] as (...a: unknown[]) => unknown)(...args)) as MobileFs[K]
}

export const readFile = forward('readFile')
export const writeFile = forward('writeFile')
export const mkdir = forward('mkdir')
export const rename = forward('rename')
export const rm = forward('rm')
export const stat = forward('stat')
export const readdir = forward('readdir')
export const realpath = forward('realpath')

export default { readFile, writeFile, mkdir, rename, rm, stat, readdir, realpath }
