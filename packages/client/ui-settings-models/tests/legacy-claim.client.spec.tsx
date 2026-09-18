// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyModelClaimCard } from '../src/client/LegacyModelClaimCard.tsx'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en) => en[key]
const candidate = { id: 'llm-deepseek:deepseek', provider: 'deepseek', kind: 'llm' as const,
  credential: 'present' as const, sharedCredential: false }
const inventory = { sourceDigest: 'a'.repeat(64), candidates: [candidate], unsupportedSettings: 0,
  unassignedCredentialReferences: 0, unassignedCredentialRecords: 0 }
const receipt = { candidateId: candidate.id, operationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3142',
  sourceDigest: inventory.sourceDigest, status: 'pending' as const }

afterEach(() => { cleanup(); Reflect.deleteProperty(globalThis, '__DSH_DESKTOP_HOST__') })

describe('Desktop legacy model claim card', () => {
  it('stays absent in the ordinary web app', () => {
    const { container } = render(<LegacyModelClaimCard t={t} onChanged={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('stays absent when a host surface does not provide the complete claim bridge', () => {
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', { modelClaimAvailable: true, modelClaimInventory: vi.fn() })
    const { container } = render(<LegacyModelClaimCard t={t} onChanged={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('stays absent in a nonpersonal Desktop DSH view', () => {
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', { modelClaimAvailable: false })
    const { container } = render(<LegacyModelClaimCard t={t} onChanged={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('inspects redacted candidates and refreshes models after an explicit claim', async () => {
    const changed = vi.fn()
    const claimModel = vi.fn(async () => ({ ok: true as const, operationId: receipt.operationId,
      outcome: { state: 'committed' as const, cleanupPending: false } }))
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      modelClaimAvailable: true,
      modelClaimInventory: async () => ({ ok: true, inventory }), claimModel,
      modelClaimRecoveryStatus: async () => ({ ok: true, receipt: null }),
      recoverModelClaim: vi.fn(),
    })
    render(<LegacyModelClaimCard t={t} onChanged={changed} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText('deepseek')
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimApply }))
    await waitFor(() => { expect(changed).toHaveBeenCalledOnce() })
    expect(claimModel).toHaveBeenCalledWith({ candidateId: candidate.id, sourceDigest: inventory.sourceDigest })
    expect(screen.getByRole('status').textContent).toBe(en.legacyClaimSaved)
  })

  it('shows pending recovery and retries only its exact receipt', async () => {
    const changed = vi.fn()
    const recoverModelClaim = vi.fn(async () => ({ ok: true as const,
      outcome: { state: 'committed' as const, cleanupPending: false } }))
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      modelClaimAvailable: true,
      modelClaimInventory: async () => ({ ok: true, inventory }),
      claimModel: async () => ({ ok: false, errorCode: 'unavailable', operationId: receipt.operationId }),
      modelClaimRecoveryStatus: async () => ({ ok: true, receipt }), recoverModelClaim,
    })
    render(<LegacyModelClaimCard t={t} onChanged={changed} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText('deepseek')
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimApply }))
    await screen.findByRole('button', { name: en.legacyClaimRetry })
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimRetry }))
    await waitFor(() => { expect(changed).toHaveBeenCalledOnce() })
    expect(recoverModelClaim).toHaveBeenCalledWith({ candidateId: candidate.id,
      operationId: receipt.operationId, sourceDigest: receipt.sourceDigest, action: 'retry' })
    expect(screen.queryByRole('button', { name: en.legacyClaimRetry })).toBeNull()
  })

  it('keeps missing credentials unclaimable and allows restore of a pending operation', async () => {
    const changed = vi.fn()
    const missing = { ...candidate, credential: 'missing' as const, sharedCredential: true }
    const recoverModelClaim = vi.fn(async () => ({ ok: true as const,
      outcome: { state: 'restored' as const, cleanupPending: false } }))
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      modelClaimAvailable: true,
      modelClaimInventory: async () => ({ ok: true, inventory: { ...inventory, candidates: [missing] } }),
      claimModel: vi.fn(), modelClaimRecoveryStatus: async () => ({ ok: true, receipt }), recoverModelClaim,
    })
    render(<LegacyModelClaimCard t={t} onChanged={changed} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText('deepseek')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.legacyClaimApply }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimStatus }))
    await screen.findByRole('button', { name: en.legacyClaimRestore })
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimRestore }))
    await waitFor(() => { expect(changed).toHaveBeenCalledOnce() })
    expect(recoverModelClaim).toHaveBeenCalledWith({ candidateId: candidate.id,
      operationId: receipt.operationId, sourceDigest: receipt.sourceDigest, action: 'restore' })
    expect(screen.getByRole('status').textContent).toBe(en.legacyClaimRestored)
  })

  it.each([
    ['reported', async () => ({ ok: false, errorCode: 'upgrade_required' })],
    ['transport', async () => { throw new Error('disconnected') }],
  ])('reports %s inventory failures without showing candidates', async (_name, inspect) => {
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', { modelClaimAvailable: true, modelClaimInventory: inspect,
      claimModel: vi.fn(), modelClaimRecoveryStatus: vi.fn(), recoverModelClaim: vi.fn() })
    render(<LegacyModelClaimCard t={t} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByRole('status')
    expect(screen.queryByText('deepseek')).toBeNull()
  })

  it('renders an empty inventory and a search provider that needs no key', async () => {
    let result: {
      sourceDigest: string
      candidates: Array<{
        id: string
        provider: string
        kind: 'llm' | 'web-search'
        credential: 'present' | 'missing' | 'none'
        sharedCredential: boolean
      }>
      unsupportedSettings: number
      unassignedCredentialReferences: number
      unassignedCredentialRecords: number
    } = { ...inventory, candidates: [] }
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      modelClaimAvailable: true,
      modelClaimInventory: async () => ({ ok: true, inventory: result }),
      claimModel: vi.fn(), modelClaimRecoveryStatus: vi.fn(), recoverModelClaim: vi.fn(),
    })
    render(<LegacyModelClaimCard t={t} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText(en.legacyClaimEmpty)
    result = { ...inventory, candidates: [{ ...candidate, id: 'web-search-deepseek:deepseek',
      kind: 'web-search', credential: 'none', sharedCredential: false }] }
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText(new RegExp(en.legacyClaimSearch))
    expect(screen.getByText(new RegExp(en.legacyClaimNoKey))).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.legacyClaimApply }).disabled).toBe(true)
  })

  it.each([
    ['reported', async () => ({ ok: false, errorCode: 'unauthorized' })],
    ['transport', async () => { throw new Error('disconnected') }],
  ])('reports %s status failures', async (_name, query) => {
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      modelClaimAvailable: true,
      modelClaimInventory: async () => ({ ok: true, inventory }), claimModel: vi.fn(),
      modelClaimRecoveryStatus: query, recoverModelClaim: vi.fn(),
    })
    render(<LegacyModelClaimCard t={t} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText('deepseek')
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimStatus }))
    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toContain(en.legacyClaimFailed)
  })

  it.each([
    ['cancelled', async () => ({ ok: false, errorCode: 'cancelled' })],
    ['rejected', async () => ({ ok: false, errorCode: 'stale' })],
    ['transport', async () => { throw new Error('disconnected') }],
  ])('handles %s claim responses without changing the model store', async (_name, claimModel) => {
    const changed = vi.fn()
    const claim = vi.fn(claimModel)
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      modelClaimAvailable: true,
      modelClaimInventory: async () => ({ ok: true, inventory }), claimModel: claim,
      modelClaimRecoveryStatus: vi.fn(), recoverModelClaim: vi.fn(),
    })
    render(<LegacyModelClaimCard t={t} onChanged={changed} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText('deepseek')
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimApply }))
    await waitFor(() => { expect(claim).toHaveBeenCalledOnce() })
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps an ambiguous claim failure visible when receipt lookup also fails', async () => {
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      modelClaimAvailable: true,
      modelClaimInventory: async () => ({ ok: true, inventory }),
      claimModel: async () => ({ ok: false, errorCode: 'unavailable', operationId: receipt.operationId }),
      modelClaimRecoveryStatus: async () => ({ ok: false, errorCode: 'unavailable' }),
      recoverModelClaim: vi.fn(),
    })
    render(<LegacyModelClaimCard t={t} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText('deepseek')
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimApply }))
    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toContain('unavailable')
    expect(screen.queryByRole('button', { name: en.legacyClaimRetry })).toBeNull()
  })

  it.each([
    ['cancelled', async () => ({ ok: false, errorCode: 'cancelled' })],
    ['rejected', async () => ({ ok: false, errorCode: 'stale' })],
    ['transport', async () => { throw new Error('disconnected') }],
  ])('handles %s recovery responses without changing the model store', async (_name, recoverModelClaim) => {
    const changed = vi.fn()
    const recover = vi.fn(recoverModelClaim)
    Reflect.set(globalThis, '__DSH_DESKTOP_HOST__', {
      modelClaimAvailable: true,
      modelClaimInventory: async () => ({ ok: true, inventory }), claimModel: vi.fn(),
      modelClaimRecoveryStatus: async () => ({ ok: true, receipt }), recoverModelClaim: recover,
    })
    render(<LegacyModelClaimCard t={t} onChanged={changed} />)
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimInspect }))
    await screen.findByText('deepseek')
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimStatus }))
    await screen.findByRole('button', { name: en.legacyClaimRetry })
    fireEvent.click(screen.getByRole('button', { name: en.legacyClaimRetry }))
    await waitFor(() => { expect(recover).toHaveBeenCalledOnce() })
    expect(changed).not.toHaveBeenCalled()
  })
})
