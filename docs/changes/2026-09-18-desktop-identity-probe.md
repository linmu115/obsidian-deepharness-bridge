# Desktop identity probe for Vault binding

The Companion runs in Obsidian's renderer. Its default identity probe used global fetch, so DSH's identity endpoint without renderer CORS permission could produce `Failed to fetch` during the genuine authenticated binding flow even though a Node GET succeeded.

Default probing now uses Node HTTP in this desktop-only plugin. The origin schema still permits loopback HTTP only. HTTP status must be 200, redirects are never followed, the entire request has a five-second deadline, response bodies are capped at 65,536 bytes including streamed bodies, and the existing identity schema, advertised origin and binding-capability checks remain mandatory. Tests can still explicitly inject fetch.

Regression coverage uses a real synthetic local HTTP server and a renderer fetch stub that always rejects. It also checks redirect rejection, response size rejection, non-loopback rejection before transport and explicit fetch injection. No real Vault or instance was changed during verification.

Validation: TypeScript noEmit and build passed; all 36 test files / 249 tests passed. Candidate version is 0.7.0-rc2.2.
