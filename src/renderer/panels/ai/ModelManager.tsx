import { useEffect, useState } from 'react'
import { EMBEDDED_MODELS, formatBytes, type VariantStatus } from '@shared/model/llm.js'
import { useChatStore, listenForModelProgress } from '@renderer/stores/chatStore.js'
import { ToolbarButton, SectionTitle } from '@renderer/ui/primitives.js'

/**
 * The embedded models: what is on disk, what this machine can run, and what the
 * engine is doing.
 *
 * The gate is shown per variant rather than per feature, which is the whole
 * reason the catalogue spans a range: on a small machine the 27B is refused
 * *and the small model is offered*, instead of "embedded" quietly meaning
 * "embedded for people with 32 GB".
 */
export function ModelManager() {
  const llm = useChatStore((store) => store.llm)
  const downloads = useChatStore((store) => store.downloads)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void useChatStore.getState().refreshLlm()
  }, [])

  useEffect(() => listenForModelProgress(), [])

  if (!llm) return null

  const statusOf = (variantId: string): VariantStatus | undefined =>
    llm.variants.find((variant) => variant.variantId === variantId)

  return (
    <div data-testid="model-manager">
      <SectionTitle>Embedded models</SectionTitle>

      {!llm.runtimeAvailable ? (
        <p className="mb-2 text-[11px] text-muted" data-testid="no-runtime">
          This build has no embedded model runtime for your platform, so a model can be downloaded
          here but not run. The other providers are unaffected.
        </p>
      ) : null}

      {llm.engine.state !== 'stopped' ? (
        <p className="mb-2 text-[11px] text-muted" data-testid="engine-state">
          {llm.engine.state === 'starting'
            ? `Warming up ${llm.engine.model}…`
            : llm.engine.state === 'running'
              ? `${llm.engine.model} is loaded.`
              : llm.engine.message}
        </p>
      ) : null}

      {EMBEDDED_MODELS.map((model) => (
        <div key={model.id} className="mb-2 rounded border border-border p-2">
          <div className="text-[12px] text-text">{model.name}</div>
          <div className="mb-1 text-[10px] text-faint">{model.summary}</div>

          {model.variants.map((variant) => {
            const status = statusOf(variant.id)
            const progress = downloads[variant.id]
            const gated = Boolean(status?.gate)

            return (
              <div key={variant.id} className="mt-1 flex items-center gap-2 text-[11px]">
                <span className="flex-1 text-muted">
                  {variant.label}
                  {status?.state === 'ready' && !status.verified ? (
                    // Unverified is a real state, not a failure — a catalogue
                    // entry with no published digest cannot be checked, and
                    // saying nothing would imply a check that never ran.
                    <span className="ml-1 text-faint">(unverified)</span>
                  ) : null}
                </span>

                {progress ? (
                  <>
                    <span className="text-faint" data-testid={`progress-${variant.id}`}>
                      {formatBytes(progress.received)}
                      {progress.total > 0 ? ` of ${formatBytes(progress.total)}` : ''}
                    </span>
                    <ToolbarButton
                      label="Stop the download"
                      onClick={() => void useChatStore.getState().cancelDownload(variant.id)}
                    >
                      stop
                    </ToolbarButton>
                  </>
                ) : status?.state === 'ready' ? (
                  <ToolbarButton
                    label="Delete these weights"
                    onClick={() => void useChatStore.getState().removeModel(variant.id)}
                  >
                    remove
                  </ToolbarButton>
                ) : gated ? (
                  <span className="text-faint" data-testid={`gate-${variant.id}`}>
                    {status?.gate}
                  </span>
                ) : (
                  <ToolbarButton
                    label={`Download ${formatBytes(variant.bytes)}`}
                    // Not gated on the runtime. Weights and the program that
                    // loads them are separate things to have, and a checkout
                    // with no `llama-server` — every development one — could
                    // otherwise not fetch a model at all.
                    onClick={async () => {
                      setError(null)
                      setError(await useChatStore.getState().downloadModel(variant.id))
                    }}
                    data-testid={`download-${variant.id}`}
                  >
                    download {formatBytes(variant.bytes)}
                  </ToolbarButton>
                )}
              </div>
            )
          })}

          <p className="mt-1 text-[10px] text-faint">
            <a href={model.license.url} target="_blank" rel="noreferrer">
              {model.license.name}
            </a>{' '}
            — {model.vendor}
          </p>
        </div>
      ))}

      {error ? <p className="mb-2 text-[11px] text-danger">{error}</p> : null}

      {/* The same rule the API keys follow, for a related reason: a project is
          a folder authors sync, share and commit. */}
      <p className="mb-2 text-[10px] text-faint">
        Downloaded once into this app&rsquo;s data folder, outside any project, and shared by every
        project. Nothing you write is sent anywhere while an embedded model is answering.
      </p>
    </div>
  )
}
