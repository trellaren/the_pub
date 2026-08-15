import { XMLParser } from 'fast-xml-parser'
import { attr, numAttr } from './units.js'

/**
 * A thin, ordered view over `fast-xml-parser`.
 *
 * The parser's default output keys children by tag name, which loses the order
 * children appeared in whenever an element mixes tags — a hyperlink between two
 * runs, a line break between two pieces of text, a table between two
 * paragraphs. In a word processor that is not a detail: it is the difference
 * between a chapter and a chapter with its table at the end.
 *
 * `preserveOrder` fixes that but produces an awkward shape — an array of
 * single-key objects, with attributes in a `:@` bag — so the whole codebase
 * would otherwise be full of `[':@']` lookups. These helpers are that shape,
 * named.
 */

export interface XmlNode {
  [key: string]: unknown
}

const ATTRIBUTE_KEY = ':@'
const TEXT_KEY = '#text'

export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  // Word writes `<w:t xml:space="preserve"> </w:t>`, and trimming would eat the
  // spaces between runs — silently joining words together.
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  textNodeName: TEXT_KEY
})

export function parseXml(source: string): XmlNode[] {
  return xmlParser.parse(source) as XmlNode[]
}

/** The tag name of an element, or `#text` for a text node. */
export function nameOf(node: XmlNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ATTRIBUTE_KEY) return key
  }
  return ''
}

/** An element's children, in document order. */
export function childrenOf(node: XmlNode): XmlNode[] {
  const value = node[nameOf(node)]
  return Array.isArray(value) ? (value as XmlNode[]) : []
}

export function att(node: XmlNode | undefined, name: string): string | undefined {
  return node === undefined ? undefined : attr(node[ATTRIBUTE_KEY], name)
}

export function numAtt(node: XmlNode | undefined, name: string): number | null {
  return node === undefined ? null : numAttr(node[ATTRIBUTE_KEY], name)
}

/** The first child with this tag name. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined
  return childrenOf(node).find((candidate) => nameOf(candidate) === name)
}

/** Every child with this tag name, in document order. */
export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return []
  return childrenOf(node).filter((candidate) => nameOf(candidate) === name)
}

/** Follow a chain of single children, e.g. `w:pPr` → `w:numPr` → `w:numId`. */
export function path(node: XmlNode | undefined, names: string[]): XmlNode | undefined {
  let cursor = node
  for (const name of names) {
    cursor = child(cursor, name)
    if (!cursor) return undefined
  }
  return cursor
}

/** Whether an element has a child with this name — the toggle-property question. */
export function hasChild(node: XmlNode | undefined, name: string): boolean {
  return child(node, name) !== undefined
}

/** The text directly inside an element. */
export function textIn(node: XmlNode | undefined): string {
  if (!node) return ''
  let text = ''
  for (const item of childrenOf(node)) {
    const value = item[TEXT_KEY]
    if (typeof value === 'string') text += value
    else if (typeof value === 'number') text += String(value)
  }
  return text
}

/** The first element with this name at the top level of a parsed document. */
export function root(nodes: XmlNode[], name: string): XmlNode | undefined {
  return nodes.find((node) => nameOf(node) === name)
}
