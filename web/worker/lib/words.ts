/**
 * Word counting for quota purposes.
 *
 * Decision 7: prefer the length of AssemblyAI's `words` array when present.
 * Otherwise count whitespace-separated tokens, with each CJK (Han), Hiragana,
 * Katakana and Hangul character counted as one word so CJK text is not
 * drastically undercounted.
 */

const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (trimmed === "") return 0;

  let total = 0;
  for (const token of trimmed.split(/\s+/u)) {
    const cjk = token.match(CJK_CHARACTER)?.length ?? 0;
    // Non-CJK runs inside a mixed token ("hello世界", "2026年") still count as
    // words; punctuation-only remnants do not.
    const rest = token.replace(CJK_CHARACTER, " ");
    const nonCjk = rest
      .split(/\s+/u)
      .filter((part) => part !== "" && WORD_CHARACTER.test(part)).length;
    const counted = cjk + nonCjk;
    // A punctuation-only whitespace token still counts as one token, matching
    // the original whitespace-token behaviour.
    total += counted > 0 ? counted : 1;
  }
  return total;
}

/**
 * Counts a parsed AssemblyAI transcript payload. The `words` array (when the
 * upstream returns one) is authoritative; otherwise the `text` field is
 * counted with `countWords`.
 */
export function countTranscriptWords(
  payload: Record<string, unknown> | null | undefined,
): number {
  if (!payload) return 0;
  const words = payload["words"];
  if (Array.isArray(words)) return words.length;
  const text = payload["text"];
  return typeof text === "string" ? countWords(text) : 0;
}
