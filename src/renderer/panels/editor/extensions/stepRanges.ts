import type { Node as PmNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step
} from '@tiptap/pm/transform'

/**
 * What one step touched: `from`/`to` in the document it was applied to, and
 * `afterFrom`/`afterTo` in the document it produced.
 *
 * Not `StepMap` ranges: mark and attribute steps have an empty map, yet a
 * plugin watching for a mark or an attribute must still see them.
 */
export interface StepRange {
  before: PmNode
  from: number
  to: number
  after: PmNode
  afterFrom: number
  afterTo: number
}

function rangeOf(step: Step, before: PmNode, after: PmNode): Omit<StepRange, 'before' | 'after'> {
  if (step instanceof ReplaceStep) {
    return { from: step.from, to: step.to, afterFrom: step.from, afterTo: step.from + step.slice.size }
  }
  if (step instanceof ReplaceAroundStep) {
    return { from: step.from, to: step.to, afterFrom: step.from, afterTo: step.getMap().map(step.to, 1) }
  }
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    return { from: step.from, to: step.to, afterFrom: step.from, afterTo: step.to }
  }
  if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
    const size = before.nodeAt(step.pos)?.nodeSize ?? 1
    return { from: step.pos, to: step.pos + size, afterFrom: step.pos, afterTo: step.pos + size }
  }
  return { from: 0, to: before.content.size, afterFrom: 0, afterTo: after.content.size }
}

export function forEachStepRange(transaction: Transaction, visit: (range: StepRange) => void): void {
  transaction.steps.forEach((step, index) => {
    const before = transaction.docs[index]!
    const after = transaction.docs[index + 1] ?? transaction.doc
    visit({ before, after, ...rangeOf(step, before, after) })
  })
}

/** Every range a transaction touched, mapped into its final document. */
export function changedRangesInResult(transaction: Transaction): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  let index = 0
  forEachStepRange(transaction, (range) => {
    const rest = transaction.mapping.slice(index + 1)
    const from = rest.map(range.afterFrom, -1)
    ranges.push({ from, to: Math.max(from, rest.map(range.afterTo, 1)) })
    index++
  })
  return ranges
}

/** Whether any node satisfying `test` lies in a range some step touched, on either side of it. */
export function stepsTouch(transaction: Transaction, test: (node: PmNode) => boolean): boolean {
  let touched = false
  forEachStepRange(transaction, (range) => {
    if (touched) return
    touched = rangeHas(range.before, range.from, range.to, test) || rangeHas(range.after, range.afterFrom, range.afterTo, test)
  })
  return touched
}

function rangeHas(doc: PmNode, from: number, to: number, test: (node: PmNode) => boolean): boolean {
  let found = false
  doc.nodesBetween(from, Math.min(to, doc.content.size), (node) => {
    if (found) return false
    if (test(node)) found = true
    return !found
  })
  return found
}
