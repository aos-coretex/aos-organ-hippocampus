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
- `lib/vectr-client.js` — Vectr embedding (single, batch, health check, 5s timeout, soft-failure)
- `lib/graph-adapter.js` — Graph organ URN minting

## Running

```bash
npm install                     # Install dependencies
npm test                        # Run 56 tests (serial, hippocampus_test DB)
npm run setup-db                # Create database + apply migrations
HIPPOCAMPUS_PORT=4008 npm start # Start organ (requires Spine + dependencies)
```

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/conversations` | POST | Create conversation (URN + participants) |
| `/conversations/:urn` | GET | Retrieve conversation with messages |
| `/conversations` | GET | List conversations (filter by participant/status) |
| `/conversations/:urn/messages` | POST | Append message (transactional seq ordering) |
| `/conversations/:urn/messages/batch` | POST | Batch append messages (single transaction) |
| `/conversations/:urn/complete` | POST | Complete conversation (triggers async summary) |
| `/conversations/:urn/archive` | POST | Archive completed conversation |
| `/conversations/:urn/summarize` | POST | Generate/regenerate LLM summary |
| `/query` | POST | Semantic search (messages or conversations level) |
| `/backfill/embeddings` | POST | Backfill embedding gaps (messages + summaries) |

## Schema

- **conversations** — URN-keyed, pgvector summary embedding (384-dim), JSONB metadata
- **messages** — UUID-keyed, sequence-ordered, pgvector content embedding (384-dim), FK to conversations

## Completed Relays

- Relay 2 (h6g-2): Core API — conversations, messages, lifecycle, summarization, query
- Relay 3 (h6g-3): Phi integration — batch endpoint, context loading, session lifecycle
- Relay 4 (h6g-4): Vectr integration — embedding pipeline, semantic search, backfill
- Relay 5 (h6g-5): Spine handlers — directed OTM, broadcast sub/pub, LaunchAgent
- Relay 6 (h6g-6): CV tests — 6 categories registered in Vigil, validated against live instance

## LaunchAgent

- **Label:** `com.coretex.aos-organ.hippocampus`
- **Plist:** `com.coretex.aos-organ.hippocampus.plist`
- **Status:** Created, not loaded (rtime deployment pending)
- **Logs:** `210-Log/hippocampus-logs/`

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
