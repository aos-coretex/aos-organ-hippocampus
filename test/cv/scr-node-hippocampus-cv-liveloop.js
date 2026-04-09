#!/usr/bin/env node
/**
 * CV Test: hippocampus-live-loop
 * Tests organ infrastructure: health endpoint, introspect, Spine connectivity.
 * Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const HIPPOCAMPUS_URL = process.env.HIPPOCAMPUS_URL || 'http://127.0.0.1:4008';

// Pre-flight
try {
  const h = await fetch(`${HIPPOCAMPUS_URL}/health`);
  if (!h.ok) throw new Error();
} catch {
  console.log(JSON.stringify({ status: 'blocked', reason: 'Hippocampus unreachable' }));
  process.exit(2);
}

describe('hippocampus-live-loop', () => {
  it('1. Health endpoint returns ok with conversation counts', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.checks, 'Health response should contain checks object');
    const checks = body.checks;
    assert.ok('active' in checks, 'Should report active conversation count');
    assert.ok('completed' in checks, 'Should report completed conversation count');
    assert.ok('total_messages' in checks, 'Should report total message count');
    assert.ok('embedding_coverage_pct' in checks, 'Should report embedding coverage');
    assert.ok('vectr_available' in checks || checks.vectr_available !== undefined, 'Should report Vectr status');
  });

  it('2. Introspect endpoint returns producer/consumer info', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/introspect`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.extra, 'Introspect should contain extra object');
    const extra = body.extra;
    assert.ok(extra.connected_producers, 'Should list connected producers');
    assert.ok(extra.connected_consumers, 'Should list connected consumers');
    assert.ok(Array.isArray(extra.connected_consumers), 'Consumers should be an array');
    assert.ok(extra.connected_consumers.includes('Phi'), 'Phi should be a consumer');
  });

  it('3. Health reports uptime and organ name', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/health`);
    const body = await res.json();
    assert.equal(body.organ, 'Hippocampus');
    assert.ok(typeof body.uptime_s === 'number', 'uptime_s should be a number');
    assert.ok(body.uptime_s >= 0, 'uptime should be non-negative');
  });
});
