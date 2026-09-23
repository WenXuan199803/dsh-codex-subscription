import { useEffect, useRef, useState } from 'react'
import { Button, Input } from './client-primitives.js'
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
const quotaWindowLabel = seconds => {
  if (seconds >= 17_100 && seconds <= 18_900) return '5h'
  if (seconds >= 574_560 && seconds <= 635_040) return '周'
  if (seconds >= 82_080 && seconds <= 90_720) return '日'
  return seconds >= 86_400 && seconds % 86_400 === 0 ? `${seconds / 86_400}天` : `${Math.round(seconds / 360) / 10}h`
}

const quotaResetLabel = resetsAt => {
  if (!Number.isSafeInteger(resetsAt)) return undefined
  const date = new Date(resetsAt * 1000)
  if (!Number.isFinite(date.getTime())) return undefined
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  return date.toLocaleString(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function AccountQuota({ snapshot }) {
  if (snapshot === undefined) return <span className="codexSubscriptionAccountQuota codexSubscriptionAccountQuotaMuted">额度读取中…</span>
  if (snapshot.disabled) return <span className="codexSubscriptionAccountQuota codexSubscriptionAccountQuotaMuted">已停用，未查询额度</span>
  if (snapshot.error) return <span className="codexSubscriptionAccountQuota codexSubscriptionAccountQuotaError">{snapshot.error === 'ChatGPT sign-in needs to be renewed' ? '账号认证失效' : '额度读取失败'}</span>
  const limit = snapshot.usage?.rateLimits?.find(item => item.id === 'codex') ?? snapshot.usage?.rateLimits?.[0]
  const windows = limit?.windows ?? []
  if (windows.length === 0) return <span className="codexSubscriptionAccountQuota codexSubscriptionAccountQuotaMuted">暂无额度数据</span>
  return <span className="codexSubscriptionAccountQuota">{windows.map((window, index) => {
    const reset = quotaResetLabel(window.resetsAt)
    const remaining = Number(window.remainingPercent).toLocaleString(undefined, { maximumFractionDigits: 1 })
    return <span className="codexSubscriptionAccountQuotaWindow" key={`${window.windowSeconds}-${index}`}>
      <strong>{quotaWindowLabel(window.windowSeconds)} {remaining}%</strong>{reset ? <small>{reset} 重置</small> : null}
    </span>
  })}</span>
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
  const [accountUsage, setAccountUsage] = useState({})
  const [quotaBusy, setQuotaBusy] = useState(false)
  const quotaRequest = useRef(0)
  const importRef = useRef()
  const call = (endpoint, payload = {}) => recoveryCall(rpc, endpoint, payload)
  const accountUsageKey = accounts.map(candidate => candidate.id).join('|')
  const loadAccountUsage = force => {
    if (account?.authenticated !== true || accounts.length === 0) {
      quotaRequest.current += 1
      setAccountUsage({})
      setQuotaBusy(false)
      return
    }
    const request = ++quotaRequest.current
    setQuotaBusy(true)
    void call('usage/accounts', { force }).then(value => {
      if (quotaRequest.current !== request) return
      setAccountUsage(Object.fromEntries((value.accounts ?? []).map(item => [item.id, item])))
    }).catch(() => {
      if (quotaRequest.current === request) setAccountUsage({})
    }).finally(() => {
      if (quotaRequest.current === request) setQuotaBusy(false)
    })
  }

  useEffect(() => {
    if (account?.authenticated !== true) { setScheduler(undefined); return undefined }
    let live = true
    void call('scheduler/status').then(value => { if (live) setScheduler(value) }).catch(() => {})
    return () => { live = false }
  }, [account?.authenticated, accounts.length])

  useEffect(() => {
    loadAccountUsage(false)
    return () => { quotaRequest.current += 1 }
  }, [account?.authenticated, accountUsageKey])

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
      let updated = 0
      let duplicates = 0
      let total
      let nextAccount
      for (const file of files) {
        const result = await call('account/import', await importPayload(file))
        added += result.added ?? 0
        updated += result.updated ?? 0
        duplicates += result.duplicates ?? 0
        total = result.total ?? total
        nextAccount = result.account ?? nextAccount
      }
      if (nextAccount) setAccount(nextAccount)
      setImportSummary(`新增 ${added} 个，更新 ${updated} 个，跳过 ${duplicates} 个完全相同账号${total === undefined ? '' : `，当前共 ${total} 个`}`)
      setScheduler(await call('scheduler/status'))
      loadAccountUsage(true)
      notifyQuickQuota()
    })().catch(error => setError(error instanceof Error ? error.message : t('failed')))
      .finally(() => setBusy(false))
  }
  const removeAccount = id => {
    if (removeId !== id) { setRemoveId(id); return }
    setBusy(true); setError(undefined)
    void call('account/remove', { id }).then(next => {
      setAccount(next); setRemoveId(undefined); onSignedOut(); loadAccountUsage(true); notifyQuickQuota()
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
    <input ref={importRef} type="file" hidden multiple accept=".json,.zip,application/json,application/zip" onChange={importAccounts} />
    <div className="codexSubscriptionAccountRow">
      <div className="codexSubscriptionStatus" role="status" aria-live="polite"><span className="codexSubscriptionDot" data-state={accountReady ? signedIn ? 'connected' : 'disconnected' : 'loading'} aria-hidden="true" />{accountReady ? signedIn ? t('connected') : t('disconnected') : t('accountLoading')}</div>
      <div className="codexSubscriptionActions">{signedIn ? <>
        <Button type="button" variant="outline" disabled={quotaBusy || loginVisible} onClick={() => loadAccountUsage(true)}>{quotaBusy ? '刷新中…' : '刷新额度'}</Button>
        <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => importRef.current?.click()}>导入账号 / ZIP</Button>
        <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => { setFlow(undefined); setAdding(true) }}>{t('addAccount')}</Button>
        <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={logout}>{t('signOutAll')}</Button>
      </> : accountReady && (flow === undefined || ['failed', 'cancelled'].includes(flow.phase)) ? <>
        <Button type="button" variant="outline" disabled={busy} onClick={() => importRef.current?.click()}>导入账号 / ZIP</Button>
        <Button type="button" variant="primary" disabled={busy} onClick={() => begin('browser')}>{t('browserLogin')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => begin('device_code')}>{t('deviceLogin')}</Button>
      </> : null}</div>
    </div>
    {signedIn && scheduler !== undefined && accounts.length > 1 ? <div className="codexSubscriptionFlow">
      <div className="codexSubscriptionActions">
        <label>调度策略 <select disabled={busy || scheduler.config?.fixedAccountId !== undefined} value={scheduler.config?.strategy ?? 'fill-first'} onChange={event => updateScheduler({ strategy: event.currentTarget.value })}>
          <option value="fill-first">依次用满</option>
          <option value="round-robin">轮询</option>
        </select></label>
        <label>固定账号（测试） <select disabled={busy} value={scheduler.config?.fixedAccountId ?? ''} onChange={event => updateScheduler({ fixedAccountId: event.currentTarget.value || null })}>
          <option value="">关闭固定模式</option>
          {accounts.filter(candidate => candidate.enabled !== false).map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.email ? maskEmail(candidate.email) : candidate.label}</option>)}
        </select></label>
        <label><input type="checkbox" disabled={busy || scheduler.config?.fixedAccountId !== undefined} checked={scheduler.config?.sessionAffinity !== false} onChange={event => updateScheduler({ sessionAffinity: event.currentTarget.checked })} /> 同一对话固定账号</label>
        {scheduler.config?.fixedAccountId === undefined ? null : <span className="codexSubscriptionAccountQuota codexSubscriptionAccountQuotaMuted">固定模式：所有对话只使用所选账号，不轮询、不自动切号</span>}
      </div>
    </div> : null}
    {signedIn && accounts.length > 0 ? <div className="codexSubscriptionAccounts">{accounts.map(candidate => <div className="codexSubscriptionAccount" data-active={candidate.active} key={candidate.id}><div className="codexSubscriptionAccountCopy"><div className="codexSubscriptionAccountName"><AccountEmail candidate={candidate} fallback={candidate.label} t={t} emailVisible={emailVisibleForAccount} onClick={toggleEmail} /><span className="codexSubscriptionAccountState">{candidate.enabled === false ? '已停用' : '已启用'}</span></div><AccountQuota snapshot={accountUsage[candidate.id]} /></div><div className="codexSubscriptionActions"><Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => configureAccount(candidate.id, { enabled: candidate.enabled === false })}>{candidate.enabled === false ? '启用' : '停用'}</Button>{candidate.active || candidate.enabled === false ? null : <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => selectAccount(candidate.id)}>{t('switchAccount')}</Button>}{accounts.length > 1 ? <Button type="button" variant="outline" disabled={busy || loginVisible} onClick={() => removeAccount(candidate.id)}>{removeId === candidate.id ? t('removeConfirm') : t('removeAccount')}</Button> : null}{removeId === candidate.id ? <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoveId(undefined)}>{t('removeCancel')}</Button> : null}</div></div>)}</div> : null}
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
