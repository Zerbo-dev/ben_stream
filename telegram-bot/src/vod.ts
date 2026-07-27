import { normalizeTitle } from "./catalog.js";
import type { ContentType, VodMetadata } from "./types.js";

const QUALITY_RE = /\b(2160p|1080p|720p|480p|360p|4k|8k|web-?dl|blu-?ray|hdr|x265|hevc|x264)\b/gi;
const LANG_RE = /\b(vostfr|vf|vff|vq|multi|truefrench|french|eng|vo)\b/gi;
const YEAR_RE = /\(((?:19|20)\d{2})\)|\b(((?:19|20)\d{2}))\b/;
const EP_PATTERNS: RegExp[] = [
  /\bS(\d{1,2})\s*E(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bSaison\s*(\d{1,2})\s*[-\s]*É?p(?:isode)?\s*(\d{1,3})\b/i,
  /\bSeason\s*(\d{1,2})\s*[-\s]*Ep(?:isode)?\s*(\d{1,3})\b/i,
  /\bÉ?p(?:isode)?\s*(\d{1,3})\b/i,
  /\bEP\.?\s*(\d{1,3})\b/i,
];

/**
 * Parse une caption / nom de fichier style release VOD.
 * Exemples supportés :
 * - Inception (2010) 1080p VF #film
 * - Breaking Bad S01E03 720p VOSTFR #serie
 * - Attack on Titan S02E01 #anime
 * - One Piece - 1095 1080p
 */
export function parseVodMetadata(
  rawTitle: string,
  fileName?: string
): VodMetadata {
  const source = [rawTitle, fileName].filter(Boolean).join(" \n ");
  const lower = source.toLowerCase();

  const qualities = unique(
    [...source.matchAll(QUALITY_RE)].map((m) => m[0].toUpperCase().replace(/BLU-?RAY/i, "BluRay"))
  );
  const languages = unique(
    [...source.matchAll(LANG_RE)].map((m) => m[0].toUpperCase())
  );

  let year: number | undefined;
  const yearMatch = source.match(YEAR_RE);
  if (yearMatch) {
    year = Number(yearMatch[1] || yearMatch[2]);
    if (!Number.isFinite(year)) year = undefined;
  }

  let season: number | undefined;
  let episode: number | undefined;

  for (const pattern of EP_PATTERNS) {
    const match = source.match(pattern);
    if (!match) continue;
    if (match[2] != null) {
      season = Number(match[1]);
      episode = Number(match[2]);
    } else if (match[1] != null) {
      episode = Number(match[1]);
      season = season ?? 1;
    }
    break;
  }

  // One Piece - 1095 / Episode number only in filename style "E1095"
  if (episode == null) {
    const looseEp = source.match(/(?:^|[\s\-_])(?:E|EP)?(\d{2,4})(?:\.|$|\s)/i);
    if (looseEp && /\b(one\s*piece|naruto|bleach|dbz|detective\s*conan)\b/i.test(source)) {
      episode = Number(looseEp[1]);
      season = 1;
    }
  }

  const taggedType = detectTaggedType(lower);
  const contentType: ContentType =
    taggedType ||
    (episode != null
      ? guessSeriesOrAnime(lower, languages)
      : "film");

  const showName = cleanShowName(rawTitle, {
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

export function showKey(normalizedShowName: string): string {
  // Hash court stable pour callback_data Telegram (<= 64 chars)
  let hash = 2166136261;
  for (let i = 0; i < normalizedShowName.length; i += 1) {
    hash ^= normalizedShowName.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function detectTaggedType(lower: string): ContentType | null {
  if (/(#|\b)(anime|animé|animation\s*japonaise)\b/.test(lower)) return "anime";
  if (/(#|\b)(serie|série|series|saison)\b/.test(lower)) return "serie";
  if (/(#|\b)(film|movie|cinema|cinéma)\b/.test(lower)) return "film";
  return null;
}

function guessSeriesOrAnime(lower: string, languages: string[]): ContentType {
  if (languages.some((l) => l === "VOSTFR" || l === "VO")) return "anime";
  if (/\b(anime|manga|shonen|shonen|ova|ona)\b/.test(lower)) return "anime";
  return "serie";
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

  name = name
    .replace(/#\w+/g, " ")
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, " ")
    .replace(/\b\d{1,2}x\d{1,3}\b/gi, " ")
    .replace(/\bSaison\s*\d{1,2}\b/gi, " ")
    .replace(/\bSeason\s*\d{1,2}\b/gi, " ")
    .replace(/\bÉ?p(?:isode)?\s*\d{1,3}\b/gi, " ")
    .replace(/\bEP\.?\s*\d{1,3}\b/gi, " ")
    .replace(/\((19|20)\d{2}\)/g, " ")
    .replace(QUALITY_RE, " ")
    .replace(LANG_RE, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s*[-–—|·•]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Enlever un numéro d'épisode collé à la fin : "One Piece - 1095"
  if (meta.episode != null) {
    name = name
      .replace(new RegExp(`(?:\\s*[-–—]?\\s*)0*${meta.episode}\\s*$`), "")
      .replace(/\s*[-–—|·•]+$/g, "")
      .trim();
  }

  return name || rawTitle.split("\n")[0]?.trim() || "Sans titre";
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
