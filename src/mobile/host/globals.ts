import { Buffer } from 'buffer'
import { addBase64Url } from './base64url.js'

/*
 * Desktop modules read `process` and `Buffer` as they are evaluated, so this
 * has to be the first import of the worker's entry point.
 */

addBase64Url(Buffer)

const scope = globalThis as unknown as { Buffer: typeof Buffer; process: unknown }
scope.Buffer = Buffer
scope.process = { platform: 'ios', arch: 'arm64', env: {}, versions: {}, resourcesPath: '/resources' }
