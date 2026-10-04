import { useState } from 'react'
import type { AiProviderId } from '@shared/model/ai.js'
import { PROVIDERS, providerInfo } from '@shared/model/ai.js'
import { EMBEDDED_MODELS, isSideloadedModel } from '@shared/model/llm.js'
import { SEARCH_PROVIDERS, searchProviderInfo, searchKeyId } from '@shared/model/webAccess.js'
import { ModelManager } from './ModelManager.js'
import { RetrievalManager } from './RetrievalManager.js'
import { basename } from './context.js'
import { useChatStore } from '@renderer/stores/chatStore.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import { ToolbarButton, TextInput, TextArea, Select, Field, SectionTitle } from '@renderer/ui/primitives.js'

export function SettingsForm() {
  const settings = useChatStore((store) => store.settings)!
  const keyStatus = useChatStore((store) => store.keyStatus)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const info = providerInfo(settings.provider)

  const patch = (changes: Partial<typeof settings>): void => {
    void useChatStore.getState().saveSettings({ ...settings, ...changes })
  }

  /**
   * Choosing a model is what starts its download.
   *
   * The rule Phase 8 set was that *pressing send* never begins a multi-gigabyte
   * transfer, and that still holds — this is someone picking a model from a
   * list of sizes, which is the one moment they have said which one they want.
   * Leaving them to find a second button in a section further down was the
   * gap, not a safeguard.
   */
  const chooseModel = async (model: string): Promise<void> => {
    setModelError(null)
    patch({ model })
    setModelError(await useChatStore.getState().ensureModel(model))
  }

  return (
    <div className="shrink-0 border-b border-border p-2" data-testid="ai-settings">
      <Field label="Provider">
        <Select
          value={settings.provider}
          onChange={(event) => patch({ provider: event.target.value as AiProviderId, model: '' })}
          data-testid="ai-provider"
        >
          {PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </Select>
      </Field>

      {settings.provider === 'embedded' ? (
        <>
          <Field label="Model">
            {/* Variants rather than models, because a variant is the thing that
                is actually downloaded and run: choosing "the 27B" without
                saying which quantisation is choosing nothing. */}
            <Select
              value={settings.model || info.defaultModel}
              onChange={(event) => void chooseModel(event.target.value)}
              data-testid="embedded-model"
            >
              {EMBEDDED_MODELS.flatMap((model) =>
                model.variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {model.name} — {variant.label}
                  </option>
                ))
              )}
              {isSideloadedModel(settings.model) ? (
                <option value={settings.model}>{basename(settings.model)}</option>
              ) : null}
            </Select>
          </Field>
          <div className="mb-2 flex gap-1">
            <ToolbarButton
              label="Use a .gguf model file already on this computer"
              data-testid="choose-model-file"
              onClick={async () => {
                const chosen = await useChatStore.getState().chooseModelFile()
                if (chosen) await chooseModel(chosen)
              }}
            >
              use a file on this computer
            </ToolbarButton>
          </div>
          {modelError ? (
            <p className="mb-2 text-[11px] text-danger" data-testid="model-error">
              {modelError}
            </p>
          ) : null}
        </>
      ) : (
        <Field label="Model">
          <TextInput
            value={settings.model}
            placeholder={info.defaultModel}
            onChange={(event) => patch({ model: event.target.value })}
          />
        </Field>
      )}

      {/* An embedded model is reached on a port only main knows, so there is no
          URL to offer — showing an empty one would invite someone to fill it. */}
      {settings.provider === 'embedded' ? null : (
        <Field label={info.needsKey ? 'Base URL (optional)' : 'Server URL'}>
          <TextInput
            value={settings.baseUrl}
            placeholder={info.defaultBaseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
          />
        </Field>
      )}

      {info.needsKey ? (
        <>
          <Field label={keyStatus.configured.includes(settings.provider) ? 'API key (stored)' : 'API key'}>
            <TextInput
              type="password"
              value={keyDraft}
              placeholder={keyStatus.configured.includes(settings.provider) ? '••••••••' : 'sk-…'}
              onChange={(event) => setKeyDraft(event.target.value)}
              data-testid="ai-key"
            />
          </Field>
          <div className="mb-2 flex gap-1">
            <ToolbarButton
              label="Save the key"
              disabled={keyDraft.trim() === ''}
              onClick={async () => {
                setKeyError(await useChatStore.getState().setKey(settings.provider, keyDraft))
                setKeyDraft('')
              }}
            >
              save key
            </ToolbarButton>
            {keyStatus.configured.includes(settings.provider) ? (
              <ToolbarButton
                label="Forget the stored key"
                onClick={async () => {
                  if (!window.confirm('Forget the stored key? It cannot be recovered.')) return
                  setKeyError(await useChatStore.getState().setKey(settings.provider, ''))
                }}
              >
                forget
              </ToolbarButton>
            ) : null}
          </div>
          {/* Keys are encrypted into the app's own data directory, never the
              project folder — a project is a thing authors sync and share. */}
          <p className="mb-2 text-[10px] text-faint">
            {keyStatus.secureStorage
              ? 'Stored encrypted on this machine, outside the project folder.'
              : 'This system has no secure storage, so keys cannot be saved here.'}
          </p>
          {keyError ? <p className="mb-2 text-[11px] text-danger">{keyError}</p> : null}
        </>
      ) : null}

      <SectionTitle>Behaviour</SectionTitle>
      <Field label="Standing instructions">
        <TextArea
          rows={3}
          value={settings.systemPrompt}
          placeholder="Tell it about your book, your voice, what you want from it."
          onChange={(event) => patch({ systemPrompt: event.target.value })}
        />
      </Field>

      <p className="mb-2 text-[10px] text-faint">
        It can search and read your documents and records, and suggest edits that appear as tracked
        changes for you to accept or reject — it never changes a document itself.
      </p>

      <WritePolicyField />
      <WebAccessFields />

      <RetrievalManager />

      {settings.provider === 'embedded' ? <ModelManager /> : null}
    </div>
  )
}

/**
 * The writer's standing choice about how the assistant's prose may land. The
 * same app-scoped setting the Settings panel shows; offered here because this
 * is where someone wonders why a change arrived as a suggestion.
 */
function WritePolicyField() {
  const policy = useAppStore((store) => store.state?.aiWritePolicy ?? 'suggest')
  return (
    <Field label="Its changes">
      <Select
        value={policy}
        onChange={(event) => void useAppStore.getState().setAiWritePolicy(event.target.value as typeof policy)}
        data-testid="ai-write-policy"
      >
        <option value="suggest">Suggest everything as tracked changes</option>
        <option value="direct-trivial">Apply trivial fixes, suggest the rest</option>
        <option value="direct">Apply directly, marked and logged</option>
      </Select>
    </Field>
  )
}

/**
 * How far the assistant may reach on the web, and through whom.
 *
 * App-scoped like the write policy, and keyed like a model provider: a search
 * key is encrypted into the same store, under a `search:` prefix, and the
 * renderer learns only that one is present.
 */
function WebAccessFields() {
  const level = useAppStore((store) => store.state?.aiWebAccess ?? 'none')
  const provider = useAppStore((store) => store.state?.aiSearchProvider ?? 'brave')
  const baseUrl = useAppStore((store) => store.state?.aiSearchBaseUrl ?? '')
  const keyStatus = useChatStore((store) => store.keyStatus)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const info = searchProviderInfo(provider)
  const keyId = searchKeyId(provider)
  const stored = keyStatus.configured.includes(keyId)

  return (
    <>
      <Field label="On the web">
        <Select
          value={level}
          onChange={(event) => void useAppStore.getState().setAiWeb({ webAccess: event.target.value as typeof level })}
          data-testid="ai-web-access"
        >
          <option value="none">Nothing — it never browses</option>
          <option value="urls">Pages you name</option>
          <option value="search">Search and fetch</option>
        </Select>
      </Field>
      {level === 'search' ? (
        <>
          <Field label="Search provider">
            <Select
              value={provider}
              onChange={(event) =>
                void useAppStore.getState().setAiWeb({ searchProvider: event.target.value as typeof provider })
              }
              data-testid="ai-search-provider"
            >
              {SEARCH_PROVIDERS.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          </Field>
          {info.needsKey ? (
            <>
              <Field label={stored ? 'Search key (stored)' : 'Search key'}>
                <TextInput
                  type="password"
                  value={keyDraft}
                  placeholder={stored ? '••••••••' : 'key'}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  data-testid="ai-search-key"
                />
              </Field>
              <div className="mb-2 flex gap-1">
                <ToolbarButton
                  label="Save the search key"
                  disabled={keyDraft.trim() === ''}
                  onClick={async () => {
                    setKeyError(await useChatStore.getState().setKey(keyId, keyDraft))
                    setKeyDraft('')
                  }}
                >
                  save key
                </ToolbarButton>
                {stored ? (
                  <ToolbarButton
                    label="Forget the stored search key"
                    onClick={async () => {
                  if (!window.confirm('Forget the stored key? It cannot be recovered.')) return
                  setKeyError(await useChatStore.getState().setKey(keyId, ''))
                }}
                  >
                    forget
                  </ToolbarButton>
                ) : null}
              </div>
              {keyError ? <p className="mb-2 text-[11px] text-danger">{keyError}</p> : null}
            </>
          ) : (
            <Field label="Search server address">
              <TextInput
                value={baseUrl}
                placeholder="http://searx.home:8080"
                onChange={(event) => void useAppStore.getState().setAiWeb({ searchBaseUrl: event.target.value })}
              />
            </Field>
          )}
        </>
      ) : null}
    </>
  )
}
