import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'

const TRANSIENT_TOOL_CODES = new Set([
  'WEB_PROVIDER_ERROR', 'WEB_FETCH_TIMEOUT', 'TOOL_TIMEOUT',
  'TRANSPORT', 'EIO', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE',
  'INVALID_TOOL_OUTPUT',
])
const REQUEST_TOOL_CODES = new Set([
  'WEB_INVALID_URL', 'WEB_BLOCKED_URL', 'WEB_UNSUPPORTED_CONTENT_TYPE',
  'WEB_FETCH_TOO_LARGE', 'WEB_REDIRECT_BLOCKED', 'UNKNOWN_TOOL', 'TOOL_ARGS_ERROR',
  'ENOENT', 'EACCES', 'EPERM',
])

// This is intentionally a small, auditable read-only subset of shell syntax.
// Any command with shell expansion, redirection, pipelines or chaining is left
// to the agent to reconcile against the real external state.
export function isSafeShellQuery(command) {
  if (typeof command !== 'string' || /[;&|<>`$\\\r\n]/u.test(command)) return false
  const value = command.trim()
  return value === 'pwd' || value === 'pwd -P'
    || /^git status(?: --short)?$/u.test(value)
    || /^(?:ls|cat)\s+(?!-)[\p{L}\p{N}._/ -]+$/u.test(value)
    || /^rg\s+(?!-)[\p{L}\p{N}._/-]+(?:\s+(?!-)[\p{L}\p{N}._/-]+)?$/u.test(value)
}

function readOnlyTool(exec) {
  if (['web_search', 'web_fetch', 'read'].includes(exec.name)) return true
  return exec.name === 'bash' && exec.arguments?.run_in_background !== true
    && isSafeShellQuery(exec.arguments?.command)
}

function retryableResult(exec, result) {
  if (result?.isError === true) {
    const code = String(result.error?.info?.code ?? '').toUpperCase()
    if (REQUEST_TOOL_CODES.has(code) || /invalid (?:url|command|argument)|permission denied|no such file|not found|unsupported content type/iu.test(result.error?.message ?? '')) return false
    if (TRANSIENT_TOOL_CODES.has(code)) return true
    // A provider can discard the nested socket code while preserving only its
    // stable WEB_PROVIDER_ERROR. That code is safe to retry for read-only tools.
    return code === '' || (['web_search', 'web_fetch'].includes(exec.name) && code === 'WEB_PROVIDER_ERROR')
  }
  return exec.name === 'bash' && result?.value?.kind === 'foreground'
    && (result.value.timedOut === true || result.value.aborted === true)
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timeout = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { clearTimeout(timeout); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function runtimeScheduler(tools) {
  const direct = tools?.[TOOL_RUNTIME_SCHEDULER]
  if (typeof direct?.dispatch === 'function') return direct
  if (!tools) return undefined
  // DSH and a packaged plugin can load different physical copies of
  // dsh-tools. Its internal Symbol is then not referentially equal, although
  // the one scheduler field on the ToolRuntime retains the same description.
  const candidates = Object.getOwnPropertySymbols(tools)
    .filter(key => key.description === TOOL_RUNTIME_SCHEDULER.description)
    .map(key => tools[key])
    .filter(value => typeof value?.dispatch === 'function')
  return candidates.length === 1 ? candidates[0] : undefined
}

/** Retry only incomplete, read-only tool attempts before DSH commits a result. */
export async function recoverToolStep(exec, next, retryDispatch, onRetry = () => {}) {
  if (exec.agent?.session?.requestContext?.()?.provider !== 'openai-codex' || !readOnlyTool(exec)) return next()
  // Cordis's next() is single-pass. Later attempts re-enter DSH's dispatch
  // scheduler so every execute wrapper runs again, under one total deadline.
  const parentSignal = exec.signal
  exec.signal = AbortSignal.any([parentSignal, AbortSignal.timeout(90_000)])
  try {
    let result = await next()
    for (let attempt = 1; attempt < 3; attempt++) {
      if (exec.signal.aborted || !retryableResult(exec, result) || retryDispatch === undefined) return result
      onRetry(exec.name, attempt + 1)
      await wait(50 * attempt, exec.signal)
      result = await retryDispatch()
    }
    return result
  } finally {
    exec.signal = parentSignal
  }
}

export function registerToolStepRecovery(ctx) {
  const retrying = new WeakSet()
  return ctx.on?.('tools/execute', (exec, next) => {
    if (retrying.has(exec)) return next()
    const scheduler = runtimeScheduler(ctx.tools)
    const dispatch = typeof scheduler?.dispatch === 'function' ? async () => {
      retrying.add(exec)
      try { return (await scheduler.dispatch(exec)).result } finally { retrying.delete(exec) }
    } : undefined
    return recoverToolStep(exec, next, dispatch,
      (name, attempt) => ctx.logger?.debug?.('Codex read-only tool %s retry %d', name, attempt))
  })
}
