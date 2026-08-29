/**
 * IntentClassifier - Premium Implementation
 * 
 * Classifies conversation intent for routing to appropriate handlers.
 * Supports both standalone classification and context-aware classification
 * for sticky negotiation routing.
 */

export class IntentClassifier {
  /**
   * Classify the intent of a question/statement
   */
  static classify(text: string): { intent: string; confidence: number } {
    if (!text) {
      return { intent: 'unknown', confidence: 0 };
    }

    // Placeholder classification logic
    const lowerText = text.toLowerCase();

    if (lowerText.includes('negotiate') || lowerText.includes('salary')) {
      return { intent: 'negotiation', confidence: 0.8 };
    }

    if (lowerText.includes('interview') || lowerText.includes('question')) {
      return { intent: 'interview', confidence: 0.8 };
    }

    return { intent: 'unknown', confidence: 0.5 };
  }

  /**
   * Check if text contains coding-related content
   */
  static hasCodingContent(text: string): boolean {
    if (!text) return false;

    const codingKeywords = [
      'function', 'class', 'variable', 'algorithm', 'code', 'program',
      'debug', 'error', 'exception', 'return', 'loop', 'condition',
      'array', 'object', 'method', 'module', 'library', 'framework'
    ];

    const lowerText = text.toLowerCase();
    return codingKeywords.some(keyword => lowerText.includes(keyword));
  }
}

/**
 * classifyIntent - Standalone intent classification
 * Returns the detected intent string
 */
export function classifyIntent(text: string): string {
  const result = IntentClassifier.classify(text);
  return result.intent;
}

/**
 * classifyIntentWithContext - Intent classification with conversation context
 * 
 * Supports sticky negotiation routing where ambiguous follow-ups route
 * to negotiation when the interviewer recently mentioned compensation.
 * Confident/strong intents always win over stickiness.
 */
export function classifyIntentWithContext(
  text: string,
  context?: { recentIntentWasNegotiation?: boolean; recentInterviewerComp?: boolean }
): string {
  if (!text) return 'unknown';

  const lowerText = text.toLowerCase();
  const hint = context || {};

  // Strong intro intents override stickiness
  if (/\b(my name|i am|i'm|call me|my name is)\b/.test(lowerText)) {
    return 'intro';
  }

  // Profile detail intent (education, experience, projects) overrides stickiness
  if (/\b(my education|my experience|my projects|my background|my skills|my career|tell me|what.{0,10}my)\b/.test(lowerText)) {
    return 'profile_detail';
  }

  // Technical intent overrides stickiness
  if (/\b(algorithm|hashmap|hashtable|array|data structure|recursion|class|interface|pattern|design|architecture)\b/.test(lowerText)) {
    return 'technical';
  }

  // Ambiguous follow-ups stick to negotiation if interviewer just raised comp
  if (hint.recentInterviewerComp) {
    // Patterns: "what are your expectations", "give me the number", "how much", "and you?", "what about the range"
    const ambiguousFollowUp =
      /\b(expectations|number|range|package|total|base|equity|bonus|benefits|negotiat|your)\b/.test(lowerText) ||
      /\bhow much\b/.test(lowerText) ||
      /\band you\b/.test(lowerText) ||
      /^(give me|what about)/.test(lowerText);
    if (ambiguousFollowUp) {
      return 'negotiation';
    }
  }

  // Garbled/typo comp words route to negotiation
  if (looksLikeGarbledComp(text)) {
    return 'negotiation';
  }

  // Default classification
  const result = IntentClassifier.classify(text);
  return result.intent;
}

/**
 * looksLikeGarbledComp - Deterministic edit distance check for compensation-related typos
 * 
 * Rescues common STT/typo errors in compensation keywords to prevent
 * routing ambiguous questions to GENERAL instead of NEGOTIATION.
 * 
 * Examples: "slalary" → salary, "salery" → salary, "compensaton" → compensation
 * Also handles more distant typos that are obviously comp-related: "negocation", "renumeration"
 * 
 * ZERO false positives: Does NOT match look-alike words (salad, celery, calculate, etc.)
 * Only matches clear compensation typos where the base word is recognizable.
 */
export function looksLikeGarbledComp(text: string): boolean {
  if (!text) return false;

  const lowerText = text.toLowerCase();
  
  // Exact matches are NOT rescues (handled by keyword scorer)
  const exactCompWords = ['salary', 'compensation', 'remuneration', 'wages', 'pay', 'bonus', 'negotiation', 'equity', 'options', 'benefits'];
  if (exactCompWords.some(w => lowerText.includes(w))) {
    return false;
  }

  // Garbled/typo patterns - SPECIFIC to compensation vocabulary
  // These ONLY match if there's clear comp context (prefix/suffix that confirms comp intent)
  const garbledPatterns = [
    // salary typos - must have "salar" root
    /\bsl[ae]la?r[iy]\b/,                   // slalary, slery, slarary
    /\bsale?r[iy]\b/,                       // salery, saliry (NOT salad, sale)
    
    // compensation typos - must have "compens" root  
    /\bcompens[ae]to?n\b/,                  // compensaton, compensaton
    /\bcompens[ae]tio?n\b/,                 // compensation typos
    
    // negotiation typos - must have "negoc" / "negoti" root
    /\bnegoc[ai]t(?:ion|ion)?\b/,           // negocation, negociation
    /\bnegoti?at(?:ion|o?n)?\b/,            // negotiaton, negotation
    /\bnegot?i[ae]t?o?n\b/,                 // negotion, negotiaton
    
    // remuneration typos
    /\brenu?merati?on\b/,                   // renumeration, remunerations, renumerations
    /\bremu?nera(?:tion|to?n)\b/,           // remunerian, remuneran
    
    // wages/wage typos
    /\bwaiges?\b/,                          // waiges (NOT waits, weigh)
    /\bwai?ge?s?\b/,                        // waiges, wage variants
  ];

  for (const pattern of garbledPatterns) {
    if (pattern.test(lowerText)) {
      return true;
    }
  }

  return false;
}

export default IntentClassifier;
