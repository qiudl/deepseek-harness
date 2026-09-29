import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace for Slark Agent mentions. */
export const NS = 'slarkAgent'

/** Simplified Chinese copy. */
export const zh = {
  'section.agents': 'Slark 企业 Agent',
  'submit.unavailable': 'Slark Agent 调用尚未接通，请稍后重试。',
} satisfies Record<string, string>

/** English copy. */
export const en = {
  'section.agents': 'Slark enterprise Agents',
  'submit.unavailable': 'Slark Agent invocation is unavailable. Try again later.',
} satisfies Record<keyof typeof zh, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Slark Agent mention copy. */
    slarkAgent: keyof typeof zh
  }
}
