/** Ordered Chat rows, local echoes, and running status share the flow slot's parent. */
import { Fragment, memo, useCallback, type ReactNode } from 'react'
import type { RenderMessageImages } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ChatFlowSlotProps, ChatTimelineRow } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { chatRenderKey } from './render-entry.ts'
import { mergeChatTimeline } from './timeline-order.ts'
import { RunningStatus } from './RunningStatus.tsx'

/** Render the flow without adding a DOM parent or changing keyed row positions. */
export const ChatFlow = memo(function ChatFlow({
  entries, pendingInputs, lastInputTurn, deferCollapse,
  useSession, useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation,
  useStore, actions, renderSlot, t, useGroupAction, useGroupHeaderAction, useTimeline, useConversation,
  cwd, openFile, openSkill, inspectCall, forkAt, loadImage, fileMentions,
}: ChatFlowSlotProps) {
  const nodeStore = useChat(snapshot => snapshot.nodes)
  const running = useSession(snapshot => snapshot.running)
  const latestTurnAnchor = useChat(snapshot => snapshot.navigation.items().at(-1)?.anchorKey)
  const runningStartTime = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.status === 'open' ? location.turn.start?.time : undefined
      : undefined
  })
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )
  const seatProps = {
    nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, openSkill, inspectCall, forkAt, loadImage, renderMessageImages, fileMentions,
  }
  const timelineRecords = useTimeline(value => value)
  const groupedView = useConversation(snapshot => snapshot.views.grouped('chat'))
  const contents = new Map<string, ReactNode>()
  const nodeRow = (entry: Extract<typeof entries[number], { kind: 'node' }>): ChatTimelineRow => {
    const key = chatRenderKey(entry)
    contents.set(key, <ChatNodeSeat {...seatProps} nodeKey={entry.key}
      {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />)
    return { key, sequence: nodeStore.get(entry.key)?.anchorSeq ?? null }
  }
  const rows: ChatTimelineRow[] = entries.map((entry) => {
    switch (entry.kind) {
      case 'node': return nodeRow(entry)
      case 'group': {
        const members = groupedView?.groupSource(entry.key).getSnapshot()?.members.map(nodeRow) ?? []
        const key = chatRenderKey(entry)
        contents.set(key, <ChatGroupSeat {...seatProps} groupKey={entry.key}
          useChatGroup={useChatGroup} useGroupHeaderAction={useGroupHeaderAction} />)
        return { key, sequence: members[0]?.sequence ?? null, members }
      }
      default:
        return assertNever(entry)
    }
  })
  const pendingRows = pendingInputs.map((item): ChatTimelineRow => {
    const key = `pending:${'requestId' in item ? item.requestId : item.id}`
    contents.set(key, 'requestId' in item ? <PendingSubmissionBubble submission={item}
      renderMessageImages={renderMessageImages} t={t} />
      : <PendingSteeringBubble content={item.content} renderMessageImages={renderMessageImages} t={t} />)
    return { key, sequence: null }
  })
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? nodeStore.get(tail.key) : undefined
  // An empty opening control follows one local transcript echo, never steering.
  // All rows share this keyed list so inserting the control keeps the echo mounted.
  if (node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn) {
    const index = pendingInputs.findIndex(item => 'requestId' in item && item.placement === 'transcript')
    if (index !== -1) rows.splice(rows.length - 1, 0, ...pendingRows.splice(index, 1))
  }
  return <>
    {renderSlot('conversation.chat.timeline', { recordId: null })}
    {[...mergeChatTimeline(rows, timelineRecords), ...pendingRows.map(row => ({ kind: 'ordinary' as const, row }))]
      .map(entry => entry.kind === 'ordinary'
        ? <Fragment key={entry.row.key}>{contents.get(entry.row.key)}</Fragment>
        : <Fragment key={`independent:${entry.record.recordId}`}>
          {renderSlot('conversation.chat.timeline', { recordId: entry.record.recordId })}
        </Fragment>)}
    {running && <RunningStatus key="running" startTime={runningStartTime} t={t} />}
  </>
})
