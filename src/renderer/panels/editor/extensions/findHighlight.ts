import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PmNode } from '@tiptap/pm/model'
import { changedRangesInResult } from './stepRanges.js'
import { forEachTextNode, rawBlockText } from '@shared/pm/extractText.js'
import type { PmNode as JsonNode } from '@shared/model/document.js'

export interface FindOptions {
  term: string
  matchCase: boolean
  wholeWord: boolean
}

export interface FindMatch {
  from: number
  to: number
}

export interface FindState extends FindOptions {
  matches: FindMatch[]
  /** Index into `matches`, or -1 when there is no active match. */
  current: number
}

export const findPluginKey = new PluginKey<FindState>('pubFind')

const EMPTY: FindState = { term: '', matchCase: false, wholeWord: false, matches: [], current: -1 }

interface FindMeta {
  options?: FindOptions
  current?: number
  step?: 1 | -1
}

/**
 * Match highlighting for find/replace and for landing on a global-search hit.
 *
 * Matching runs per text block rather than per text node, so a phrase that spans
 * a bold word or a character mention is still found — those split a paragraph
 * into several text nodes but not into several blocks.
 */
export const FindHighlight = Extension.create({
  name: 'findHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findPluginKey,
        state: {
          init: () => EMPTY,
          apply(transaction: Transaction, previous: FindState, _old, next): FindState {
            const meta = transaction.getMeta(findPluginKey) as FindMeta | undefined
            if (meta?.options) {
              const matches = findMatches(next.doc, meta.options)
              return { ...meta.options, matches, current: matches.length > 0 ? 0 : -1 }
            }
            if (meta?.step && previous.matches.length > 0) {
              const count = previous.matches.length
              const current = (previous.current + meta.step + count) % count
              return { ...previous, current }
            }
            if (meta?.current !== undefined) {
              return { ...previous, current: meta.current }
            }
            if (transaction.docChanged && previous.term) {
              const matches = remapMatches(previous.matches, transaction, previous)
              return {
                ...previous,
                matches,
                current: matches.length === 0 ? -1 : Math.min(previous.current, matches.length - 1)
              }
            }
            return previous
          }
        },
        props: {
          decorations(state: EditorState) {
            const found = findPluginKey.getState(state)
            if (!found || found.matches.length === 0) return DecorationSet.empty
            return DecorationSet.create(
              state.doc,
              found.matches.map((match, index) =>
                Decoration.inline(match.from, match.to, {
                  class: index === found.current ? 'pub-find-match-current' : 'pub-find-match'
                })
              )
            )
          }
        }
      })
    ]
  }
})

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matcherFor(options: FindOptions): RegExp | null {
  if (!options.term) return null
  const pattern = options.wholeWord
    ? `(?<![\\p{L}\\p{N}])${escapeRegExp(options.term)}(?![\\p{L}\\p{N}])`
    : escapeRegExp(options.term)
  try {
    return new RegExp(pattern, options.matchCase ? 'gu' : 'giu')
  } catch {
    return null
  }
}

/** Locate every occurrence of `options.term`, returning ProseMirror positions. */
export function findMatches(doc: PmNode, options: FindOptions): FindMatch[] {
  const matcher = matcherFor(options)
  if (!matcher) return []
  const matches: FindMatch[] = []
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true
    matches.push(...blockMatches(node, position, matcher))
    return false
  })
  return matches
}

/**
 * The matches after an edit, without rescanning the whole document: a match
 * never spans two blocks, so matches in blocks the transaction did not touch
 * only need mapping, and only the touched blocks are searched again.
 */
export function remapMatches(previous: FindMatch[], transaction: Transaction, options: FindOptions): FindMatch[] {
  const matcher = matcherFor(options)
  if (!matcher) return []
  const doc = transaction.doc
  const touched = new Map<number, PmNode>()
  for (const range of changedRangesInResult(transaction)) {
    doc.nodesBetween(range.from, Math.min(range.to, doc.content.size), (node, position) => {
      if (!node.isTextblock) return true
      touched.set(position, node)
      return false
    })
  }
  const inTouchedBlock = (match: FindMatch): boolean => {
    for (const [position, node] of touched) {
      if (match.from > position && match.to <= position + node.nodeSize) return true
    }
    return false
  }

  const matches: FindMatch[] = []
  for (const match of previous) {
    const from = transaction.mapping.map(match.from, 1)
    const to = transaction.mapping.map(match.to, -1)
    if (to <= from) continue
    const mapped = { from, to }
    if (!inTouchedBlock(mapped)) matches.push(mapped)
  }
  for (const [position, node] of touched) matches.push(...blockMatches(node, position, matcher))
  return matches.sort((a, b) => a.from - b.from)
}

/**
 * Where each JSON node sits in the live document, so offsets from the shared
 * text walker can be turned back into positions.
 */
function pairPositions(live: PmNode, json: JsonNode, position: number, into: Map<JsonNode, number>): void {
  live.forEach((child, offset, index) => {
    const jsonChild = json.content?.[index]
    if (!jsonChild) return
    const childPosition = position + 1 + offset
    into.set(jsonChild, childPosition)
    if (!child.isLeaf) pairPositions(child, jsonChild, childPosition, into)
  })
}

/**
 * The block's text comes from `shared/pm/extractText.ts`, the one walker
 * global search also reads, so the two agree on what fields, footnotes, hard
 * breaks and pending deletions contribute.
 */
function blockMatches(node: PmNode, position: number, matcher: RegExp): FindMatch[] {
  const json = node.toJSON() as JsonNode
  const nodePositions = new Map<JsonNode, number>()
  pairPositions(node, json, position, nodePositions)
  const text = rawBlockText(json)
  const positions: (number | undefined)[] = new Array(text.length)
  forEachTextNode(json, (entry) => {
    const start = nodePositions.get(entry.node)
    if (start === undefined) return
    for (let index = 0; index < entry.text.length; index++) {
      positions[entry.start + index] = entry.node.type === 'text' ? start + index : start
    }
  })

  const matches: FindMatch[] = []
  matcher.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = matcher.exec(text)) !== null) {
    if (match[0].length === 0) {
      matcher.lastIndex += 1
      continue
    }
    const from = positions[match.index]
    const lastCharPosition = positions[match.index + match[0].length - 1]
    if (from === undefined || lastCharPosition === undefined) continue
    matches.push({ from, to: lastCharPosition + 1 })
  }
  return matches
}

export function getFindState(state: EditorState): FindState {
  return findPluginKey.getState(state) ?? EMPTY
}
