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
import type { PmDoc } from '@shared/model/document.js'
import type { NamedStyle } from '@shared/model/style.js'
import { NamedStyles } from './extensions/namedStyles.js'
import { ParagraphFormat } from './extensions/paragraphFormat.js'
import { FindHighlight } from './extensions/findHighlight.js'

export interface CreateEditorOptions {
  content: PmDoc
  getStyles: () => NamedStyle[]
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
  return new Editor({
    content: options.content,
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
      ParagraphFormat,
      FindHighlight
    ],
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
