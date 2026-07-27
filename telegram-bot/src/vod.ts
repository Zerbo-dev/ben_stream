import { normalizeTitle } from "./catalog.js";
import type { ContentType, VodMetadata } from "./types.js";

const QUALITY_RE =
  /\b(2160p|1080p|720p|480p|360p|4k|8k|web-?dl|blu-?ray|hdr|x265|hevc|x264)\b/gi;
const LANG_RE = /\b(vostfr|vost|vfq|vff|vf|vq|multi|truefrench|french|eng(?:lish)?|vo)\b/gi;
const YEAR_RE = /\(((?:19|20)\d{2})\)|\b(((?:19|20)\d{2}))\b/;

/**
 * Ordre important : patterns complets Sxx + Ep avant les "EP12" seuls.
 * Formats Telegram courants :
 * - S01E12 / S01 E12 / S01EP12 / S01 EP12
 * - [S01E04]
 * - Saison 1 Ep 22
 * - Season 2 Episode 3
 */
const EP_PATTERNS: RegExp[] = [
  /\bS(\d{1,2})\s*E(?:P)?\.?\s*(\d{1,3})\b/i,
  /\[S(\d{1,2})\s*E(?:P)?\.?\s*(\d{1,3})\]/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bSaison\s*(\d{1,2})\s*[-–—:]?\s*É?p(?:isode)?\.?\s*(\d{1,3})\b/i,
  /\bSeason\s*(\d{1,2})\s*[-–—:]?\s*Ep(?:isode)?\.?\s*(\d{1,3})\b/i,
  /\bÉ?p(?:isode)?\.?\s*(\d{1,3})\b/i,
  /\bEP\.?\s*(\d{1,3})\b/i,
];

/**
 * Parse intelligent style release Telegram VOD, AVANT stockage Redis.
 */
export function parseVodMetadata(
  rawTitle: string,
  fileName?: string
): VodMetadata {
  const captionLine = (rawTitle || "").split("\n")[0] || "";
  const fileLine = (fileName || "").replace(/_/g, " ");
  // Priorité caption ; filename en complément pour SxxEPxx souvent plus propre
  const source = [captionLine, fileLine].filter(Boolean).join(" \n ");
  const lower = source.toLowerCase();

  const qualities = unique(
    [...source.matchAll(QUALITY_RE)].map((m) =>
      m[0].toUpperCase().replace(/BLU-?RAY/i, "BluRay")
    )
  );
  const languages = unique(
    [...source.matchAll(LANG_RE)].map((m) => normalizeLang(m[0]))
  );

  let year: number | undefined;
  const yearMatch = source.match(YEAR_RE);
  if (yearMatch) {
    year = Number(yearMatch[1] || yearMatch[2]);
    if (!Number.isFinite(year)) year = undefined;
  }

  const ep = extractSeasonEpisode(source);
  let season = ep.season;
  let episode = ep.episode;

  // One Piece / long-runners : numéro nu
  if (episode == null) {
    const looseEp = source.match(/(?:^|[\s\-_])(?:E|EP)?(\d{2,4})(?:\.|$|\s)/i);
    if (
      looseEp &&
      /\b(one\s*piece|naruto|bleach|dbz|detective\s*conan)\b/i.test(source)
    ) {
      episode = Number(looseEp[1]);
      season = 1;
    }
  }

  const taggedType = detectTaggedType(lower);
  let contentType: ContentType;
  if (taggedType) {
    contentType = taggedType;
  } else if (episode != null) {
    contentType = looksLikeAnime(lower, source) ? "anime" : "serie";
  } else {
    contentType = "film";
  }

  const showName = cleanShowName(captionLine || fileLine, {
    year,
    season,
    episode,
    qualities,
    languages,
  });

  const displayTitle = buildDisplayTitle({
    showName,
    contentType,
    year,
    season,
    episode,
    qualities,
    languages,
  });

  return {
    contentType,
    showName,
    normalizedShowName: normalizeTitle(showName),
    year,
    season,
    episode,
    quality: qualities[0],
    language: languages[0],
    displayTitle,
  };
}

function extractSeasonEpisode(source: string): {
  season?: number;
  episode?: number;
} {
  for (const pattern of EP_PATTERNS) {
    const match = source.match(pattern);
    if (!match) continue;
    if (match[2] != null) {
      return { season: Number(match[1]), episode: Number(match[2]) };
    }
    if (match[1] != null) {
      return { season: 1, episode: Number(match[1]) };
    }
  }
  return {};
}

export function showKey(normalizedShowName: string): string {
  let hash = 2166136261;
  for (let i = 0; i < normalizedShowName.length; i += 1) {
    hash ^= normalizedShowName.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function detectTaggedType(lower: string): ContentType | null {
  if (/(#|\b)(anime|animé|animation\s*japonaise)\b/.test(lower)) return "anime";
  if (/(#|\b)(serie|série|series)\b/.test(lower)) return "serie";
  if (/(#|\b)(film|movie|cinema|cinéma)\b/.test(lower)) return "film";
  return null;
}

function looksLikeAnime(lower: string, source: string): boolean {
  if (/\b(anime|manga|shonen|shoujo|ova|ona|seinen)\b/.test(lower)) return true;
  // Handles Telegram type [@AnimeGinga] [@otaku_xxx]
  if (/@[^\s\]]*(anime|otaku|manga)[^\s\]]*/i.test(source)) return true;
  return false;
}

function normalizeLang(raw: string): string {
  const v = raw.toUpperCase();
  if (v === "VOST") return "VOSTFR";
  if (v === "ENGLISH") return "ENG";
  return v;
}

function cleanShowName(
  rawTitle: string,
  meta: {
    year?: number;
    season?: number;
    episode?: number;
    qualities: string[];
    languages: string[];
  }
): string {
  let name = rawTitle.split("\n")[0] || rawTitle;

  name = stripChannelNoise(name);

  name = name
    .replace(/#\w+/g, " ")
    // Sxx EPxx / SxxExx / [SxxExx]
    .replace(/\[?\bS\d{1,2}\s*E(?:P)?\.?\s*\d{1,3}\b\]?/gi, " ")
    .replace(/\b\d{1,2}x\d{1,3}\b/gi, " ")
    .replace(/\bSaison\s*\d{1,2}\b/gi, " ")
    .replace(/\bSeason\s*\d{1,2}\b/gi, " ")
    .replace(/\bÉ?p(?:isode)?\.?\s*\d{1,3}\b/gi, " ")
    .replace(/\bEP\.?\s*\d{1,3}\b/gi, " ")
    // Saison orpheline laissée après parse "S02 EP12" → enlever S02 restant
    .replace(/\bS\d{1,2}\b/gi, " ")
    .replace(/\((19|20)\d{2}\)/g, " ")
    .replace(QUALITY_RE, " ")
    .replace(LANG_RE, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\bFIN\b/gi, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/[._]+/g, " ")
    .replace(/\[\s*\]/g, " ")
    .replace(/\{\s*\}/g, " ")
    .replace(/\s*[-–—|·•:]+\s*$/g, "")
    .replace(/^\s*[-–—|·•:]+\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (meta.episode != null) {
    name = name
      .replace(new RegExp(`(?:\\s*[-–—]?\\s*)0*${meta.episode}\\s*$`), "")
      .replace(/\s*[-–—|·•]+$/g, "")
      .trim();
  }

  name = stripChannelNoise(name).replace(/\s{2,}/g, " ").trim();
  // Deux-points orphelins "Title :"
  name = name.replace(/\s*[:|-]\s*$/g, "").trim();

  return name || rawTitle.split("\n")[0]?.trim() || "Sans titre";
}

/**
 * Retire handles, liens Telegram, tags canal et suffixes type release.
 */
function stripChannelNoise(input: string): string {
  let name = input;

  name = name
    .replace(/https?:\/\/t\.me\/\S+/gi, " ")
    .replace(/\bt\.me\/\+\S+/gi, " ")
    .replace(/\bt\.me\/\S+/gi, " ")
    .replace(/@[A-Za-z0-9_]{3,}/g, " ")
    .replace(/【[^】]*】/g, " ")
    // Tags [VF] [S01E01] [1080p] etc.
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/[«»""]/g, " ")
    .replace(/➡️/g, " ");

  const parts = name
    .split(/\s*[|•·]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    const scored = parts
      .map((part) => ({ part, score: titlePartScore(part) }))
      .sort((a, b) => b.score - a.score);
    name = scored[0]?.part || name;
  }

  name = name
    .replace(
      /^\s*([A-Za-z0-9_]{3,24})\s*[-–—]\s+(?=[A-Za-zÀ-ÿ0-9])/u,
      (full, maybeChannel: string) =>
        looksLikeChannelToken(maybeChannel) ? "" : full
    )
    .replace(
      /\s*[-–—]\s*([A-Za-z0-9_]{3,24})\s*$/u,
      (full, maybeChannel: string) =>
        looksLikeChannelToken(maybeChannel) ? "" : full
    );

  name = name.replace(
    /\b(join|rejoins|abonne[-\s]?toi|subscribe|channel|canal|telegram|streaming|film gratis|lien|link|addlist)\b/gi,
    " "
  );

  return name.replace(/\s{2,}/g, " ").trim();
}

function titlePartScore(part: string): number {
  let score = part.length;
  if (/[a-zà-ÿ]/u.test(part)) score += 8;
  if (/^[A-Z0-9 _-]{3,20}$/.test(part)) score -= 12;
  if (looksLikeChannelToken(part)) score -= 20;
  if (/\bS\d{1,2}\s*E(?:P)?\.?\s*\d{1,3}\b/i.test(part) || /\b\d{1,2}x\d{1,3}\b/.test(part)) {
    score += 15;
  }
  if (/\(\d{4}\)/.test(part)) score += 10;
  return score;
}

function looksLikeChannelToken(token: string): boolean {
  const t = token.trim();
  if (!t) return true;
  if (/^@/.test(t)) return true;
  if (
    /^(benstream|benflix|animebox|animeginga|cine[_\s-]?galaxy|stream|movies?|films?|series?|serie|tv|vod|zone|hub|premium|gratuit|free)$/i.test(
      t
    )
  ) {
    return true;
  }
  if (/^[A-Z0-9_]{3,18}$/.test(t) && t === t.toUpperCase()) return true;
  return false;
}

export function formatShowLabel(
  showName: string,
  options: { seasons?: number[]; year?: number; contentType?: ContentType } = {}
): string {
  const seasons = [...new Set(options.seasons || [])].sort((a, b) => a - b);
  if (options.contentType === "film" || seasons.length === 0) {
    return options.year ? `${showName} (${options.year})` : showName;
  }
  if (seasons.length === 1) {
    return `${showName} · S${String(seasons[0]).padStart(2, "0")}`;
  }
  const first = String(seasons[0]).padStart(2, "0");
  const last = String(seasons[seasons.length - 1]).padStart(2, "0");
  return `${showName} · S${first}-S${last}`;
}

function buildDisplayTitle(meta: {
  showName: string;
  contentType: ContentType;
  year?: number;
  season?: number;
  episode?: number;
  qualities: string[];
  languages: string[];
}): string {
  const bits: string[] = [meta.showName];

  if (meta.episode != null) {
    const s = String(meta.season ?? 1).padStart(2, "0");
    const e = String(meta.episode).padStart(2, "0");
    bits.push(`S${s}E${e}`);
  } else if (meta.year) {
    bits.push(`(${meta.year})`);
  }

  if (meta.qualities[0]) bits.push(meta.qualities[0]);
  if (meta.languages[0]) bits.push(meta.languages[0]);

  return bits.join(" · ");
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function contentTypeLabel(type: ContentType): string {
  switch (type) {
    case "film":
      return "🎬 Film";
    case "serie":
      return "📺 Série";
    case "anime":
      return "🎌 Animé";
  }
}

export function contentTypeEmoji(type: ContentType): string {
  switch (type) {
    case "film":
      return "🎬";
    case "serie":
      return "📺";
    case "anime":
      return "🎌";
  }
}

export function formatEpisodeCode(season?: number, episode?: number): string {
  if (episode == null) return "";
  const s = String(season ?? 1).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  return `S${s}E${e}`;
}
