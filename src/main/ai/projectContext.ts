import type { ProjectSession } from '../services/projectSession.js'
import { DEFAULT_ENTITY_KINDS } from '../../shared/model/entity.js'

/**
 * What the assistant is told about the project before any question.
 *
 * A paragraph, not the project: names, titles and the beats still at outline
 * stage, bounded so it costs the same on every send. The point is that "give
 * me a prompt" or "what should the next scene be" start from *this* book
 * rather than from the model's idea of a book — the tools can fetch the rest
 * when a question needs it. Pure over a facts record, so the wording is
 * testable without a session.
 */
export interface ProjectFacts {
  name: string
  projectType: string
  /** Document titles in manuscript order. */
  documents: string[]
  records: { kind: string; kindLabel: string; name: string }[]
  outlineBeats: { title: string; summary: string }[]
  /** Open review threads on the document the writer is looking at, if any. */
  openComments: number | null
}

export const BRIEF_MAX_CHARS = 1_500
const MAX_DOCUMENT_TITLES = 12
const MAX_RECORD_NAMES = 50
const MAX_OUTLINE_BEATS = 8

export function describeProject(facts: ProjectFacts, maxChars = BRIEF_MAX_CHARS): string {
  const lines: string[] = []
  lines.push(`The project is "${facts.name}", a ${facts.projectType.replace(/-/g, ' ')}.`)

  if (facts.documents.length > 0) {
    const shown = facts.documents.slice(0, MAX_DOCUMENT_TITLES)
    const more = facts.documents.length - shown.length
    lines.push(
      `Manuscript (${facts.documents.length} document${facts.documents.length === 1 ? '' : 's'}): ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`
    )
  }

  if (facts.records.length > 0) {
    const byKind = new Map<string, string[]>()
    let shown = 0
    for (const record of facts.records) {
      if (shown >= MAX_RECORD_NAMES) break
      const names = byKind.get(record.kindLabel) ?? []
      names.push(record.name)
      byKind.set(record.kindLabel, names)
      shown += 1
    }
    const parts = [...byKind.entries()].map(([label, names]) => `${label.toLowerCase()}: ${names.join(', ')}`)
    const more = facts.records.length - shown
    lines.push(`Records — ${parts.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`)
  }

  if (facts.outlineBeats.length > 0) {
    const shown = facts.outlineBeats.slice(0, MAX_OUTLINE_BEATS)
    lines.push(
      `Beats still at outline stage: ${shown
        .map((beat) => (beat.summary ? `${beat.title} (${beat.summary})` : beat.title))
        .join('; ')}.`
    )
  }

  if (facts.openComments !== null && facts.openComments > 0) {
    lines.push(`The open document has ${facts.openComments} open review comment${facts.openComments === 1 ? '' : 's'}.`)
  }

  const brief = lines.join(' ')
  return brief.length > maxChars ? `${brief.slice(0, maxChars - 1)}…` : brief
}

export async function projectFacts(session: ProjectSession, activeDocId?: string): Promise<ProjectFacts> {
  const kinds = session.manifest.entityKinds ?? DEFAULT_ENTITY_KINDS
  const label = (kind: string): string => kinds.find((def) => def.id === kind)?.labelPlural ?? kind
  const view = session.manuscript.view()
  const openComments = activeDocId
    ? (await session.reviews.list(activeDocId).catch(() => [])).filter((thread) => thread.status === 'open').length
    : null
  return {
    name: session.manifest.name,
    projectType: session.manifest.projectType,
    documents: view.nodes.filter((node) => node.kind === 'document' && !node.missing).map((node) => node.title),
    records: session.entities
      .snapshot()
      .entities.filter((entity) => !entity.provisional)
      .map((entity) => ({ kind: entity.kind, kindLabel: label(entity.kind), name: entity.name })),
    outlineBeats: session.beats
      .snapshot()
      .beats.filter((beat) => beat.status === 'outline')
      .map((beat) => ({ title: beat.title, summary: beat.summary })),
    openComments
  }
}
