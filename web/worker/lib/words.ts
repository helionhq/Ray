/**
 * Word counting for quota purposes. The contract defines a word as a
 * whitespace-separated token in the final transcript.
 */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/u).length;
}
