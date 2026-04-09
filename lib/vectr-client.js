/**
 * Vectr client — embedding requests for Hippocampus.
 * Vectr (#30) is stateless: same input always produces same output.
 * 384-dim, L2-normalized, all-MiniLM-L6-v2.
 * Max 256 tokens per input (~200 words).
 *
 * Soft-failure: if Vectr is unavailable, return null.
 * Caller stores message without embedding; backfill later.
 */

const VECTR_TIMEOUT_MS = 5000;  // 5-second timeout per organ instructions

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Embed a single text string.
 * @param {string} vectrUrl - Vectr base URL (e.g. http://127.0.0.1:4001)
 * @param {string} text - Text to embed
 * @returns {Promise<number[]|null>} - 384-dim vector or null if unavailable
 */
export async function embedText(vectrUrl, text) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VECTR_TIMEOUT_MS);

    const response = await fetch(`${vectrUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log('vectr_embed_failed', { status: response.status });
      return null;
    }

    const data = await response.json();
    return data.embedding;  // number[384]
  } catch (error) {
    log('vectr_unavailable', { error: error.message });
    return null;
  }
}

/**
 * Embed multiple text strings in batch.
 * @param {string} vectrUrl - Vectr base URL
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<(number[]|null)[]>} - Array of 384-dim vectors (null for failures)
 */
export async function embedBatch(vectrUrl, texts) {
  if (texts.length === 0) return [];

  try {
    const controller = new AbortController();
    // Batch timeout: 5s base + 1s per 10 items
    const timeoutMs = VECTR_TIMEOUT_MS + Math.ceil(texts.length / 10) * 1000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${vectrUrl}/embed-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log('vectr_batch_failed', { status: response.status, count: texts.length });
      return texts.map(() => null);
    }

    const data = await response.json();
    return data.embeddings;  // number[384][]
  } catch (error) {
    log('vectr_batch_unavailable', { error: error.message, count: texts.length });
    return texts.map(() => null);
  }
}

/**
 * Check Vectr availability.
 * @param {string} vectrUrl
 * @returns {Promise<boolean>}
 */
export async function isVectrAvailable(vectrUrl) {
  try {
    const response = await fetch(`${vectrUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}
