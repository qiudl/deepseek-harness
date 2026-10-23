import assert from 'node:assert/strict'
import { it } from 'vitest'
import { parseWorkbenchTerminalRequest as parse, parseWorkbenchTerminalStreamPayload as stream } from '../src/workbench-terminal.ts'
const sessionId = 'session-1'
const intent = (method: unknown, args: unknown) => ({ sessionId, method, args })
it('preserves only exact terminal methods and binds every argument to its controlled Session', () => {
  const valid = [intent('follow', { agentId: sessionId, id: 't', attachmentId: 'a' }), intent('retain', { sessionId, id: 't' }), intent('environment', { agentId: sessionId }), intent('shells', { agentId: sessionId }),
    intent('list', { sessionId }), intent('create', { agentId: sessionId, request: { id: 't-1', cols: 80, rows: 24 } }),
    intent('create', { agentId: sessionId, request: { id: 't-1', cols: 500, rows: 200, shellPath: '/bin/zsh' } }),
    intent('write', { agentId: sessionId, id: 't-1', attachmentId: 'a-1', data: '\u0003\t你好\n' }),
    intent('resize', { agentId: sessionId, id: 't-1', attachmentId: 'a-1', cols: 2, rows: 1 }),
    intent('rename', { agentId: sessionId, id: 't-1', title: ' 新终端 ' }), intent('close', { agentId: sessionId, id: 't-1' })]
  for (const input of valid) { const actual = parse(input); assert.deepEqual(actual, input); assert.notEqual(actual?.args, input.args) }
  for (const input of [null, [], 1, {}, { ...valid[0], computerId: 'other' }, { ...valid[0], args: null },
    { ...valid[0], args: [] }, { ...valid[0], sessionId: 1 }, { ...valid[0], sessionId: '' },
    intent('list', { sessionId: 'foreign' }), intent('list', { sessionId, agentId: sessionId }),
    intent('environment', { agentId: 'foreign' }), intent('environment', { agentId: sessionId, shell: 'anything' }),
    intent('destroy', { agentId: sessionId }),
    intent('retain', { sessionId, id: '' }), intent('retain', { sessionId: 'foreign', id: 't' }),
    intent('follow', { agentId: sessionId, id: 't', attachmentId: '' }), intent('follow', { agentId: sessionId, id: '', attachmentId: 'a' }),
    intent('follow', { agentId: sessionId, id: 't' }),
    ...[null, {}, { id: 1, cols: 80, rows: 24 }, { id: '', cols: 80, rows: 24 },
      { id: 'bad id', cols: 80, rows: 24 }, { id: 't', cols: '80', rows: 24 },
      { id: 't', cols: 1.5, rows: 24 }, { id: 't', cols: 1, rows: 24 }, { id: 't', cols: 501, rows: 24 },
      { id: 't', cols: 80, rows: 0 }, { id: 't', cols: 80, rows: 201 },
      ...[1, '', 'x'.repeat(4097), '/bin/zsh\0'].map(shellPath => ({ id: 't', cols: 80, rows: 24, shellPath })),
      { id: 't', cols: 80, rows: 24, argv: ['rm'] }].map(request => intent('create', { agentId: sessionId, request })),
    intent('create', { agentId: sessionId, request: {}, profile: 'foreign' }),
    ...[{ id: 't', attachmentId: 'a' }, { id: '', attachmentId: 'a', data: '' },
      { id: 't', attachmentId: '', data: '' }, { id: 't', attachmentId: 'a', data: 1 },
      { id: 't', attachmentId: 'a', data: '你'.repeat(10923) }, { id: 't', attachmentId: 'a', data: '\0'.repeat(10000) }]
      .map(args => intent('write', { agentId: sessionId, ...args })),
    ...[{ id: 't', attachmentId: 'a', cols: 80 }, { id: '', attachmentId: 'a', cols: 80, rows: 24 },
      { id: 't', attachmentId: '', cols: 80, rows: 24 }, { id: 't', attachmentId: 'a', cols: 501, rows: 24 },
      { id: 't', attachmentId: 'a', cols: 80, rows: 201 }].map(args => intent('resize', { agentId: sessionId, ...args })),
    ...[{ id: 't' }, { id: '', title: 't' }, { id: 't', title: 1 }, { id: 't', title: ' ' },
      { id: 't', title: 'x'.repeat(121) }].map(args => intent('rename', { agentId: sessionId, ...args })),
    intent('close', { agentId: sessionId, id: '' }), intent('close', { agentId: sessionId, id: 't', all: true }),
  ]) assert.equal(parse(input), undefined, JSON.stringify(input)?.slice(0, 200))
})

it('streams accept only a detached one-use grant handle without Session selectors', () => {
  const value = { args: { grantId: '123e4567-e89b-42d3-a456-426614174000' } }
  assert.deepEqual(stream(value), value)
  assert.notEqual(stream(value)?.args, value.args)
  for (const input of [null, [], {}, { args: null }, { args: [] }, { ...value, sessionId: 'other' },
    { args: { ...value.args, sessionId: 'other' } }, { args: { grantId: 1 } }, { args: { grantId: 'bad' } }]) {
    assert.equal(stream(input), undefined)
  }
})
