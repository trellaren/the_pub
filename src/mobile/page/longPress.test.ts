// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installLongPress } from './longPress.js'

let target: HTMLElement
let uninstall: () => void

function touch(type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] })
  target.dispatchEvent(event)
}

beforeEach(() => {
  vi.useFakeTimers()
  target = document.createElement('div')
  document.body.append(target)
  uninstall = installLongPress(document)
})

afterEach(() => {
  uninstall()
  target.remove()
  vi.useRealTimers()
})

describe('installLongPress', () => {
  it('sends a context menu event where the finger is held', () => {
    const opened: MouseEvent[] = []
    target.addEventListener('contextmenu', (event) => opened.push(event))
    touch('touchstart', 40, 60)
    vi.advanceTimersByTime(600)
    expect(opened).toHaveLength(1)
    expect([opened[0]!.clientX, opened[0]!.clientY]).toEqual([40, 60])
  })

  it('does nothing for a tap', () => {
    const opened = vi.fn()
    target.addEventListener('contextmenu', opened)
    touch('touchstart', 40, 60)
    vi.advanceTimersByTime(200)
    touch('touchend', 40, 60)
    vi.advanceTimersByTime(600)
    expect(opened).not.toHaveBeenCalled()
  })

  it('does nothing for a scroll that began as a press', () => {
    const opened = vi.fn()
    target.addEventListener('contextmenu', opened)
    touch('touchstart', 40, 60)
    touch('touchmove', 40, 120)
    vi.advanceTimersByTime(600)
    expect(opened).not.toHaveBeenCalled()
  })

  it('keeps the lifting finger from clicking through a menu that opened', () => {
    const clicked = vi.fn()
    target.addEventListener('contextmenu', (event) => event.preventDefault())
    target.addEventListener('click', clicked)
    touch('touchstart', 40, 60)
    vi.advanceTimersByTime(600)
    touch('touchend', 40, 60)
    target.click()
    expect(clicked).not.toHaveBeenCalled()
    // Only that one: the next tap is an ordinary tap.
    touch('touchstart', 40, 60)
    touch('touchend', 40, 60)
    target.click()
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('leaves the click alone where nothing claimed the press', () => {
    const clicked = vi.fn()
    target.addEventListener('click', clicked)
    touch('touchstart', 40, 60)
    vi.advanceTimersByTime(600)
    touch('touchend', 40, 60)
    target.click()
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})
