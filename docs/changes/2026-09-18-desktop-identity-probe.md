# Desktop identity probe for Vault binding

The Companion runs in Obsidian's renderer. Its default identity probe used global fetch, so DSH's identity endpoint without renderer CORS permission could produce `Failed to fetch` during the genuine authenticated binding flow even though a Node GET succeeded.

Default probing now uses Node HTTP in this desktop-only plugin. The origin schema still permits loopback HTTP only. HTTP status must be 200, redirects are never followed, the entire request has a five-second deadline, response bodies are capped at 65,536 bytes including streamed bodies, and the existing identity schema, advertised origin and binding-capability checks remain mandatory. Tests can still explicitly inject fetch.

Regression coverage uses a real synthetic local HTTP server and a renderer fetch stub that always rejects. It also checks redirect rejection, response size rejection, non-loopback rejection before transport and explicit fetch injection. No real Vault or instance was changed during verification.

Validation: TypeScript noEmit and build passed; all 36 test files / 249 tests passed. Candidate version is 0.7.0-rc2.2.

## Live installation and binding acceptance

Installed 0.7.0-rc2.2 (source c368e8b) into the math Vault on 2026-09-18. The existing plugin directory was backed up outside the plugin scan directory; data.json was unchanged by installation. The user disabled and re-enabled DeepHarness Bridge to load the update.

Using the actual Session Maintenance business page, binding math to the 0.1.5-rc.2 copy completed successfully. The page reports READY, revision 1, and the persisted Vault snapshot names instance i-7ecb6c19-80a5-4c2e-97e6-484bbfc0e926 with profile web. The target uses a stable instance identity rather than a fixed port. The current maintenance scope remains all / revision 0. No notes or historical reference ownership were edited for this acceptance.

Installation and activation evidence: D:/AI/DeepSeekHarness-Plugin/artifacts/single-bridge-20260918/companion-binding-fix-installed.json. This verifies binding only; it does not certify every cross-application reference operation or external browser access.
