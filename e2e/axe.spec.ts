import { createRequire } from 'node:module'
import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { launch, openProject, cleanup, type Harness } from './helpers.js'

const axeCoreSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core'), 'utf8')

interface AxeViolation {
  id: string
  help: string
  nodes: unknown[]
}

/**
 * `@axe-core/playwright`'s `AxeBuilder` opens a fresh `BrowserContext` page to
 * do its work, which Electron's CDP support rejects
 * (`Target.createTarget: Not supported`) — Electron windows aren't created
 * through `browserContext.newPage()`. And the app's own CSP
 * (`script-src 'self'`, see `main/index.ts`) blocks `addScriptTag` from
 * inserting `axe-core` as an inline `<script>`.
 *
 * `page.evaluate()` given a source string instead of a function runs it via
 * CDP's `Runtime.evaluate`, which — unlike a `<script>` element or an in-page
 * `eval` — is not subject to the page's CSP at all, so it can define
 * `window.axe` from the raw `axe-core` bundle directly.
 */
async function runAxe(page: Page, include: string): Promise<AxeViolation[]> {
  await page.evaluate(axeCoreSource)
  return page.evaluate(async (selector) => {
    const results = await (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe.run(
      document.querySelector(selector) ?? document,
      {
        rules: {
          'color-contrast': { enabled: false },
          // dockview's own tab markup (`dockview-core`, not this codebase):
          // each `.dv-tab` is `role="tab"` (interactive) and contains its own
          // close `<button>` (also interactive) so the tab is draggable and
          // clickable as a whole while still exposing a separate close
          // target. Fixing it means patching or forking the library, out of
          // scope for this pass — every panel trips it identically, which is
          // itself the evidence it's shell chrome, not panel content.
          'nested-interactive': { enabled: false }
        }
      }
    )
    return results.violations.map((violation) => ({
      id: violation.id,
      help: violation.help,
      nodes: (violation.nodes as { html: string }[]).map((node) => node.html)
    }))
  }, include)
}

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

/**
 * Phase 14, Part 5: "the part that stops the phase from decaying." Sweeps the
 * shell with each dock panel open in turn, failing on any axe violation
 * rather than only on the ones a human happened to notice.
 *
 * One project, one launch, each panel opened and swept in sequence rather
 * than one launch per panel — panels are additive (`showPanel` focuses an
 * existing one or adds it) and this suite already runs slowly enough without
 * ~15 separate app launches.
 */
test('the dock has no axe violations with each panel open', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const commandIds = [
    'panel.explorer',
    'panel.search',
    'panel.styles',
    'panel.records.character',
    'panel.records.location',
    'panel.timeline',
    'panel.storyboard',
    'panel.history',
    'panel.manuscript',
    'panel.maps',
    'panel.ai',
    'panel.settings',
    'panel.notes',
    'panel.progress',
    'panel.research',
    'panel.review',
    'panel.sources'
  ]

  const violationsByPanel: Record<string, string[]> = {}

  for (const commandId of commandIds) {
    const ran = await harness.page.evaluate((id) => window.__pub.runCommand(id), commandId)
    expect(ran, `${commandId} should be a registered command`).toBe(true)
    // Panels mount async data (records, beats, settings) before axe should
    // judge them — waiting a tick for the network-idle-ish quiet is cheaper
    // and less flaky than guessing a fixed panel-specific selector for each.
    await harness.page.waitForTimeout(150)

    // Colour contrast is asserted separately, per-theme, in
    // `shared/themes.test.ts` (WCAG ratios computed straight from the token
    // values) — running it here too would just re-check the same thing
    // against whatever DOM happens to be visible, noisily.
    const violations = await runAxe(harness.page, '.dockview-theme-pub')

    if (violations.length > 0) {
      violationsByPanel[commandId] = violations.map(
        (violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`
      )
    }
  }

  expect(violationsByPanel, JSON.stringify(violationsByPanel, null, 2)).toEqual({})
})
