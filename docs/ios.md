# Quoth for iOS

The iOS app is the desktop app's interface and the desktop app's services, running in a WebView
inside a [Capacitor](https://capacitorjs.com) shell. It opens the same projects, in the same
format, and a project kept in OneDrive is the same project on both: that is what "sync" means
here. There is no second implementation of anything a project is made of.

This document is how it is put together, how to build it, and — stated plainly — what has and has
not been checked on a real device.

## Why it is built this way

`docs/ROADMAP.md` used to rule a mobile build out, on the grounds that it would need a shared core
extracted from the main process. It turned out not to. Two things the desktop app already did made
the extraction unnecessary:

- **The renderer reaches the main process through one bridge**, `window.pub`, with two functions
  and an allow-list. Anything that puts the same two functions on `window` can host the renderer.
- **Everything reaches a project through `VfsAdapter`**, and the OneDrive adapter is Graph requests
  over `fetch` — no Node in it.

So the iOS build bundles `src/main`'s handlers and services as they are and runs them in a Web
Worker beside the page. The page's bridge posts to the worker instead of to another process. The
modules those services import that a WebView does not have — `node:fs`, `node:sqlite`, `electron`
itself — are answered at bundle time by stand-ins of the same shape (`vite.mobile.config.ts` is the
list). Nothing in `src/main` knows which build it is in.

```
src/mobile/
├─ protocol.ts     what the page and the worker say to each other
├─ host/           the worker: the main process's counterpart
│  ├─ worker.ts      start-up — the wiring `src/main/index.ts` does on desktop
│  ├─ mobileFs.ts    `node:fs` over IndexedDB
│  ├─ network.ts     `fetch` that survives CORS, by way of the native shell where it must
│  ├─ signIn.ts      the OneDrive redirect, caught by URL scheme instead of a loopback port
│  └─ shims/         one file per module stood in for
└─ page/           the page: the preload script's counterpart, plus what needs a DOM
   ├─ bridge.ts      `window.pub`
   ├─ shell.tsx      the dialogs, pickers and print sheet Electron's main process draws natively
   ├─ assetUrls.ts   `pub-asset:` URLs, which a WebView has no handler for
   └─ native.ts      everything that differs between the shell and a browser tab
```

A worker rather than the page itself for the reason there is a main process at all: the house rule
that nothing the renderer can reach holds a credential. The refresh token and the AI keys are
decrypted in the worker's memory and nowhere else.

### The stand-ins

| Desktop module | On iOS | Notes |
|---|---|---|
| `node:fs`, `node:fs/promises` | `MobileFs` over IndexedDB | Metadata is held in memory, so `existsSync`/`statSync` work; contents are held too for app data, which is what the synchronous stores read. |
| `node:sqlite` | SQLite compiled to WebAssembly | In memory, written back to storage as one file. FTS5 included. `npm run test:mobile` runs the desktop search index's own test suite against it. |
| `electron` `safeStorage` | AES-GCM, key wrapped by a non-extractable WebCrypto key | See *Credentials* below. |
| `electron` `dialog` | In-app dialogs and the system file picker | A picked file is copied into temporary storage so the caller reads it by path, as it always has. |
| `electron` `BrowserWindow` (printing) | The system print sheet | |
| `chokidar` | The filesystem's own change notices | Nothing else writes to that storage, so they are complete. |
| `ssh2`, `basic-ftp`, `pg`, `mysql2`, `node:net`, `node:child_process` | Not available | Raw sockets and child processes. See *What is different*. |

## Sync

A project in OneDrive is opened on iOS through the same `OneDriveAdapter` the desktop uses, so
everything Phase 8 and Phase 9 built applies unchanged: the change feed surfaces the other device's
writes, `DocumentService`'s mtime check refuses to save over a version it has not seen, the conflict
bar offers the choice, and comments and suggestions merge because each is a single-writer file.

It is the same asynchronous model as co-authoring, with the same cost: **do not type in the same
document on two devices at the same moment.** Close the laptop, pick up the iPad.

`e2e/mobile/onedrive.spec.ts` proves this against the in-memory OneDrive the adapter's unit tests
use, with the iOS build on one end and the desktop's adapter and document service on the other.

### Setting it up

The Azure app registration from the README's *Setting up OneDrive* needs one more redirect URI:
under **Authentication → Mobile and desktop applications**, add `quoth://auth` beside
`http://localhost`. Use the same Application (client) ID on both devices and open the same folder.

A project can also be kept on the device alone ("Open a project on this device…"). Those live in
the app's own storage, do not sync, and are deleted with the app.

## Building it

Everything up to the native shell builds and tests on any machine:

```sh
npm run dev:mobile     # the iOS build in a browser tab, with hot reload
npm run build:mobile   # typecheck and bundle to dist/mobile
npm run test:mobile    # the desktop search index's tests, against the WebAssembly SQLite
npm run e2e:mobile     # Playwright driving the bundle in Chromium (needs build:mobile first)
```

The app itself needs a Mac with Xcode 16 or later, and runs on iOS and iPadOS 16.4 and up — the
first release whose WebKit has everything the shared code relies on. Regular-expression lookbehind
is the one that decides it: mention scanning and whole-word find are built on it, and would throw
on anything older:

```sh
npm run ios:sync       # build:mobile, then copy the bundle and plugins into ios/
npm run ios:open       # open ios/App in Xcode
```

In Xcode, choose a signing team for the `App` target and run it on a simulator or a device. The
bundle identifier is `app.quoth.ios` (`capacitor.config.ts`); change it there, and in the Xcode
project, if you sign under your own. Capacitor's plugins come in through Swift Package Manager, so
there is no CocoaPods step.

The app icon and launch screen in `ios/App/App/Assets.xcassets` are Capacitor's placeholders.

## What is different from the desktop app

Everything not listed here is the same code doing the same thing.

- **Where a project can live: OneDrive, or the device.** SFTP, FTP and database projects need raw
  sockets, which a WebView does not have. The connect dialog offers only OneDrive.
- **The assistant uses a hosted provider.** An embedded model is a native binary and gigabytes of
  weights. Keys are stored the same way; the first-run card says so.
- **PDF export is the print sheet.** A page cannot render itself to a PDF file, but the iOS print
  sheet can save one. Word, EPUB and Fountain export produce a file and hand it to the share sheet.
- **One window.** No "New Window", no tearing a pane off. The dock layout, tabs and splits are
  otherwise the desktop's.
- **Deleting is permanent.** There is no trash to move a file to; the confirmation says so.
- **On-device projects are managed in the app.** There is no file manager to find them in, so the
  "Open a project on this device…" picker is also where one is deleted.
- **Leaving the app is the only warning it gets.** iOS can end a backgrounded app without telling
  it, so going to the background does what closing a desktop window does: pending edits are saved,
  and the statistics and the search index are written down.
- **Spelling is the system keyboard's.** The project's own word list is still kept and still
  syncs, but iOS does not let an app add to its dictionary.
- **The web gate cannot resolve names.** The assistant's page fetches refuse private addresses by
  resolving the host first; a page cannot. The checks on the URL's own text still run. A public
  name that resolves to a private address is not caught on iOS the way it is on desktop.

## Credentials

Electron's `safeStorage` sits on the OS keychain. This build's stand-in is the nearest thing a
WebView offers without native code: secrets are sealed with AES-256-GCM under a random key that
exists only in the worker's memory, and that key is itself stored encrypted under a second key the
browser generated as *non-extractable*. Nothing in storage, read as a file, is a usable key, and no
channel returns a secret to the page — the same guarantees as desktop. What it is not is
hardware-backed. Moving the wrapping key into the iOS Keychain is a native plugin away and is the
first thing worth doing once the app is running on devices.

## What has and has not been verified

The bundle — renderer, services, stand-ins, sync — is covered by unit tests and by the Playwright
suite in Chromium. **The native shell has not been run.** This was built on a machine with no Xcode,
and the following exist only on a device, so they are written against Capacitor's and Apple's
documentation and need checking there:

- The OneDrive redirect arriving through the `quoth://` URL scheme (`page/native.ts`,
  `ios/App/App/Info.plist`).
- Requests routed through the native HTTP plugin: the Microsoft token endpoint always, anything
  the WebView refuses on CORS grounds as a fallback (`host/network.ts`, `page/native.ts`). In
  particular, whether Graph accepts uploads and downloads from the WebView's origin directly or
  falls back for them.
- The share sheet for exports, and the print sheet.
- Long-press as the context menu gesture (`page/longPress.ts`; unit-tested, never felt).
- The keyboard: resizing above it, a hardware keyboard's shortcuts, and autocorrect's interaction
  with suggesting mode.
- Storage limits. IndexedDB in an app's WebView is not subject to Safari's seven-day eviction, but
  a large on-device project with many images has not been measured.
- Layout on a phone. The dock shell is the desktop's; it is usable on an iPad and has not been
  redesigned for a narrow screen.
