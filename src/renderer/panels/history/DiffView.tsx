import { useMemo } from 'react'
import type { PmDoc } from '@shared/model/document.js'
import { extractBlocks } from '@shared/pm/extractText.js'
import { diffBlocks, type BlockDiffEntry } from '@shared/pm/diffDocument.js'
import { cx, EmptyState } from '@renderer/ui/primitives.js'

/**
 * What changed between two versions.
 *
 * Prose, not marks: this shows paragraphs added, removed, moved and edited, and
 * the words within an edit. A bold run that changed inside an otherwise
 * identical sentence is not shown, which is a real boundary and worth knowing —
 * the comparison is about what was written, not how it was formatted.
 */
export function DiffView({ before, after }: { before: PmDoc; after: PmDoc }) {
  const entries = useMemo(
    () => diffBlocks(extractBlocks(before), extractBlocks(after)),
    [before, after]
  )

  const changed = entries.filter((entry) => entry.kind !== 'unchanged')
  if (changed.length === 0) {
    return <EmptyState title="No changes" hint="This version reads the same as the current one." />
  }

  return (
    <div className="flex flex-col gap-1 p-3 text-[13px] leading-relaxed" data-testid="history-diff">
      {entries.map((entry, index) => (
        <Row key={`${entry.kind}-${entry.oldIndex}-${entry.newIndex}-${index}`} entry={entry} />
      ))}
    </div>
  )
}

function Row({ entry }: { entry: BlockDiffEntry }) {
  if (entry.kind === 'unchanged') {
    return <p className="px-2 py-1 text-muted">{entry.text || ' '}</p>
  }

  return (
    <div
      data-testid={`diff-${entry.kind}`}
      className={cx(
        'rounded border-l-2 px-2 py-1',
        entry.kind === 'added' && 'border-l-accent bg-accent-soft text-text',
        entry.kind === 'removed' && 'border-l-danger bg-surface-2 text-muted line-through',
        entry.kind === 'moved' && 'border-l-accent bg-surface-2 text-text',
        entry.kind === 'changed' && 'border-l-accent bg-surface-2 text-text'
      )}
    >
      {entry.kind === 'moved' ? (
        <span className="mr-2 text-[11px] uppercase tracking-wide text-accent" data-testid="diff-moved-badge">
          {/* Both ends of the journey, because "moved" alone leaves the reader
              hunting for where it went. Numbered from one, as prose is read. */}
          moved from ¶{(entry.oldIndex ?? 0) + 1} to ¶{(entry.newIndex ?? 0) + 1}
        </span>
      ) : null}
      {entry.kind === 'changed' && entry.words ? (
        <span>
          {entry.words.map((word, index) =>
            word.kind === 'equal' ? (
              <span key={index}>{word.text}</span>
            ) : (
              <span
                key={index}
                data-testid={word.kind === 'insert' ? 'diff-word-added' : 'diff-word-removed'}
                className={cx(
                  'rounded px-0.5',
                  word.kind === 'insert' ? 'bg-accent-soft text-accent' : 'text-danger line-through'
                )}
              >
                {word.text}
              </span>
            )
          )}
        </span>
      ) : (
        <span>{entry.text}</span>
      )}
    </div>
  )
}
