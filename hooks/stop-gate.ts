// E5: a turn that ends by announcing work instead of doing it.
import type { JevQuestion } from './jev'

export const STOP_POINT = 'stop'

// Measured with jev-1.14.0 (10 repeats each): this two-way choice put
// announcing endings at 0.98-0.99 and reports or questions at 0.01-0.03,
// where a noul left clear announcements at 0.45-0.63.
export const STOP_QUESTION: JevQuestion = {
  type: 'choice',
  instructions: 'How does the last paragraph of an assistant turn end?',
  criteria: {
    announce: 'It announces work it has not done yet and stops there.',
    report: 'It reports what was done, asks the person something, or says why it stopped.',
  },
}

/** How much of the last paragraph goes to Jev, from its end. */
export const PARAGRAPH_CHARS = 600

export const STOP_MESSAGE =
  'Your last paragraph announces work you have not done yet. If you can do it now, do it. ' +
  'If you are waiting for the person, say plainly what you need from them.'


/** The last prose paragraph of a message. The caller scrubs it and then keeps
 * its end, at most `PARAGRAPH_CHARS`: a cut before the scrub could leave part
 * of a value the scrub would have replaced. */
export function lastParagraph(message: string | undefined): string {
  if (message === undefined) return ''
  const withoutFences = message.replace(/```[\s\S]*?```/g, '\n\n')
  const blocks = withoutFences
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(block => block !== '' && !/^(\|.*\|\s*)+$/s.test(block) && !/^[-=*_`\s]+$/.test(block))
  return blocks.at(-1) ?? ''
}

const lastSentence = (paragraph: string): string => {
  const sentences = paragraph.split(/(?<=[.!?。])\s+|\n+/).map(s => s.trim()).filter(Boolean)

  return sentences.at(-1) ?? ''
}

// Conditioned endings wait on the person ("알려주시면 처리하겠습니다") or on
// running work ("결과가 나오면 말씀드리겠습니다") and are legitimate. Replaying
// 3,000 past turn ends showed these were most of what the rule wrongly flagged.
const CONDITIONAL =
  /[가-힣](시면|으면|면)(\s|,)|let me know|\bif you\b|\bonce\b|\bwhen (it|they|the|that|this|you|all|both)\b|\bafter (it|they|the|that|this|you)\b|\bas soon as\b/i

const ANNOUNCE_KO = /(할게요|하겠습니다|진행할게요|진행하겠습니다|드릴게요|드리겠습니다|해볼게요|해 볼게요|볼게요|시작할게요|시작하겠습니다)\s*[.!]?\s*$/
const ANNOUNCE_EN = /\b(I'll|I will|I'm going to|Next,? I|Now I'll|Let me (?!know))\b/i

/** The rule's verdict: does the last sentence announce work? */
export function announcesByRule(paragraph: string): boolean {
  const sentence = lastSentence(paragraph)
  if (sentence === '' || CONDITIONAL.test(sentence)) return false

  return ANNOUNCE_KO.test(sentence) || ANNOUNCE_EN.test(sentence)
}

export type StopFacts = {
  /** The turn answers the plugin's own request to update the canonical files before a fold. */
  isFoldCleanup?: boolean
  stopHookActive: boolean
  permissionMode?: string
  backgroundTasks: number
  scheduledTasks: number
  agentId?: string
  paragraph: string
}

/** Why this stop is not judged at all, or undefined when it is. */
export function stopSkipReason(facts: StopFacts): string | undefined {
  if (facts.agentId !== undefined) return 'subagent'
  if (facts.isFoldCleanup === true) return 'fold-cleanup'
  if (facts.stopHookActive) return 'stop-hook-active'
  if (facts.permissionMode === 'plan') return 'plan-mode'
  if (facts.backgroundTasks > 0) return 'background-tasks'
  if (facts.scheduledTasks > 0) return 'scheduled-tasks'
  if (facts.paragraph === '') return 'empty'
  const sentence = lastSentence(facts.paragraph)
  if (/[?？]\s*$/.test(sentence)) return 'question'
  if (CONDITIONAL.test(sentence)) return 'conditional'

  return undefined
}
