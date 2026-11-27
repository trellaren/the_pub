const HOLD_MS = 500
const SLOP_PX = 10

/**
 * Turn a long press into the `contextmenu` event a right-click would have sent.
 *
 * WebKit on iOS never fires `contextmenu`, and every context menu in the app —
 * the file tree's, a tab's, the editor's — is opened by one. Synthesising the
 * event here gives all of them a touch gesture without any of them knowing.
 */
export function installLongPress(root: Document = document): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let start: { x: number; y: number } | null = null
  /** The finger lifting after a menu opened must not also click what is under it. */
  let swallowClick = false

  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    start = null
  }

  const onStart = (event: TouchEvent): void => {
    cancel()
    swallowClick = false
    if (event.touches.length !== 1) return
    const touch = event.touches[0]!
    const target = event.target
    start = { x: touch.clientX, y: touch.clientY }
    timer = setTimeout(() => {
      timer = null
      if (!(target instanceof Element) || !target.isConnected) return
      const menu = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 2
      })
      // Only a handler that claimed the event opened a menu; anywhere else the
      // press is left to do what the system does with it, such as select a word.
      if (!target.dispatchEvent(menu)) swallowClick = true
    }, HOLD_MS)
  }

  const onMove = (event: TouchEvent): void => {
    const touch = event.touches[0]
    if (!start || !touch) return
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP_PX) cancel()
  }

  const onClick = (event: MouseEvent): void => {
    if (!swallowClick) return
    swallowClick = false
    event.preventDefault()
    event.stopPropagation()
  }

  root.addEventListener('touchstart', onStart, { passive: true })
  root.addEventListener('touchmove', onMove, { passive: true })
  root.addEventListener('touchend', cancel)
  root.addEventListener('touchcancel', cancel)
  root.addEventListener('click', onClick, true)
  return () => {
    cancel()
    root.removeEventListener('touchstart', onStart)
    root.removeEventListener('touchmove', onMove)
    root.removeEventListener('touchend', cancel)
    root.removeEventListener('touchcancel', cancel)
    root.removeEventListener('click', onClick, true)
  }
}
