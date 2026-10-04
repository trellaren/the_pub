import { describe, expect, it } from 'vitest'
import { resolveEmbedder, type EmbedderDeps } from './embeddedRuntime.js'
import { aiSettingsSchema } from '../../shared/model/ai.js'

const CUSTOM = 'https://proxy.example'

function deps(options: { stored: boolean; confirm: boolean }) {
  const askedWith: (number | undefined)[] = []
  const value: EmbedderDeps = {
    engine: { runningUrl: () => null } as unknown as EmbedderDeps['engine'],
    models: {} as EmbedderDeps['models'],
    appState: { get: () => ({ aiEnabled: true }) } as unknown as EmbedderDeps['appState'],
    sessions: {
      get: () =>
        ({
          chats: { settings: () => aiSettingsSchema.parse({ provider: 'openai', baseUrl: CUSTOM }) }
        }) as unknown as ReturnType<EmbedderDeps['sessions']['get']>
    },
    keyFor: async (_id, _url, _default, _name, asker) => {
      askedWith.push(asker)
      return options.stored && options.confirm && asker !== undefined ? 'sk-test' : null
    },
    hasKey: () => options.stored
  }
  return { value, askedWith }
}

describe('resolveEmbedder on a custom host', () => {
  it('asks the requesting window to confirm only for a build the author started', async () => {
    const { value, askedWith } = deps({ stored: true, confirm: true })
    await resolveEmbedder(value, 7, false)
    const built = await resolveEmbedder(value, 7, true)
    expect(askedWith).toEqual([undefined, 7])
    expect(built.embedder).not.toBeNull()
  })

  it('tells a background pass how to confirm, rather than claiming there is no key', async () => {
    const { value } = deps({ stored: true, confirm: false })
    const result = await resolveEmbedder(value, 7, false)
    expect(result.unavailable).toBe(`Build the index to confirm sending your OpenAI key to ${CUSTOM}.`)
  })

  it('says the key was not sent when the author declines', async () => {
    const { value } = deps({ stored: true, confirm: false })
    expect((await resolveEmbedder(value, 7, true)).unavailable).toBe(`Your OpenAI key was not sent to ${CUSTOM}.`)
  })

  it('still reports a missing key as missing', async () => {
    const { value } = deps({ stored: false, confirm: false })
    expect((await resolveEmbedder(value, 7, true)).unavailable).toBe('No API key is set for OpenAI.')
  })
})
