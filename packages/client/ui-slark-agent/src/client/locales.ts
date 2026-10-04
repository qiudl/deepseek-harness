import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace for Slark Agent mentions. */
export const NS = 'slarkAgent'

/** Simplified Chinese copy. */
export const zh = {
  'scope.selectedPending': '还有 {count} 个已选空间未在当前目录中显示。加载更多可查看，已有选择会保留。',
  'scope.title': 'Slark 协同',
  'scope.description': '选择此 DSH 工作区可 @ 的 Slark 项目空间，可多选。日常任务直接在聊天中 @Agent 并用自然语言描述。',
  'scope.count': '已选 {count} 个空间',
  'scope.ungrouped': '此会话未归属 DSH 工作区。请先将它加入工作区，再设置项目范围。',
  'scope.loading': '正在读取项目范围…',
  'scope.projects': '项目空间',
  'scope.agents': '范围内的 Agent',
  'scope.empty': '尚未选择项目空间，当前没有可 @ 的 Slark Agent。',
  'scope.noProjects': '当前没有可用的项目空间。',
  'scope.more': '加载更多',
  'scope.clear': '清空选择',
  'scope.cancel': '取消',
  'scope.apply': '应用范围',
  'scope.saving': '保存中…',
  'scope.refresh': '刷新',
  'scope.conflict': '范围已被其他窗口修改，已重新读取。请重新选择后应用。',
  'scope.uncertain': '保存结果未能确认，已尝试重新读取当前范围。请核对后再操作。',
  'scope.unavailable': '范围或目录读取失败。请刷新后重试。',
  'scope.executorPending': '项目范围可以设置，Agent 目录目前仅供查看；新版任务发送尚未接通。',
  'scope.readOnly': '仅供查看',
  'scope.mentionReady': '可 @ 发送',
  'scope.chatReady': '在聊天中 @ 下方 Agent，即可用自然语言提交任务。',

  'section.agents': 'Slark 企业 Agent',
  'section.scopedAgents': 'Slark Agent',
  'submit.unavailable': 'Slark Agent 调用尚未接通，请稍后重试。',
  'submit.single': '每次只能向一个 Slark Agent 发送纯文本问题。',
  'submit.question': '请输入要交给 Agent 的任务或问题。',
  'submit.changed': '输入内容已变化，请重新发送。',
  'submit.accepted': 'Agent 调用已受理，结果将在本会话显示。',
  'submit.acceptedV2': '任务已受理。',
  'submit.uncertainV2': '发送结果尚未确认，原消息已保留。再次发送会核对同一条消息。',
  'submit.unavailableV2': '当前无法受理这条任务，原消息已保留。',
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
  'scope.selectedPending': '{count} selected spaces are outside the loaded list. Load more to view them; existing selections are retained.',
  'scope.title': 'Slark collaboration',
  'scope.description': 'Choose the Slark project spaces this DSH workspace can mention. Select multiple spaces, then describe tasks in chat with @Agent.',
  'scope.count': '{count} spaces selected',
  'scope.ungrouped': 'This Session is outside a DSH workspace. Add it to a workspace before selecting project spaces.',
  'scope.loading': 'Reading project scope…',
  'scope.projects': 'Project spaces',
  'scope.agents': 'Agents in scope',
  'scope.empty': 'No project spaces selected. No Slark Agents can be mentioned.',
  'scope.noProjects': 'No project spaces are currently available.',
  'scope.more': 'Load more',
  'scope.clear': 'Clear selection',
  'scope.cancel': 'Cancel',
  'scope.apply': 'Apply scope',
  'scope.saving': 'Saving…',
  'scope.refresh': 'Refresh',
  'scope.conflict': 'Another window changed the scope. It has been reloaded. Select again before applying.',
  'scope.uncertain': 'The save result could not be confirmed. A fresh read was attempted. Check the current scope before proceeding.',
  'scope.unavailable': 'Scope or directory could not be read. Refresh and try again.',
  'scope.executorPending': 'Project scope can be saved. The Agent directory is currently read-only; the new task submission is not connected yet.',
  'scope.readOnly': 'Read-only',
  'scope.mentionReady': 'Available for @ tasks',
  'scope.chatReady': 'Mention an Agent below in chat and describe the task in natural language.',

  'section.agents': 'Slark enterprise Agents',
  'section.scopedAgents': 'Slark Agents',
  'submit.unavailable': 'Slark Agent invocation is unavailable. Try again later.',
  'submit.single': 'Send one text question to one Slark Agent at a time.',
  'submit.question': 'Enter a task or question for the Agent.',
  'submit.changed': 'The draft changed. Send again.',
  'submit.accepted': 'Agent invocation accepted. The result will appear in this session.',
  'submit.acceptedV2': 'Task accepted.',
  'submit.uncertainV2': 'Submission could not be confirmed. The draft is retained; sending again checks the same message.',
  'submit.unavailableV2': 'This task could not be accepted. The draft is retained.',
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
