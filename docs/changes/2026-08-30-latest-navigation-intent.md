# 0.3.16 - Latest navigation intent

- Deep links are ephemeral UI commands. The Bridge now keeps only the latest pending navigation request instead of replaying every historical click when DSH reconnects.
- One-shot acknowledgements are idempotent, so concurrent DSH surfaces cannot turn an already-consumed command into a retry storm.
- Durable reference captures and reference-deletion outbox entries retain their existing retry semantics.
