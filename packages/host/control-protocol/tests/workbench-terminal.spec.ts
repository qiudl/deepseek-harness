import assert from 'node:assert/strict'
import { it } from 'vitest'
import { parseWorkbenchTerminalRequest as parse } from '../src/workbench-terminal.ts'
const sessionId = 'session-1'
const intent = (method: unknown, args: unknown) => ({ sessionId, method, args })
it('preserves only exact terminal methods and binds every argument to its controlled Session', () => {
  const valid = [intent('environment', { agent: sessionId }), intent('shells', { agent: sessionId }),
    intent('list', { sessionId }), intent('create', { agent: sessionId, request: { id: 't-1', cols: 80, rows: 24 } }),
    intent('create', { agent: sessionId, request: { id: 't-1', cols: 500, rows: 200, shellPath: '/bin/zsh' } }),
    intent('write', { agent: sessionId, id: 't-1', attachmentId: 'a-1', data: '\u0003\t你好\n' }),
    intent('resize', { agent: sessionId, id: 't-1', attachmentId: 'a-1', cols: 2, rows: 1 }),
    intent('rename', { agent: sessionId, id: 't-1', title: ' 新终端 ' }), intent('close', { agent: sessionId, id: 't-1' })]
  for (const input of valid) { const actual = parse(input); assert.deepEqual(actual, input); assert.notEqual(actual?.args, input.args) }
  for (const input of [null, [], 1, {}, { ...valid[0], computerId: 'other' }, { ...valid[0], args: null },
    { ...valid[0], args: [] }, { ...valid[0], sessionId: 1 }, { ...valid[0], sessionId: '' },
    intent('list', { sessionId: 'foreign' }), intent('list', { sessionId, agent: sessionId }),
    intent('environment', { agent: 'foreign' }), intent('environment', { agent: sessionId, shell: 'anything' }),
    intent('destroy', { agent: sessionId }),
    ...[null, {}, { id: 1, cols: 80, rows: 24 }, { id: '', cols: 80, rows: 24 },
      { id: 'bad id', cols: 80, rows: 24 }, { id: 't', cols: '80', rows: 24 },
      { id: 't', cols: 1.5, rows: 24 }, { id: 't', cols: 1, rows: 24 }, { id: 't', cols: 501, rows: 24 },
      { id: 't', cols: 80, rows: 0 }, { id: 't', cols: 80, rows: 201 },
      ...[1, '', 'x'.repeat(4097), '/bin/zsh\0'].map(shellPath => ({ id: 't', cols: 80, rows: 24, shellPath })),
      { id: 't', cols: 80, rows: 24, argv: ['rm'] }].map(request => intent('create', { agent: sessionId, request })),
    intent('create', { agent: sessionId, request: {}, profile: 'foreign' }),
    ...[{ id: 't', attachmentId: 'a' }, { id: '', attachmentId: 'a', data: '' },
      { id: 't', attachmentId: '', data: '' }, { id: 't', attachmentId: 'a', data: 1 },
      { id: 't', attachmentId: 'a', data: '你'.repeat(10923) }, { id: 't', attachmentId: 'a', data: '\0'.repeat(10000) }]
      .map(args => intent('write', { agent: sessionId, ...args })),
    ...[{ id: 't', attachmentId: 'a', cols: 80 }, { id: '', attachmentId: 'a', cols: 80, rows: 24 },
      { id: 't', attachmentId: '', cols: 80, rows: 24 }, { id: 't', attachmentId: 'a', cols: 501, rows: 24 },
      { id: 't', attachmentId: 'a', cols: 80, rows: 201 }].map(args => intent('resize', { agent: sessionId, ...args })),
    ...[{ id: 't' }, { id: '', title: 't' }, { id: 't', title: 1 }, { id: 't', title: ' ' },
      { id: 't', title: 'x'.repeat(121) }].map(args => intent('rename', { agent: sessionId, ...args })),
    intent('close', { agent: sessionId, id: '' }), intent('close', { agent: sessionId, id: 't', all: true }),
  ]) assert.equal(parse(input), undefined, JSON.stringify(input)?.slice(0, 200))
})
