import { useEffect, useMemo, useRef, useState } from 'react'
import { providerInfo, resolveSettings } from '@shared/model/ai.js'
import { availableTasks, type AssistantTask } from '@shared/model/assistantTasks.js'
import { pickAngle } from '@shared/model/writingPrompt.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useChatStore, listenForReplies } from '@renderer/stores/chatStore.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { applyAssistantEditLocally } from './applyEdit.js'
import { ulid } from 'ulid'
import type { AssistantEdit } from '@shared/pm/assistantEdits.js'
import { useReviewStore } from '@renderer/stores/reviewStore.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import { assistantProfile } from '@shared/model/author.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  LiveRegion,
  ToolbarButton,
  TextArea,
  Select,
  cx
} from '@renderer/ui/primitives.js'
import { RavenMark } from '@renderer/ui/RavenMark.js'
import { SettingsForm } from './AiSettings.js'
import { ToolTrail } from './ToolTrail.js'
import { hasEditorSelection, manuscriptContext } from './context.js'

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

  const activeDocId = useDocumentStore((store) => store.activeDocId)
  const activeDoc = useDocumentStore((store) => (store.activeDocId ? store.docs[store.activeDocId] : undefined))
  const webAccess = useAppStore((store) => store.state?.aiWebAccess ?? 'none')
  const [draft, setDraft] = useState('')
  const [useSelection, setUseSelection] = useState(true)
  // Re-read on each render rather than subscribed: a selection changes on
  // every keystroke, and the chips only need to be right when looked at.
  const hasSelection = hasEditorSelection(activeDocId)
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

  const send = async (prompt: string, attach = useSelection): Promise<void> => {
    if (!prompt.trim() || streaming) return
    let target = chat
    if (!target) target = await useChatStore.getState().createChat()
    if (!target) return
    setDraft('')
    await useChatStore.getState().send(target.id, prompt, attach ? manuscriptContext() : '')
  }

  const runTask = (task: AssistantTask): void => {
    void send(task.prompt({ docPath: activeDoc?.path ?? '', angle: pickAngle('') }), task.attach)
  }

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Assistant</PanelHeader>
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
        <span className="flex-1">Assistant</span>
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
            title="Ask the assistant"
            hint="It can read and search the project, review and proofread, and suggest changes you accept or reject. The selected text, or the open document, is sent with your question."
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
        <div className="mb-1 flex flex-wrap gap-1" data-testid="assistant-tasks">
          {availableTasks({ hasDocument: Boolean(activeDoc), hasSelection, web: webAccess }).map((task) => (
            <ToolbarButton
              key={task.id}
              label={task.title}
              disabled={Boolean(streaming)}
              onClick={() => runTask(task)}
              data-testid={`task-${task.id}`}
            >
              {task.title}
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
