import { Context } from '@deepseek-ai/cordis'
import type { ProjectOperationOriginToken, SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { describe, expect, it } from 'vitest'
import { DesktopOperationOrigin } from '../src/desktop-operation-origin.ts'

describe('desktop operation origin reader', () => {
  it('does not publish an unissued token when no reader extension is installed', () => {
    const origin = new DesktopOperationOrigin(new Context(), {} as SessionController, [],
      'profile', new AbortController().signal)
    expect(origin.reader.read({} as ProjectOperationOriginToken)).toBeNull()
  })
})
