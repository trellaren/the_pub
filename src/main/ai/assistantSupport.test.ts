import { describe, expect, it } from 'vitest'
import { limitedResponse, readCapped } from './assistantSupport.js'

function endlessResponse(chunk: Uint8Array, headers: Record<string, string> = {}): { response: Response; pulls: () => number; cancelled: () => boolean } {
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      controller.enqueue(chunk)
    },
    cancel() {
      cancelled = true
    }
  })
  return { response: new Response(body, { headers }), pulls: () => pulls, cancelled: () => cancelled }
}

describe('readCapped', () => {
  it('stops reading an endless body at the cap and cancels it', async () => {
    const stream = endlessResponse(new Uint8Array(1000).fill(65))
    const bytes = await readCapped(stream.response, 2500)
    expect(bytes.byteLength).toBe(2500)
    expect(stream.pulls()).toBeLessThan(10)
    expect(stream.cancelled()).toBe(true)
  })

  it('returns a short body whole', async () => {
    const bytes = await readCapped(new Response('hello'), 100)
    expect(new TextDecoder().decode(bytes)).toBe('hello')
  })
})

describe('limitedResponse', () => {
  it('refuses a declared length over the cap without reading it', async () => {
    const stream = endlessResponse(new Uint8Array(10), { 'content-length': '5000' })
    const limited = limitedResponse(stream.response, 100)
    expect(limited.ok).toBe(false)
    expect(await limited.text()).toBe('')
    expect(stream.pulls()).toBeLessThanOrEqual(1)
  })

  it('truncates an undeclared body to the cap', async () => {
    const limited = limitedResponse(new Response('abcdefghij'), 4)
    expect(limited.ok).toBe(true)
    expect(await limited.text()).toBe('abcd')
  })
})
