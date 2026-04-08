/**
 * Graph organ adapter — URN minting for conversations.
 * Graph (#40) on port 4020 (AOS) / 3920 (SAAS).
 * Uses insertConcept to mint a conversation URN.
 *
 * In target architecture, Graphheight provides URN minting.
 * Graph is the interim adapter (SQLite ai-kb.db backend).
 */

/**
 * Mint a conversation URN via Graph organ.
 * @param {string} graphUrl - Graph organ base URL
 * @param {object} participants - { user_urn, persona_urn?, agent_session }
 * @returns {Promise<string>} - minted URN
 */
export async function mintConversationUrn(graphUrl, participants) {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  const urn = `urn:graphheight:conversation:${timestamp}-${rand}`;

  try {
    const response = await fetch(`${graphUrl}/concepts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn,
        type: 'conversation',
        data: {
          participants,
          organ: 'Hippocampus',
          created_at: new Date().toISOString(),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Graph insertConcept failed: ${response.status}`);
    }

    return urn;
  } catch (error) {
    // Fail-open: generate URN locally if Graph is unavailable
    // Flag for reconciliation (URN_RESOLUTION_FAILED exception)
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'urn_resolution_failed',
      error: error.message,
      fallback_urn: urn,
    }));
    return urn;
  }
}
