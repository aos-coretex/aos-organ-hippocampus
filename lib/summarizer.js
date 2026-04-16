/**
 * Conversation summarization agent — internal to Hippocampus.
 *
 * Model: resolved by `@coretex/organ-boot/llm-settings-loader` from
 * `01-Organs/80-Hippocampus/hippocampus-organ-session-summarizer-llm-settings.yaml`.
 * Boot path constructs the loader + cascade-wrapped client and injects it via
 * `setLLMClient()`. Production boot always injects; tests that don't exercise
 * the LLM path leave the unavailable stub in place. (MP-CONFIG-1 R6 — l9m-6.)
 */

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer for a platform memory system.
Given a full conversation transcript, produce a concise summary (3-8 sentences) that captures:
1. The main topics discussed
2. Key decisions or conclusions reached
3. Any unresolved questions or action items
4. The participants and their roles

The summary will be used for:
- Loading context in future sessions ("what did we discuss last time?")
- Semantic search across conversation history
- Persona behavioral analysis

Be factual and specific. Include proper nouns, technical terms, and concrete outcomes.
Do not include preamble or meta-commentary. Output the summary directly.`;

// Boot path injects a loader-derived cascade-wrapped client. Tests that don't
// exercise the LLM path leave this unavailable stub in place — preserves the
// existing test expectation that `isSummarizerAvailable()` returns false when
// no API key / no boot wiring is present.
let llmClient = {
  chat: async () => {
    const err = new Error('Hippocampus summarizer: no LLM client wired; boot path must inject one (MP-CONFIG-1 R6)');
    err.code = 'LLM_UNAVAILABLE';
    throw err;
  },
  isAvailable: () => false,
  getUsage: () => ({}),
};

/**
 * Inject the loader-derived LLM client. Called once at organ boot.
 */
export function setLLMClient(client) {
  llmClient = client;
}

/**
 * Check whether the summarization agent is available (wired + API key present).
 * @returns {boolean}
 */
export function isSummarizerAvailable() {
  return llmClient.isAvailable();
}

/**
 * Summarize a conversation from its messages.
 * @param {Array<{role: string, content: string, seq: number}>} messages
 * @returns {Promise<{summary: string, token_count: number}>}
 */
export async function summarizeConversation(messages) {
  const transcript = messages
    .sort((a, b) => a.seq - b.seq)
    .map(m => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  const result = await llmClient.chat(
    [{ role: 'user', content: transcript }],
    { system: SUMMARY_SYSTEM_PROMPT },
  );

  return {
    summary: result.content,
    token_count: result.output_tokens || 0,
  };
}
