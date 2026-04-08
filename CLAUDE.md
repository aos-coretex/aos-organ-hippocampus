# Hippocampus Organ (#80)

## Identity

- **Organ:** Hippocampus (Conversation Memory)
- **Number:** 80
- **Profile:** Probabilistic
- **Artifact:** database
- **Monad Leg:** 4
- **Ports:** 4008 (AOS) / 3908 (SAAS)
- **Binding:** 127.0.0.1
- **Database:** `hippocampus` on localhost:5432 (PostgreSQL 17, pgvector)

## Dependencies

| Organ | AOS Port | Purpose |
|---|---|---|
| Spine | 4000 | Message bus (WebSocket + HTTP) |
| Vectr | 4001 | 384-dim embedding generation |
| Graph | 4020 | URN minting, structural identity |
| Phi | 4005 | Session tokens, identity |

## Key Modules

- `@coretex/organ-boot` — boot factory (`createOrgan()`), Spine client, health/introspect, live loop
- `llm-client` (from organ-shared-lib) — summarization agent

## Running

```bash
npm install                     # Install dependencies
npm test                        # Run all unit tests
npm run setup-db                # Create database + apply migrations
HIPPOCAMPUS_PORT=4008 npm start # Start organ (requires Spine + dependencies)
```

## Schema

- **conversations** — URN-keyed, pgvector summary embedding (384-dim), JSONB metadata
- **messages** — UUID-keyed, sequence-ordered, pgvector content embedding (384-dim), FK to conversations

## Zero Cross-Contamination Rules

- Never reference `ai-kb.db` or `AI-Datastore/`
- Never reference `AOS-software-dev/` paths
- Never use ports 3800-3851 (monolith range)
- Never import from monolith packages

## Conventions

- ES modules (import/export)
- Node.js built-in test runner (`node --test`)
- Structured JSON logging to stdout
- Express 5 path patterns (from organ-shared-lib)
