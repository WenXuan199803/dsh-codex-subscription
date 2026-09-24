/** Validate the upstream model before the buffered adapter exposes any output. */
export function guardSseModel(response, target, requestedModel) {
  if (target.hostname !== 'chatgpt.com' || target.pathname !== '/backend-api/codex/responses'
    || !response.ok || !response.body || typeof requestedModel !== 'string') return response
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  let pending = ''
  const validateFrame = frame => {
    for (const line of frame.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue
      let event
      try { event = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (!['response.created', 'response.completed', 'response.done'].includes(event?.type)) continue
      const actual = event.response?.model
      if (typeof actual === 'string' && actual.length > 0 && actual !== requestedModel) {
        throw Object.assign(new Error(`Upstream model mismatch: requested ${requestedModel}, received ${actual}`), {
          code: 'CODEX_MODEL_MISMATCH',
        })
      }
    }
  }
  const stream = response.body.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true })
      let match
      while ((match = /\r?\n\r?\n/u.exec(pending)) !== null) {
        const end = match.index + match[0].length
        const frame = pending.slice(0, end)
        pending = pending.slice(end)
        validateFrame(frame)
        controller.enqueue(encoder.encode(frame))
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) { validateFrame(pending); controller.enqueue(encoder.encode(pending)) }
    },
  }))
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** Suppress a mismatched WS frame before pi-ai can consume any output from it. */
export function guardWebSocketModel(socket, requestedModel) {
  if (!socket || typeof requestedModel !== 'string' || requestedModel.length === 0) return socket
  const add = socket.addEventListener.bind(socket)
  const remove = socket.removeEventListener.bind(socket)
  const wrapped = new WeakMap()
  let rejected = false
  socket.addEventListener = (type, listener, options) => {
    if (type !== 'message' || typeof listener !== 'function') return add(type, listener, options)
    const guarded = event => {
      if (rejected) return
      let frame
      try { frame = JSON.parse(String(event.data)) } catch { return listener(event) }
      if (['response.created', 'response.completed', 'response.done'].includes(frame?.type)
        && typeof frame.response?.model === 'string' && frame.response.model.length > 0
        && frame.response.model !== requestedModel) {
        rejected = true
        socket.close(1011, 'model_mismatch')
        return
      }
      return listener(event)
    }
    wrapped.set(listener, guarded)
    return add(type, guarded, options)
  }
  socket.removeEventListener = (type, listener, options) => remove(type, wrapped.get(listener) ?? listener, options)
  return socket
}
