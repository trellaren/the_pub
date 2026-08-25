import { describe, it, expect } from 'vitest'
import {
  ensembleConstraintsSchema,
  draftedRecordSchema,
  validateEnsemble,
  hasConstraints,
  type DraftedRecord
} from './ensemble.js'

function crew(...properties: Record<string, string>[]): DraftedRecord[] {
  return properties.map((props, index) =>
    draftedRecordSchema.parse({ name: `Sailor ${index + 1}`, properties: props })
  )
}

const constraints = (partial: Record<string, unknown>) => ensembleConstraintsSchema.parse(partial)

describe('validateEnsemble', () => {
  it('passes a group that meets every constraint', () => {
    const failures = validateEnsemble(
      crew(
        { 'home town': 'Lisbon', lying: 'yes', 'served together': 'yes' },
        { 'home town': 'Porto', lying: 'no', 'served together': 'yes' },
        { 'home town': 'Faro', lying: 'no', 'served together': 'no' }
      ),
      constraints({
        distinct: ['home town'],
        exactlyOne: ['lying'],
        atLeast: [{ count: 2, property: 'served together' }]
      })
    )
    expect(failures).toEqual([])
  })

  it('catches two records sharing a property that must be distinct', () => {
    const failures = validateEnsemble(
      crew({ 'home town': 'Lisbon' }, { 'home town': 'lisbon ' }, { 'home town': 'Faro' }),
      constraints({ distinct: ['home town'] })
    )
    // Compared case-insensitively and trimmed: two spellings of one town is the
    // same town, and a generator that passes on whitespace is not validating.
    expect(failures).toHaveLength(1)
    expect(failures[0]!.detail).toContain('Sailor 1 and Sailor 2')
  })

  it('catches a group where nobody, or everybody, has the exactly-one property', () => {
    const none = validateEnsemble(
      crew({ lying: 'no' }, { lying: 'no' }),
      constraints({ exactlyOne: ['lying'] })
    )
    expect(none[0]!.detail).toContain('Nobody')

    const all = validateEnsemble(
      crew({ lying: 'yes' }, { lying: 'yes' }),
      constraints({ exactlyOne: ['lying'] })
    )
    expect(all[0]!.detail).toContain('exactly one')
  })

  it('counts an at-least constraint against the whole group', () => {
    const failures = validateEnsemble(
      crew({ served: 'yes' }, { served: 'no' }, { served: 'no' }),
      constraints({ atLeast: [{ count: 2, property: 'served' }] })
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]!.detail).toContain('1 of 3')
  })

  it('treats an unanswered property as a failure rather than a no', () => {
    /*
     * The alternative makes "exactly one is lying" satisfiable by a model that
     * simply declined to say — which is precisely the silent pass this
     * validation exists to catch.
     */
    const failures = validateEnsemble(
      crew({ lying: 'yes' }, {}),
      constraints({ exactlyOne: ['lying'] })
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]!.detail).toContain('did not answer')
  })

  it('reports every unmet constraint, not the first', () => {
    // A group told only that it broke one of three comes back breaking the
    // other two.
    const failures = validateEnsemble(
      crew({ town: 'Lisbon', lying: 'yes' }, { town: 'Lisbon', lying: 'yes' }),
      constraints({ distinct: ['town'], exactlyOne: ['lying'] })
    )
    expect(failures).toHaveLength(2)
  })

  it('holds a group to nothing when nothing was asked of it', () => {
    const none = constraints({})
    expect(hasConstraints(none)).toBe(false)
    expect(validateEnsemble(crew({}, {}), none)).toEqual([])
  })
})
