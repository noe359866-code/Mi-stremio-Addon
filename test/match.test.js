'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  similarity,
  pickBestMatch,
  rankCandidates,
  parseSeasonEpisode,
  torrentSeasonEpisode,
  normalizeTitle
} = require('../lib/match');

test('similitud: título exacto y con subtítulo en español', () => {
  assert.strictEqual(similarity('Breaking Bad', 'Breaking Bad'), 1);
  assert.ok(similarity('The Avengers', 'Avengers: Los Vengadores') > 0.7);
  // Comparte "Avengers", pero debe puntuar menos que el título correcto
  assert.ok(similarity('The Avengers', 'Avengers: Los Vengadores') >
    similarity('The Avengers', 'Avengers: Infinity War'));
});

test('similitud: no confunde secuelas ni títulos que sólo comparten una palabra', () => {
  assert.ok(similarity('Avengers', 'Avengers: Age of Ultron') < 0.85);
  assert.ok(similarity('Dune', 'Dune: Part Two') < 0.85);
  assert.strictEqual(similarity('Breaking Bad', 'Better Call Saul'), 0);
});

test('títulos de una sola palabra que son stopword ("From") sí se comparan', () => {
  assert.strictEqual(normalizeTitle('From'), 'from');
  assert.strictEqual(similarity('From', 'From'), 1);
  assert.ok(similarity('From', 'From Dusk Till Dawn') < 0.5);
});

test('pickBestMatch: elige la película correcta por año entre secuelas', () => {
  const results = [
    { titulo: 'Avengers: Age of Ultron', tituloOriginal: 'Avengers: Age of Ultron', año: '2015', tipo: 'pelicula' },
    { titulo: 'Avengers: Infinity War', tituloOriginal: 'Avengers: Infinity War', año: '2018', tipo: 'pelicula' },
    { titulo: 'Avengers: Los Vengadores', tituloOriginal: 'The Avengers', año: '2012', tipo: 'pelicula' }
  ];
  const { best } = pickBestMatch(results, { title: 'The Avengers', year: '2012', type: 'movie' });
  assert.strictEqual(best.slug === undefined ? best.titulo : best.slug, 'Avengers: Los Vengadores');
});

test('pickBestMatch: NUNCA devuelve una serie para una película (y viceversa)', () => {
  const results = [
    { titulo: 'The Avengers', tituloOriginal: 'The Avengers', año: '1961', tipo: 'serie', slug: 'the-avengers-serie' },
    { titulo: 'Avengers: Los Vengadores', tituloOriginal: 'The Avengers', año: '2012', tipo: 'pelicula', slug: 'avengers-los-vengadores' }
  ];
  const movie = pickBestMatch(results, { title: 'The Avengers', year: '2012', type: 'movie' });
  assert.strictEqual(movie.best.slug, 'avengers-los-vengadores');

  const show = pickBestMatch(results, { title: 'The Avengers', year: '1961', type: 'series' });
  assert.strictEqual(show.best.slug, 'the-avengers-serie');
});

test('pickBestMatch: sin coincidencia segura devuelve null (no contenido ajeno)', () => {
  const results = [
    { titulo: 'Dune: Parte Dos', tituloOriginal: 'Dune: Part Two', año: '2024', tipo: 'pelicula', slug: 'dune-parte-dos' }
  ];
  const { best, reason } = pickBestMatch(results, { title: 'Dune', year: '2021', type: 'movie' });
  assert.strictEqual(best, null, `debería ser null (${reason})`);
});

test('pickBestMatch: acepta título traducido cuando el año coincide y es único', () => {
  const results = [
    { titulo: 'Spider-Man: Sin Camino A Casa', tituloOriginal: 'Spider-Man: No Way Home', año: '2021', tipo: 'pelicula', slug: 'spiderman-sin-camino-a-casa' }
  ];
  const { best } = pickBestMatch(results, { title: 'Spider-Man: No Way Home', year: '2021', type: 'movie' });
  assert.ok(best, 'debería emparejar por título original/año');
  assert.strictEqual(best.slug, 'spiderman-sin-camino-a-casa');
});

test('rankCandidates ordena y filtra por tipo', () => {
  const ranked = rankCandidates([
    { titulo: 'From', tipo: 'pelicula', año: '2020' },
    { titulo: 'From', tipo: 'serie', año: '2022' }
  ], { title: 'From', year: '2022', type: 'series' });
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].cand.tipo, 'serie');
});

test('parseSeasonEpisode reconoce formatos habituales', () => {
  assert.deepStrictEqual(
    { s: parseSeasonEpisode('Breaking.Bad.S05E14.1080p').season, e: parseSeasonEpisode('Breaking.Bad.S05E14.1080p').episode },
    { s: 5, e: 14 }
  );
  assert.deepStrictEqual(
    { s: parseSeasonEpisode('Naruto 1x03 [720p]').season, e: parseSeasonEpisode('Naruto 1x03 [720p]').episode },
    { s: 1, e: 3 }
  );
  assert.deepStrictEqual(
    { s: parseSeasonEpisode('Temporada 2 Episodio 7').season, e: parseSeasonEpisode('Temporada 2 Episodio 7').episode },
    { s: 2, e: 7 }
  );
  const pack = parseSeasonEpisode('From Temporada 2 Completa 1080p');
  assert.strictEqual(pack.isPack, true);
  assert.strictEqual(pack.episode, null);
});

test('torrentSeasonEpisode usa el nombre del magnet cuando faltan campos', () => {
  const se = torrentSeasonEpisode({ magnet: 'magnet:?xt=urn:btih:abc&dn=From.S02E05.1080p-Lat' });
  assert.deepStrictEqual({ season: se.season, episode: se.episode }, { season: 2, episode: 5 });
});

test('torrentSeasonEpisode no inventa packs', () => {
  const se = torrentSeasonEpisode({ temporada: 2, calidad: '1080p' });
  assert.strictEqual(se.episode, null);
  assert.strictEqual(se.isPack, false);
});
