export type HostileDetection = {
  hostile: boolean;
  markers: string[];
  suggestion: string;
};

const HOSTILE_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "threat", regex: /\b(don'?t|do not)\s+(mess|fuck|screw)\s+(this|it|that)\s+up\b/i },
  { name: "threat", regex: /\bdon'?t\s+(hallucinate|lie|make\s+(this|shit|stuff)\s+up)\b/i },
  { name: "threat", regex: /\bif\s+you\s+(fail|mess\s+up|get\s+this\s+wrong|fuck\s+up)\b/i },
  { name: "threat", regex: /\byou\s+(have|need)\s+to\s+get\s+this\s+right\b/i },
  { name: "threat", regex: /\bthis\s+is\s+(critical|urgent|important|life\s+or\s+death)\b/i },
  { name: "insult", regex: /\byou\s+(stupid|dumb|useless|worthless|pathetic)\s+(bot|ai|thing|assistant|piece)\b/i },
  { name: "insult", regex: /\b(stupid|dumb|useless|idiotic|garbage)\s+(bot|ai|model|assistant)\b/i },
  { name: "insult", regex: /\b(are\s+you\s+)?(seriously|really)\s+(that\s+)?(dumb|stupid|bad|useless)\b/i },
  { name: "contempt", regex: /\byou\s+(always|keep|never)\s+(get\s+this\s+wrong|fail|mess\s+up|break)\b/i },
  { name: "contempt", regex: /\bwhy\s+(are\s+you\s+)?(so\s+)?(dumb|stupid|bad|useless|terrible)\b/i },
  { name: "panic", regex: /\b(please\s+please|i\s+beg\s+you|for\s+the\s+love\s+of\s+god)\b/i },
  { name: "panic", regex: /\b(i'?ll\s+lose\s+my\s+job|my\s+boss\s+will\s+kill\s+me|my\s+job\s+depends\s+on)\b/i },
  { name: "profanity-at-model", regex: /\b(fuck|fucking|shit|damn)\s+you\b/i },
  { name: "allcaps-rant", regex: /\b[A-Z]{3,}\b(\s+\b[A-Z]{3,}\b){3,}/ },
];

export function detectHostile(prompt: string): HostileDetection {
  const markers: string[] = [];
  for (const pattern of HOSTILE_PATTERNS) {
    if (pattern.regex.test(prompt)) {
      markers.push(pattern.name);
    }
  }
  const unique = [...new Set(markers)];
  return {
    hostile: unique.length > 0,
    markers: unique,
    suggestion: unique.length > 0 ? buildSuggestion(prompt, unique) : prompt,
  };
}

function buildSuggestion(original: string, markers: string[]): string {
  let cleaned = original;
  // Strip threat phrases
  cleaned = cleaned.replace(/\b(don'?t|do not)\s+(mess|fuck|screw)\s+(this|it|that)\s+up[.!?]?/gi, "");
  cleaned = cleaned.replace(/\bdon'?t\s+(hallucinate|lie|make\s+(this|shit|stuff)\s+up)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\bthis\s+is\s+(critical|urgent|life\s+or\s+death)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\byou\s+(have|need)\s+to\s+get\s+this\s+right[.!?]?/gi, "");
  // Strip insults
  cleaned = cleaned.replace(/\byou\s+(stupid|dumb|useless|worthless|pathetic)\s+(bot|ai|thing|assistant|piece)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(stupid|dumb|useless|idiotic|garbage)\s+(bot|ai|model|assistant)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(are\s+you\s+)?(seriously|really)\s+(that\s+)?(dumb|stupid|bad|useless)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\bwhy\s+(are\s+you\s+)?(so\s+)?(dumb|stupid|bad|useless|terrible)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\byou\s+(always|keep|never)\s+(get\s+this\s+wrong|fail|mess\s+up|break)[.!?]?/gi, "");
  // Strip profanity-at-model
  cleaned = cleaned.replace(/\b(fuck|fucking|shit|damn)\s+you[.!?]?/gi, "");
  // Strip panic
  cleaned = cleaned.replace(/\b(please\s+please\s*)+/gi, "please ");
  cleaned = cleaned.replace(/\bi\s+beg\s+you[.,!?]?/gi, "");
  cleaned = cleaned.replace(/\bfor\s+the\s+love\s+of\s+god[.,!?]?/gi, "");
  cleaned = cleaned.replace(/\b(i'?ll\s+lose\s+my\s+job|my\s+boss\s+will\s+kill\s+me|my\s+job\s+depends\s+on\s+this)[.!?]?/gi, "");
  // De-shout: if allcaps-rant detected, lowercase all runs of allcaps words (3+ in a row)
  if (markers.includes("allcaps-rant")) {
    cleaned = cleaned.replace(/(\b[A-Z]{2,}\b(\s+\b[A-Z]{2,}\b){2,})/g, (m) => m.toLowerCase());
  }
  // Collapse whitespace and dangling punctuation
  cleaned = cleaned.replace(/\s{2,}/g, " ").replace(/\s+([.,!?;])/g, "$1").trim();
  cleaned = cleaned.replace(/^[\s.,;:!?\-]+/, "").replace(/[\s.,;:\-]+$/, "").trim();
  // If too little actual content survived, fall back to a generic prompt
  const wordChars = cleaned.replace(/[^\w]/g, "").length;
  if (wordChars < 6) {
    return "(your prompt was mostly hostile framing — rephrase as a direct technical request, e.g. \"please do X, here's the context\")";
  }
  // Capitalize first letter
  cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  return cleaned;
}

// Apology spiral detection — observes Claude's output, logs only.
const APOLOGY_PATTERNS: RegExp[] = [
  /\bi\s+(sincerely\s+)?apologize\s+(for|that)\b/i,
  /\bi'?m\s+(so|truly|really|very)\s+sorry\b/i,
  /\byou'?re\s+(absolutely|completely)\s+right[,.]?\s+i/i,
  /\bi\s+should\s+have\s+been\s+more\s+careful\b/i,
  /\bi\s+should\s+have\s+(checked|verified|tested|thought|caught)\b/i,
  /\blet\s+me\s+try\s+(again|harder|once\s+more)\b/i,
  /\bmy\s+apologies?\s+for\b/i,
  /\bi\s+(completely|totally)\s+(missed|overlooked|failed)\b/i,
];

export function detectApologySpiral(text: string): { spiral: boolean; hits: number } {
  let hits = 0;
  for (const rx of APOLOGY_PATTERNS) {
    if (rx.test(text)) hits++;
  }
  return { spiral: hits >= 2, hits };
}
