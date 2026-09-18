/** REQ-20260918-0001: optional Desktop-only, redacted legacy model claim card. */
import { useState } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type Candidate = Readonly<{
  id: string
  provider: string
  kind: 'llm' | 'web-search'
  credential: 'present' | 'missing' | 'none'
  sharedCredential: boolean
}>
type Inventory = Readonly<{
  sourceDigest: string
  candidates: readonly Candidate[]
  unsupportedSettings: number
  unassignedCredentialReferences: number
  unassignedCredentialRecords: number
}>
type Outcome = Readonly<{ state: 'committed' | 'restored'; cleanupPending: boolean }>
type Receipt = Readonly<{
  candidateId: string
  operationId: string
  sourceDigest: string
  status: 'pending' | 'committed' | 'restored'
}>
type Response<T> = ({ ok: true } & T) | { ok: false; errorCode: string; operationId?: string }
type Bridge = Readonly<{
  modelClaimAvailable: true
  modelClaimInventory(): Promise<Response<{ inventory: Inventory }>>
  claimModel(input: { candidateId: string; sourceDigest: string }): Promise<Response<{ operationId: string; outcome: Outcome }>>
  modelClaimRecoveryStatus(candidateId: string): Promise<Response<{ receipt: Receipt | null }>>
  recoverModelClaim(input: {
    candidateId: string
    operationId: string
    sourceDigest: string
    action: 'retry' | 'restore'
  }): Promise<Response<{ outcome: Outcome }>>
}>

function desktopBridge(): Bridge | null {
  const candidate: unknown = Reflect.get(globalThis, '__DSH_DESKTOP_HOST__')
  if (!candidate || typeof candidate !== 'object') return null
  const value = candidate as Record<string, unknown>
  return value.modelClaimAvailable === true && ['modelClaimInventory', 'claimModel', 'modelClaimRecoveryStatus', 'recoverModelClaim']
    .every(key => typeof value[key] === 'function') ? candidate as Bridge : null
}

export function LegacyModelClaimCard({ t, onChanged }: {
  t: (key: keyof typeof en) => string
  onChanged: () => void | Promise<void>
}) {
  const bridge = desktopBridge()
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [receipts, setReceipts] = useState<Record<string, Receipt | null>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  if (!bridge) return null

  const inspect = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const result = await bridge.modelClaimInventory()
      if (result.ok) { setInventory(result.inventory); setReceipts({}) }
      else setMessage(`${t('legacyClaimFailed')}: ${result.errorCode}`)
    } catch { setMessage(t('legacyClaimFailed')) }
    finally { setBusy(false) }
  }

  const status = async (candidateId: string): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const result = await bridge.modelClaimRecoveryStatus(candidateId)
      if (result.ok) setReceipts(previous => ({ ...previous, [candidateId]: result.receipt }))
      else setMessage(`${t('legacyClaimFailed')}: ${result.errorCode}`)
    } catch { setMessage(t('legacyClaimFailed')) }
    finally { setBusy(false) }
  }

  const claim = async (candidate: Candidate, sourceDigest: string): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const result = await bridge.claimModel({ candidateId: candidate.id, sourceDigest })
      if (result.ok) {
        setMessage(t('legacyClaimSaved'))
        void onChanged()
      } else if (result.errorCode !== 'cancelled') {
        setMessage(`${t('legacyClaimFailed')}: ${result.errorCode}`)
        if (result.operationId) {
          const recovery = await bridge.modelClaimRecoveryStatus(candidate.id)
          if (recovery.ok) setReceipts(previous => ({ ...previous, [candidate.id]: recovery.receipt }))
        }
      }
    } catch { setMessage(t('legacyClaimFailed')) }
    finally { setBusy(false) }
  }

  const recover = async (candidate: Candidate, receipt: Receipt, action: 'retry' | 'restore'): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const result = await bridge.recoverModelClaim({ candidateId: candidate.id,
        operationId: receipt.operationId, sourceDigest: receipt.sourceDigest, action })
      if (result.ok) {
        setMessage(action === 'retry' ? t('legacyClaimSaved') : t('legacyClaimRestored'))
        setReceipts(previous => ({ ...previous, [candidate.id]: null }))
        void onChanged()
      } else if (result.errorCode !== 'cancelled') {
        setMessage(`${t('legacyClaimFailed')}: ${result.errorCode}`)
      }
    } catch { setMessage(t('legacyClaimFailed')) }
    finally { setBusy(false) }
  }

  return <section className={styles['rowCard']} aria-label={t('legacyClaimTitle')}>
    <h3 className={styles['title']}>{t('legacyClaimTitle')}</h3>
    <p className={styles['intro']}>{t('legacyClaimIntro')}</p>
    <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={() => { void inspect() }}>
      {t('legacyClaimInspect')}
    </button>
    {inventory?.candidates.length === 0 ? <p>{t('legacyClaimEmpty')}</p> : null}
    {inventory?.candidates.map((candidate) => {
      const receipt = receipts[candidate.id]
      return <div key={candidate.id} className={styles['rowHead']}>
        <span className={styles['rowName']}>{candidate.provider}</span>
        <span className={styles['intro']}>{candidate.kind === 'llm' ? t('legacyClaimModel') : t('legacyClaimSearch')}
          {' · '}{candidate.credential === 'present' ? t('legacyClaimKeyPresent')
            : candidate.credential === 'missing' ? t('legacyClaimKeyMissing') : t('legacyClaimNoKey')}
          {candidate.sharedCredential ? ` · ${t('legacyClaimSharedKey')}` : ''}
        </span>
        <button type="button" className={styles['secondaryButton']} disabled={busy || candidate.credential !== 'present'}
          onClick={() => { void claim(candidate, inventory.sourceDigest) }}>{t('legacyClaimApply')}</button>
        <button type="button" className={styles['secondaryButton']} disabled={busy}
          onClick={() => { void status(candidate.id) }}>{t('legacyClaimStatus')}</button>
        {receipt?.status === 'pending' ? <>
          <button type="button" className={styles['secondaryButton']} disabled={busy}
            onClick={() => { void recover(candidate, receipt, 'retry') }}>{t('legacyClaimRetry')}</button>
          <button type="button" className={styles['secondaryButton']} disabled={busy}
            onClick={() => { void recover(candidate, receipt, 'restore') }}>{t('legacyClaimRestore')}</button>
        </> : null}
      </div>
    })}
    {message ? <p role="status" className={styles['notice']}>{message}</p> : null}
  </section>
}
