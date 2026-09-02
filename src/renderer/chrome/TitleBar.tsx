import { useEffect, useState } from 'react'
import { useAppStore } from '@renderer/stores/appStore.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { invoke, on } from '@renderer/lib/ipc.js'
import { RavenMark } from '@renderer/ui/RavenMark.js'
import { cx } from '@renderer/ui/primitives.js'
import { MenuBar } from './MenuBar.js'

/**
 * The window's own title bar: raven, menus, search, window buttons.
 *
 * The frame is off (`windowManager.ts`), so everything a frame used to provide
 * is here — which is the point rather than the cost: the middle of a title bar
 * is the best real estate in the window, and a frame spends it on a filename
 * the tab strip already shows. This spends it on the way to any document.
 *
 * macOS is the exception in two ways, both of them the platform's: the menus
 * stay in the system bar, and the traffic lights stay where a Mac user's hand
 * already goes — so this leaves room for them and draws no buttons of its own.
 */
export function TitleBar({ onSearch }: { onSearch: () => void }): React.JSX.Element {
  const platform = useAppStore((store) => store.state?.platform)
  const project = useProjectStore((store) => store.project)
  const [chrome, setChrome] = useState({ maximized: false, fullScreen: false })
  const mac = platform === 'darwin'

  useEffect(() => {
    void invoke('window:chromeState', {}).then(setChrome)
    return on('window:chromeChanged', setChrome)
  }, [])

  return (
    <div
      className={cx(
        'pub-drag flex h-9 shrink-0 items-stretch gap-2 border-b border-border bg-surface pr-0 pl-2',
        // Room for the traffic lights, which sit over the page in `hiddenInset`.
        mac && !chrome.fullScreen && 'pl-20'
      )}
      data-testid="title-bar"
      onDoubleClick={() => {
        // Windows and macOS maximize a double-clicked drag region themselves;
        // doing it here as well would toggle twice. Linux does not, so this is
        // the only place it happens there.
        if (platform === 'linux') void invoke('window:toggleMaximize', {}).then(setChrome)
      }}
    >
      <div className="flex items-center gap-2">
        {mac ? null : <RavenMark size={16} className="shrink-0 text-muted" />}
        {mac ? null : <MenuBar />}
      </div>

      <div className="flex flex-1 items-center justify-center">
        <button
          type="button"
          onClick={onSearch}
          data-testid="title-search"
          className="pub-no-drag flex h-6 w-full max-w-md items-center gap-2 rounded border border-border bg-surface-2 px-2 text-[12px] text-faint hover:border-faint hover:text-muted"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            className="shrink-0"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.2" />
            <line x1="10.2" y1="10.2" x2="14" y2="14" />
          </svg>
          <span className="truncate">
            {project ? `Search ${project.manifest.name}` : 'Search'}
          </span>
        </button>
      </div>

      {mac ? (
        // The traffic lights are the platform's, and already on the left.
        <div className="w-20 shrink-0" />
      ) : (
        <div className="pub-no-drag flex shrink-0 items-stretch" data-testid="window-controls">
          <ControlButton label="Minimize" onClick={() => void invoke('window:minimize', {})}>
            <line x1="3" y1="8" x2="13" y2="8" />
          </ControlButton>
          <ControlButton
            label={chrome.maximized ? 'Restore' : 'Maximize'}
            testId="window-maximize"
            onClick={() => void invoke('window:toggleMaximize', {}).then(setChrome)}
          >
            {chrome.maximized ? (
              <>
                <rect x="3" y="5" width="7" height="7" />
                <path d="M5.5 5V3h7.5v7.5H11" />
              </>
            ) : (
              <rect x="3.5" y="3.5" width="9" height="9" />
            )}
          </ControlButton>
          <ControlButton label="Close" danger onClick={() => void invoke('window:close', {})}>
            <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
            <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
          </ControlButton>
        </div>
      )}
    </div>
  )
}

/**
 * One window button.
 *
 * Drawn rather than depended upon, like the map markers: three shapes on a
 * 16-unit grid at one stroke weight is not worth an icon library, and the
 * platform conventions they imitate are lines and boxes anyway.
 */
function ControlButton({
  label,
  onClick,
  children,
  danger,
  testId
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className={cx(
        'flex w-11 items-center justify-center text-muted',
        danger ? 'hover:bg-danger hover:text-bg' : 'hover:bg-surface-3 hover:text-text'
      )}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
        {children}
      </svg>
    </button>
  )
}
