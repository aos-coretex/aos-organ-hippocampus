#!/usr/bin/env node
/**
 * CV Test: hippocampus-urn-minting
 * Tests conversation URN minting via Graph adapter.
 * Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const HIPPOCAMPUS_URL = process.env.HIPPOCAMPUS_URL || 'http://127.0.0.1:4008';
const GRAPH_URL = process.env.GRAPH_URL || 'http://127.0.0.1:4020';
const TEST_USER = 'urn:graphheight:user:cv-test-urn';

// Pre-flight
try {
  const h = await fetch(`${HIPPOCAMPUS_URL}/health`);
  if (!h.ok) throw new Error();
} catch {
  console.log(JSON.stringify({ status: 'blocked', reason: 'Hippocampus unreachable' }));
  process.exit(2);
}

// Check Graph availability (degraded test if unavailable)
let graphAvailable = false;
try {
  const g = await fetch(`${GRAPH_URL}/health`);
  graphAvailable = g.ok;
} catch { /* Graph is optional — test runs with fallback path */ }

const mintedUrns = [];

async function cleanup() {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      host: 'localhost', port: 5432,
      database: process.env.HIPPOCAMPUS_DB || 'hippocampus',
      user: process.env.PGUSER || 'graphheight_sys', max: 1,
    });
    for (const urn of mintedUrns) {
      await pool.query('DELETE FROM messages WHERE conversation_urn = $1', [urn]);
      await pool.query('DELETE FROM conversations WHERE urn = $1', [urn]);
    }
    await pool.end();
  } catch { /* best effort */ }
}

describe('hippocampus-urn-minting', () => {
  after(cleanup);

  it('1. mintConversationUrn returns valid URN pattern', async () => {
    const { mintConversationUrn } = await import('../../lib/graph-adapter.js');
    const urn = await mintConversationUrn(GRAPH_URL, { user_urn: TEST_USER, agent_session: 'cv-sess' });
    mintedUrns.push(urn);

    assert.ok(urn.startsWith('urn:graphheight:conversation:'), `URN should match pattern, got: ${urn}`);
    assert.ok(urn.length > 30, 'URN should have timestamp + random suffix');
  });

  it('2. Graph concept created for URN (if Graph available)', async (t) => {
    if (!graphAvailable) {
      t.skip('Graph organ not available — skipping Graph verification');
      return;
    }
    const urn = mintedUrns[0];
    const res = await fetch(`${GRAPH_URL}/concepts/${encodeURIComponent(urn)}`);
    assert.equal(res.status, 200, 'Concept should exist in Graph');
  });

  it('3. Minted URN works as conversation identifier', async () => {
    const urn = mintedUrns[0];
    const res = await fetch(`${HIPPOCAMPUS_URL}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urn, participants: { user_urn: TEST_USER } }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.urn, urn);
  });

  it('4. Fallback: URN minted locally when Graph unreachable', async () => {
    const { mintConversationUrn } = await import('../../lib/graph-adapter.js');
    // Use an unreachable URL
    const urn = await mintConversationUrn('http://127.0.0.1:1', { user_urn: TEST_USER });
    mintedUrns.push(urn);
    assert.ok(urn.startsWith('urn:graphheight:conversation:'), 'Fallback URN should still match pattern');
  });
});
