export interface TranscriptPiece {
  text: string;
  removed: boolean;
}

/** Above this many LCS cells, skip highlighting and show the raw text. */
const MAX_CELLS = 250_000;

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Word-level LCS between the original transcript and the cleaned text.
 * Words in the original that do not survive into the cleaned text are marked
 * removed. Punctuation and whitespace are never marked, and when the diff
 * would be expensive we return the raw text untouched rather than guessing.
 */
export function diffTranscript(raw: string, cleaned: string): TranscriptPiece[] {
  const rawTokens = raw.split(/(\s+)/);

  const rawWords: { norm: string; index: number }[] = [];
  for (let index = 0; index < rawTokens.length; index++) {
    if (/^\s+$/.test(rawTokens[index])) continue;
    const norm = normalizeToken(rawTokens[index]);
    if (norm) rawWords.push({ norm, index });
  }

  const cleanWords = cleaned
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);

  if (rawWords.length === 0) {
    return rawTokens.map((text) => ({ text, removed: false }));
  }
  if (cleanWords.length === 0) {
    return rawTokens.map((text) => ({
      text,
      removed: !/^\s+$/.test(text) && Boolean(normalizeToken(text)),
    }));
  }
  if (rawWords.length * cleanWords.length > MAX_CELLS) {
    return rawTokens.map((text) => ({ text, removed: false }));
  }

  const m = rawWords.length;
  const n = cleanWords.length;
  const width = n + 1;
  const table = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i * width + j] =
        rawWords[i].norm === cleanWords[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const matched = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (rawWords[i].norm === cleanWords[j]) {
      matched.add(rawWords[i].index);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return rawTokens.map((text, index) => ({
    text,
    removed:
      !/^\s+$/.test(text) &&
      Boolean(normalizeToken(text)) &&
      !matched.has(index),
  }));
}
