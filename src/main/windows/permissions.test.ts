import { describe, expect, it } from 'vitest'
import { installPermissionPolicy, isPermissionAllowed } from './permissions.js'

describe('the permission policy', () => {
  it('allows clipboard writes only', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true)
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'hid', 'serial', 'openExternal']) {
      expect(isPermissionAllowed(permission), permission).toBe(false)
    }
  })

  it('answers requests and checks with the same policy', () => {
    type Handlers = {
      request?: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
      check?: (contents: unknown, permission: string) => boolean
      device?: () => boolean
    }
    const handlers: Handlers = {}
    const session = {
      setPermissionRequestHandler: (handler: Handlers['request']) => (handlers.request = handler),
      setPermissionCheckHandler: (handler: Handlers['check']) => (handlers.check = handler),
      setDevicePermissionHandler: (handler: Handlers['device']) => (handlers.device = handler)
    }
    installPermissionPolicy(session as unknown as Parameters<typeof installPermissionPolicy>[0])
    const granted: boolean[] = []
    handlers.request!(null, 'media', (value) => granted.push(value))
    handlers.request!(null, 'clipboard-sanitized-write', (value) => granted.push(value))
    expect(granted).toEqual([false, true])
    expect(handlers.check!(null, 'geolocation')).toBe(false)
    expect(handlers.device!()).toBe(false)
  })
})
