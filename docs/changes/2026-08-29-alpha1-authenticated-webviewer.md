# 0.2.3 DSH alpha.1 Web Viewer authentication

## Symptom

Opening a DSH backlink from Obsidian revealed an embedded Web Viewer that only displayed
`dsh web authentication required`. The logical deep-link action was queued, but the viewer could
not connect to DSH and therefore could not consume or navigate to it.

## Cause

DSH 0.1.2-alpha.1 emits a process-specific launch URL containing a Web authentication token.
The Bridge retained only the loopback origin and reused an already-open unauthenticated viewer
without navigating it to the current launch URL.

## Fix

- Add an optional DSH launch-log setting. The Bridge reads the newest `dsh web:` URL each time a
  reference is opened, so DSH restarts and token rotation do not require updating stored tokens.
- Accept only HTTP loopback launch URLs whose origin exactly matches the configured DSH origin.
- Reauthenticate an existing Obsidian Web Viewer before queuing the logical session/anchor action.
- Keep the launch token out of Bridge settings and persisted plugin data.

## Verification

- Unit tests cover current-log selection, origin validation, repeated token refresh and existing
  Web Viewer reauthentication.
- The installed Vault configuration points to the official DSH stdout log rather than persisting a
  bearer URL.
