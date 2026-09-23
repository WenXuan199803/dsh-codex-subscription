# Codex protocol parity and performance acceptance (2.1.16)

## Implementation

The model catalog is a protocol contract, not only a picker. The provider now
preserves `use_responses_lite`, reasoning summary support/default and default
effort. For Lite models the adapter sends the full tool list as `additional_tools`,
keeps the complete system instructions in a developer message, uses the official
function namespace format, and sets `reasoning.context=all_turns`. Both the WS
`ws_request_header_x_openai_internal_codex_responses_lite` metadata and HTTP
`x-openai-internal-codex-responses-lite` header are sent. Moving fields without
these protocol markers is not sufficient parity.

`parallel_tool_calls=false` is the official Lite protocol setting, not removal of
any tool. Explicit model, reasoning effort, speed tier, verbosity, context and
all tool schemas remain intact. Removing the summary when the catalog requests
`none` does not turn off reasoning. Encrypted reasoning is still requested and
replayed. Older non-Lite models retain their existing format.

Prefix item IDs are deterministic within the account-scoped session. Pi remains
responsible for OAuth, message/event conversion, WS reuse, incremental
`previous_response_id`, SSE fallback and encrypted reasoning replay; no second
agent loop or native Codex process is introduced in production.

The first model request waits for a pending catalog refresh: importing/removing
an account previously let it race the refresh and use the legacy envelope.
Failed catalog refresh retains the existing offline fallback and reports failure.

The network scope now lasts for the complete iterator instead of its first
`next()`. Reused sockets report events to the current request. Provider error
frames are marked failed instead of reporting a successful network exchange.
Diagnostics add reasoning tokens, requested effort, actual Lite marker and
continuation, without changing the conversation TPS display or returning secrets.

Protocol sources:
- [OpenAI Codex client](https://github.com/openai/codex/blob/b7add4df3d95e2d41249e54d3c3a1bd14680848a/codex-rs/core/src/client.rs)
- [OpenAI tool serialization](https://github.com/openai/codex/blob/b7add4df3d95e2d41249e54d3c3a1bd14680848a/codex-rs/tools/src/tool_spec.rs)
- [Responses WebSocket continuation](https://developers.openai.com/api/docs/guides/websocket-mode)

The official installed binary used for validation was `0.155.0-alpha.9.2`.
Its actual WebSocket requests confirmed the Lite envelope and metadata flag.
Apache-2.0 attribution and license are included in THIRD_PARTY_NOTICES.md and
CODEX-LICENSE.txt.

## Measurements, 2026-09-23

All rows below request `gpt-5.6-sol`, `medium`, standard speed; successful server
responses confirm the model and `default` service tier. The task asks for a
Chinese explanation of at-least-once delivery, idempotency, outbox, and deduplication.
DSH retains its full 35-tool environment and complete prompt context.

Same-account final comparison (the account currently used by official Codex):

| Path | Model call duration | First body text | Output / reasoning tokens | Body throughput |
| --- | ---: | ---: | ---: | ---: |
| Official Codex binary, captured stream | 26.430 s | 5.724 s | 753 / 105 | 31.3 tok/s |
| Installed 2.1.16, Native Direct | 24.175 s | 3.571 s | 664 / 19 | 31.3 tok/s |
| Installed 2.1.16, scheduler enabled | 25.543 s | 3.571 s | 688 / 0 | 31.3 tok/s |

Throughput uses `(output_tokens - reasoning_tokens) / (completion - first body
text)`. It is a reproducible approximation of body decoding, not output tokens
divided by total turn time. Official process startup/teardown was 34.724 s and
is not included in the 26.430 s model call. Official capture adds a local relay;
a separate unrelayed native run completed successfully in 33.621 s total.
DSH durations are measured in its actual provider stream, not the UI.

### What the evidence does and does not establish

The original local state did NOT contain the same account on both sides:
official Codex used a Pro-tier account (`prolite` claim), while the seven DSH
accounts were distinct Plus accounts. With a Plus account and complete DSH
context, installed DSH measured 62.684 s / about 16.6 body tok/s. Replaying that
complete request directly without DSH also measured about 16–18 body tok/s.
Official Codex using that Plus account repeatedly returned server capacity errors.
The slow stream was therefore also present upstream of DSH's rendering, adapter,
and scheduler. Do not describe this as a proven universal Plus-vs-Pro speed policy;
backend routing and capacity are not visible to this plugin.

A short request on one Plus account measured 16.5 body tok/s with the legacy
protocol and 55.8 with Lite. That improvement did not reproduce consistently with
complete context, so it is NOT a release speedup claim. Likewise, replaying the
full DSH context with the official account through the OLD 2.1.15 provider already
completed in 24.635 s; the new provider replay was 29.141 s. These results do NOT
establish that the protocol patch caused a consistent speed increase.

The supported conclusion is narrower and useful: with account/model/effort/tier
matched, installed DSH and official Codex had the same body throughput, and
scheduler dispatch showed no material generation penalty. This release fixes
verified protocol/lifecycle defects; it does not promise faster server decoding
for the original Plus pool or conceal capacity errors.

## Regression and restoration

- Full repository check: 378 passed, 26 skipped, zero failures; build and pack pass.
- Delayed stream tests cover scope lifetime, completion usage, provider failure,
  current-request attribution on socket reuse, Lite flags, delta continuation,
  catalog readiness and new connection/full context after account change.
- Existing scheduler tests cover affinity, account rotation, quota failover,
  committed-output protection, Native Direct and credential refresh.
- Actual installed scheduler session executed `bash`, wrote the result of 37*41,
  called `read`, and completed with 1517; cached input and continuation survived.
- Server reported version 2.1.16; installed server/client JS hashes matched build.
- The official account was imported only for temporary acceptance, then removed.
  The original seven account identities, enabled states, priorities, weights and
  active account were restored, with round-robin and session affinity enabled.
  The user's original default `gpt-6-sol / medium` and standard speed were restored.
- No quota-reset credit was used, no original session was deleted, and no
  ShangShuShengV4 runtime data was read or modified.
