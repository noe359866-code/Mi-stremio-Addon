/**
 * lib/match.js
 * ---------------------------------------------------------------------------
 * Utilidades de emparejamiento (matching) de títulos para el addon UniverTorrent.
 *
 * El objetivo de este módulo es evitar el bug clásico de "me da otra película":
 *   - Normaliza títulos (acentos, puntuación, etiquetas de release, stopwords).
 *   - Equivale palabras compuestas con/sin guión ("Spider-Man" ↔ "Spiderman")
 *     y numerales romanos/arábigos de secuelas ("Gladiator II" ↔ "Gladiator 2",
 *     "Part Two" ↔ "Part 2").
 *   - Puntúa resultados por similitud de título + título original + AÑO + TIPO.
 *   - Nunca cruza tipos: una película no puede resolverse contra una serie
 *     (ni al revés) y un anime sólo se empareja con anime/serie.
 *   - Devuelve `null` si no está seguro, para que el addon no entregue un
 *     torrent de contenido equivocado.
 *   - Parsea temporada/episodio (incluidos capítulos dobles S01E01E02 / 1x01-02
 *     y distinción entre packs de una temporada vs packs multitemporada S01-S05).
 * ---------------------------------------------------------------------------
 */

'use strict';

// Palabras que no aportan al título (artículos, preposiciones, conectores)
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'from',
  'with', 'by', 'is', 'as', 'vs', 'feat',
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'al', 'y', 'e', 'o', 'en', 'con', 'por', 'para', 'que',
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
  'latino', 'lat', 'castellano', 'espanol', 'spanish', 'english', 'ingles', 'dual', 'multi',
  'subtitulado', 'subtitulada', 'subtitulados', 'subs', 'sub', 'vose', 'audio',
  'mkv', 'mp4', 'avi', 'm4v',
  'completa', 'completo', 'complete', 'season', 'temporada', 'serie', 'series', 'anime',
  'episodio', 'episode', 'capitulo', 'cap', 'pack'
]);

const ROMAN_TO_ARABIC = {
  ii: '2',
  iii: '3',
  iv: '4',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  xi: '11',
  xii: '12',
  xiii: '13'
};

const WORD_NUM_TO_ARABIC = {
  one: '1', uno: '1', primera: '1', primero: '1',
  two: '2', dos: '2', segunda: '2', segundo: '2',
  three: '3', tres: '3', tercera: '3', tercero: '3',
  four: '4', cuatro: '4', cuarta: '4', cuarto: '4',
  five: '5', cinco: '5', quinta: '5', quinto: '5',
  six: '6', seis: '6',
  seven: '7', siete: '7',
  eight: '8', ocho: '8',
  nine: '9', nueve: '9',
  ten: '10', diez: '10'
};

const PART_MARKERS = new Set(['part', 'parte', 'chapter', 'capitulo', 'vol', 'volume', 'volumen']);

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
 * Canonicaliza numerales romanos y palabras numéricas tras "Part/Parte/Chapter"
 * para comparar títulos como "Gladiator II" ↔ "Gladiator 2" o "Part Two" ↔ "Part 2".
 */
function canonicalizeTokenList(tokList, otherSet = null) {
  if (tokList.length <= 1) return tokList;
  return tokList.map((tok, idx) => {
    if (idx > 0 && ROMAN_TO_ARABIC[tok]) return ROMAN_TO_ARABIC[tok];
    if (idx > 0 && tok === 'v' && otherSet && otherSet.has('5')) return '5';
    if (idx > 0 && tok === 'x' && otherSet && otherSet.has('10')) return '10';
    if (idx > 0 && WORD_NUM_TO_ARABIC[tok] && PART_MARKERS.has(tokList[idx - 1])) {
      return WORD_NUM_TO_ARABIC[tok];
    }
    return tok;
  });
}

/**
 * Colapsa pares adyacentes de tokens cuando coinciden con una palabra compuesta
 * en el otro título (ej. ["spider", "man"] ↔ ["spiderman"], ["x", "men"] ↔ ["xmen"]).
 */
function alignCompoundTokens(listA, targetSetB) {
  if (listA.length < 2 || targetSetB.size === 0) return listA;
  const out = [];
  for (let i = 0; i < listA.length; i++) {
    if (i + 1 < listA.length) {
      const joined = listA[i] + listA[i + 1];
      if (targetSetB.has(joined) && !targetSetB.has(listA[i]) && !targetSetB.has(listA[i + 1])) {
        out.push(joined);
        i++;
        continue;
      }
    }
    out.push(listA[i]);
  }
  return out;
}

function setSimilarity(A, B) {
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

/**
 * Similitud 0..1 entre dos títulos.
 * - Iguales (mismo conjunto de tokens) → 1
 * - Un título contenido en otro → 0.62..0.95 según cuánto se recorte
 * - Coincidencia parcial → hasta 0.9 según Jaccard
 */
function similarity(a, b) {
  const rawA = tokens(a);
  const rawB = tokens(b);
  if (rawA.length === 0 || rawB.length === 0) return 0;

  const direct = setSimilarity(new Set(rawA), new Set(rawB));
  if (direct === 1) return 1;

  const rawSetA = new Set(rawA);
  const rawSetB = new Set(rawB);
  const canonA = canonicalizeTokenList(rawA, rawSetB);
  const canonB = canonicalizeTokenList(rawB, rawSetA);
  const alignedA = alignCompoundTokens(canonA, new Set(canonB));
  const alignedB = alignCompoundTokens(canonB, new Set(alignedA));

  return Math.max(direct, setSimilarity(new Set(alignedA), new Set(alignedB)));
}

/** Extrae un año (19xx / 20xx) de un string o Date-like. */
function parseYear(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !isNaN(value)) return value.getFullYear();
  const m = String(value).match(/(?:^|[^0-9])((?:19|20)\d{2})(?=$|[^0-9])/);
  return m ? parseInt(m[1], 10) : null;
}

/** Normaliza el "tipo" de un resultado a movie / series / null */
function normalizeType(value) {
  if (!value) return null;
  const t = String(value).toLowerCase();
  if (['movie', 'movies', 'pelicula', 'peliculas', 'película', 'películas', 'film', 'films'].includes(t)) return 'movie';
  if (['series', 'serie', 'tv', 'show', 'shows', 'anime', 'animes', 'animeserie', 'miniserie'].includes(t)) return 'series';
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
  /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,4})(?:v\d+)?(?=$|[^0-9])/i,
  // 1x02
  /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,4})(?:v\d+)?(?=$|[^0-9])/i,
  // Temporada 1 Episodio 2 / T1 Ep2 / Temporada 1 Capitulo 2
  /temporada\s*(\d{1,2}).{0,24}?(?:episodio|cap[ií]tulo|ep\.?|cap\.?)\s*(\d{1,4})/i,
  /(?:^|[^a-z0-9])t(\d{1,2})[\s._-]*e(?:p)?(\d{1,4})(?=$|[^0-9])/i,
  // Episodio 5 de la Temporada 3
  /(?:episodio|cap[ií]tulo)\s*(\d{1,4}).{0,24}?temporada\s*(\d{1,2})/i
];

/**
 * Detecta si el texto describe un pack que abarca MÚLTIPLES temporadas distintas
 * (p. ej. "Season 1-5", "S01-S05", "S01-S02-S03", "Temporadas 1-4", "T1 T2", "Complete Series").
 */
function detectMultiSeasonPack(s) {
  // Rango explícito: Season 1-5 / Temporadas 1 a 4 / S01-S05 / S01-05 / T1-T4
  const rangePatterns = [
    /(?:seasons?|temporadas?|saisons?)\s*(\d{1,2})\s*(?:[-–~]|to|a|al|y|&)\s*(\d{1,2})(?=$|[^0-9])/i,
    /(?:^|[^a-z0-9])s(\d{1,2})\s*[-–~]\s*s?(\d{1,2})(?=$|[^a-z0-9])/i,
    /(?:^|[^a-z0-9])t(\d{1,2})\s*[-–~]\s*t?(\d{1,2})(?=$|[^a-z0-9])/i
  ];
  for (const re of rangePatterns) {
    const m = s.match(re);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a && b - a <= 30) {
        return true;
      }
    }
  }

  // Serie completa sin número de temporada única ("Complete Series", "Serie Completa")
  if (/\b(?:complete\s+series|serie\s+completa|todas\s+las\s+temporadas)\b/i.test(s)) {
    return true;
  }

  // Múltiples marcadores de temporada distintos (ej. "S01-S02-S03" o "T1 T2"),
  // respetando "S02 Season 2" o "S01.S01" donde el número es el MISMO.
  const distinctSeasons = new Set();
  for (const m of s.matchAll(/(?:^|[^a-z0-9])s(\d{1,2})(?=$|[^a-z0-9])/gi)) {
    // Ignorar si va seguido de E\d+ (episodio)
    const after = s.slice(m.index + m[0].length);
    if (/^[\s._-]*e\d/i.test(after)) continue;
    distinctSeasons.add(parseInt(m[1], 10));
  }
  for (const m of s.matchAll(/\b(?:season|temporada)\s*(\d{1,2})(?=$|[^0-9])/gi)) {
    distinctSeasons.add(parseInt(m[1], 10));
  }
  return distinctSeasons.size > 1;
}

/**
 * Parsea temporada/episodio desde un nombre de archivo o texto.
 * Incluye `episodes` cuando el archivo cubre varios capítulos (p. ej. `S01E01E02`, `S01E01-02`, `1x01x02`).
 * @returns {{season:number|null, episode:number|null, episodes:number[], isPack:boolean, isMultiSeasonPack?:boolean}}
 */
function parseSeasonEpisode(text) {
  const empty = { season: null, episode: null, episodes: [], isPack: false, isMultiSeasonPack: false };
  if (!text) return empty;
  const s = String(text);

  // 1) Multi-episodio S01E01E02 / S01E01-E02 / S01E01-02
  const multiSE = s.match(/(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})((?:[\s._-]*e\d{1,3})+)(?=$|[^0-9])/i);
  if (multiSE) {
    const season = parseInt(multiSE[1], 10);
    const firstEp = parseInt(multiSE[2], 10);
    const extraEps = [...multiSE[3].matchAll(/e(\d{1,3})/gi)].map(m => parseInt(m[1], 10));
    const episodes = [...new Set([firstEp, ...extraEps])].filter(Number.isFinite);
    return { season, episode: episodes[0] ?? null, episodes, isPack: false, isMultiSeasonPack: false };
  }

  const rangeSE = s.match(/(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})\s*[-–]\s*e?(\d{1,3})(?=$|[^0-9])/i);
  if (rangeSE) {
    const season = parseInt(rangeSE[1], 10);
    const startEp = parseInt(rangeSE[2], 10);
    const endEp = parseInt(rangeSE[3], 10);
    if (endEp > startEp && endEp - startEp <= 12) {
      const episodes = [];
      for (let ep = startEp; ep <= endEp; ep++) episodes.push(ep);
      return { season, episode: startEp, episodes, isPack: false, isMultiSeasonPack: false };
    }
  }

  // 2) Multi-episodio 1x01x02 / 1x01-02 / 1x01-1x02
  const multiX = s.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})((?:x\d{1,3})+)(?=$|[^0-9])/i);
  if (multiX) {
    const season = parseInt(multiX[1], 10);
    const firstEp = parseInt(multiX[2], 10);
    const extraEps = multiX[3].split(/x/i).filter(Boolean).map(n => parseInt(n, 10)).filter(Number.isFinite);
    const episodes = [...new Set([firstEp, ...extraEps])];
    return { season, episode: episodes[0] ?? null, episodes, isPack: false, isMultiSeasonPack: false };
  }

  const rangeX = s.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})\s*[-–]\s*(?:\1x)?(\d{1,3})(?=$|[^0-9])/i);
  if (rangeX) {
    const season = parseInt(rangeX[1], 10);
    const startEp = parseInt(rangeX[2], 10);
    const endEp = parseInt(rangeX[3], 10);
    if (endEp > startEp && endEp - startEp <= 12) {
      const episodes = [];
      for (let ep = startEp; ep <= endEp; ep++) episodes.push(ep);
      return { season, episode: startEp, episodes, isPack: false, isMultiSeasonPack: false };
    }
  }

  // 3) Episodio individual estándar
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
        return { season, episode, episodes: [episode], isPack: false, isMultiSeasonPack: false };
      }
    }
  }

  // 4) Pack multitemporada (ej. "Season 1-5", "S01-S05"): no atribuir en falso a la temporada 1
  if (detectMultiSeasonPack(s)) {
    return { season: null, episode: null, episodes: [], isPack: true, isMultiSeasonPack: true };
  }

  // 5) Sólo temporada (packs de 1 temporada: "Temporada 1 Completa", "S01 COMPLETE")
  const seasonOnly = s.match(/temporada[\s._-]*(\d{1,2})(?=$|[^0-9])/i) ||
    s.match(/(?:^|[^a-z0-9])s(?:eason|aison)?[\s._-]*(\d{1,2})(?=$|[^0-9])/i);
  const episodeOnly = s.match(/(?:episodio|cap[ií]tulo|cap)[\s._-]*(\d{1,4})(?=$|[^0-9])/i);
  const isPack = /complet[aoe]|complete|pack|temporada\s*completa|full\s*season/i.test(s);

  const epVal = episodeOnly ? parseInt(episodeOnly[1], 10) : null;
  return {
    season: seasonOnly ? parseInt(seasonOnly[1], 10) : null,
    episode: epVal,
    episodes: epVal !== null ? [epVal] : [],
    isPack: isPack || (!!seasonOnly && !episodeOnly),
    isMultiSeasonPack: false
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
    altTitles: Array.isArray(c.altTitles) ? c.altTitles : [],
    slug: c.slug || '',
    year: c.año || c.year || c.years || null,
    type: c.tipo || c.type || null,
    tmdbId: (c.tmdbId || c.tmdb_id) ? String(c.tmdbId || c.tmdb_id).trim() : null
  };
}

/**
 * Puntúa un candidato contra un objetivo.
 * @param {object} cand  Resultado del sitio (titulo/title, tipo/type, año/year, tmdbId/tmdb_id)
 * @param {object} target {title, originalTitle, altTitles, year, type, tmdbId}
 * @returns {{score:number, titleScore:number, yearDelta:number|null, tmdbMatch:boolean}}
 */
function scoreCandidate(cand, target) {
  const f = candidateFields(cand || {});
  const extraTitles = Array.isArray(target.altTitles) ? target.altTitles : [];
  const targetTitles = [target.title, target.originalTitle, ...extraTitles].filter(Boolean);
  const candTitles = [
    f.title,
    f.originalTitle,
    ...f.altTitles,
    String(f.slug || '').replace(/-/g, ' ')
  ].filter(Boolean);

  const targetTmdbId = (target.tmdbId || target.tmdb_id) ? String(target.tmdbId || target.tmdb_id).trim() : null;
  const tmdbMatch = Boolean(targetTmdbId && f.tmdbId && targetTmdbId === f.tmdbId);
  const tmdbConflict = Boolean(targetTmdbId && f.tmdbId && targetTmdbId !== f.tmdbId);

  let titleScore = 0;
  for (const ct of candTitles) {
    for (const tt of targetTitles) {
      titleScore = Math.max(titleScore, similarity(ct, tt));
    }
  }

  if (tmdbMatch) {
    titleScore = 1;
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

  if (tmdbConflict) {
    factor *= 0.25;
  }

  return { score: titleScore * factor, titleScore, yearDelta, tmdbMatch };
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
  if (!torrent) return { season: null, episode: null, episodes: [], isPack: false, isMultiSeasonPack: false };
  const directSeason = toIntOrNull(torrent.temporada ?? torrent.season ?? torrent.season_number);
  const directEpisode = toIntOrNull(torrent.episodio ?? torrent.episode ?? torrent.episode_number);
  const directEpisodes = Array.isArray(torrent.episodios)
    ? torrent.episodios.map(toIntOrNull).filter(v => v !== null)
    : (Array.isArray(torrent.episodes) ? torrent.episodes.map(toIntOrNull).filter(v => v !== null) : []);

  const fromName = parseSeasonEpisode(
    torrent.dn || torrent.name || torrent.filename || torrent.title || torrent.magnet || torrent.url || ''
  );

  if (directSeason !== null && directEpisode !== null) {
    const episodes = directEpisodes.length > 0
      ? [...new Set([directEpisode, ...directEpisodes])]
      : (fromName.season === directSeason && fromName.episodes.includes(directEpisode)
        ? fromName.episodes
        : [directEpisode]);
    return { season: directSeason, episode: directEpisode, episodes, isPack: false, isMultiSeasonPack: false };
  }

  const season = directSeason !== null ? directSeason : fromName.season;
  const episode = directEpisode !== null ? directEpisode : fromName.episode;
  const episodes = directEpisodes.length > 0
    ? directEpisodes
    : (episode !== null ? (fromName.episodes.length > 0 ? fromName.episodes : [episode]) : []);
  const isMultiSeasonPack = Boolean(fromName.isMultiSeasonPack && directSeason === null);

  return {
    season,
    episode,
    episodes,
    // Sólo es "pack" si el propio nombre o flag lo dice. Un episodio desconocido NO
    // se puede asumir pack: devolverlo sería entregar un capítulo equivocado.
    isPack: episode === null && (fromName.isPack === true || torrent.esPack === true || torrent.isPack === true),
    isMultiSeasonPack
  };
}

/**
 * Comprueba si un torrent corresponde al episodio pedido:
 *   - `'exact'`: coincide temporada y episodio (incluidos episodios dobles S01E01E02 / 1x01-02)
 *   - `'pack'`:  pack completo de ESA temporada (nunca un pack multitemporada S01-S05 sin temporada fija)
 *   - `null`:    no coincide
 */
function torrentMatchesEpisode(torrent, season, episode) {
  const s = toIntOrNull(season);
  const e = toIntOrNull(episode);
  if (s === null || e === null) return null;

  const se = torrentSeasonEpisode(torrent);
  if (se.season === s) {
    if (se.episode === e || (Array.isArray(se.episodes) && se.episodes.includes(e))) {
      return 'exact';
    }
    if (se.episode === null && se.isPack && !se.isMultiSeasonPack) {
      return 'pack';
    }
  }
  return null;
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
  torrentMatchesEpisode,
  DEFAULT_MIN_SCORE
};
