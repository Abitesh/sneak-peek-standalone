/**
 * NegotiationConversationTracker - Premium Implementation
 * 
 * Analyzes conversation context for negotiation-related evidence.
 * Tracks compensation-related discussion markers to improve answer grounding.
 */

/**
 * Check if recent conversation text contains compensation-related evidence
 * Scans the last 1-2 INTERVIEWER turns for compensation mentions
 */
export function textHasCompEvidence(conversationText: string | null): boolean {
  if (!conversationText || typeof conversationText !== 'string') {
    return false;
  }

  const lowerText = conversationText.toLowerCase();
  
  // Keywords indicating compensation discussion
  const compKeywords = [
    'salary', 'compensation', 'pay', 'budget', 'range', 'offer',
    'negotiate', 'negotiation', 'bonus', 'equity', 'options',
    'benefits', 'package', 'total comp', 'base', 'commission',
    'raise', 'increase', 'stock', 'rrsu', 'vest', 'signing bonus'
  ];

  // Check if any compensation keywords appear in the text
  return compKeywords.some(keyword => lowerText.includes(keyword));
}

export class NegotiationConversationTracker {
  /**
   * Placeholder for negotiation tracking
   */
  static trackNegotiationContext(transcript: string): any {
    return {
      hasCompEvidence: textHasCompEvidence(transcript),
      negotiationMarkers: [],
      timestamp: Date.now(),
    };
  }
}
