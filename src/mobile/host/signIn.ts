import { shell } from './runtime.js'
import type { RedirectCatcher, SignInBrowser } from '../../main/services/oneDriveAuth.js'

/**
 * A OneDrive sign-in on a device with no loopback listener to catch the
 * redirect. The page opens the system browser and is handed the URL Microsoft
 * sent it back to — through the app's own URL scheme inside the native shell.
 */
export class MobileRedirect implements SignInBrowser {
  constructor(private readonly redirectUri: string) {}

  async listen(): Promise<RedirectCatcher> {
    let settle: (url: string) => void = () => {}
    let fail: (error: Error) => void = () => {}
    const redirect = new Promise<string>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    // Rejected-and-unobserved must not surface as an unhandled rejection when
    // a sign-in is abandoned before anything awaits it.
    redirect.catch(() => {})
    const redirectUri = this.redirectUri
    return {
      redirectUri,
      redirect,
      open: async (url) => {
        shell({ op: 'authSession', url, redirectUri }).then(({ url: landed }) => settle(landed), fail)
      },
      abort: (message) => {
        fail(new Error(message))
        void shell({ op: 'authCancel' }).catch(() => {})
      },
      close: async () => {}
    }
  }
}
