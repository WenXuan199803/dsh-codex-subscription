# 2026-09-14 Codex SSE connection-reset repair

## Observed incident

The same Astra session ended at 09:51:49, 10:09:27 and 10:16:43 Asia/Shanghai with `PI_AI_ERROR: aborted`. Earlier attempts reported TLS connection closure or `socket hang up`. The later two failures occurred while one DSH process remained alive. The final attempt had already received an SSE reasoning-block start. No evidence identifies whether the proxy path or upstream closed that socket.

## Mechanism and change

Node IncomingMessage emits an Error with message `aborted` and code `ECONNRESET` for a truncated response. The previous Readable.toWeb bridge let pi-ai flatten that to an unknown error, which stopped the host retry policy. The bridge now retains a clear connection-failure message and original cause for ECONNRESET / ERR_STREAM_PREMATURE_CLOSE only when the caller signal is not aborted. No additional retry loop, provider fallback, timeout extension, or credential change was added. The host keeps its existing bounded retries. A caller abort retains the original error and cancellation behavior.

## Verification

- Reproduced the old behavior with an actual local TCP server closing after SSE headers/data: message aborted, code ECONNRESET, callerAborted false.
- 8 focused source/release checks cover real TCP truncation, caller cancellation, complete bodies, downstream cancellation and unrelated errors.
- Current production DSH 0.1.5-rc.2 PiAiAdapter plus the Codex pi-ai provider correctly transforms the real truncated SSE to TRANSPORT. This test is runnable with DSH_RUNTIME_ROOT set to that checkout.
- Existing OAuth-network / transport-contract tests plus the 8 checks: 22 passed; the production-adapter check adds 1 passed.
- Full original suite after change: 383 tests, 353 passed, 4 failed, 26 skipped. The four failures are existing fork-name/README assertions; an untouched eef4d9e baseline reproduces the exact same four failures (50 passed, 4 failed across the relevant files). They were not suppressed or rewritten.
- pnpm build passed. Release changes are limited to the body bridge and version labels. Plugin-manager installation of 2.1.0-beta.5.sssv4.1 succeeded.
- Standard external restart passed at 10:27:59; launchd owns PID 14161 and the formal loopback listener remained stable. Live plugin diagnostics report 2.1.0-beta.5.sssv4.1, signed-in, issues empty. A live Astra diagnostic turn completed with ASTRA_STREAM_OK; the later status check still showed the same launchd-owned PID.

## Scope and rollback

The upstream compatibility declarations remain unchanged and do not yet list rc.2; the current-version runtime tests above are separate evidence, not a reason to blanket-edit peer ranges. The old release is privately backed up outside this repository. Reinstall that release via dsh-web-plugin-manager and use the standard external restart entry to roll back. Do not overwrite credentials or sessions. A successful short live generation cannot guarantee an unreliable network will never disconnect; this repair fixes classification and premature retry termination.
