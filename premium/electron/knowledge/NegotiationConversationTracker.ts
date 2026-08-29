/**
 * NegotiationConversationTracker - Premium Implementation
 * 
 * Analyzes conversation context for negotiation-related evidence.
 * Tracks compensation-related discussion markers to improve answer grounding.
 */

/**
 * Check if recent conversation text contains compensation-related evidence
 * Scans the last 1-2 INTERVIEWER turns for compensation mentions
 * 
 * This detector is intentionally permissive to catch even shorthand comp mentions
 * (e.g., "ctc", "lpa", "yoy") that might indicate salary discussion.
 */
export function textHasCompEvidence(conversationText: string | null): boolean {
  if (!conversationText || typeof conversationText !== 'string') {
    return false;
  }

  const lowerText = conversationText.toLowerCase();
  
  // Keywords and patterns indicating compensation discussion
  const compPatterns = [
    // Direct salary/compensation terms
    /\b(salary|compensation|pay|compensation|wage|wages)\b/,
    /\b(budget|range|offer|package)\b/,
    /\b(negotiate|negotiation|negotiate)\b/,
    
    // Bonus/equity terms
    /\b(bonus|equity|options|stock|rsu|vest|vestment)\b/,
    /\b(signing\s+bonus|performance\s+bonus)\b/,
    
    // Benefits
    /\b(benefits|pto|vacation|healthcare|insurance)\b/,
    
    // International comp terms (CTC, LPA, YoY)
    /\b(ctc|lpa|yoy|gross|net)\b/,
    
    // Amount-like patterns (numbers with currency)
    /\b\d+k\b/i,  // 150k, 200k
    /\$\s*\d+/,   // $150,000
    /^\d+\s*-\s*\d+/,  // 120-140k range
  ];

  // Check if any compensation patterns match
  return compPatterns.some(pattern => pattern.test(lowerText));
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
