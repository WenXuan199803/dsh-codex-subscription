import { createHash } from 'node:crypto'

// Protocol adaptation of openai/codex core/src/client.rs build_responses_request
// and tools/src/tool_spec.rs create_tools_json_for_responses_lite. See the pinned
// source and compatibility rationale in docs/responses-protocol.md.
const itemId = (prefix, session, value) => `${prefix}_${createHash('sha256')
  .update(JSON.stringify([session, value])).digest('hex').slice(0, 32)}`

function namespacedTools(tools) {
  const functions = { type: 'namespace', name: 'functions', description: '', tools: [] }
  const result = []
  let index
  for (const tool of tools) {
    if (tool.type === 'function' || tool.type === 'custom') functions.tools.push(tool)
    else if (tool.type === 'namespace' && tool.name === 'functions') {
      functions.tools.push(...tool.tools)
      if (tool.description?.trim()) functions.description = tool.description
    } else { result.push(tool); continue }
    index ??= result.length
  }
  if (functions.tools.length) result.splice(index, 0, functions)
  return result
}

/** Preserve the requested model/effort, every message, and every tool. Lite is
 * a catalog-selected wire format, not a smaller model or a context reduction. */
export function officialCodexRequest(payload, metadata) {
  if (!metadata) return payload
  const reasoning = { ...payload.reasoning }
  if (reasoning.effort === undefined && metadata.defaultReasoningEffort) {
    reasoning.effort = metadata.defaultReasoningEffort
  }
  if (metadata.supportsReasoningSummary === false || metadata.defaultReasoningSummary === 'none') {
    delete reasoning.summary
  } else if (metadata.defaultReasoningSummary !== undefined) {
    reasoning.summary = metadata.defaultReasoningSummary
  }
  const next = { ...payload, reasoning }
  if (metadata.useResponsesLite !== true) return next
  const tools = namespacedTools(payload.tools ?? [])
  const prefix = [{
    type: 'additional_tools', role: 'developer', tools,
    id: itemId('at', payload.prompt_cache_key, tools),
  }]
  if (payload.instructions) prefix.push({
    type: 'message', role: 'developer',
    id: itemId('msg', payload.prompt_cache_key, payload.instructions),
    content: [{ type: 'input_text', text: payload.instructions }],
  })
  delete next.instructions
  delete next.tools
  next.input = [...prefix, ...(payload.input ?? [])]
  next.reasoning.context = 'all_turns'
  next.parallel_tool_calls = false
  next.client_metadata = {
    ...payload.client_metadata,
    ws_request_header_x_openai_internal_codex_responses_lite: 'true',
  }
  return next
}
