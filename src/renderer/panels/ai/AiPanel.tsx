import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiProviderId, ToolCall } from '@shared/model/ai.js'
import { PROVIDERS, PROMPT_PRESETS, providerInfo, resolveSettings } from '@shared/model/ai.js'
import { EMBEDDED_MODELS, isSideloadedModel } from '@shared/model/llm.js'
import { ModelManager } from './ModelManager.js'
import { RetrievalManager } from './RetrievalManager.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useChatStore, listenForReplies } from '@renderer/stores/chatStore.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { applyAssistantEditLocally } from './applyEdit.js'
import { ulid } from 'ulid'
import type { AssistantEdit } from '@shared/pm/assistantEdits.js'
import { useReviewStore } from '@renderer/stores/reviewStore.js'
import { assistantProfile } from '@shared/model/author.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  LiveRegion,
  ToolbarButton,
  TextInput,
  TextArea,
  Select,
  Field,
  SectionTitle,
  cx
} from '@renderer/ui/primitives.js'
import { RavenMark } from '@renderer/ui/RavenMark.js'

/**
 * Conversations about the manuscript.
 *
 * Every provider looks the same from here — the differences end at the main
 * process. What changes between them is a name, a model and, for the hosted
 * three, a key; LM Studio takes a URL instead because it runs on the author's
 * own machine.
 */
export function AiPanel() {
  const project = useProjectStore((store) => store.project)
  const chats = useChatStore((store) => store.chats)
  const settings = useChatStore((store) => store.settings)
  const activeChatId = useChatStore((store) => store.activeChatId)
  const streaming = useChatStore((store) => store.streaming)
  const keyStatus = useChatStore((store) => store.keyStatus)

  const [draft, setDraft] = useState('')
  const [useSelection, setUseSelection] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [replyAnnouncement, setReplyAnnouncement] = useState('')
  const threadEnd = useRef<HTMLDivElement>(null)
  const wasStreaming = useRef(false)

  const chat = chats.find((candidate) => candidate.id === activeChatId) ?? null
  const resolved = useMemo(
    () => (settings ? resolveSettings(settings, chat?.settings) : null),
    [settings, chat?.settings]
  )

  useEffect(() => {
    if (!project) return
    void useChatStore.getState().load()
  }, [project?.root])

  useEffect(() => listenForReplies(), [])
  // The insert button stamps the assistant's marks with an id derived from
  // the writer's own, so their profile has to be known before it is pressed.
  useEffect(() => {
    if (project && !useReviewStore.getState().me) void useReviewStore.getState().loadMe()
  }, [project?.root])

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' })
  }, [chat?.messages.length, streaming?.text])

  // Announced once when the reply finishes, not per token — a live region
  // updated on every streamed chunk would read the whole reply aloud twice.
  useEffect(() => {
    if (wasStreaming.current && !streaming) setReplyAnnouncement('Reply received')
    wasStreaming.current = Boolean(streaming)
  }, [streaming])

  const send = async (prompt: string): Promise<void> => {
    if (!prompt.trim() || streaming) return
    let target = chat
    if (!target) target = await useChatStore.getState().createChat()
    if (!target) return
    setDraft('')
    await useChatStore.getState().send(target.id, prompt, useSelection ? manuscriptContext() : '')
  }

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>AI</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  const missingKey =
    resolved && providerInfo(resolved.provider).needsKey && !keyStatus.configured.includes(resolved.provider)

  return (
    <PanelShell>
      <PanelHeader>
        <RavenMark variant="bust" size={14} className="shrink-0 text-faint" />
        <span className="flex-1">AI</span>
        <Select
          value={activeChatId ?? ''}
          onChange={(event) => useChatStore.getState().setActive(event.target.value || null)}
          className="max-w-40"
          data-testid="chat-picker"
        >
          {chats.length === 0 ? <option value="">No chats</option> : null}
          {chats.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </Select>
        <ToolbarButton label="New chat" onClick={() => void useChatStore.getState().createChat()}>
          ＋
        </ToolbarButton>
        <ToolbarButton
          label="Delete chat"
          disabled={!chat}
          onClick={() => chat && void useChatStore.getState().deleteChat(chat.id)}
        >
          ✕
        </ToolbarButton>
        <ToolbarButton label="Settings" active={showSettings} onClick={() => setShowSettings((on) => !on)}>
          ⚙
        </ToolbarButton>
      </PanelHeader>

      <LiveRegion text={replyAnnouncement} testId="ai-reply-live" />

      {showSettings && settings ? <SettingsForm /> : null}

      {missingKey && resolved ? (
        <div className="border-b border-border bg-surface-2 px-2 py-1 text-[11px] text-muted">
          No API key for {providerInfo(resolved.provider).name}. Add one in ⚙ settings.
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="chat-thread">
        {!chat || chat.messages.length === 0 ? (
          <EmptyState
            title="Ask about the manuscript"
            hint="The selected text, or the open document, is sent with your question."
          />
        ) : (
          chat.messages.map((message) => (
            <article
              key={message.id}
              data-testid={`chat-${message.role}`}
              className={cx(
                'mb-2 rounded border px-2 py-1.5 text-[12px] whitespace-pre-wrap',
                message.role === 'user'
                  ? 'border-border bg-surface-2 text-text'
                  : 'border-transparent bg-surface text-muted'
              )}
            >
              {/* What it did is part of what it said: a run only auditable
                  through a separate file is a run nobody audits. */}
              {message.toolCalls.length > 0 ? <ToolTrail calls={message.toolCalls} /> : null}
              {message.text}
              {message.role === 'assistant' && message.text ? (
                <div className="mt-1 flex gap-1">
                  <ToolbarButton
                    label="Insert this at the cursor, as a tracked change"
                    onClick={() => void insertIntoDocument(message.text, message.model)}
                  >
                    insert
                  </ToolbarButton>
                  <ToolbarButton
                    label="Copy"
                    onClick={() => void navigator.clipboard.writeText(message.text)}
                  >
                    copy
                  </ToolbarButton>
                </div>
              ) : null}
            </article>
          ))
        )}

        {streaming ? (
          <article
            className="mb-2 rounded border border-transparent bg-surface px-2 py-1.5 text-[12px] whitespace-pre-wrap text-muted"
            data-testid="chat-streaming"
          >
            {streaming.toolCalls.length > 0 ? <ToolTrail calls={streaming.toolCalls} /> : null}
            {streaming.text || '…'}
          </article>
        ) : null}

        <div ref={threadEnd} />
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <div className="mb-1 flex flex-wrap gap-1">
          {PROMPT_PRESETS.map((preset) => (
            <ToolbarButton
              key={preset.id}
              label={preset.prompt}
              disabled={Boolean(streaming)}
              onClick={() => void send(preset.prompt)}
            >
              {preset.title}
            </ToolbarButton>
          ))}
        </div>

        <TextArea
          rows={3}
          value={draft}
          placeholder="Ask anything about this manuscript…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter is a newline — the convention everywhere
            // else, and the composer is not where anyone drafts prose.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send(draft)
            }
          }}
          data-testid="chat-input"
        />

        <div className="mt-1 flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={useSelection}
              onChange={(event) => setUseSelection(event.target.checked)}
            />
            Send the selection
          </label>
          <span className="flex-1" />
          {streaming ? (
            <ToolbarButton label="Stop generating" onClick={() => void useChatStore.getState().cancel()}>
              stop
            </ToolbarButton>
          ) : (
            <ToolbarButton label="Send" onClick={() => void send(draft)} data-testid="chat-send">
              send
            </ToolbarButton>
          )}
        </div>
      </div>
    </PanelShell>
  )
}

function SettingsForm() {
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
                onClick={() => void useChatStore.getState().setKey(settings.provider, '')}
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

      <RetrievalManager />

      {settings.provider === 'embedded' ? <ModelManager /> : null}
    </div>
  )
}

/** What the agent did, above the answer it did it for. */
function ToolTrail({ calls }: { calls: ToolCall[] }) {
  return (
    <ul className="mb-1 border-l-2 border-border pl-2" data-testid="tool-trail">
      {calls.map((call) => (
        <li key={call.id} className={cx('text-[10px]', call.ok ? 'text-faint' : 'text-danger')}>
          {call.result || call.name}
        </li>
      ))}
    </ul>
  )
}

/**
 * What to send with the question: the selected prose, or the whole open
 * document when nothing is selected.
 */
function manuscriptContext(): string {
  const docId = useDocumentStore.getState().activeDocId
  if (!docId) return ''
  const editor = getEditor(docId)
  if (!editor) return ''
  const { from, to } = editor.state.selection
  if (from !== to) return editor.state.doc.textBetween(from, to, '\n\n')
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n\n')
}

/**
 * Put a reply into the manuscript at the cursor — as a tracked change.
 *
 * Through the same path a tool's suggestion takes, so no button in this panel
 * writes assistant prose into a document without the insertion mark that says
 * where it came from.
 */
async function insertIntoDocument(text: string, model: string): Promise<void> {
  const docId = useDocumentStore.getState().activeDocId
  if (!docId) return
  const editor = getEditor(docId)
  const state = useDocumentStore.getState().docs[docId]
  const me = useReviewStore.getState().me
  if (!editor || !state || !me) return
  const assistant = assistantProfile(me)

  const { from } = editor.state.selection
  const $from = editor.state.doc.resolve(from)
  // The block the cursor is in, and how far into its text: `textBetween` over
  // the block's own range measures the same characters the walker does for a
  // plain paragraph, which is the case a cursor insertion serves.
  const blockIndex = $from.index(0)
  const blockStart = $from.start(1)
  const offset = editor.state.doc.textBetween(blockStart, from, '\n').replace(/\n+/g, ' ').length
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim())

  const ops: AssistantEdit['ops'] = [
    { kind: 'replace', blockIndex, start: offset, end: offset, text: paragraphs[0] ?? text, reason: '' }
  ]
  for (const paragraph of paragraphs.slice(1)) ops.push({ kind: 'append', text: paragraph, reason: '' })

  await applyAssistantEditLocally({
    id: ulid(),
    runId: 'insert',
    docId,
    docPath: state.path,
    authorId: assistant.id,
    model,
    at: new Date().toISOString(),
    mode: 'suggest',
    ops
  })
}

/** The file name of a sideloaded model, on either platform's separator. */
function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}
