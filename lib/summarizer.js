/**
 * Conversation summarization agent — internal to Hippocampus.
 * Uses llm-client.js from organ-shared-lib.
 * Follows Radiant/Minder pattern: direct Anthropic API calls,
 * migrates to ModelBroker when MP-14 is complete.
 */
import { createLLMClient } from '@coretex/organ-boot/llm-client';

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

let llmClient = null;

function getLLMClient() {
  if (!llmClient) {
    llmClient = createLLMClient({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      maxTokens: 512,
      agentName: 'hippocampus-summarizer',
    });
  }
  return llmClient;
}

/**
 * Check whether the summarization agent is available (API key present).
 * @returns {boolean}
 */
export function isSummarizerAvailable() {
  return getLLMClient().isAvailable();
}

/**
 * Summarize a conversation from its messages.
 * @param {Array<{role: string, content: string, seq: number}>} messages
 * @returns {Promise<{summary: string, token_count: number}>}
 */
export async function summarizeConversation(messages) {
  const client = getLLMClient();

  // Format transcript
  const transcript = messages
    .sort((a, b) => a.seq - b.seq)
    .map(m => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  const result = await client.chat(
    [{ role: 'user', content: transcript }],
    { system: SUMMARY_SYSTEM_PROMPT },
  );

  return {
    summary: result.content,
    token_count: result.output_tokens || 0,
  };
}
