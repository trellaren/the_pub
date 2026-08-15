import fs from 'node:fs/promises'

/*
 * A real 8×4 PNG, generated once and embedded, so no binary lives in the repo.
 * Non-square on purpose: a square fixture would let a dimension swap or a
 * dropped aspect ratio pass every assertion by accident.
 */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAH0lEQVR4nGM4YaOBFTGcSNHAihhO9GhgRQwntmhgRQBCnC0B6d2q4AAAAABJRU5ErkJggg=='

export const TINY_PNG_WIDTH = 8
export const TINY_PNG_HEIGHT = 4

export function tinyPngBytes(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, 'base64')
}

/** Write the fixture where a test's file input can pick it up. */
export async function writeTinyPng(filePath: string): Promise<void> {
  await fs.writeFile(filePath, tinyPngBytes())
}

/**
 * Load a `pub-asset://` url in the page and report what came back.
 *
 * An `Image` rather than `fetch`: the content-security-policy allows the
 * scheme under `img-src` and not under `connect-src`, which is the right
 * policy — these urls exist to be displayed. Decoding also proves more than a
 * status code would, because the natural size can only be right if the
 * protocol handler returned the real bytes.
 */
export async function loadImage(
  page: { evaluate: <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T> },
  url: string
): Promise<{ ok: boolean; width: number; height: number }> {
  return page.evaluate(
    (target: string) =>
      new Promise<{ ok: boolean; width: number; height: number }>((resolve) => {
        const image = new Image()
        image.onload = () => resolve({ ok: true, width: image.naturalWidth, height: image.naturalHeight })
        image.onerror = () => resolve({ ok: false, width: 0, height: 0 })
        image.src = target
      }),
    url
  )
}
