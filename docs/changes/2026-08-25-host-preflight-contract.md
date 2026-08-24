# DSH Host preflight contract

## Scope

This follow-up completes the protocol-v2 integration needed by the DSH sticker-board Host service.

Baseline commit: `31fb625` (`feat: upgrade Obsidian reference bridge to protocol v2`).

## Problem

- Browser-origin validation correctly rejected untrusted pages, but it also rejected the DSH Host's server-side loopback requests because those requests do not carry a browser `Origin` header.
- A configured DSH port could silently point at the wrong local service because health and handshake responses did not identify the Bridge's actual origin.
- Typed Vault failures were mapped to useful HTTP statuses but their machine-readable error code was dropped from the JSON response.

## Changes

- Requests with an allowlisted browser origin keep the existing CORS and token binding rules.
- Requests without an `Origin` header are accepted as a distinct `local-host` caller because the server listens exclusively on `127.0.0.1`; their tokens cannot be replayed by browser callers.
- Browser preflight still requires an explicitly allowlisted origin, and an explicit untrusted origin still receives HTTP 403.
- Protocol-v2 health and handshake responses now return the actual `bridgeOrigin`.
- Typed application failures preserve `code` in the JSON payload so DSH can distinguish source changes, revision conflicts, idempotency conflicts and missing notes.

## Verification

- `pnpm check`
- 12 test files and 54 tests passed
- Obsidian bundle build completed

## Rollback

Revert the commit that adds this report. Doing so also removes Host-side no-Origin access and `bridgeOrigin` preflight metadata, so the protocol-v2 DSH Host adapter must not be used with the reverted build.
