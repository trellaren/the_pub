import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle, Color, FontFamily, FontSize, BackgroundColor } from '@tiptap/extension-text-style'
import Highlight from '@tiptap/extension-highlight'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import TextAlign from '@tiptap/extension-text-align'
import Image from '@tiptap/extension-image'
import CharacterCount from '@tiptap/extension-character-count'
import Typography from '@tiptap/extension-typography'
import Placeholder from '@tiptap/extension-placeholder'
import { TableKit } from '@tiptap/extension-table'
import { ulid } from 'ulid'
import type { PmDoc } from '@shared/model/document.js'
import type { NamedStyle } from '@shared/model/style.js'
import type { StoryEntity } from '@shared/model/entity.js'
import { dedupeBlockIds } from '@shared/pm/blockIds.js'
import { Mention } from './extensions/mention.js'
import { NamedStyles } from './extensions/namedStyles.js'
import { ParagraphFormat } from './extensions/paragraphFormat.js'
import { FindHighlight } from './extensions/findHighlight.js'
import { BlockIds } from './extensions/blockIds.js'
import { Anchors } from './extensions/anchors.js'

export interface CreateEditorOptions {
  content: PmDoc
  getStyles: () => NamedStyle[]
  /** Live getter for the same reason `getStyles` is one: a record created a
   *  moment ago must be @-mentionable in every open editor without a rebuild. */
  getEntities: () => StoryEntity[]
  onUpdate: () => void
}

/**
 * Build the editor for one open document.
 *
 * Editors are created outside React and live as long as the document is open,
 * not as long as a panel is mounted — so moving a tab between dock groups or
 * tearing it out into its own window keeps the undo history, selection and
 * scroll position intact.
 */
export function createEditor(options: CreateEditorOptions): Editor {
  // A duplicate `blockId` can only reach disk from outside a live editor
  // session — a hand edit, or content merged in from elsewhere — since the
  // `BlockIds` extension's own plugin keeps one session's ids unique as it
  // goes. Sanitising here, once, at the boundary, is cheaper than teaching
  // every future consumer of a `blockId` to double-check it first.
  const { doc: content } = dedupeBlockIds(options.content, () => ulid())

  return new Editor({
    content,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: { openOnClick: false, autolink: true },
        // Our own Enter handling implements "style for following paragraph".
        trailingNode: false
      }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      BackgroundColor,
      Highlight.configure({ multicolor: true }),
      Subscript,
      Superscript,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({ inline: false, allowBase64: false }),
      CharacterCount,
      Typography,
      Placeholder.configure({ placeholder: 'Begin writing…' }),
      NamedStyles.configure({ getStyles: options.getStyles }),
      Mention.configure({ getEntities: options.getEntities }),
      ParagraphFormat,
      FindHighlight,
      BlockIds,
      Anchors
    ],
    // ProseMirror *throws* on an unknown mark type rather than degrading, so
    // without this a document containing mentions would refuse to open in any
    // build lacking the extension. Reporting beats a blank panel.
    enableContentCheck: true,
    onContentError: ({ error }) => {
      console.error('Document contains content this build cannot render', error)
    },
    editorProps: {
      attributes: {
        class: 'pub-prose',
        spellcheck: 'true'
      }
    },
    // Only handlers that actually exist are passed: TipTap installs no-op
    // defaults for its lifecycle events, and handing it an explicit `undefined`
    // replaces the no-op and throws on every emit.
    onUpdate: options.onUpdate
  })
}
