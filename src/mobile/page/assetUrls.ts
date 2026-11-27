import { ASSET_PROTOCOL } from '@shared/constants.js'
import type { Host } from './bridge.js'

const PREFIX = `${ASSET_PROTOCOL}://`
const IN_CSS = new RegExp(`${ASSET_PROTOCOL}://[^"')\\s]+`, 'g')

/**
 * Make `pub-asset:` URLs load in a WebView.
 *
 * On desktop the scheme is registered with Electron and answered in the main
 * process. A page cannot register a scheme, and those URLs are written into
 * documents verbatim, so they cannot be changed either. Instead every image
 * and stylesheet that names one is pointed at an object URL holding the same
 * bytes, fetched from the host that would have answered the request.
 *
 * The attribute is rewritten on the element, never in the document: an image
 * is a leaf to the editor, which ignores attribute changes on leaves, so the
 * `src` that is saved stays the one that was written.
 */
export function installAssetUrls(host: Host): void {
  const resolved = new Map<string, Promise<string | null>>()

  function objectUrl(url: string): Promise<string | null> {
    let found = resolved.get(url)
    if (!found) {
      found = host
        .asset(url)
        .then((asset) =>
          asset ? URL.createObjectURL(new Blob([asset.bytes as BlobPart], { type: asset.mime })) : null
        )
        .catch(() => null)
      resolved.set(url, found)
      // A miss is usually a project still opening; the next element to ask tries again.
      void found.then((value) => {
        if (value === null) resolved.delete(url)
      })
    }
    return found
  }

  function fixAttribute(element: Element, name: 'src' | 'href'): void {
    const value = element.getAttribute(name)
    if (!value?.startsWith(PREFIX)) return
    void objectUrl(value).then((replacement) => {
      if (replacement && element.getAttribute(name) === value) element.setAttribute(name, replacement)
    })
  }

  function fixStyle(style: HTMLStyleElement): void {
    const css = style.textContent ?? ''
    const urls = [...new Set(css.match(IN_CSS) ?? [])]
    if (urls.length === 0) return
    void Promise.all(urls.map(objectUrl)).then((replacements) => {
      if (style.textContent !== css) return
      let next = css
      urls.forEach((url, index) => {
        const replacement = replacements[index]
        if (replacement) next = next.split(url).join(replacement)
      })
      if (next !== css) style.textContent = next
    })
  }

  function fix(node: Node): void {
    if (!(node instanceof Element)) {
      if (node.parentElement instanceof HTMLStyleElement) fixStyle(node.parentElement)
      return
    }
    if (node instanceof HTMLStyleElement) return fixStyle(node)
    if (node instanceof HTMLImageElement) fixAttribute(node, 'src')
    else if (node.localName === 'image') fixAttribute(node, 'href')
    for (const image of node.querySelectorAll('img[src^="pub-asset:"]')) fixAttribute(image, 'src')
    for (const image of node.querySelectorAll('image[href^="pub-asset:"]')) fixAttribute(image, 'href')
    for (const style of node.querySelectorAll('style')) fixStyle(style)
  }

  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(fix)
      else fix(record.target)
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['src', 'href']
  })
  fix(document.documentElement)
}
