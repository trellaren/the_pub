import { useEffect, useMemo } from 'react'
import { useStatsStore } from '@renderer/stores/statsStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useManuscriptStore } from '@renderer/stores/manuscriptStore.js'
import { rollUpWords, wordsForScope, isDocument, isPart } from '@shared/model/manuscript.js'
import { computeStreak, deriveDailyTarget, localDayKey, shiftDayKey } from '@renderer/stats/session.js'
import { daysToCsv, daysToSummary } from '@renderer/stats/csv.js'
import { invoke, attempt, reportNotice } from '@renderer/lib/ipc.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, NumberField, Select, Field } from '@renderer/ui/primitives.js'
import { ProgressChart, Sparkline } from './ProgressChart.js'

const CHART_DAYS = 90

export function ProgressPanel() {
  const days = useStatsStore((store) => store.days)
  const load = useStatsStore((store) => store.load)
  const project = useProjectStore((store) => store.project)
  const updateManifest = useProjectStore((store) => store.updateManifest)
  const manuscript = useManuscriptStore((store) => store.view)
  const loadManuscript = useManuscriptStore((store) => store.load)

  useEffect(() => {
    void load()
    void loadManuscript()
  }, [load, loadManuscript])

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Progress</PanelHeader>
        <EmptyState title="Open a project to see writing statistics" />
      </PanelShell>
    )
  }

  const goals = project.manifest.goals
  const today = localDayKey(new Date())
  const todayStat = days.find((day) => day.date === today)
  const firstRecordedDate = days.length > 0 ? days[0]!.date : today

  const wordsMap = useMemo(() => new Map(manuscript.nodes.map((node) => [node.id, node.words])), [manuscript.nodes])
  const projectWords = wordsForScope(manuscript.nodes, wordsMap, goals.countScope)

  const dailyTarget =
    goals.dailyTarget > 0 ? goals.dailyTarget : deriveDailyTarget(goals.target, goals.deadline, projectWords, today)

  const streak = computeStreak(days, dailyTarget, firstRecordedDate, today)

  const chartDays = useMemo(() => {
    const byDate = new Map(days.map((day) => [day.date, day]))
    const window: typeof days = []
    let cursor = shiftDayKey(today, -(CHART_DAYS - 1))
    for (let i = 0; i < CHART_DAYS; i++) {
      window.push(byDate.get(cursor) ?? { date: cursor, added: 0, removed: 0, net: 0, minutes: 0, byDoc: {} })
      cursor = shiftDayKey(cursor, 1)
    }
    return window
  }, [days, today])

  // Net words contributed per document, summed across every recorded day —
  // "how much was actually written here", not the document's raw length.
  const statsByDoc = useMemo(() => {
    const totals = new Map<string, number>()
    for (const day of days) {
      for (const [docId, net] of Object.entries(day.byDoc)) {
        totals.set(docId, (totals.get(docId) ?? 0) + net)
      }
    }
    return totals
  }, [days])

  const docTotals = rollUpWords(manuscript.nodes, statsByDoc)
  const documentRows = manuscript.nodes.filter(isDocument)
  const partRows = manuscript.nodes.filter(isPart)

  const patchGoals = (changes: Partial<typeof goals>): void => {
    void updateManifest((manifest) => ({ ...manifest, goals: { ...manifest.goals, ...changes } }))
  }

  const copyStats = async (): Promise<void> => {
    const summary = daysToSummary(days, today, dailyTarget)
    await navigator.clipboard.writeText(summary)
    reportNotice('Stats copied to clipboard')
  }

  const exportCsv = async (): Promise<void> => {
    const result = await attempt(invoke('stats:exportCsv', { csv: daysToCsv(days) }), 'Could not export stats')
    if (result) reportNotice(`Exported to ${result.file}`)
  }

  return (
    <PanelShell>
      <PanelHeader>
        Progress
        <span className="flex-1" />
        <ToolbarButton label="Copy stats" onClick={() => void copyStats()}>
          Copy
        </ToolbarButton>
        <ToolbarButton label="Export CSV" onClick={() => void exportCsv()}>
          CSV
        </ToolbarButton>
      </PanelHeader>
      <div className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-2 gap-3 text-[12px]">
          <StatTile
            label="Today"
            value={`${todayStat?.added ?? 0} words`}
            hint={dailyTarget > 0 ? `target ${dailyTarget}` : 'no daily target'}
            met={dailyTarget > 0 && (todayStat?.added ?? 0) >= dailyTarget}
          />
          <StatTile
            label="Project"
            value={`${projectWords.toLocaleString()} words`}
            hint={goals.target > 0 ? `target ${goals.target.toLocaleString()}` : 'no target set'}
            met={goals.target > 0 && projectWords >= goals.target}
          />
          <StatTile label="Streak" value={`${streak} day${streak === 1 ? '' : 's'}`} hint="meeting daily target" />
          <StatTile
            label="This week"
            value={`${days
              .filter((day) => shiftDayKey(today, -6) <= day.date)
              .reduce((sum, day) => sum + day.net, 0)
              .toLocaleString()} net`}
            hint="last 7 days"
          />
        </div>

        <p className="mt-4 mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Last {CHART_DAYS} days
        </p>
        <ProgressChart days={chartDays} dailyTarget={dailyTarget} />
        <p className="mt-1 text-[10px] text-faint">Added above the line, removed below.</p>

        <p className="mt-4 mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Goal</p>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Target words" value={goals.target || undefined} onChange={(v) => patchGoals({ target: v ?? 0 })} />
          <Field label="Deadline">
            <input
              type="date"
              value={goals.deadline}
              onChange={(event) => patchGoals({ deadline: event.target.value })}
              className="rounded border border-border bg-surface-2 px-2 py-1 text-[12px] text-text"
            />
          </Field>
          <NumberField
            label="Daily target (0 = derive)"
            value={goals.dailyTarget || undefined}
            onChange={(v) => patchGoals({ dailyTarget: v ?? 0 })}
          />
          <Field label="Counts">
            <Select
              value={goals.countScope}
              onChange={(event) => patchGoals({ countScope: event.target.value as 'manuscript' | 'project' })}
            >
              <option value="manuscript">Manuscript (excludes back matter)</option>
              <option value="project">Whole project</option>
            </Select>
          </Field>
        </div>

        <p className="mt-4 mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">By part</p>
        {partRows.length === 0 ? (
          <p className="text-[11px] text-faint">No parts yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {partRows.map((part) => (
              <BreakdownRow key={part.id} label={part.title} net={docTotals.get(part.id) ?? 0} />
            ))}
          </div>
        )}

        <p className="mt-4 mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">By document</p>
        {documentRows.length === 0 ? (
          <p className="text-[11px] text-faint">No documents yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {documentRows.map((doc) => (
              <BreakdownRow
                key={doc.id}
                label={doc.title}
                net={statsByDoc.get(doc.docId ?? '') ?? 0}
                spark={days.map((day) => day.byDoc[doc.docId ?? ''] ?? 0)}
              />
            ))}
          </div>
        )}
      </div>
    </PanelShell>
  )
}

function StatTile({
  label,
  value,
  hint,
  met
}: {
  label: string
  value: string
  hint: string
  met?: boolean
}) {
  return (
    <div className="rounded border border-border bg-surface-2 p-2">
      <p className="text-[10px] uppercase tracking-wide text-faint">{label}</p>
      <p className={met ? 'text-[15px] font-semibold text-accent' : 'text-[15px] font-semibold text-text'}>
        {value}
      </p>
      <p className="text-[10px] text-faint">{hint}</p>
    </div>
  )
}

function BreakdownRow({ label, net, spark }: { label: string; net: number; spark?: number[] }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="flex-1 truncate" title={label}>
        {label}
      </span>
      {spark ? <Sparkline values={spark} /> : null}
      <span className={net >= 0 ? 'tabular-nums text-accent' : 'tabular-nums text-danger'}>
        {net >= 0 ? '+' : ''}
        {net.toLocaleString()}
      </span>
    </div>
  )
}
