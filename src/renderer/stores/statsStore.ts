import { create } from 'zustand'
import type { DayStat } from '@shared/model/stats.js'
import { STATS_IDLE_TIMEOUT_MS } from '@shared/constants.js'
import { invoke, attempt, on } from '@renderer/lib/ipc.js'
import { useAppStore } from './appStore.js'
import {
  INITIAL_SESSION_STATE,
  recordActivity,
  closeSession,
  activeMinutes,
  classifyDelta,
  localDayKey,
  type SessionState
} from '@renderer/stats/session.js'

interface StatsStore {
  days: DayStat[]
  load: () => Promise<void>
  /**
   * Report one document's before/after word count for a change that just
   * autosaved. Called by `documentStore.save`, reusing its existing debounce
   * rather than adding a second timer — see `docs/phase-13-plan.md`.
   */
  recordChange: (docId: string, before: number, after: number, now?: number) => Promise<void>
  /** Fold the open session's minutes in and stop tracking. Called on window close. */
  flush: (now?: number) => Promise<void>
}

let session: SessionState = INITIAL_SESSION_STATE
let idleTimer: ReturnType<typeof setTimeout> | null = null

function idleTimeoutMs(): number {
  const minutes = useAppStore.getState().state?.statsIdleTimeoutMinutes
  return minutes && minutes > 0 ? minutes * 60_000 : STATS_IDLE_TIMEOUT_MS
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    // Nothing to report from an idle close on its own — the next edit's
    // `recordChange` reports the accrued minutes. This timer only exists so
    // a long-idle sitting doesn't keep growing in `activeMinutes` forever.
    session = closeSession(session, Date.now(), idleTimeoutMs())
  }, idleTimeoutMs())
  idleTimer.unref?.()
}

export const useStatsStore = create<StatsStore>(() => ({
  days: [],

  load: async () => {
    const days = await attempt(invoke('stats:list', {}), 'Could not load writing stats')
    useStatsStore.setState({ days: days ?? [] })
  },

  recordChange: async (docId, before, after, now = Date.now()) => {
    const timeout = idleTimeoutMs()
    session = recordActivity(session, now, timeout)
    scheduleIdleClose()

    const delta = classifyDelta(before, after)
    const date = localDayKey(new Date(now))
    const minutes = activeMinutes(session, now)

    // Optimistic local update so the status bar and Progress panel do not
    // wait on a round trip for every keystroke's worth of autosave.
    const days = useStatsStore.getState().days
    const index = days.findIndex((day) => day.date === date)
    const nextDays =
      index === -1
        ? [
            ...days,
            {
              date,
              added: delta.added,
              removed: delta.removed,
              net: delta.net,
              minutes,
              byDoc: delta.net !== 0 ? { [docId]: delta.net } : {}
            }
          ]
        : days.map((day, i) =>
            i === index
              ? {
                  date,
                  added: day.added + delta.added,
                  removed: day.removed + delta.removed,
                  net: day.net + delta.net,
                  minutes,
                  byDoc: {
                    ...day.byDoc,
                    [docId]: (day.byDoc[docId] ?? 0) + delta.net
                  }
                }
              : day
          )
    useStatsStore.setState({ days: nextDays })

    if (delta.added === 0 && delta.removed === 0 && minutes === days[index]?.minutes) return
    await attempt(
      invoke('stats:record', { date, docId, added: delta.added, removed: delta.removed, net: delta.net, minutes }),
      'Could not save writing stats'
    )
  },

  flush: async (now = Date.now()) => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (session.openSince === null) return
    const minutes = activeMinutes(session, now)
    session = closeSession(session, now, idleTimeoutMs())
    const date = localDayKey(new Date(now))
    await attempt(
      invoke('stats:record', { date, docId: '', added: 0, removed: 0, net: 0, minutes }),
      'Could not save writing stats'
    )
  }
}))

on('stats:changed', () => {
  void useStatsStore.getState().load()
})
