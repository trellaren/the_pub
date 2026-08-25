import { z } from 'zod'
import { entityFieldSchema } from './entity.js'

/**
 * A group of records asked for as a group.
 *
 * The characteristic failure of ensemble generators is eight independent
 * rolls — everyone the same person with different hair — because a per-record
 * loop cannot satisfy "exactly one of them is lying" except by accident. So an
 * ensemble is one request against stated constraints, and the constraints are
 * checked *here*, by us, rather than trusted because the model said so.
 *
 * What makes them checkable at all is that each drafted record reports the
 * value it was given for every constrained property. "Is lying about why they
 * signed on" is not something this file can evaluate; "the model said yes for
 * exactly one of these eight" is.
 */
export const ensembleConstraintsSchema = z.object({
  /** Properties no two records may share: "home town", "reason for signing on". */
  distinct: z.array(z.string()).default(() => []),
  /** Properties exactly one record must have: "lying about why they signed on". */
  exactlyOne: z.array(z.string()).default(() => []),
  /** Properties at least `count` records must have: two who served together before. */
  atLeast: z
    .array(z.object({ count: z.number().int().min(1), property: z.string() }))
    .default(() => [])
})
export type EnsembleConstraints = z.infer<typeof ensembleConstraintsSchema>

/**
 * One record as the model drafted it.
 *
 * `properties` is the constraint ledger, keyed by the exact property names the
 * request asked for. `fields` is what a person will read on the card. They are
 * separate because a property can be one the writer should not see spelled out
 * on the card — which of the crew is lying is the story, not a detail field.
 */
export const draftedRecordSchema = z.object({
  name: z.string().min(1),
  summary: z.string().default(''),
  fields: z.array(entityFieldSchema).default(() => []),
  properties: z.record(z.string(), z.string()).default(() => ({}))
})
export type DraftedRecord = z.infer<typeof draftedRecordSchema>

/** One constraint the group did not meet, in words the model can act on. */
export interface ConstraintFailure {
  constraint: string
  detail: string
}

/** Whether a reported property value reads as "this record has it". */
function isYes(value: string | undefined): boolean {
  return /^\s*(yes|true|y)\s*$/i.test(value ?? '')
}

/** Whether a reported property value reads as an answer at all. */
function isAnswered(value: string | undefined): boolean {
  return isYes(value) || /^\s*(no|false|n)\s*$/i.test(value ?? '')
}

function normalise(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Check a drafted group against the constraints it was asked for.
 *
 * Returns every failure rather than the first: a group told only that it broke
 * one of three constraints will come back breaking the other two.
 *
 * A property nobody reported is a failure, not a silent pass. The alternative —
 * treating an absent answer as "no" — makes "exactly one is lying" satisfiable
 * by a model that simply declined to say, which is the failure this validation
 * exists to catch.
 */
export function validateEnsemble(
  records: DraftedRecord[],
  constraints: EnsembleConstraints
): ConstraintFailure[] {
  const failures: ConstraintFailure[] = []

  for (const property of constraints.distinct) {
    const missing = records.filter((record) => !normalise(record.properties[property] ?? ''))
    if (missing.length > 0) {
      failures.push({
        constraint: `distinct: ${property}`,
        detail: `${missing.map((record) => record.name).join(', ')} gave no value for "${property}".`
      })
      continue
    }

    const seen = new Map<string, string[]>()
    for (const record of records) {
      const value = normalise(record.properties[property]!)
      seen.set(value, [...(seen.get(value) ?? []), record.name])
    }
    const shared = [...seen.values()].filter((names) => names.length > 1)
    if (shared.length > 0) {
      failures.push({
        constraint: `distinct: ${property}`,
        detail: `${shared.map((names) => names.join(' and ')).join('; ')} share a value for "${property}".`
      })
    }
  }

  for (const property of constraints.exactlyOne) {
    const unanswered = records.filter((record) => !isAnswered(record.properties[property]))
    if (unanswered.length > 0) {
      failures.push({
        constraint: `exactlyOne: ${property}`,
        detail: `${unanswered.map((record) => record.name).join(', ')} did not answer yes or no for "${property}".`
      })
      continue
    }

    const yes = records.filter((record) => isYes(record.properties[property]))
    if (yes.length !== 1) {
      failures.push({
        constraint: `exactlyOne: ${property}`,
        detail:
          yes.length === 0
            ? `Nobody has "${property}"; exactly one must.`
            : `${yes.map((record) => record.name).join(', ')} all have "${property}"; exactly one must.`
      })
    }
  }

  for (const { count, property } of constraints.atLeast) {
    const unanswered = records.filter((record) => !isAnswered(record.properties[property]))
    if (unanswered.length > 0) {
      failures.push({
        constraint: `atLeast ${count}: ${property}`,
        detail: `${unanswered.map((record) => record.name).join(', ')} did not answer yes or no for "${property}".`
      })
      continue
    }

    const yes = records.filter((record) => isYes(record.properties[property]))
    if (yes.length < count) {
      failures.push({
        constraint: `atLeast ${count}: ${property}`,
        detail: `${yes.length} of ${records.length} have "${property}"; at least ${count} must.`
      })
    }
  }

  return failures
}

/** The unmet constraints as one line, for a tool result and for the panel. */
export function describeFailures(failures: ConstraintFailure[]): string {
  return failures.map((failure) => `${failure.constraint} — ${failure.detail}`).join(' ')
}

/**
 * Whether a constraint set asks for anything at all.
 *
 * An ensemble with no constraints is a legitimate request — "eight sailors" —
 * and must not be reported as a group that passed validation it never had.
 */
export function hasConstraints(constraints: EnsembleConstraints): boolean {
  return (
    constraints.distinct.length > 0 ||
    constraints.exactlyOne.length > 0 ||
    constraints.atLeast.length > 0
  )
}
