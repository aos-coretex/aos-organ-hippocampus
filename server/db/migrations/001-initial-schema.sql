-- Hippocampus schema v1 — Conversation Memory (Monad Leg 4)
-- Organ: #80 | Database: hippocampus | Extension: pgvector
-- Source of truth: 01-Organs/80-Hippocampus/hippocampus-organ-intervention-instruction.md

BEGIN;

-- Extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  urn               VARCHAR PRIMARY KEY,              -- Graphheight-minted URN
  status            VARCHAR NOT NULL DEFAULT 'active', -- active | completed | archived
  user_urn          VARCHAR,                           -- participant: human identity
  persona_urn       VARCHAR,                           -- participant: Vivan identity (nullable)
  agent_session     VARCHAR,                           -- participant: agent session ID
  summary           TEXT,                              -- LLM-generated conversation summary
  summary_embedding vector(384),                       -- vectorized summary for search
  message_count     INTEGER DEFAULT 0,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_urn  VARCHAR NOT NULL REFERENCES conversations(urn),
  role              VARCHAR NOT NULL,                  -- user | assistant | system
  content           TEXT NOT NULL,
  participant_urn   VARCHAR,                           -- who said this
  seq               INTEGER NOT NULL,                  -- message order within conversation
  embedding         vector(384),                       -- vectorized content for search
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations (status);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations (user_urn);
CREATE INDEX IF NOT EXISTS idx_conv_persona ON conversations (persona_urn);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (conversation_urn, seq);

-- Vector indexes (ivfflat) — require at least 1 row to build.
-- These are created as empty indexes; PostgreSQL builds the index structure
-- on first query if lists=1 (safe for small datasets, rebuild at scale).
-- For initial development, cosine distance operator class is used.
CREATE INDEX IF NOT EXISTS idx_msg_embedding
  ON messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1);
CREATE INDEX IF NOT EXISTS idx_conv_summary_embedding
  ON conversations USING ivfflat (summary_embedding vector_cosine_ops) WITH (lists = 1);

-- Unique constraint: one sequence number per conversation
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_conv_seq
  ON messages (conversation_urn, seq);

COMMIT;
