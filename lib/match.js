/**
 * lib/match.js
 * ---------------------------------------------------------------------------
 * Utilidades de emparejamiento (matching) de títulos para el addon HackTorrent.
 *
 * El objetivo de este módulo es evitar el bug clásico de "me da otra película":
 *   - Normaliza títulos (acentos, puntuación, etiquetas de release, stopwords).
 *   - Puntúa resultados por similitud de título + título original + AÑO + TIPO.
 *   - Nunca cruza tipos: una película no puede resolverse contra una serie
 *     (ni al revés) y un anime sólo se empareja con anime/serie.
 *   - Devuelve `null` si no está seguro, para que el addon no entregue un
 *     torrent de contenido equivocado.
 *   - Parsea temporada/episodio desde nombres de archivo tipo magnet (`dn`).
 * ---------------------------------------------------------------------------
 */

'use strict';

// Palabras que no aportan al título (artículos, preposiciones, conectores)
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'from',
  'with', 'by', 'is', 'as', 'vs', 'feat',
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'al', 'y', 'o', 'en', 'con', 'por', 'para', 'que',
  'le', 'les', 'des', 'du', 'et', 'von', 'der', 'die', 'das'
]); // "It", "You", "Up", "Her" NO son stopwords: son títulos reales.

// Etiquetas típicas de releases/torrents que nunca forman parte del título
const RELEASE_TOKENS = new Set([
  '1080p', '720p', '480p', '2160p', '4k', 'uhd', 'hdr', 'hdr10', 'sdr', 'dolby', 'vision',
  'web', 'webdl', 'webrip', 'web-dl', 'bluray', 'blu', 'ray', 'brrip', 'bdrip', 'dvdrip',
  'dvd', 'hdrip', 'hdtv', 'cam', 'camrip', 'ts', 'telesync', 'hc', 'hdcam',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'aac', 'ac3', 'eac3', 'dts', 'truehd',
  'atmos', '10bit', '8bit', 'hq', 'fullhd', 'microhd', 'bdremux', 'dl',
  'remux', 'proper', 'repack', 'extended', 'unrated', 'directors', 'director', 'cut',
  'latino', 'lat', 'castellano', 'espanol', 'spanish', 'english', 'ingles', 'dual',
  'subtitulado', 'subtitulada', 'subtitulados', 'subs', 'sub', 'audio',
  'mkv', 'mp4', 'avi', 'm4v',
  'completa', 'completo', 'complete', 'season', 'temporada', 'serie', 'series', 'anime',
  'episodio', 'episode', 'capitulo', 'cap', 'pack'
]);

function stripDiacritics(str) {
  return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normaliza un título para comparar: minúsculas, sin acentos, sin puntuación.
 * No elimina números de año (hay títulos como "1917").
 */
function normalizeTitle(input) {
  if (input === null || input === undefined) return '';
  let s = stripDiacritics(String(input).toLowerCase());
  s = s.replace(/&/g, ' y ');
  s = s.replace(/[’'`´]/g, '');
  s = s.replace(/[\[\]{}()]/g, ' ');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Tokens significativos de un título (sin stopwords ni etiquetas de release).
 */
function tokens(input) {
  const normalized = normalizeTitle(input);
  if (!normalized) return [];
  const all = normalized.split(' ').filter(Boolean);
  const meaningful = all.filter(
    t => !STOPWORDS.has(t) && !RELEASE_TOKENS.has(t) && !/^\d{3,4}i?p$/.test(t)
  );
  // Títulos de una sola palabra que además son stopword ("From", "The"...):
  // si no queda nada, usamos el título completo para no perder el match.
  return meaningful.length > 0 ? meaningful : all;
}

/**
 * Similitud 0..1 entre dos títulos.
 * - Iguales (mismo conjunto de tokens) → 1
 * - Un título contenido en otro → 0.62..0.95 según cuánto se recorte
 * - Coincidencia parcial → hasta 0.9 según Jaccard
 */
function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;

  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter === 0) return 0;

  const min = Math.min(A.size, B.size);
  const max = Math.max(A.size, B.size);
  const containment = inter / min;
  const jaccard = inter / (A.size + B.size - inter);

  if (A.size === B.size && containment === 1) return 1;
  if (containment === 1) return 0.62 + 0.33 * (min / max);
  return 0.25 + 0.65 * jaccard;
}

/** Extrae un año (19xx / 20xx) de un string o Date-like. */
function parseYear(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !isNaN(value)) return value.getFullYear();
  const m = String(value).match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
}

/** Normaliza el "tipo" de un resultado a movie / series / null */
function normalizeType(value) {
  if (!value) return null;
  const t = String(value).toLowerCase();
  if (['movie', 'movies', 'pelicula', 'peliculas', 'film', 'films'].includes(t)) return 'movie';
  if (['series', 'serie', 'tv', 'show', 'shows', 'anime', 'animes', 'animeserie'].includes(t)) return 'series';
  return null;
}

/**
 * Tipos de Stremio aceptados para un tipo de resultado del sitio.
 * Se usa para filtrar candidatos: nunca devolver una película para una serie.
 */
function typeCompatible(targetType, candType) {
  if (!targetType) return true;
  const t = normalizeType(targetType);
  const c = normalizeType(candType);
  if (!c) return true; // el sitio no informó el tipo: no podemos descartarlo aquí
  if (!t) return true;
  return t === c;
}

const SEASON_EPISODE_RE = [
  // S01E02 / S01.E02 / S01 E02 / s01e02v2
  /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,4})(?=$|[^0-9])/i,
  // 1x02
  /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,4})(?=$|[^0-9])/i,
  // Temporada 1 Episodio 2 / T1 Ep2 / Temporada 1 Capitulo 2
  /temporada\s*(\d{1,2}).{0,20}?(?:episodio|cap[ií]tulo)\s*(\d{1,4})/i,
  /t(\d{1,2})[\s._-]*e(?:p)?(\d{1,4})(?=$|[^0-9])/i,
  // Episodio 5 de la Temporada 3
  /(?:episodio|cap[ií]tulo)\s*(\d{1,4}).{0,20}?temporada\s*(\d{1,2})/i
];

/**
 * Parsea temporada/episodio desde un nombre de archivo o texto.
 * @returns {{season:number|null, episode:number|null, isPack:boolean}}
 */
function parseSeasonEpisode(text) {
  const empty = { season: null, episode: null, isPack: false };
  if (!text) return empty;
  const s = String(text);

  for (let i = 0; i < SEASON_EPISODE_RE.length; i++) {
    const m = s.match(SEASON_EPISODE_RE[i]);
    if (m) {
      let season = parseInt(m[1], 10);
      let episode = parseInt(m[2], 10);
      // La última regex invierte el orden (episodio ... temporada)
      if (i === SEASON_EPISODE_RE.length - 1) {
        const tmp = season;
        season = episode;
        episode = tmp;
      }
      if (Number.isFinite(season) && Number.isFinite(episode)) {
        return { season, episode, isPack: false };
      }
    }
  }

  // Sólo temporada (packs: "Temporada 1 Completa", "S01 COMPLETE")
  const seasonOnly = s.match(/temporada[\s._-]*(\d{1,2})/i) ||
    s.match(/(?:^|[^a-z0-9])s(?:eason|aison)?[\s._-]*(\d{1,2})(?=$|[^0-9])/i);
  const episodeOnly = s.match(/(?:episodio|cap[ií]tulo|cap)[\s._-]*(\d{1,4})/i);
  const isPack = /complet[aoe]|complete|pack|temporada\s*completa/i.test(s);

  return {
    season: seasonOnly ? parseInt(seasonOnly[1], 10) : null,
    episode: episodeOnly ? parseInt(episodeOnly[1], 10) : null,
    isPack: isPack || (!!seasonOnly && !episodeOnly)
  };
}

function toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/** Campos comunes de un resultado, venga de wpreact, react, HTML o caché. */
function candidateFields(c) {
  return {
    title: c.titulo || c.title || c.name || '',
    originalTitle: c.tituloOriginal || c.original_title || c.originalTitle || '',
    slug: c.slug || '',
    year: c.año || c.year || c.years || null,
    type: c.tipo || c.type || null
  };
}

/**
 * Puntúa un candidato contra un objetivo.
 * @param {object} cand  Resultado del sitio (titulo/title, tipo/type, año/year)
 * @param {object} target {title, originalTitle, year, type}
 * @returns {{score:number, titleScore:number, yearDelta:number|null}}
 */
function scoreCandidate(cand, target) {
  const f = candidateFields(cand || {});
  const targetTitles = [target.title, target.originalTitle].filter(Boolean);
  const candTitles = [f.title, f.originalTitle, String(f.slug || '').replace(/-/g, ' ')].filter(Boolean);

  let titleScore = 0;
  for (const ct of candTitles) {
    for (const tt of targetTitles) {
      titleScore = Math.max(titleScore, similarity(ct, tt));
    }
  }

  // Los títulos del sitio suelen ser largos ("Avengers: Los Vengadores"): si el
  // título buscado aparece completo como subcadena normalizada del candidato,
  // damos un pequeño empujón (evita perder matches por subtítulos añadidos).
  if (titleScore < 0.95) {
    for (const ct of candTitles) {
      const normCand = ' ' + normalizeTitle(ct) + ' ';
      for (const tt of targetTitles) {
        const normTarget = normalizeTitle(tt);
        if (normTarget && normTarget.length >= 4 && normCand.includes(' ' + normTarget + ' ')) {
          const lenTarget = normTarget.split(' ').length;
          const lenCand = normCand.trim().split(' ').length;
          titleScore = Math.max(titleScore, 0.65 + 0.3 * (lenTarget / Math.max(lenCand, lenTarget)));
        }
      }
    }
  }

  const targetYear = parseYear(target.year);
  const candYear = parseYear(f.year);
  let factor = 1;
  let yearDelta = null;
  if (targetYear && candYear) {
    yearDelta = Math.abs(targetYear - candYear);
    factor = yearDelta === 0 ? 1 : yearDelta === 1 ? 0.85 : yearDelta === 2 ? 0.4 : 0.1;
  } else if (targetYear && !candYear) {
    factor = 0.92; // año desconocido en el sitio: pequeña penalización
  }

  return { score: titleScore * factor, titleScore, yearDelta };
}

/**
 * Filtra y ordena candidatos por compatibilidad de tipo + puntuación.
 * @returns {Array<{cand:object, score:number, titleScore:number, yearDelta:number|null}>}
 */
function rankCandidates(results, target = {}) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const ranked = [];
  for (const cand of results) {
    const f = candidateFields(cand);
    if (target.type && !typeCompatible(target.type, f.type)) continue;
    const s = scoreCandidate(cand, target);
    ranked.push({ cand, ...s });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

const DEFAULT_MIN_SCORE = 0.6;

/**
 * Devuelve el mejor candidato seguro, o null si no hay coincidencia confiable.
 *
 * Regla extra para títulos en otro idioma: si la similitud de título es baja
 * (0.45..0.6) pero el AÑO coincide exactamente y sólo hay UN candidato de ese
 * tipo que lo hace, se acepta (el sitio traduce los títulos).
 *
 * @param {Array} results
 * @param {object} target {title, originalTitle, year, type, minScore}
 * @param {object} [options] {minScore}
 */
function pickBestMatch(results, target = {}, options = {}) {
  const minScore = options.minScore ?? target.minScore ?? DEFAULT_MIN_SCORE;
  const ranked = rankCandidates(results, target);
  if (ranked.length === 0) return { best: null, ranked: [], reason: 'sin candidatos del tipo correcto' };

  const top = ranked[0];
  if (top.score >= minScore) {
    return { best: top.cand, match: top, ranked, reason: 'score' };
  }

  // Regla de desempate por año exacto y unicidad (títulos traducidos)
  const targetYear = parseYear(target.year);
  if (targetYear) {
    const exactYear = ranked.filter(r => r.yearDelta === 0 && r.titleScore >= 0.45);
    if (exactYear.length === 1 && exactYear[0].score >= minScore * 0.75) {
      return { best: exactYear[0].cand, match: exactYear[0], ranked, reason: 'year-unique' };
    }
    if (exactYear.length > 1) {
      return { best: null, match: null, ranked, reason: 'ambiguo (varios con el mismo año)' };
    }
  }

  return { best: null, match: null, ranked, reason: `score insuficiente (${top.score.toFixed(2)} < ${minScore})` };
}

/** Checks de episodio/pack. */
function torrentSeasonEpisode(torrent) {
  if (!torrent) return { season: null, episode: null, isPack: false };
  const directSeason = toIntOrNull(torrent.temporada ?? torrent.season ?? torrent.season_number);
  const directEpisode = toIntOrNull(torrent.episodio ?? torrent.episode ?? torrent.episode_number);
  if (directSeason !== null && directEpisode !== null) {
    return { season: directSeason, episode: directEpisode, isPack: false };
  }
  const fromName = parseSeasonEpisode(
    torrent.dn || torrent.name || torrent.filename || torrent.title || torrent.magnet || torrent.url || ''
  );
  const season = directSeason !== null ? directSeason : fromName.season;
  const episode = directEpisode !== null ? directEpisode : fromName.episode;
  return {
    season,
    episode,
    // Sólo es "pack" si el propio nombre lo dice. Un episodio desconocido NO
    // se puede asumir pack: devolverlo sería entregar un capítulo equivocado.
    isPack: episode === null && (fromName.isPack === true || torrent.esPack === true || torrent.isPack === true)
  };
}

module.exports = {
  STOPWORDS,
  RELEASE_TOKENS,
  normalizeTitle,
  tokens,
  similarity,
  parseYear,
  normalizeType,
  typeCompatible,
  parseSeasonEpisode,
  scoreCandidate,
  rankCandidates,
  pickBestMatch,
  torrentSeasonEpisode,
  DEFAULT_MIN_SCORE
};
