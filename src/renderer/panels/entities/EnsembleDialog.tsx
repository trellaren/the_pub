import { useRef, useState } from 'react'
import type { EnsembleConstraints } from '@shared/model/ensemble.js'
import { Field, TextInput, TextArea, ToolbarButton, SectionTitle } from '@renderer/ui/primitives.js'
import { useModalFocusTrap } from '@renderer/ui/useModalFocusTrap.js'

const DEFAULT_COUNT = 6
/** More than this is a cast list, not an ensemble, and one request cannot hold it together. */
const MAX_COUNT = 20

export interface EnsembleRequest {
  count: number
  premise: string
  constraints: EnsembleConstraints
}

/**
 * Asking for a group as a group.
 *
 * The constraints are collected here, as structure, and passed to the model as
 * structure — not paraphrased into a sentence and parsed back out. What the
 * writer typed is what `draft_ensemble` is checked against, so the two must be
 * the same text.
 */
export function EnsembleDialog({
  label,
  labelPlural,
  onCancel,
  onDraft
}: {
  label: string
  labelPlural: string
  onCancel: () => void
  onDraft: (request: EnsembleRequest) => void
}) {
  const [count, setCount] = useState(DEFAULT_COUNT)
  const [premise, setPremise] = useState('')
  const [distinct, setDistinct] = useState<string[]>([])
  const [exactlyOne, setExactlyOne] = useState<string[]>([])
  const [atLeast, setAtLeast] = useState<{ count: number; property: string }[]>([])

  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocusTrap(dialogRef, onCancel)

  const draft = (): void => {
    onDraft({
      count: Math.min(Math.max(1, count), MAX_COUNT),
      premise: premise.trim(),
      constraints: {
        distinct: distinct.map((value) => value.trim()).filter(Boolean),
        exactlyOne: exactlyOne.map((value) => value.trim()).filter(Boolean),
        atLeast: atLeast
          .map((row) => ({ count: row.count, property: row.property.trim() }))
          .filter((row) => row.property)
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Draft an ensemble of ${labelPlural.toLowerCase()}`}
        data-testid="ensemble-dialog"
        className="flex max-h-full w-[30rem] flex-col overflow-hidden rounded border border-border bg-surface"
      >
        <header className="flex items-center border-b border-border px-3 py-2">
          <h2 className="flex-1 text-[13px] text-text">Draft an ensemble</h2>
          <ToolbarButton label="Close" onClick={onCancel}>
            ✕
          </ToolbarButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <Field label={`How many ${labelPlural.toLowerCase()}`}>
            <TextInput
              type="number"
              min={1}
              max={MAX_COUNT}
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
              data-testid="ensemble-count"
            />
          </Field>

          <Field label="What this group is">
            <TextArea
              rows={3}
              value={premise}
              placeholder={`A ship's crew, mixed nationalities, signed on at Lisbon in 1954.`}
              onChange={(event) => setPremise(event.target.value)}
              data-testid="ensemble-premise"
            />
          </Field>

          {/*
            The three constraint kinds, kept separate rather than collected as
            free text. "Exactly one is lying" is only checkable because it is
            stored as a property name the group must answer for, one by one.
          */}
          <SectionTitle>No two share</SectionTitle>
          <RowList
            rows={distinct}
            onChange={setDistinct}
            placeholder="home town"
            addLabel="＋ distinct property"
            testId="ensemble-distinct"
          />

          <SectionTitle>Exactly one has</SectionTitle>
          <RowList
            rows={exactlyOne}
            onChange={setExactlyOne}
            placeholder="is lying about why they signed on"
            addLabel="＋ exactly-one property"
            testId="ensemble-exactly-one"
          />

          <SectionTitle>At least this many have</SectionTitle>
          {atLeast.map((row, index) => (
            <div key={index} className="mb-2 flex items-center gap-2">
              <TextInput
                type="number"
                min={1}
                className="w-16 shrink-0"
                value={row.count}
                onChange={(event) =>
                  setAtLeast(
                    atLeast.map((candidate, position) =>
                      position === index ? { ...candidate, count: Number(event.target.value) } : candidate
                    )
                  )
                }
              />
              <TextInput
                value={row.property}
                placeholder="has served with another of them before"
                onChange={(event) =>
                  setAtLeast(
                    atLeast.map((candidate, position) =>
                      position === index ? { ...candidate, property: event.target.value } : candidate
                    )
                  )
                }
              />
              <ToolbarButton
                label="Remove constraint"
                onClick={() => setAtLeast(atLeast.filter((_row, position) => position !== index))}
              >
                ✕
              </ToolbarButton>
            </div>
          ))}
          <ToolbarButton
            label="Add an at-least constraint"
            className="mb-2 w-full justify-start"
            onClick={() => setAtLeast([...atLeast, { count: 2, property: '' }])}
          >
            ＋ at-least property
          </ToolbarButton>

          <p className="mt-2 text-[11px] text-muted">
            Every {label} arrives as a draft you accept or discard. Nothing is added to your project
            until you say so.
          </p>
        </div>

        <footer className="flex justify-end gap-1 border-t border-border px-3 py-2">
          <ToolbarButton label="Cancel" onClick={onCancel}>
            cancel
          </ToolbarButton>
          <ToolbarButton
            label="Draft this ensemble"
            data-testid="ensemble-draft"
            disabled={!premise.trim()}
            onClick={draft}
          >
            draft
          </ToolbarButton>
        </footer>
      </div>
    </div>
  )
}

function RowList({
  rows,
  onChange,
  placeholder,
  addLabel,
  testId
}: {
  rows: string[]
  onChange: (rows: string[]) => void
  placeholder: string
  addLabel: string
  testId: string
}) {
  return (
    <>
      {rows.map((row, index) => (
        <div key={index} className="mb-2 flex items-center gap-2">
          <TextInput
            value={row}
            placeholder={placeholder}
            data-testid={`${testId}-${index}`}
            onChange={(event) =>
              onChange(rows.map((candidate, position) => (position === index ? event.target.value : candidate)))
            }
          />
          <ToolbarButton
            label="Remove constraint"
            onClick={() => onChange(rows.filter((_row, position) => position !== index))}
          >
            ✕
          </ToolbarButton>
        </div>
      ))}
      <ToolbarButton
        label={addLabel}
        className="mb-2 w-full justify-start"
        data-testid={`${testId}-add`}
        onClick={() => onChange([...rows, ''])}
      >
        {addLabel}
      </ToolbarButton>
    </>
  )
}

/**
 * The request, written out for the model.
 *
 * The constraints go across verbatim, as JSON, because `draft_ensemble`
 * validates the group against the property names *the writer typed*. A
 * paraphrase would be checked against a different constraint than the one on
 * screen, and the writer would be told their group passed something they did
 * not ask for.
 */
export function ensembleInstruction(kind: string, request: EnsembleRequest): string {
  return [
    `Draft an ensemble of ${request.count} ${kind} records for this project.`,
    '',
    `The group: ${request.premise}`,
    '',
    'Call draft_ensemble exactly once, with all of them in that one call, and with these constraints copied across unchanged:',
    JSON.stringify(request.constraints, null, 2),
    '',
    'Give every member a value for each constrained property in its `properties`, using the property names exactly as written above — "yes" or "no" for the exactlyOne and atLeast properties.'
  ].join('\n')
}

/** The same, for a single record: no group, so no constraints to hold together. */
export function draftInstruction(kind: string, description: string): string {
  return [
    `Draft one ${kind} record for this project: ${description}`,
    '',
    'Call draft_record once. Look at the records this project already has first, so you do not draft someone it already has.'
  ].join('\n')
}
