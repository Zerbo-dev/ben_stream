import { normalizeTitle } from "./text.js";
import type { ContentType, VodMetadata } from "./types.js";

const QUALITY_RE =
  /\b(2160p|1080p|720p|480p|360p|4k|8k|web-?dl|web-?rip|web|blu-?ray|hdr|x265|hevc|x264|xvid)\b/gi;
const LANG_RE =
  /\b(vostfr|vost|vfq|vff|vf|vq|multi|truefrench|french|eng(?:lish)?|vo)\b/gi;
const YEAR_RE = /\(((?:19|20)\d{2})\)|\b(((?:19|20)\d{2}))\b/;
const RELEASE_JUNK_RE =
  /\b(final|proper|repack|extended|unrated|limited|internal|dubbed|subbed|sub|dub|aac|ac3|dts|hdtv|pdtv|dvdrip|bdrip|brrip|nf|amzn|dsnp|extre+me|zt)\b/gi;
const EXT_RE = /\b(mkv|mp4|avi|mov|wmv|m4v|ts|m2ts)\b/gi;

/**
 * Formats Telegram / scene réels observés dans le catalogue BenStream :
 * - S01E12 / S01 EP12 / S01EP12
 * - [S02 - E03] / [S01-E12] / [S01E04]
 * - Saison 1 Ep 22
 * - Tokyo_Revengers_S02_EP10_VF_@AnimeGinga_...
 * - [@NetflixFilmSeriesBox].La.Casa.De.Papel.S01E09.FRENCH.WEB-DL.XviD-ZT.avi
 */
const EP_PATTERNS: RegExp[] = [
  /\[S(\d{1,2})\s*[-–—.]?\s*E(?:P)?\.?\s*(\d{1,3})\]/i,
  /\bS(\d{1,2})\s*[-–—.]?\s*E(?:P)?\.?\s*(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bSaison\s*(\d{1,2})\s*[-–—:]?\s*É?p(?:isode)?\.?\s*(\d{1,3})\b/i,
  /\bSeason\s*(\d{1,2})\s*[-–—:]?\s*Ep(?:isode)?\.?\s*(\d{1,3})\b/i,
  /\bÉ?p(?:isode)?\.?\s*(\d{1,3})\b/i,
  /\bEP\.?\s*(\d{1,3})\b/i,
];

export function parseVodMetadata(
  rawTitle: string,
  fileName?: string
): VodMetadata {
  const fullCaption = rawTitle || "";
  const fileLine = fileName || "";
  const originalBlob = [fullCaption, fileLine].filter(Boolean).join(" \n ");
  const animeSignal = looksLikeAnime(originalBlob.toLowerCase(), originalBlob);

  // Underscores / dots style release → espaces (KO Telegram filenames)
  const normalizedSource = normalizeReleaseText(originalBlob);
  const captionLine =
    normalizeReleaseText(
      fullCaption.split("\n").map((l) => l.trim()).find(Boolean) || fileLine
    ) || "Sans titre";

  const lower = normalizedSource.toLowerCase();

  const qualities = unique(
    [...normalizedSource.matchAll(QUALITY_RE)].map((m) =>
      m[0].toUpperCase().replace(/BLU-?RAY/i, "BluRay").replace(/WEB-?DL/i, "WEB-DL").replace(/WEB-?RIP/i, "WEBRip")
    )
  );
  const languages = unique(
    [...normalizedSource.matchAll(LANG_RE)].map((m) => normalizeLang(m[0]))
  );

  let year: number | undefined;
  const yearMatch = normalizedSource.match(YEAR_RE);
  if (yearMatch) {
    year = Number(yearMatch[1] || yearMatch[2]);
    if (!Number.isFinite(year)) year = undefined;
  }

  const ep = extractSeasonEpisode(normalizedSource);
  let season = ep.season;
  let episode = ep.episode;

  if (episode == null) {
    const looseEp = normalizedSource.match(
      /(?:^|[\s\-_])(?:E|EP)?(\d{2,4})(?:\.|$|\s)/i
    );
    if (
      looseEp &&
      /\b(one\s*piece|naruto|bleach|dbz|detective\s*conan)\b/i.test(
        normalizedSource
      )
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
    contentType = animeSignal ? "anime" : "serie";
  } else if (/\b(oav|ova|ona|special|sp)\b/i.test(normalizedSource) || animeSignal) {
    contentType = "anime";
  } else {
    contentType = "film";
  }

  // Alias titres connus (même œuvre, noms différents)
  let showName = cleanShowName(captionLine, {
    year,
    season,
    episode,
    qualities,
    languages,
  });
  // Les synonymes bilingues + fuzzy matching se font au groupement / upsert
  // (voir show-match.ts) — pas un if unique ici.

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

/** Transforme les noms type scene/Telegram en texte parsable. */
export function normalizeReleaseText(input: string): string {
  return (
    input
      .replace(/https?:\/\/t\.me\/\S+/gi, " ")
      .replace(/\bt\.me\/\S+/gi, " ")
      // IMPORTANT : retirer les @handles AVANT de transformer les _ en espaces
      .replace(/@[A-Za-z0-9_]{3,}/g, " ")
      .replace(/([A-Za-z0-9])@/g, "$1 ")
      // EP12VF / S01E02FRENCH collés
      .replace(/\b(EP\.?\s*\d{1,3})(VF|VOSTFR?|FRENCH|VO)\b/gi, "$1 $2")
      .replace(/\b(S\d{1,2}E\d{1,3})(VF|VOSTFR?|FRENCH|VO)\b/gi, "$1 $2")
      .replace(/[._]+/g, " ")
      .replace(/[\[\]{}【】]/g, " ")
      .replace(/™/g, " ")
      .replace(/➡️/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
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
  if (/\b(anime|manga|shonen|shoujo|ova|oav|ona|seinen)\b/.test(lower)) {
    return true;
  }
  if (/@[^\s]*(anime|otaku|manga|crunchyroll)/i.test(source)) return true;
  if (/animeginga|otaku_sekai|crunchyroll|a_n_i_m_e/i.test(source)) return true;
  return false;
}

function normalizeLang(raw: string): string {
  const v = raw.toUpperCase();
  if (v === "VOST") return "VOSTFR";
  if (v === "ENGLISH") return "ENG";
  if (v === "FRENCH") return "VF";
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
  let name = normalizeReleaseText(rawTitle.split("\n")[0] || rawTitle);

  name = stripChannelNoise(name);

  name = name
    .replace(/#\w+/g, " ")
    .replace(/\[?\bS\d{1,2}\s*[-–—.]?\s*E(?:P)?\.?\s*\d{1,3}\b\]?/gi, " ")
    .replace(/\b\d{1,2}x\d{1,3}\b/gi, " ")
    .replace(/\bSaison\s*\d{1,2}\b/gi, " ")
    .replace(/\bSeason\s*\d{1,2}\b/gi, " ")
    .replace(/\bÉ?p(?:isode)?\.?\s*\d{1,3}\b/gi, " ")
    .replace(/\bEP\.?\s*\d{1,3}\b/gi, " ")
    .replace(/\bS\d{1,2}\b/gi, " ")
    .replace(/\((19|20)\d{2}\)/g, " ")
    .replace(QUALITY_RE, " ")
    .replace(LANG_RE, " ")
    .replace(RELEASE_JUNK_RE, " ")
    .replace(EXT_RE, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\bFIN\b/gi, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    // Team / scene after dash at end: -ZT -EXTREME
    .replace(/\s[-–—]\s*[A-Z0-9]{1,15}\s*$/g, " ")
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
  name = name.replace(/\s*[:|-]\s*$/g, "").trim();

  return name || "Sans titre";
}

function stripChannelNoise(input: string): string {
  let name = input;

  name = name
    .replace(/https?:\/\/t\.me\/\S+/gi, " ")
    .replace(/\bt\.me\/\+\S+/gi, " ")
    .replace(/\bt\.me\/\S+/gi, " ")
    .replace(/@[A-Za-z0-9_]{3,}/g, " ")
    .replace(/【[^】]*】/g, " ");

  // Préfixe canal type NetflixFilmSeriesBox / CrunchyrollFlashVF / A N I M E VF
  name = name.replace(
    /^(netflixfilmseriesbox|netflixboxfr|crunchyrollflashvf|cine(?:\s*galaxy)?|a(?:\s*n){3,}(?:\s*i)?(?:\s*m)?(?:\s*e)?(?:\s*vf)?)\s+/i,
    ""
  );
  name = name.replace(/^\s*a\s+n\s+i\s+m\s+e(?:\s+vf)?\s+/i, "");
  name = name.replace(/\b(?:cine\s*)?galaxy\b/gi, " ");
  name = name.replace(/\bsekailiste\b/gi, " ");
  name = name.replace(/\bfr\b$/i, " ");

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
      /^\s*([A-Za-z0-9_]{3,28})\s*[-–—]\s+(?=[A-Za-zÀ-ÿ0-9])/u,
      (full, maybeChannel: string) =>
        looksLikeChannelToken(maybeChannel) ? "" : full
    )
    .replace(
      /\s*[-–—]\s*([A-Za-z0-9_]{3,28})\s*$/u,
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
  if (/\bS\d{1,2}\s*E(?:P)?\.?\s*\d{1,3}\b/i.test(part)) score += 15;
  if (/\(\d{4}\)/.test(part)) score += 10;
  return score;
}

function looksLikeChannelToken(token: string): boolean {
  const t = token.trim();
  if (!t) return true;
  if (/^@/.test(t)) return true;
  if (
    /^(benstream|benflix|animebox|animeginga|cine[_\s-]?galaxy|netflixfilmseriesbox|netflixboxfr|crunchyrollflashvf|stream|movies?|films?|series?|serie|tv|vod|zone|hub|premium|gratuit|free|extreme|zt)$/i.test(
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

  // Langue utile ; qualité scene souvent bruit → on garde si 720p/1080p/4K seulement
  if (meta.qualities[0] && /\d{3,4}P|4K|8K|HDR/i.test(meta.qualities[0])) {
    bits.push(meta.qualities[0]);
  }
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
