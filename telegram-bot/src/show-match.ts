import { normalizeTitle } from "./text.js";

/**
 * Matching d'œuvres robuste (cas imprévus).
 *
 * Principes :
 * 1. Normaliser fort (accents, ponctuation, articles)
 * 2. Empreinte de tokens (ordre-indépendant)
 * 3. Similarité Jaccard + ratio Levenshtein
 * 4. Contenance (sous-chaîne significative)
 * 5. Clusters de synonymes bilingues (extensible, pas un if unique)
 * 6. Seuil élevé pour éviter les faux positifs
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "le",
  "la",
  "les",
  "un",
  "une",
  "des",
  "de",
  "du",
  "el",
  "los",
  "las",
  "and",
  "et",
  "or",
  "ou",
  "of",
  "in",
  "on",
  "to",
  "vs",
]);

/** Synonymes bilingues — `primary` = nom affiché canonique. */
const SYNONYM_CLUSTERS: { primary: string; aliases: string[] }[] = [
  {
    primary: "La Casa de Papel",
    aliases: ["la casa de papel", "money heist", "casa de papel"],
  },
  {
    primary: "Squid Game",
    aliases: ["squid game", "el juego del calamar", "round 6"],
  },
  {
    primary: "Attack on Titan",
    aliases: ["attack on titan", "shingeki no kyojin"],
  },
  {
    primary: "Demon Slayer",
    aliases: ["demon slayer", "kimetsu no yaiba"],
  },
  {
    primary: "The Seven Deadly Sins",
    aliases: [
      "seven deadly sins",
      "nanatsu no taizai",
      "the seven deadly sins",
      "four knights of the apocalypse",
    ],
  },
];

export type ShowMatch = {
  name: string;
  normalized: string;
  score: number;
  reason: "exact" | "synonym" | "containment" | "fuzzy";
};

export function canonicalizeShowName(input: string): string {
  return normalizeTitle(input)
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t))
    .join(" ");
}

export function tokenSet(input: string): Set<string> {
  return new Set(
    canonicalizeShowName(input)
      .split(" ")
      .filter((t) => t.length > 1)
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

function synonymClusterIndex(normalized: string): number {
  const c = canonicalizeShowName(normalized);
  for (let i = 0; i < SYNONYM_CLUSTERS.length; i += 1) {
    for (const alias of SYNONYM_CLUSTERS[i].aliases) {
      const ca = canonicalizeShowName(alias);
      if (!ca) continue;
      if (c === ca || c.includes(ca) || ca.includes(c)) return i;
    }
  }
  return -1;
}

function synonymPrimary(normalized: string): string | null {
  const idx = synonymClusterIndex(normalized);
  return idx >= 0 ? SYNONYM_CLUSTERS[idx].primary : null;
}

/**
 * Score de similarité ∈ [0,1] entre deux titres d'œuvre.
 */
export function showSimilarity(a: string, b: string): {
  score: number;
  reason: ShowMatch["reason"];
} {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return { score: 0, reason: "fuzzy" };
  if (na === nb) return { score: 1, reason: "exact" };

  const sa = synonymClusterIndex(na);
  const sb = synonymClusterIndex(nb);
  if (sa >= 0 && sa === sb) return { score: 0.99, reason: "synonym" };

  const ca = canonicalizeShowName(na);
  const cb = canonicalizeShowName(nb);
  if (ca && cb && (ca === cb)) return { score: 0.98, reason: "exact" };

  // Contenance significative (évite "break" ⊂ "prison break" trop court)
  const minContain = 8;
  if (ca.length >= minContain && cb.length >= minContain) {
    if (ca.includes(cb) || cb.includes(ca)) {
      const ratio = Math.min(ca.length, cb.length) / Math.max(ca.length, cb.length);
      if (ratio >= 0.55) return { score: 0.92 * ratio + 0.05, reason: "containment" };
    }
  }

  const tokensA = tokenSet(na);
  const tokensB = tokenSet(nb);
  const jac = jaccard(tokensA, tokensB);
  const lev = levenshteinRatio(ca, cb);

  // Mix : tokens dominent, edit distance départage
  const score = jac * 0.7 + lev * 0.3;
  return { score, reason: "fuzzy" };
}

/** Seuil de fusion — volontairement strict pour limiter les faux positifs. */
export const SHOW_MATCH_THRESHOLD = 0.82;

/**
 * Trouve la meilleure œuvre existante pour un nouveau titre.
 * Renvoie null si rien n'est assez proche (cas imprévu → nouveau show).
 */
export function findBestShowMatch(
  candidate: string,
  existingNames: string[]
): ShowMatch | null {
  let best: ShowMatch | null = null;

  for (const name of existingNames) {
    const { score, reason } = showSimilarity(candidate, name);
    if (score < SHOW_MATCH_THRESHOLD) continue;
    if (!best || score > best.score) {
      best = {
        name,
        normalized: normalizeTitle(name),
        score,
        reason,
      };
    }
  }

  return best;
}

/**
 * Choisit le nom canonique le plus "propre" entre deux variantes.
 * Préfère : plus court (sans junk), plus de majuscules titre, moins de chiffres.
 */
export function preferCanonicalName(a: string, b: string): string {
  const primaryA = synonymPrimary(a);
  const primaryB = synonymPrimary(b);
  if (primaryA && primaryB && primaryA === primaryB) return primaryA;
  if (primaryA) return primaryA;
  if (primaryB) return primaryB;

  const score = (s: string) => {
    let v = 0;
    if (s.length >= 4 && s.length <= 60) v += 2;
    if (/[A-ZÀÂÄÉÈÊËÏÎÔÙÛÜ]/.test(s)) v += 1;
    if (!/\b(avi|mp4|mkv|web|xvid)\b/i.test(s)) v += 2;
    if (!/@/.test(s)) v += 1;
    v -= Math.max(0, s.length - 40) * 0.05;
    return v;
  };
  return score(a) >= score(b) ? a : b;
}

/**
 * Fusionne une liste de noms en clusters similaires.
 * Utile au groupement lecture (cas imprévus déjà en base).
 */
export function clusterShowNames(names: string[]): Map<string, string> {
  const unique = [...new Set(names.filter(Boolean))];
  const parent = new Map<string, string>();

  const find = (x: string): string => {
    const p = parent.get(x) || x;
    if (p !== x) {
      const root = find(p);
      parent.set(x, root);
      return root;
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const keep = preferCanonicalName(ra, rb);
    const drop = keep === ra ? rb : ra;
    parent.set(drop, keep);
  };

  for (const n of unique) parent.set(n, n);

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const { score } = showSimilarity(unique[i], unique[j]);
      if (score >= SHOW_MATCH_THRESHOLD) union(unique[i], unique[j]);
    }
  }

  const map = new Map<string, string>();
  for (const n of unique) {
    map.set(normalizeTitle(n), find(n));
  }
  return map;
}
