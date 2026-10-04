import type { HandlerContext } from '../context.js'

export function register({ handle, appState, engine }: HandlerContext): void {
  handle('app:getState', () => appState.get())
  handle('app:setTheme', ({ theme }) => appState.setTheme(theme))
  handle('app:setTimelineOrientation', ({ orientation }) => appState.setTimelineOrientation(orientation))
  handle('app:setKeybinding', ({ commandId, accelerator }) =>
    appState.setKeybinding(commandId, accelerator)
  )
  handle('app:resetKeybindings', () => appState.resetKeybindings())
  handle('app:setAiWritePolicy', ({ policy }) => appState.setAiWritePolicy(policy))
  handle('app:setAssistantSetupDone', () => appState.setAssistantSetupDone())
  handle('app:setAiWeb', (changes) => appState.setAiWeb(changes))

  handle('app:setAiEnabled', async ({ enabled }) => {
    // Turning it off stops the model now rather than at the next quit: the
    // point of the switch is that nothing AI-shaped is running, and gigabytes
    // of resident memory would make a liar of it.
    if (!enabled) await engine.stop()
    return appState.setAiEnabled(enabled)
  })
  handle('app:setEmbeddedIdleMinutes', ({ minutes }) => {
    engine.setIdleMs(minutes * 60_000)
    return appState.setEmbeddedIdleMinutes(minutes)
  })
  handle('app:setStatsIdleTimeoutMinutes', ({ minutes }) => appState.setStatsIdleTimeoutMinutes(minutes))
}
