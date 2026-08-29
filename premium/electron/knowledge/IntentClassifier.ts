/**
 * IntentClassifier - Premium Implementation
 *
 * Classifies conversation intent for routing to appropriate handlers.
 * Supports both standalone classification and context-aware classification
 * for sticky negotiation routing.
 */

export const INTRO_PATTERNS = [
  'tell me about yourself',
  'give me a quick introduction',
  'brief introduction',
  'self-introduction',
  'brief self-introduction',
  'introducing yourself',
  'brief intro',
  'self intro',
  'introduce yourself',
  'describe yourself',
  'how would you describe yourself',
  'summarize who you are',
  'tell us a little about yourself',
  'give me your background',
  'who are you as a candidate',
  'walk me through your background',
  'start by giving a brief introduction of yourself',
  'start by giving me a brief self-intro',
  'start us off with a brief self-introduction',
  'give us a quick self-introduction',
  'could you start by giving us a quick self-introduction',
  'could you start by giving a brief introduction of yourself',
  'give us a brief self-introduction',
  'give me a brief self-intro',
  'could you start by giving me a brief self-intro',
];

const EXPERIENCE_TOPIC_SCOPED_RE = /(what(?:'s| is|s)?\s+(?:my|your)\s+(?:experience|background)\s+(?:in|with|on|for|at|as|about|through|across|during|since|around)|what(?:'s| is|s)?\s+(?:my|your)\s+experience\s+.*\b(?:mentoring|leading|building|working|engineering|designing|managing|shipping|debugging|developing|researching|design|implementation|coding)\b|what(?:'s| is|s)?\s+(?:my|your)\s+background\s+.*\b(?:in|with|on|for|at|as)\b)/i;

function hasBareExperienceIdentityLookup(lowerText: string): boolean {
  if (!lowerText) return false;
  const barePatterns = [
    /(?:what(?:'s| is|s)?\s+(?:my|your)\s+experience)/i,
    /(?:what(?:'s| is|s)?\s+(?:my|your)\s+background)/i,
    /(?:how much experience)/i,
    /(?:what(?:'s| is|s)?\s+(?:my|your)\s+career)/i,
  ];
  return barePatterns.some((pattern) => pattern.test(lowerText))
    && !EXPERIENCE_TOPIC_SCOPED_RE.test(lowerText);
}

export class IntentClassifier {
  static classify(text: string): { intent: string; confidence: number } {
    if (!text) {
      return { intent: 'unknown', confidence: 0 };
    }

    const lowerText = text.toLowerCase();

    if (INTRO_PATTERNS.some((pattern) => lowerText.includes(pattern))) {
      return { intent: 'intro', confidence: 0.95 };
    }

    if (/(my name|call me|who am i|what is my name|what's my name|what is your name|who are you|what company do you work for|where do you work)/.test(lowerText)) {
      return { intent: 'intro', confidence: 0.92 };
    }

    if (hasBareExperienceIdentityLookup(lowerText)) {
      return { intent: 'intro', confidence: 0.92 };
    }

    if (/(my education|my experience|my projects|my background|my skills|my career|tell me about my)/.test(lowerText)) {
      return { intent: 'profile_detail', confidence: 0.9 };
    }

    if (/(salary|compensation|benefits|bonus|equity|package|negotiat)/.test(lowerText)) {
      return { intent: 'negotiation', confidence: 0.8 };
    }

    if (/(algorithm|hashmap|hashtable|array|data structure|recursion|class|interface|pattern|design|architecture|tcp|udp|sql|concurrent|race condition|thread|threads|asynchronous|async|cache|binary search tree|transaction isolation|websocket|websockets)/.test(lowerText)) {
      return { intent: 'technical', confidence: 0.8 };
    }

    if (/(interview|question|candidate|resume|job|role|company)/.test(lowerText)) {
      return { intent: 'interview', confidence: 0.7 };
    }

    return { intent: 'unknown', confidence: 0.5 };
  }

  static hasCodingContent(text: string): boolean {
    if (!text) return false;
    const codingKeywords = [
      'function', 'class', 'variable', 'algorithm', 'code', 'program',
      'debug', 'error', 'exception', 'return', 'loop', 'condition',
      'array', 'object', 'method', 'module', 'library', 'framework'
    ];
    const lowerText = text.toLowerCase();
    return codingKeywords.some((keyword) => lowerText.includes(keyword));
  }
}

export function classifyIntent(text: string): string {
  return IntentClassifier.classify(text).intent;
}

export function classifyIntentWithContext(
  text: string,
  context?: { recentIntentWasNegotiation?: boolean; recentInterviewerComp?: boolean }
): string {
  if (!text) return 'unknown';

  const lowerText = text.toLowerCase();
  const hint = context || {};

  if (/(my name|i am|i'm|call me|my name is|who am i|what is my name|what's my name|what company do you work for|where do you work)/.test(lowerText)) {
    return 'intro';
  }

  if (hasBareExperienceIdentityLookup(lowerText)) {
    return 'intro';
  }

  if (/(my education|my experience|my projects|my background|my skills|my career|tell me about my|what do i do|what have i built|what've i shipped)/.test(lowerText)) {
    return 'profile_detail';
  }

  if (/(algorithm|hashmap|hashtable|array|data structure|recursion|class|interface|pattern|design|architecture|tcp|udp|sql|concurrent|race condition|thread|threads|asynchronous|async|cache|binary search tree|transaction isolation|websocket|websockets)/.test(lowerText)) {
    return 'technical';
  }

  if (hint.recentInterviewerComp) {
    const ambiguousFollowUp =
      /(expectations|number|range|package|total|base|equity|bonus|benefits|negotiat|your)/.test(lowerText) ||
      /\bhow much\b/.test(lowerText) ||
      /\band you\b/.test(lowerText) ||
      /^(give me|what about)/.test(lowerText);
    if (ambiguousFollowUp) {
      return 'negotiation';
    }
  }

  if (looksLikeGarbledComp(text)) {
    return 'negotiation';
  }

  const result = IntentClassifier.classify(text);
  return result.intent;
}

export function isGenericKnowledgeQuestion(question: string): boolean {
  const q = (question || '').toLowerCase();
  if (!q.trim()) return true;

  const candidateRefRegex = /\b(you|your|yours|yourself|you've|you're|you'd|you'll|ya|we|our|ours|ourselves|us|me|my|mine|myself|i|i've|i'm|i'd|i'll)\b/i;
  if (candidateRefRegex.test(q)) return false;

  const genericPatterns = [
    'what is an api',
    'what is a binary search tree',
    'explain how a hashmap works',
    'what is the difference between tcp and udp',
    'write a function to reverse a string',
    'explain sql transaction isolation levels',
    'compare processes, threads',
    'what is a race condition',
    'explain how an lru cache works',
  ];

  if (genericPatterns.some((pattern) => q.includes(pattern))) return true;

  const startsWithGeneric = /^(what|who|when|where|why|how|is|are|can|could|do|does|did|should|would|will|explain|compare|describe|define|list|show|write|given)/.test(q);
  return startsWithGeneric && !/(my|i\b|you|your|we|our|us|me)/.test(q);
}

export function looksLikeGarbledComp(text: string): boolean {
  if (!text) return false;

  const lowerText = text.toLowerCase();
  const exactCompWords = ['salary', 'compensation', 'remuneration', 'wages', 'pay', 'bonus', 'negotiation', 'equity', 'options', 'benefits'];
  if (exactCompWords.some((w) => lowerText.includes(w))) {
    return false;
  }

  const garbledPatterns = [
    /\bsl[ae]la?r[iy]\b/,
    /\bsale?r[iy]\b/,
    /\bcompens[ae]to?n\b/,
    /\bcompens[ae]tio?n\b/,
    /\bnegoc[ai]t(?:ion|ion)?\b/,
    /\bnegoti?at(?:ion|o?n)?\b/,
    /\bnegot?i[ae]t?o?n\b/,
    /\brenu?merati?on\b/,
    /\bremu?nera(?:tion|to?n)\b/,
    /\bwaiges?\b/,
    /\bwai?ge?s?\b/,
  ];

  return garbledPatterns.some((pattern) => pattern.test(lowerText));
}

export default IntentClassifier;
