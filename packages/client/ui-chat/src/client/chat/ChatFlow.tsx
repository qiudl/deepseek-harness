/** Ordered Chat rows, local echoes, and running status share the flow slot's parent. */
import { Fragment, memo, type ReactNode } from 'react'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ChatFlowSlotProps, ChatTimelineRow } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { chatRenderKey } from './render-entry.ts'
import { mergeChatTimeline } from './timeline-order.ts'
import { RunningStatus } from './RunningStatus.tsx'

/** A local submission echo, or a Host-pending steering item without a local submission. */
type PendingInput = ChatFlowSlotProps['pendingInputs'][number]

/** Whether the echo is a local submission rather than a Host-pending steering item. */
function isLocalSubmission(item: PendingInput): item is PendingSubmission {
  return 'requestId' in item
}

/** Whether the echo is a local submission that opens a new Turn. */
function isTranscriptEcho(item: PendingInput): boolean {
  return isLocalSubmission(item) && item.placement === 'transcript'
}

/** Render the flow without adding a DOM parent or changing keyed row positions. */
export const ChatFlow = memo(function ChatFlow({
  entries, pendingInputs, lastInputTurn, deferCollapse,
  useSession, useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation, useConnectionState,
  useStore, actions, renderSlot, renderFactorySlot, t, useGroupAction, useGroupHeaderAction, useTimeline, useConversation,
  cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
}: ChatFlowSlotProps) {
  const nodeStore = useChat(snapshot => snapshot.nodes)
  const running = useSession(snapshot => snapshot.running)
  const disconnected = useConnectionState(state => state === 'disconnected' || state === 'connecting')
  const latestTurnAnchor = useChat(snapshot => snapshot.navigation.items().at(-1)?.anchorKey)
  const runningStartTime = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.status === 'open' ? location.turn.start?.time : undefined
      : undefined
  })
  const latestTurnOpen = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return (location?.kind === 'turn' || location?.kind === 'step') && location.turn.status === 'open'
  })
  const holding = !running && latestTurnOpen
  const seatProps = {
    nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
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
  const firstTranscript = pendingInputs.findIndex(isTranscriptEcho)
  const leadingRows: ChatTimelineRow[] = []
  const openingRows: ChatTimelineRow[] = []
  const pendingRows: ChatTimelineRow[] = []
  for (const [index, item] of pendingInputs.entries()) {
    const key = `pending:${isLocalSubmission(item) ? item.requestId : item.id}`
    contents.set(key, isLocalSubmission(item)
      ? <PendingSubmissionBubble submission={item} loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
      : <PendingSteeringBubble content={item.content} loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />)
    const row: ChatTimelineRow = { key, sequence: null }
    if (index <= firstTranscript) leadingRows.push(row)
    else if (isTranscriptEcho(item)) openingRows.push(row)
    else pendingRows.push(row)
  }
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? nodeStore.get(tail.key) : undefined
  // An empty opening control follows the echoes that lead its Turn.
  // All rows share this keyed list so inserting the control keeps the echoes mounted.
  if (node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn) {
    rows.splice(rows.length - 1, 0, ...leadingRows.splice(0))
  }
  const timeline = mergeChatTimeline([...rows, ...leadingRows, ...openingRows], timelineRecords)
  return <>
    {renderSlot('conversation.chat.timeline', { recordId: null })}
    {timeline.map(entry => entry.kind === 'ordinary'
      ? <Fragment key={entry.row.key}>{contents.get(entry.row.key)}</Fragment>
      : <Fragment key={`independent:${entry.record.recordId}`}>
        {renderSlot('conversation.chat.timeline', { recordId: entry.record.recordId })}
      </Fragment>)}
    {(running || holding) && <RunningStatus key="running" startTime={runningStartTime}
      paused={disconnected} holding={holding} t={t} />}
    {pendingRows.map(row => <Fragment key={row.key}>{contents.get(row.key)}</Fragment>)}
  </>
})
