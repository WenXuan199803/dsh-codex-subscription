import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { readLoginProgress } from './login-progress.js'
import { CHANNEL, unwrap, accountStatusErrorText, maskEmail, notifyQuickQuota } from './client-shared.js'
import { recoveryCall } from './client-recovery.js'

const MAX_IMPORT_FILE_BYTES = 6 * 1024 * 1024
async function importPayload(file) {
  if (file.size <= 0 || file.size > MAX_IMPORT_FILE_BYTES) throw new Error('账号文件必须小于 6 MiB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)))
  }
  return { name: file.name, encoded: btoa(binary) }
}
export function AccountEmail({ candidate, fallback, t, emailVisible, onClick }) {
  if (typeof candidate?.email !== 'string' || candidate.email.length === 0) {
    return <span title={t('emailUnavailable')}>{fallback ?? candidate?.label ?? t('emailUnavailable')}</span>
  }
  return <button
    type="button"
    className="codexSubscriptionEmail"
    aria-label={t(emailVisible ? 'hideEmail' : 'showEmail')}
    aria-pressed={emailVisible}
    onClick={onClick}
  >{emailVisible ? candidate.email : maskEmail(candidate.email)}</button>
}

export function AccountCard({ rpc, t, account, setAccount, onSignedOut }) {
  const [flow, setFlow] = useState()
  const flowGeneration = useRef(0)
  const [manualCode, setManualCode] = useState('')
  const [adding, setAdding] = useState(false)
  const [removeId, setRemoveId] = useState()
  const [emailVisible, setEmailVisible] = useState(false)
  const accounts = account?.accounts ?? []
  const accountVisibilityKey = `${account?.authenticated === true ? 'signed-in' : 'signed-out'}:${accounts.map(candidate => `${candidate.id ?? ''}:${candidate.active === true}:${candidate.email ?? ''}`).join('|')}`
  const [emailVisibilityKey, setEmailVisibilityKey] = useState(accountVisibilityKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState()
  const [scheduler, setScheduler] = useState()
  const [importSummary, setImportSummary] = useState()
  const importRef = useRef()
  const call = (endpoint, payload = {}) => recoveryCall(rpc, endpoint, payload)

  useEffect(() => {
    if (account?.authenticated !== true) { setScheduler(undefined); return undefined }
    let live = true
    void call('scheduler/status').then(value => { if (live) setScheduler(value) }).catch(() => {})
    return () => { live = false }
  }, [account?.authenticated, accounts.length])

  useEffect(() => {
    if (emailVisibilityKey === accountVisibilityKey) return
    setEmailVisible(false)
    setEmailVisibilityKey(accountVisibilityKey)
  }, [accountVisibilityKey, emailVisibilityKey])

  useEffect(() => {
    if (busy || flow?.id === undefined || ['authenticated', 'failed', 'cancelled'].includes(flow.phase)) return undefined
    let live = true
    let reading = false
    const generation = flowGeneration.current
    const timer = window.setInterval(() => {
      if (reading) return
      reading = true
      const read = adding
        ? call('login/status', { id: flow.id }).then(async nextFlow => ({
            flow: nextFlow,
            account: nextFlow.phase === 'authenticated' ? await call('status') : undefined,
          }))
        : readLoginProgress({
            flow,
            readFlow: () => call('login/status', { id: flow.id }),
            readAccount: () => call('status'),
          })
      void read.then(next => {
        if (!live || generation !== flowGeneration.current) return
        setFlow(next.flow)
        setError(undefined)
        if (next.account !== undefined) {
          setAccount(next.account)
          onSignedOut()
          setAdding(false)
          setFlow(undefined)
          notifyQuickQuota()
        }
      }).catch(() => { if (live && generation === flowGeneration.current) setError(t('failed')) })
        .finally(() => { reading = false })
    }, 800)
    return () => { live = false; window.clearInterval(timer) }
  }, [flow?.id, flow?.phase, adding, busy])

  const begin = (method, label) => {
    flowGeneration.current += 1
    setFlow(undefined); setBusy(true); setError(undefined)
    const loginLabel = adding && label === undefined ? `Account ${accounts.length + 1}` : label
    void call('login/start', { method, openExternal: true, ...(loginLabel === undefined ? {} : { label: loginLabel }) }).then(setFlow)
      .catch(() => setError(t('failed'))).finally(() => setBusy(false))
  }
  const cancel = () => {
    if (flow?.id === undefined) return
    flowGeneration.current += 1
    setBusy(true); setError(undefined)
    void call('login/cancel', { id: flow.id }).then(next => {
      setFlow(adding ? undefined : next)
      if (adding) setAdding(false)
      if (adding) return undefined
      return call('status').then(account => {
        if (account.authenticated === true) {
          setAccount(account)
          setFlow({ ...next, phase: 'authenticated', authenticated: true })
          setError(undefined)
          notifyQuickQuota()
        }
      })
    }).catch(() => setError(t('failed'))).finally(() => setBusy(false))
  }
  const submit = event => {
    event.preventDefault()
    if (flow?.id === undefined || manualCode.trim() === '') return
    setBusy(true)
    void call('login/submit', { id: flow.id, value: manualCode.trim() }).then(next => {
      setManualCode(''); setFlow(next)
    }).catch(() => setError(t('failed'))).finally(() => setBusy(false))
  }
  const logout = () => {
    setBusy(true); setError(undefined)
    void call('logout').then(next => {
      setAccount(next); setFlow(undefined); onSignedOut(); notifyQuickQuota()
    }).catch(() => setError(t('failed'))).finally(() => setBusy(false))
  }
  const selectAccount = id => {
    setBusy(true); setError(undefined)
    void call('account/select', { id }).then(next => {
      setAccount(next); onSignedOut(); notifyQuickQuota()
    }).catch(() => setError(t('failed'))).finally(() => setBusy(false))
  }
  const configureAccount = (id, patch) => {
    setBusy(true); setError(undefined)
    void call('account/configure', { id, ...patch }).then(next => {
      setAccount(next)
      return call('scheduler/status')
    }).then(setScheduler)
      .catch(error => setError(error instanceof Error ? error.message : t('failed')))
      .finally(() => setBusy(false))
  }
  const updateScheduler = patch => {
    setBusy(true); setError(undefined)
    void call('scheduler/update', patch).then(setScheduler)
      .catch(error => setError(error instanceof Error ? error.message : t('failed')))
      .finally(() => setBusy(false))
  }
  const importAccounts = event => {
    const files = [...(event.currentTarget.files ?? [])]
    event.currentTarget.value = ''
    if (files.length === 0) return
    setBusy(true); setError(undefined); setImportSummary(undefined)
    void (async () => {
      let added = 0
      let duplicates = 0
      let total
      let nextAccount
      for (const file of files) {
        const result = await call('account/import', await importPayload(file))
        added += result.added ?? 0
        duplicates += result.duplicates ?? 0
        total = result.total ?? total
        nextAccount = result.account ?? nextAccount
      }
      if (nextAccount) setAccount(nextAccount)
      setImportSummary(`已导入 ${added} 个账号，跳过 ${duplicates} 个重复账号${total === undefined ? '' : `，当前共 ${total} 个`}`)
      setScheduler(await call('scheduler/status'))
      notifyQuickQuota()
    })().catch(error => setError(error instanceof Error ? error.message : t('failed')))
      .finally(() => setBusy(false))
  }
  const removeAccount = id => {
    if (removeId !== id) { setRemoveId(id); return }
    setBusy(true); setError(undefined)
    void call('account/remove', { id }).then(next => {
      setAccount(next); setRemoveId(undefined); onSignedOut(); notifyQuickQuota()
    }).catch(() => setError(t('failed'))).finally(() => setBusy(false))
  }
  const signedIn = account?.authenticated === true
  const accountReady = account !== undefined
  const loginVisible = flow !== undefined && !['authenticated', 'failed', 'cancelled'].includes(flow.phase)

  const toggleEmail = () => {
    setEmailVisibilityKey(accountVisibilityKey)
    setEmailVisible(value => emailVisibilityKey === accountVisibilityKey ? !value : true)
  }
  const emailVisibleForAccount = emailVisible && emailVisibilityKey === accountVisibilityKey
  return <div className="codexSubscriptionCard">
    <div className="codexSubscriptionAccountRow">
      <div className="codexSubscriptionStatus" role="status" aria-live="polite"><span className="codexSubscriptionDot" data-state={accountReady ? signedIn ? 'connected' : 'disconnected' : 'loading'} aria-hidden="true" />{accountReady ? signedIn ? t('connected') : t('disconnected') : t('accountLoading')}</div>
      <div className="codexSubscriptionActions">{signedIn ? <>
        <input ref={importRef} type="file" hidden multiple accept=".json,.zip,application/json,application/zip" onChange={importAccounts} />
        <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => importRef.current?.click()}>导入账号 / ZIP</Button>
        <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => { setFlow(undefined); setAdding(true) }}>{t('addAccount')}</Button>
        <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={logout}>{t('signOutAll')}</Button>
      </> : accountReady && (flow === undefined || ['failed', 'cancelled'].includes(flow.phase)) ? <><Button type="button" variant="primary" disabled={busy} onClick={() => begin('browser')}>{t('browserLogin')}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => begin('device_code')}>{t('deviceLogin')}</Button></> : null}</div>
    </div>
    {signedIn && scheduler !== undefined && accounts.length > 1 ? <div className="codexSubscriptionFlow">
      <div className="codexSubscriptionActions">
        <label>调度策略 <select disabled={busy} value={scheduler.config?.strategy ?? 'fill-first'} onChange={event => updateScheduler({ strategy: event.currentTarget.value })}>
          <option value="fill-first">依次用满</option>
          <option value="round-robin">轮询</option>
          <option value="weighted-round-robin">按权重轮询</option>
        </select></label>
        <label><input type="checkbox" disabled={busy} checked={scheduler.config?.sessionAffinity !== false} onChange={event => updateScheduler({ sessionAffinity: event.currentTarget.checked })} /> 同一对话固定账号</label>
      </div>
    </div> : null}
    {signedIn && accounts.length > 0 ? <div className="codexSubscriptionAccounts">{accounts.map(candidate => <div className="codexSubscriptionAccount" data-active={candidate.active} key={candidate.id}><AccountEmail candidate={candidate} fallback={candidate.label} t={t} emailVisible={emailVisibleForAccount} onClick={toggleEmail} /><span>{candidate.enabled === false ? '已停用' : '已启用'}</span><div className="codexSubscriptionActions"><Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => configureAccount(candidate.id, { enabled: candidate.enabled === false })}>{candidate.enabled === false ? '启用' : '停用'}</Button>{candidate.active ? null : <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => selectAccount(candidate.id)}>{t('switchAccount')}</Button>}{accounts.length > 1 ? <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => removeAccount(candidate.id)}>{removeId === candidate.id ? t('removeConfirm') : t('removeAccount')}</Button> : null}{removeId === candidate.id ? <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoveId(undefined)}>{t('removeCancel')}</Button> : null}</div></div>)}</div> : null}
    {signedIn && adding && flow === undefined ? <div className="codexSubscriptionFlow"><div className="codexSubscriptionActions"><Button type="button" variant="primary" disabled={busy} onClick={() => begin('browser')}>{t('browserLogin')}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => begin('device_code')}>{t('deviceLogin')}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setAdding(false)}>{t('cancel')}</Button></div></div> : null}
    {flow?.phase === 'waiting_device' ? <div className="codexSubscriptionFlow"><p>{t('deviceHint')}</p><code className="codexSubscriptionCode">{flow.deviceCode?.userCode}</code><a href={flow.deviceCode?.verificationUri} target="_blank" rel="noreferrer">{t('openLogin')}</a><p>{t('waiting')}</p><Button type="button" variant="outline" disabled={busy} onClick={cancel}>{t('cancel')}</Button></div> : null}
    {flow?.phase === 'waiting_input' ? <form className="codexSubscriptionFlow" onSubmit={submit}><p>{t('manualCode')}</p><Input className="codexSubscriptionInput" value={manualCode} onChange={event => setManualCode(event.currentTarget.value)} autoComplete="off" spellCheck={false} /><div className="codexSubscriptionActions"><Button type="submit" variant="primary" disabled={busy || manualCode.trim() === ''}>{t('submit')}</Button><Button type="button" variant="outline" disabled={busy} onClick={cancel}>{t('cancel')}</Button></div></form> : null}
    {flow !== undefined && ['starting', 'waiting_browser'].includes(flow.phase) ? <div className="codexSubscriptionFlow"><p>{t('waiting')}</p>{flow.authUrl === undefined ? null : <a href={flow.authUrl} target="_blank" rel="noreferrer">{t('openLogin')}</a>}<Button type="button" variant="outline" disabled={busy} onClick={cancel}>{t('cancel')}</Button></div> : null}
    {importSummary !== undefined ? <p className="codexSubscriptionPreferenceHint" role="status">{importSummary}</p> : null}
    {flow?.phase === 'failed' || error !== undefined ? <p className="codexSubscriptionError" role="alert">{error ?? t('failed')}</p> : null}
  </div>
}

export function AccountFailureCard({ accountStatus, snapshot, t, rpc, onRecovered }) {
  const retrying = snapshot.retrying === true
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const clear = async () => {
    if (!confirm) { setConfirm(true); return }
    setBusy(true); setFailed(false)
    try { const next = await recoveryCall(rpc, 'logout'); accountStatus.acceptAccount(next); onRecovered(); notifyQuickQuota() }
    catch { setFailed(true) }
    finally { setBusy(false); setConfirm(false) }
  }
  return <div className="codexSubscriptionCard codexSubscriptionRecover" role="alert">
    <p className="codexSubscriptionError">{retrying ? t('accountRetrying') : accountStatusErrorText(snapshot.error, t)}</p>
    <div className="codexSubscriptionActions"><Button type="button" variant="outline" disabled={retrying || busy} aria-busy={retrying} onClick={() => { void accountStatus.retry() }}>{retrying ? t('accountRetrying') : t('accountRetry')}</Button>
    <Button type="button" variant="outline" disabled={busy || retrying} onClick={() => void clear()}>{busy ? t('accountRetrying') : t(confirm ? 'recoveryClearConfirm' : 'recoveryClear')}</Button>{confirm ? <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(false)}>{t('cancel')}</Button> : null}</div>
    <p className="codexSubscriptionPreferenceHint">{t(confirm ? 'recoveryClearHint' : 'recoveryHint')}</p>
    {failed ? <p className="codexSubscriptionError">{t('recoveryFailed')}</p> : null}
  </div>
}
