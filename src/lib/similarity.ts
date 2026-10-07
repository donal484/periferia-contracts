const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "en", "para", "por", "con", "a", "al", "un", "una"]);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .split(" ")
      .filter((w) => w && !STOPWORDS.has(w)),
  );
}

/** Similitud de Jaccard sobre palabras significativas, en [0, 1]. */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}
