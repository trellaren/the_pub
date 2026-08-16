import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiProviderId, ToolCall, EditProposal } from '@shared/model/ai.js'
import { PROVIDERS, PROMPT_PRESETS, providerInfo, resolveSettings } from '@shared/model/ai.js'
import { EMBEDDED_MODELS } from '@shared/model/llm.js'
import { ModelManager } from './ModelManager.js'
import { RetrievalManager } from './RetrievalManager.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useChatStore, listenForReplies } from '@renderer/stores/chatStore.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  ToolbarButton,
  TextInput,
  TextArea,
  Select,
  Field,
  SectionTitle,
  cx
} from '@renderer/ui/primitives.js'

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
  const proposals = useChatStore((store) => store.proposals)
  const keyStatus = useChatStore((store) => store.keyStatus)

  const [draft, setDraft] = useState('')
  const [useSelection, setUseSelection] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const threadEnd = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' })
  }, [chat?.messages.length, streaming?.text])

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
                    label="Insert this at the cursor"
                    onClick={() => insertIntoDocument(message.text)}
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

        {proposals.map((proposal) => (
          <EditProposalCard key={proposal.id} proposal={proposal} />
        ))}
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
  const info = providerInfo(settings.provider)

  const patch = (changes: Partial<typeof settings>): void => {
    void useChatStore.getState().saveSettings({ ...settings, ...changes })
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
        <Field label="Model">
          <Select
            value={settings.model || info.defaultModel}
            onChange={(event) => patch({ model: event.target.value })}
            data-testid="embedded-model"
          >
            {EMBEDDED_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </Select>
        </Field>
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

      <label className="mb-1 flex items-center gap-1 text-[11px] text-muted">
        <input
          type="checkbox"
          checked={settings.agent}
          onChange={(event) => patch({ agent: event.target.checked })}
          data-testid="ai-agent"
        />
        Let it search the project before answering
      </label>
      {/* Off by default: an ordinary question should cost one request, and a
          writer who has not asked for an assistant that goes looking through
          their project should not get one. */}
      <p className="mb-2 text-[10px] text-faint">
        It can search and read your documents and records, and suggest edits for you to accept —
        it never changes a document itself.
      </p>

      {settings.agent ? <RetrievalManager /> : null}

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
 * An edit the agent has proposed.
 *
 * Applying it is an ordinary editor command the author runs — the agent has no
 * write path to a document, and this card is the whole of its reach into prose.
 * When Phase 9's suggestion marks exist, "apply" becomes "insert as a
 * suggestion" and this is the only place that changes.
 */
function EditProposalCard({ proposal }: { proposal: EditProposal }) {
  const [error, setError] = useState<string | null>(null)

  return (
    <article
      className="mb-2 rounded border border-accent bg-surface-2 px-2 py-1.5 text-[12px]"
      data-testid="edit-proposal"
    >
      <div className="mb-1 text-[10px] text-faint">Suggested change to {proposal.docPath}</div>
      {proposal.find ? (
        <div className="mb-1 whitespace-pre-wrap text-danger line-through">{proposal.find}</div>
      ) : null}
      <div className="mb-1 whitespace-pre-wrap text-text">{proposal.replace}</div>
      {proposal.reason ? <div className="mb-1 text-[10px] text-muted">{proposal.reason}</div> : null}
      {error ? <div className="mb-1 text-[11px] text-danger">{error}</div> : null}
      <div className="flex gap-1">
        <ToolbarButton
          label="Make this change"
          onClick={() => {
            const failure = applyProposal(proposal)
            if (failure) {
              setError(failure)
              return
            }
            useChatStore.getState().dismissProposal(proposal.id)
          }}
          data-testid="proposal-apply"
        >
          apply
        </ToolbarButton>
        <ToolbarButton
          label="Discard this suggestion"
          onClick={() => useChatStore.getState().dismissProposal(proposal.id)}
        >
          dismiss
        </ToolbarButton>
      </div>
    </article>
  )
}

/**
 * Apply a proposal to the open document, as one undoable edit.
 *
 * Matched against the document's *current* text rather than what the agent saw:
 * the author may have written since, and silently replacing the wrong range is
 * far worse than refusing.
 */
function applyProposal(proposal: EditProposal): string | null {
  const docId = useDocumentStore.getState().activeDocId
  if (!docId) return 'Open the document first.'
  const editor = getEditor(docId)
  if (!editor) return 'Open the document first.'

  if (!proposal.find) {
    editor.chain().focus().insertContentAt(editor.state.doc.content.size, proposal.replace).run()
    return null
  }

  let range: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isText || !node.text) return true
    const index = node.text.indexOf(proposal.find)
    if (index !== -1) range = { from: pos + index, to: pos + index + proposal.find.length }
    return true
  })

  if (!range) return 'That text is no longer in this document.'
  editor.chain().focus().insertContentAt(range, proposal.replace).run()
  return null
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

/** Put a reply into the manuscript at the cursor. */
function insertIntoDocument(text: string): void {
  const docId = useDocumentStore.getState().activeDocId
  if (!docId) return
  const editor = getEditor(docId)
  if (!editor) return
  // Inserted as plain paragraphs at the selection, so it is an ordinary edit
  // the author can undo in one step.
  editor.chain().focus().insertContent(text.split('\n\n').map((block) => ({
    type: 'paragraph',
    content: block ? [{ type: 'text', text: block }] : []
  }))).run()
}
