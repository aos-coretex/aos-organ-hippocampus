/**
 * Tests for Hippocampus query (semantic search) endpoint.
 * Vectr dependency is not available in test context — tests verify
 * request validation and error handling.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createQueryRoutes } from '../server/routes/query.js';
import { getPool, closePool } from '../server/db/pool.js';

// Point to test database
process.env.HIPPOCAMPUS_DB = 'hippocampus_test';

// Vectr URL points to a non-running port — simulates unavailability
const testConfig = { vectrUrl: 'http://127.0.0.1:19999' };

describe('Query API', () => {
  let server, baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json());
    createQueryRoutes(app, testConfig);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM conversations');
  });

  it('1. POST /query — rejects missing participant_urn for user-scoped query', async () => {
    const res = await fetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test search' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('participant_urn required'));
  });

  it('2. POST /query — accepts scope:all without participant_urn', async () => {
    // This will proceed past validation but fail at Vectr (expected — tests Vectr unavailability)
    const res = await fetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test search', scope: 'all' }),
    });
    // Should get 503 (Vectr unavailable), not 400 (validation)
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error.includes('Vectr unavailable'));
  });

  it('3. POST /query — rejects empty query string', async () => {
    const res = await fetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '', participant_urn: 'urn:test:user:leon' }),
    });
    assert.equal(res.status, 400);
  });

  it('4. POST /query — returns 503 when Vectr is down', async () => {
    const res = await fetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', participant_urn: 'urn:test:user:leon' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error.includes('Vectr unavailable'));
  });
});
