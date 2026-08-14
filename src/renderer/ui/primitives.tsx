import type { ComponentPropsWithRef, ReactNode } from 'react'

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

interface ToolbarButtonProps extends ComponentPropsWithRef<'button'> {
  active?: boolean
  label: string
  children: ReactNode
}

export function ToolbarButton({ active, label, children, className, ...rest }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        'pub-focus-ring inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-[12px]',
        'text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-40 disabled:hover:bg-transparent',
        active && 'bg-accent-soft text-accent',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" />
}

export function Select({ className, ...rest }: ComponentPropsWithRef<'select'>) {
  return (
    <select
      className={cx(
        'pub-focus-ring h-7 rounded border border-border bg-surface-2 px-1.5 text-[12px] text-text',
        'hover:border-faint',
        className
      )}
      {...rest}
    />
  )
}

export function TextInput({ className, ...rest }: ComponentPropsWithRef<'input'>) {
  return (
    <input
      className={cx(
        'pub-focus-ring h-7 w-full rounded border border-border bg-surface-2 px-2 text-[12px] text-text',
        'placeholder:text-faint hover:border-faint',
        className
      )}
      {...rest}
    />
  )
}

export function PanelShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex h-full min-h-0 flex-col bg-surface text-text', className)}>{children}</div>
}

export function PanelHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2 text-[11px] font-medium uppercase tracking-wide text-muted">
      {children}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-[13px] text-muted">{title}</p>
      {hint ? <p className="text-[12px] text-faint">{hint}</p> : null}
    </div>
  )
}
