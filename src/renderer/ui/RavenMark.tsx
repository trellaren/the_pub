import { RAVEN_PATHS, RAVEN_VIEWBOX, type RavenMark as RavenMarkVariant } from './ravenMarks.js'

interface RavenMarkProps {
  variant?: RavenMarkVariant
  /** Rendered size in px; the marks are drawn to stay legible down to about 16. */
  size?: number
  className?: string
  /**
   * What a screen reader should call it. Omitted — the usual case, where the
   * mark sits beside the name it stands for — the bird is hidden rather than
   * announced twice.
   */
  label?: string
}

/**
 * The app's raven, as a filled silhouette in the current text colour.
 *
 * `currentColor` rather than a token so the mark takes the colour of whatever
 * it is set in, which is what lets one bird serve a masthead, a dark theme and
 * a high-contrast one without a per-theme variant.
 */
export function RavenMark({
  variant = 'perched',
  size = 24,
  className,
  label
}: RavenMarkProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={RAVEN_VIEWBOX}
      fill="currentColor"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {RAVEN_PATHS[variant].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
