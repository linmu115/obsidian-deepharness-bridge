# Local Vault location proof

Companion 0.7.0-rc2.3 adds `GET /discovery/v1/vault-location` for a local Maintenance process to compare a user-selected folder with the currently running Vault.

The JSON response contains only `locationProtocolVersion: 1`, `vaultId`, `publisherId`, `bootId`, `origin`, and `vaultRoot`. Identity fields come from the same live `discoveryIdentity()` used by public discovery. The server verifies the published boot and origin still match itself before replying. The strict public discovery identity schema is unchanged and does not contain filesystem locations.

`vaultRoot` is the realpath of the current desktop `FileSystemAdapter.getBasePath()`. Unknown adapters, missing or relative base paths, non-directory paths, and filesystem errors are unavailable; there is no cwd or saved-config fallback. No Vault data is written.

The route accepts only a loopback socket with the exact running origin Host header, no Origin header, and no browser fetch-site marker other than `none`. Forwarded addresses and existing browser CORS grants do not authorize it. It does not emit CORS response headers, including on preflight or errors. Non-local callers receive HTTP 403 / `VAULT_LOCATION_FORBIDDEN`; unsupported methods receive HTTP 405 / `METHOD_NOT_ALLOWED`. Startup, draining, shutdown, unavailable location, and inconsistent live identity receive HTTP 503 / `VAULT_LOCATION_UNAVAILABLE`. Error responses contain no filesystem path or credential. Location resolution participates in graceful in-flight request draining and is checked again after it finishes.

Local source verification on 2026-09-18: TypeScript check passed; 37 test files / 261 tests passed, including 12 location tests; release bundle built. Coverage includes directory aliases, unknown base paths, file/missing-directory failures, identity consistency, CORS and cross-site rejection, forged Host, non-loopback sockets, sanitized errors, and shutdown during path resolution.

This record is synthetic source/build verification only. Real Companion installation, plugin reload, Maintenance folder selection UI, and real binding integration are not verified by these tests. Local linked development dependencies remain unchanged.
