# ShangShuSheng V4 patch scope

Upstream base: `WSL043/dsh-codex-subscription@86bedfc31be03a7d17b7814c726bd16f0cfc61d7`.

This fork intentionally stays upstream-first. ShangShuSheng-specific production changes are limited to:

- package/module identity isolation for the ShangShuSheng runtime;
- OAuth multi-account JSON/ZIP import and account vault;
- per-account quota display and account enable/priority/weight controls;
- request-scoped scheduling, session affinity and pre-output failover;
- scheduler policy in ordinary plugin settings rather than credential records;
- official-model-catalog Responses Lite request formatting and catalog-refresh race protection;
- model-stream network scope held for the whole iterator.

Explicitly excluded from the production fork:

- Native Direct / scheduler-bypass A/B modes;
- non-persistent test-account selection;
- forced-Fast diagnostics or hidden routing overrides;
- CODEX-DSH launcher/runtime/process-management code.

CODEX-DSH is an acceptance harness only. Its standalone launcher fixes must not be copied into this plugin.
- Fixed-account diagnostic override: select one enabled vault account and force every conversation through it; no rotation or cross-account failover occurs while fixed, and disabling/removing that account clears the override.
