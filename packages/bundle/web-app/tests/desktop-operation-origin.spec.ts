import { Context } from '@deepseek-ai/cordis'
import type { ProjectOperationOrigins, ProjectOperationOriginToken, SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { describe, expect, it, vi } from 'vitest'
import { DesktopOperationOrigin } from '../src/desktop-operation-origin.ts'

describe('desktop operation origin reader', () => {
  it('does not publish an unissued token when no reader extension is installed', () => {
    const origin = new DesktopOperationOrigin(new Context(), {} as SessionController, [],
      'profile', new AbortController().signal)
    expect(origin.reader.read({} as ProjectOperationOriginToken)).toBeNull()
  })

  it('passes the scoped reader through an installed extension', () => {
    const extend = vi.fn((reader: ProjectOperationOrigins) => reader)
    const origin = new DesktopOperationOrigin(new Context(), {} as SessionController, [],
      'profile', new AbortController().signal, extend)
    expect(extend).toHaveBeenCalledOnce()
    expect(origin.reader.read({} as ProjectOperationOriginToken)).toBeNull()
  })
})
