import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.quoth.ios',
  appName: 'Quoth',
  webDir: 'dist/mobile',
  ios: {
    // The app draws under the status bar and pads for it itself, the way it pads for a desktop title bar.
    contentInset: 'never'
  },
  plugins: {
    // The web view shrinks to sit above the keyboard, so the line being typed is never underneath it.
    Keyboard: { resize: 'native' }
  }
}

export default config
