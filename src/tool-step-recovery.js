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

/** Retry only incomplete, read-only tool attempts before DSH commits a result. */
export async function recoverToolStep(exec, next, onRetry = () => {}) {
  if (exec.agent?.session?.requestContext?.()?.provider !== 'openai-codex' || !readOnlyTool(exec)) return next()
  // Cordis consumes the downstream waterfall listener list on the first
  // next(). Keep a separate total deadline for later attempts even if another
  // timeout wrapper was downstream of this hook and is no longer in that list.
  const parentSignal = exec.signal
  exec.signal = AbortSignal.any([parentSignal, AbortSignal.timeout(90_000)])
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await next()
      if (exec.signal.aborted || !retryableResult(exec, result) || attempt === 2) return result
      onRetry(exec.name, attempt + 1)
      await wait(50 * (attempt + 1), exec.signal)
    }
  } finally {
    exec.signal = parentSignal
  }
}

export function registerToolStepRecovery(ctx) {
  return ctx.on?.('tools/execute', (exec, next) => recoverToolStep(exec, next,
    (name, attempt) => ctx.logger?.debug?.('Codex read-only tool %s retry %d', name, attempt)))
}
