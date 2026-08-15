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

export function TextArea({ className, ...rest }: ComponentPropsWithRef<'textarea'>) {
  return (
    <textarea
      className={cx(
        'pub-focus-ring w-full resize-y rounded border border-border bg-surface-2 px-2 py-1 text-[12px] leading-relaxed text-text',
        'placeholder:text-faint hover:border-faint',
        className
      )}
      {...rest}
    />
  )
}

/** Native colour well plus the hex, since the well alone is unreadable at 12px. */
export function ColorInput({
  value,
  onChange,
  className
}: {
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <span className={cx('flex items-center gap-2', className)}>
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="pub-focus-ring h-7 w-10 shrink-0 cursor-pointer rounded border border-border bg-surface-2"
      />
      <TextInput value={value} onChange={(event) => onChange(event.target.value)} />
    </span>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-4 mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">{children}</h3>
  )
}

/**
 * Label above the control rather than beside it: these panels are usually docked
 * to a narrow sidebar, where a side-by-side layout pushes the input out of view.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-2 flex flex-col gap-1 text-[12px] text-muted">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function NumberField({
  label,
  value,
  step = 1,
  onChange
}: {
  label: string
  value: number | undefined
  step?: number
  onChange: (value: number | undefined) => void
}) {
  return (
    <Field label={label}>
      <TextInput
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      />
    </Field>
  )
}

export function Checkbox({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-1 text-[12px] text-muted">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

export function PanelShell({
  children,
  className,
  ref
}: {
  children: ReactNode
  className?: string
  ref?: React.Ref<HTMLDivElement>
}) {
  return (
    <div ref={ref} className={cx('flex h-full min-h-0 flex-col bg-surface text-text', className)}>
      {children}
    </div>
  )
}

export function PanelHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2 text-[11px] font-medium uppercase tracking-wide text-muted">
      {children}
    </div>
  )
}

export function EmptyState({
  title,
  hint,
  action
}: {
  title: string
  hint?: string
  /** A way out of the empty state — without one, a fresh project is a dead end. */
  action?: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-[13px] text-muted">{title}</p>
      {hint ? <p className="text-[12px] text-faint">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
