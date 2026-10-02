import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace for Slark Agent mentions. */
export const NS = 'slarkAgent'

/** Simplified Chinese copy. */
export const zh = {
  'section.agents': 'Slark 企业 Agent',
  'submit.unavailable': 'Slark Agent 调用尚未接通，请稍后重试。',
  'submit.single': '每次只能向一个 Slark Agent 发送纯文本问题。',
  'submit.question': '请输入要交给 Agent 的任务或问题。',
  'submit.changed': '输入内容已变化，请重新发送。',
  'submit.accepted': 'Agent 调用已受理，结果将在本会话显示。',
  'task.title': 'Agent 任务',
  'task.question': '你发送的消息',
  'task.answer': 'Agent 回复',
  'task.waiting': '等待答复',
  'task.background': '后台执行中',
  'task.done': '已完成',
  'task.failed': '未完成',
} satisfies Record<string, string>

/** English copy. */
export const en = {
  'section.agents': 'Slark enterprise Agents',
  'submit.unavailable': 'Slark Agent invocation is unavailable. Try again later.',
  'submit.single': 'Send one text question to one Slark Agent at a time.',
  'submit.question': 'Enter a task or question for the Agent.',
  'submit.changed': 'The draft changed. Send again.',
  'submit.accepted': 'Agent invocation accepted. The result will appear in this session.',
  'task.title': 'Agent tasks',
  'task.question': 'Your message',
  'task.answer': 'Agent reply',
  'task.waiting': 'Waiting for reply',
  'task.background': 'Running in background',
  'task.done': 'Completed',
  'task.failed': 'Not completed',
} satisfies Record<keyof typeof zh, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Slark Agent mention copy. */
    slarkAgent: keyof typeof zh
  }
}
