import type { ReactNode } from 'react'
import { cx } from './primitives.js'

export interface SnippetRanges {
  snippet: string
  ranges: { start: number; end: number }[]
}

/**
 * A block of text with its matched ranges highlighted.
 *
 * Shared by global search and by mention backlinks, which is why `MentionHit`
 * carries the same `snippet` + `ranges` pair a `SearchHit` does — the two lists
 * look the same to a reader because they are the same component.
 */
export function Snippet({ hit, className }: { hit: SnippetRanges; className?: string }) {
  if (hit.ranges.length === 0) {
    return <span className={cx('line-clamp-2', className)}>{hit.snippet}</span>
  }

  const parts: ReactNode[] = []
  let cursor = 0
  for (const [index, range] of hit.ranges.entries()) {
    if (range.start > cursor) parts.push(hit.snippet.slice(cursor, range.start))
    parts.push(
      <mark key={index} className="rounded-sm bg-accent-soft px-0.5 text-accent">
        {hit.snippet.slice(range.start, range.end)}
      </mark>
    )
    cursor = range.end
  }
  if (cursor < hit.snippet.length) parts.push(hit.snippet.slice(cursor))
  return <span className={cx('line-clamp-2', className)}>{parts}</span>
}
