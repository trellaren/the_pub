import { Buffer } from 'buffer'

/*
 * Desktop modules read `process` and `Buffer` as they are evaluated, so this
 * has to be the first import of the worker's entry point.
 */
const scope = globalThis as unknown as { Buffer: typeof Buffer; process: unknown }
scope.Buffer = Buffer
scope.process = { platform: 'ios', arch: 'arm64', env: {}, versions: {}, resourcesPath: '/resources' }
