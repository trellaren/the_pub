import { z } from 'zod'

/**
 * The daily writing prompt on the welcome screen.
 *
 * Shown only when the app already has a model to ask — an embedded one that has
 * been downloaded, or a provider that has been connected. There is no canned
 * fallback list, and that is deliberate: a rotating deck of stock prompts would
 * be a different feature wearing this one's clothes, and an app that quietly
 * substitutes one for the other teaches its writer not to trust what it says.
 */
export const dailyPromptSchema = z.object({
  /** `YYYY-MM-DD` in the writer's local time — the day the prompt belongs to. */
  date: z.string().default(''),
  text: z.string().default(''),
  /** Which angle it was asked for, so the same one is not drawn twice running. */
  angle: z.string().default('')
})
export type DailyPrompt = z.infer<typeof dailyPromptSchema>

export const EMPTY_DAILY_PROMPT: DailyPrompt = { date: '', text: '', angle: '' }

/**
 * The angles a prompt can be asked from.
 *
 * The randomisation lives here rather than in the model's own temperature,
 * because a model asked "give me a writing prompt" thirty days running gives
 * thirty variations on a locked door and a letter. Picking the *angle* here and
 * the words there is what makes a month of these read like a month of different
 * mornings.
 */
export const PROMPT_ANGLES = [
  'a character arriving somewhere too late',
  'an object that changes hands',
  'two people who agree about everything except one thing',
  'a place described by someone who is leaving it',
  'a conversation where the real subject is never named',
  'a small kindness with an unwelcome consequence',
  'a routine performed for the last time',
  'weather that refuses to match the mood',
  'a lie told for a good reason',
  'something found that was not lost',
  'a room after everyone has gone',
  'an apology that arrives decades late',
  'a skill inherited from someone unforgiven',
  'a border, literal or otherwise, being crossed',
  'a person recognised out of context'
] as const

/** The local calendar day, which is what "daily" means to a person. */
export function today(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Choose today's angle, avoiding yesterday's.
 *
 * Random rather than a rotation through the list, because a rotation is a
 * pattern a daily reader notices within a fortnight — but never the same angle
 * twice running, which is the one repetition that reads as a bug.
 */
export function pickAngle(previous: string, random: () => number = Math.random): string {
  const choices = PROMPT_ANGLES.filter((angle) => angle !== previous)
  return choices[Math.floor(random() * choices.length)] ?? PROMPT_ANGLES[0]
}

/** What the model is asked. Kept here so a test can assert on it. */
export function promptRequest(angle: string): string {
  return [
    'Write one writing prompt for a fiction writer, two sentences at most.',
    `Build it around this angle: ${angle}.`,
    'Give the prompt only — no preamble, no title, no quotation marks.'
  ].join(' ')
}

/**
 * Whether the stored prompt is today's.
 *
 * Empty text counts as stale even on today's date, so a failed request is
 * retried tomorrow rather than pinning an empty card in place.
 */
export function isFresh(prompt: DailyPrompt, date = today()): boolean {
  return prompt.date === date && prompt.text.trim().length > 0
}
