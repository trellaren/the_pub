import { z } from 'zod'
import { defineContract } from './defineContract.js'
import type { ContractShape, InvokeChannel, InvokeReq, InvokeRes, EventChannel, EventPayload } from './defineContract.js'
import type { InvokeChannelName, EventChannelName } from './channels.js'
import { openProjectSchema, projectManifestSchema } from '../model/manifest.js'
import { vfsEntrySchema, fileChangeEventSchema } from '../model/vfs.js'
import { loadedDocumentSchema, pubDocumentSchema } from '../model/document.js'
import { searchQuerySchema, searchHitSchema, indexProgressSchema } from '../model/search.js'
import { entityFileSchema, storyEntitySchema, entityKindSchema } from '../model/entity.js'
import { noteSchema } from '../model/note.js'
import { beatFileSchema, beatSchema, boardColumnSchema } from '../model/beat.js'
import { mapFileSchema, storyMapSchema } from '../model/map.js'
import { manuscriptViewSchema, partRoleSchema, exportItemSchema } from '../model/manuscript.js'
import { connectionProfileSchema, untrustedHostKeySchema } from '../model/connection.js'
import {
  chatFileSchema,
  chatSchema,
  chatMessageSchema,
  aiSettingsSchema,
  aiProviderIdSchema,
  streamEventSchema
} from '../model/ai.js'
import {
  mentionHitSchema,
  mentionQuerySchema,
  mentionRefSchema,
  mentionCountsSchema
} from '../model/mention.js'
import { layoutFileSchema, layoutPresetSchema, dockLayoutSchema } from '../model/layout.js'
import { snapshotSchema } from '../model/snapshot.js'
import { appStateSchema } from '../model/app.js'

const empty = z.object({})
const ok = z.object({ ok: z.literal(true) })
const projectPath = z.object({ path: z.string() })

/** What an import did, and everything it could not bring across. */
const docxImportResultSchema = z.object({
  imported: z.array(z.object({ path: z.string(), title: z.string(), docId: z.string() })),
  warnings: z.array(z.string()),
  stylesAdded: z.number().int()
})

/**
 * The complete renderer↔main surface. Every channel is validated against these
 * schemas in the main process, and the preload bridge is generated from the keys,
 * so a channel that exists here but is unimplemented is a type error.
 */
export const ipcContract = defineContract({
  invoke: {
    'app:getState': { req: empty, res: appStateSchema },
    'app:setTheme': { req: z.object({ theme: appStateSchema.shape.theme }), res: appStateSchema },
    'app:setTimelineOrientation': {
      req: z.object({ orientation: appStateSchema.shape.timelineOrientation }),
      res: appStateSchema
    },

    'project:openDialog': { req: empty, res: openProjectSchema.nullable() },
    'project:open': { req: z.object({ uri: z.string() }), res: openProjectSchema },
    'project:close': { req: empty, res: ok },
    'project:updateManifest': { req: z.object({ manifest: projectManifestSchema }), res: projectManifestSchema },

    'vfs:list': { req: projectPath, res: z.array(vfsEntrySchema) },
    'vfs:stat': { req: projectPath, res: vfsEntrySchema.nullable() },
    'vfs:mkdir': { req: projectPath, res: ok },
    'vfs:rename': { req: z.object({ from: z.string(), to: z.string() }), res: ok },
    'vfs:delete': { req: z.object({ path: z.string(), recursive: z.boolean().default(false) }), res: ok },
    'vfs:revealInOs': { req: projectPath, res: ok },

    'doc:read': { req: projectPath, res: loadedDocumentSchema },
    /** Current path of a document by its stable id — lets restored panels survive a file move. */
    'doc:resolve': { req: z.object({ docId: z.string() }), res: z.object({ path: z.string() }).nullable() },
    'doc:create': { req: z.object({ path: z.string(), title: z.string().optional() }), res: loadedDocumentSchema },
    'doc:write': {
      req: z.object({
        path: z.string(),
        doc: pubDocumentSchema,
        /** Guards against clobbering an edit made outside the app. */
        expectedMtime: z.number().nullable()
      }),
      // Not a `discriminatedUnion`: two of the three shapes share `ok: false`, and
      // TypeScript narrows a plain union on a literal field exactly as well —
      // `result.ok` first, then `result.reason` — without needing a second
      // discriminator zod has to reconcile.
      res: z.union([
        z.object({ ok: z.literal(true), mtime: z.number() }),
        z.object({ ok: z.literal(false), reason: z.literal('conflict'), diskMtime: z.number() }),
        z.object({ ok: z.literal(false), reason: z.literal('format-too-new'), diskVersion: z.number() })
      ])
    },
    /** Writes a pasted/imported image into the project's assets directory. */
    'doc:writeAsset': {
      req: z.object({ dataBase64: z.string(), ext: z.string() }),
      res: z.object({ path: z.string(), url: z.string() })
    },

    /*
     * Word import and export, each split into a dialog-free half and a dialog
     * wrapper. Playwright cannot operate a native dialog, so without the split
     * the whole feature would be untestable end to end — and the halves are the
     * same code either way, which is the point.
     */
    'docx:import': {
      req: z.object({ files: z.array(z.string()), targetDir: z.string().default('') }),
      res: docxImportResultSchema
    },
    'docx:importDialog': {
      req: z.object({ targetDir: z.string().default('') }),
      res: docxImportResultSchema.nullable()
    },
    /**
     * `items` is the general shape — documents and part headings interleaved,
     * for compiling the whole book — while `paths` stays as the plain document
     * list every existing caller already sends. The handler folds `paths` into
     * `items` at the boundary, so `DocxService.export` only ever sees one
     * shape; a request needs at least one entry across the two.
     */
    'docx:export': {
      req: z
        .object({ paths: z.array(z.string()).default([]), items: z.array(exportItemSchema).default([]), file: z.string() })
        .refine((value) => value.paths.length > 0 || value.items.length > 0, { message: 'Nothing to export' }),
      res: z.object({ ok: z.literal(true), file: z.string() })
    },
    'docx:exportDialog': {
      req: z
        .object({
          paths: z.array(z.string()).default([]),
          items: z.array(exportItemSchema).default([]),
          /** Proposed file name for the save dialog, without the extension. */
          suggestedName: z.string().optional()
        })
        .refine((value) => value.paths.length > 0 || value.items.length > 0, { message: 'Nothing to export' }),
      res: z.object({ ok: z.literal(true), file: z.string() }).nullable()
    },

    'search:query': { req: searchQuerySchema, res: z.array(searchHitSchema) },
    'search:reindex': { req: empty, res: ok },
    'search:status': { req: empty, res: indexProgressSchema },

    /** Records and dismissals in one round trip: the panel always needs both. */
    'entities:list': { req: empty, res: entityFileSchema },
    'entities:create': { req: z.object({ kind: entityKindSchema, name: z.string() }), res: storyEntitySchema },
    'entities:save': { req: z.object({ entity: storyEntitySchema }), res: storyEntitySchema },
    'entities:delete': { req: z.object({ id: z.string() }), res: ok },

    'mentions:forEntity': { req: mentionQuerySchema, res: z.array(mentionHitSchema) },
    'mentions:summary': { req: empty, res: z.record(z.string(), mentionCountsSchema) },
    'mentions:confirm': {
      req: mentionRefSchema,
      res: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), mtime: z.number() }),
        z.object({
          ok: z.literal(false),
          reason: z.enum(['missing-document', 'missing-entity', 'not-found', 'conflict'])
        })
      ])
    },
    'mentions:confirmAll': {
      req: z.object({ entityId: z.string() }),
      res: z.object({ confirmed: z.number().int(), failed: z.number().int() })
    },
    'mentions:dismiss': {
      req: z.object({ entityId: z.string(), docId: z.string(), surface: z.string() }),
      res: ok
    },

    'notes:list': { req: z.object({ docId: z.string() }), res: z.array(noteSchema) },
    'notes:create': {
      req: z.object({
        docId: z.string(),
        anchorId: z.string(),
        anchorText: z.string(),
        blockIndex: z.number().int()
      }),
      res: noteSchema
    },
    'notes:save': { req: z.object({ docId: z.string(), note: noteSchema }), res: noteSchema },
    'notes:delete': { req: z.object({ docId: z.string(), noteId: z.string() }), res: ok },

    /** Beats and columns together: both views need the whole board at once. */
    'beats:list': { req: empty, res: beatFileSchema },
    'beats:create': {
      req: z.object({
        title: z.string(),
        columnId: z.string().optional(),
        docId: z.string().nullable().optional()
      }),
      res: beatSchema
    },
    'beats:save': { req: z.object({ beat: beatSchema }), res: beatSchema },
    'beats:delete': { req: z.object({ id: z.string() }), res: ok },
    'beats:saveColumns': {
      req: z.object({ columns: z.array(boardColumnSchema) }),
      res: z.array(boardColumnSchema)
    },

    /**
     * The book's structure.
     *
     * Every mutation answers with the whole resolved view rather than the node
     * it touched: a move rewrites one record but can change several rows' word
     * roll-ups and depths, and a renderer patching its own copy would drift from
     * the file the moment a repair in `reconcile` disagreed with it.
     */
    'manuscript:view': { req: empty, res: manuscriptViewSchema },
    'manuscript:createPart': {
      req: z.object({ title: z.string(), role: partRoleSchema.default('body') }),
      res: manuscriptViewSchema
    },
    /**
     * Add documents by path.
     *
     * Paths rather than ids because main reads each file to take its `docId` and
     * title — which works for a document created seconds ago and not yet
     * indexed, exactly when an author is most likely to add one.
     */
    'manuscript:addDocuments': {
      req: z.object({ paths: z.array(z.string()), parentId: z.string().nullable().default(null) }),
      res: manuscriptViewSchema
    },
    'manuscript:move': {
      req: z.object({ id: z.string(), parentId: z.string().nullable(), index: z.number().int() }),
      res: manuscriptViewSchema
    },
    'manuscript:rename': { req: z.object({ id: z.string(), title: z.string() }), res: manuscriptViewSchema },
    'manuscript:setRole': { req: z.object({ id: z.string(), role: partRoleSchema }), res: manuscriptViewSchema },
    /** Point a row at a different file, so a broken chapter recovers in place. */
    'manuscript:relink': { req: z.object({ id: z.string(), path: z.string() }), res: manuscriptViewSchema },
    'manuscript:remove': { req: z.object({ id: z.string() }), res: manuscriptViewSchema },
    /** Every document in the project, flagged with whether it is already in the book. */
    'manuscript:candidates': {
      req: empty,
      res: z.array(
        z.object({ path: z.string(), title: z.string(), docId: z.string(), inBook: z.boolean() })
      )
    },

    'maps:list': { req: empty, res: mapFileSchema },
    // Background and dimensions default, so a plain { name } still sketches.
    'maps:create': {
      req: z.object({
        name: z.string(),
        background: z.string().nullable().default(null),
        width: z.number().positive().optional(),
        height: z.number().positive().optional()
      }),
      res: storyMapSchema
    },
    'maps:save': { req: z.object({ map: storyMapSchema }), res: storyMapSchema },
    'maps:delete': { req: z.object({ id: z.string() }), res: ok },

    /** Chats and the project's AI settings in one round trip. */
    'ai:list': { req: empty, res: chatFileSchema },
    'ai:createChat': { req: z.object({ title: z.string() }), res: chatSchema },
    'ai:saveChat': { req: z.object({ chat: chatSchema }), res: chatSchema },
    'ai:deleteChat': { req: z.object({ id: z.string() }), res: ok },
    'ai:saveSettings': { req: z.object({ settings: aiSettingsSchema }), res: aiSettingsSchema },
    /**
     * Start a reply. Resolves as soon as the request is accepted; the reply
     * itself arrives as `ai:stream` events keyed by this request id.
     */
    'ai:send': {
      req: z.object({
        chatId: z.string(),
        text: z.string(),
        context: z.string().default('')
      }),
      res: z.object({ requestId: z.string(), message: chatMessageSchema })
    },
    'ai:cancel': { req: z.object({ requestId: z.string() }), res: ok },
    /** Which providers hold a key. Never the keys themselves. */
    'ai:keyStatus': {
      req: empty,
      res: z.object({ configured: z.array(aiProviderIdSchema), secureStorage: z.boolean() })
    },
    'ai:setKey': {
      req: z.object({ provider: aiProviderIdSchema, key: z.string() }),
      res: z.object({ ok: z.boolean(), reason: z.string().optional() })
    },
    'ai:listModels': { req: z.object({ settings: aiSettingsSchema }), res: z.array(z.string()) },

    /** Saved servers. Profiles only — no channel ever returns a secret. */
    'connections:list': {
      req: empty,
      res: z.object({
        connections: z.array(connectionProfileSchema),
        secureStorage: z.boolean()
      })
    },
    'connections:save': {
      req: z.object({
        profile: connectionProfileSchema.partial().extend({
          name: z.string(),
          protocol: connectionProfileSchema.shape.protocol,
          host: z.string(),
          user: z.string()
        }),
        /** Omitted to keep the stored one; empty string to forget it. */
        secret: z.string().optional()
      }),
      res: connectionProfileSchema
    },
    'connections:delete': { req: z.object({ id: z.string() }), res: ok },
    /**
     * Open a connection and list its root, so a mistake is caught before a
     * project is.
     *
     * Also where an SSH server's identity gets reviewed: a host whose key this
     * machine has not accepted fails here with `hostKey` filled in, and the
     * dialog shows the fingerprint for the author to compare.
     */
    'connections:test': {
      req: z.object({ id: z.string() }),
      res: z.object({
        ok: z.boolean(),
        message: z.string(),
        entries: z.number().int(),
        hostKey: untrustedHostKeySchema.nullable().default(null)
      })
    },
    /**
     * Accept an SSH host key, after the author has read its fingerprint.
     *
     * The fingerprint is echoed back rather than taken on trust: main accepts
     * only the key it actually saw the server offer during the matching test,
     * so a dialog left open while something else changed cannot commit a key
     * nobody read.
     */
    'connections:trustHostKey': {
      req: z.object({ id: z.string(), fingerprint: z.string() }),
      res: z.object({ ok: z.boolean(), message: z.string() })
    },
    /**
     * Sign in to OneDrive in the person's own browser.
     *
     * Returns the account it signed in as and nothing else: the refresh token
     * this mints is stored encrypted in the main process, and no channel hands
     * one back, exactly as with the server passwords and the AI keys.
     */
    'connections:signIn': {
      req: z.object({ id: z.string() }),
      res: z.object({ ok: z.boolean(), account: z.string(), message: z.string() })
    },
    'connections:signOut': { req: z.object({ id: z.string() }), res: ok },

    'layout:load': { req: empty, res: layoutFileSchema },
    'layout:saveLast': { req: z.object({ layout: dockLayoutSchema }), res: ok },
    'layout:savePreset': { req: z.object({ name: z.string(), layout: dockLayoutSchema }), res: layoutPresetSchema },
    'layout:deletePreset': { req: z.object({ id: z.string() }), res: ok },

    'snapshot:list': { req: z.object({ docId: z.string() }), res: z.array(snapshotSchema) },
    'snapshot:read': { req: z.object({ docId: z.string(), timestamp: z.string() }), res: pubDocumentSchema },
    /**
     * Put a version back, over the document or into a new file beside it.
     *
     * Restoring in place archives what is there first, so the restore is itself
     * recoverable, and answers with a conflict rather than overwriting a
     * document that changed on disk since the panel last looked.
     */
    'snapshot:restore': {
      req: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('inPlace'), docId: z.string(), timestamp: z.string() }),
        z.object({
          mode: z.literal('newFile'),
          docId: z.string(),
          timestamp: z.string(),
          targetPath: z.string()
        })
      ]),
      res: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), docId: z.string(), path: z.string(), mtime: z.number() }),
        z.object({
          ok: z.literal(false),
          reason: z.enum(['conflict', 'format-too-new', 'missing-document']),
          diskMtime: z.number().optional(),
          diskVersion: z.number().optional()
        })
      ])
    },

    'window:newProject': { req: z.object({ uri: z.string().optional() }), res: ok },
    /** Renderer's answer to `window:requestClose` once pending saves have flushed. */
    'window:closeConfirmed': { req: empty, res: ok }
  },
  events: {
    'vfs:changed': z.array(fileChangeEventSchema),
    'search:indexProgress': indexProgressSchema,
    /**
     * Mentions were re-indexed; backlink lists should refetch.
     *
     * There is deliberately no `entities:changed` counterpart: popout windows
     * share their opener's JS context and therefore the same store, so only two
     * separate project windows on one folder can go stale — which is already
     * true of the manifest today.
     */
    'mentions:changed': z.object({}),
    /**
     * A document's notes changed — including from `doc:write`'s automatic
     * reconcile, which happens without the renderer ever calling a notes
     * endpoint. That path is exactly why this one, unlike `entities:changed`,
     * earns its keep: a shared store catches up on its own when the write
     * came from a notes action, but not when it came from saving the document.
     */
    'notes:changed': z.object({ docId: z.string() }),
    /** Deltas, completion and failure of an in-flight reply. */
    'ai:stream': streamEventSchema,
    'app:stateChanged': appStateSchema,
    /** Native menu / accelerator dispatch into the renderer command registry. */
    'command:invoke': z.object({ commandId: z.string() }),
    /** Close was requested; flush unsaved documents, then confirm. */
    'window:requestClose': z.object({})
  }
} satisfies ContractShape)

export type IpcContract = typeof ipcContract
export type IpcInvokeChannel = InvokeChannel<IpcContract>
export type IpcEventChannel = EventChannel<IpcContract>
export type IpcReq<K extends IpcInvokeChannel> = InvokeReq<IpcContract, K>
export type IpcRes<K extends IpcInvokeChannel> = InvokeRes<IpcContract, K>
export type IpcEvent<K extends IpcEventChannel> = EventPayload<IpcContract, K>

export const invokeChannels = Object.keys(ipcContract.invoke) as IpcInvokeChannel[]
export const eventChannels = Object.keys(ipcContract.events) as IpcEventChannel[]

// Compile-time guard: the preload allow-list in `channels.ts` must match this
// contract exactly. Adding a channel above without listing it there fails here.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type _InvokeChannelsMatch = Assert<Exact<IpcInvokeChannel, InvokeChannelName>>
export type _EventChannelsMatch = Assert<Exact<IpcEventChannel, EventChannelName>>
