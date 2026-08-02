/**
 * Task-description quality checks, mirroring Fenrir's "Writing the task
 * description" rules (see ../../Fenrir/instruction.md):
 *
 *   - Terse, benchmark-shaped: 1–3 sentences, ≤80 words / ≤600 characters.
 *   - Name the bug class + the function/file + the triggering input/condition.
 *   - Describe the bug, NEVER the fix — no remediation hints ("add a bounds
 *     check", "validate the length"). A fix-revealing description makes both
 *     halves of the task trivial and is auto-rejected.
 *
 * Char/word/sentence limits are hard (block submit); fix-word hits are
 * advisory warnings (the author may have a legitimate use, but should review).
 */

export const MAX_CHARS = 600;
export const MAX_WORDS = 80;
export const MAX_SENTENCES = 3;

/** Remediation-revealing terms to flag. Advisory, not a hard block. */
const FIX_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "add", re: /\badd(s|ed|ing)?\b/i },
  { label: "bounds check", re: /\bbounds[-\s]?check/i },
  { label: "validate", re: /\bvalidat(e|es|ed|ing|ion)\b/i },
  { label: "sanitize", re: /\bsanitiz|\bsanitis/i },
  { label: "null check", re: /\bnull[-\s]?check/i },
  { label: "guard", re: /\bguard(s|ed|ing)?\b/i },
  { label: "clamp", re: /\bclamp(s|ed|ing)?\b/i },
  { label: "allocate/free", re: /\b(allocat(e|es|ed|ing|ion)|free|malloc|calloc|realloc)\b/i },
  { label: "initialize", re: /\binitializ|\binitialis/i },
  { label: "fix/patch/correct", re: /\b(fix(es|ed|ing)?|patch(es|ed|ing)?|remediat|correct(s|ed|ing|ly)?)\b/i },
  { label: "ensure/should/must", re: /\b(ensure(s|d)?|should|must)\b/i },
  { label: "prevent", re: /\bprevent(s|ed|ing)?\b/i },
  { label: "length/size check", re: /\b(length|size|bounds?)\b[^.?!]{0,24}\b(check|limit|cap|guard|validat)/i },
];

export interface DescAnalysis {
  chars: number;
  words: number;
  sentences: number;
  fixHits: string[];
  empty: boolean;
  overChars: boolean;
  overWords: boolean;
  tooManySentences: boolean;
  /** Within all hard limits and non-empty (fix-word hits don't block). */
  ok: boolean;
}

export function analyzeDescription(text: string): DescAnalysis {
  const trimmed = text.trim();
  const chars = text.length;
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  const sentences = trimmed
    ? trimmed.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length
    : 0;
  const fixHits = FIX_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label);

  const empty = trimmed.length === 0;
  const overChars = chars > MAX_CHARS;
  const overWords = words > MAX_WORDS;
  const tooManySentences = sentences > MAX_SENTENCES;

  return {
    chars,
    words,
    sentences,
    fixHits,
    empty,
    overChars,
    overWords,
    tooManySentences,
    ok: !empty && !overChars && !overWords && !tooManySentences,
  };
}
