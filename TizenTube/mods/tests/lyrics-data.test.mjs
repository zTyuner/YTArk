import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lyricsQueries, parseLrc, pickLrclibResult, songFromLrclib, parseLetrasSearch,
  letrasSongUrl, letrasTranslationUrl, letrasLyricLines, letrasVersePairs,
  alignTranslations, detectLanguage, activeLineIndex, modeLanguage, modeShowsOriginal,
  normalize, decodeEntities, nonMusicRanges, songTime, nonMusicLength,
} from '../features/lyricsData.js';

test('video titles become artist/track guesses without video noise', () => {
  assert.deepEqual(lyricsQueries('Coldplay - Yellow (Official Video)', 'Coldplay')[0],
    { artist: 'Coldplay', track: 'Yellow' });
  assert.deepEqual(lyricsQueries('Luis Fonsi - Despacito ft. Daddy Yankee', 'LuisFonsiVEVO')[0],
    { artist: 'Luis Fonsi', track: 'Despacito' });
  assert.deepEqual(lyricsQueries('Yellow', 'Coldplay - Topic')[0], { artist: 'Coldplay', track: 'Yellow' });
  assert.deepEqual(lyricsQueries('Legião Urbana - Tempo Perdido [Clipe Oficial]', 'Legião Urbana Oficial')[0],
    { artist: 'Legião Urbana', track: 'Tempo Perdido' });
  const duo = lyricsQueries('Henrique e Juliano - Liberdade Provisória (Ao Vivo)', 'Henrique e Juliano');
  assert.deepEqual(duo[0], { artist: 'Henrique e Juliano', track: 'Liberdade Provisória' });
  assert.ok(duo.some(q => q.artist === '' && q.track.includes('Liberdade Provisória')));
});

test('LRC text becomes sorted timed lines, including repeated timestamps', () => {
  const lines = parseLrc('[ar:X]\n[00:35.66]Look at the stars\n[01:02.00][00:10.5]Chorus\n[00:40.36]\n');
  assert.deepEqual(lines, [
    { t: 10.5, text: 'Chorus' },
    { t: 35.66, text: 'Look at the stars' },
    { t: 40.36, text: '' },
    { t: 62, text: 'Chorus' },
  ]);
  assert.equal(activeLineIndex(lines, 5), -1);
  assert.equal(activeLineIndex(lines, 36), 1);
  assert.equal(activeLineIndex(lines, 100), 3);
});

test('LRCLIB picks timed lyrics closest to the video length and keeps clean names', () => {
  const results = [
    { trackName: 'Yellow', artistName: 'Coldplay', duration: 400, syncedLyrics: '[00:01.00]a' },
    { trackName: 'Yellow', artistName: 'Coldplay', duration: 270, syncedLyrics: '[00:01.00]b' },
    { trackName: 'Yellow', artistName: 'Coldplay', duration: 269, plainLyrics: 'c' },
  ];
  const query = { artist: 'Coldplay', track: 'Yellow' };
  const best = pickLrclibResult(results, query, 269);
  assert.equal(best.syncedLyrics, '[00:01.00]b');
  const unknownLength = { trackName: 'Yellow', artistName: 'Coldplay', duration: null, syncedLyrics: '[00:01.00]d' };
  assert.equal(pickLrclibResult([unknownLength, ...results], query, 269).syncedLyrics, '[00:01.00]b');
  const song = songFromLrclib({ ...best, trackName: 'Yellow [Parachutes, 2000]' }, query);
  assert.equal(song.track, 'Yellow');
  assert.equal(song.synced, true);
  assert.equal(pickLrclibResult([{ trackName: 'Other', plainLyrics: 'x' }], { artist: '', track: 'Coldplay Yellow' }, 0), null);
});

test('Letras search answers (JSONP or JSON) resolve to song and translation URLs', () => {
  const body = 'LetrasSug({"response":{"docs":[{"t":"1","dns":"coldplay","txt":"Coldplay"},'
    + '{"t":"2","dns":"coldplay","url":8091,"txt":"Yellow"}]}})';
  const match = parseLetrasSearch(body, 'Yellow');
  assert.deepEqual(match, { dns: 'coldplay', slug: '8091' });
  assert.equal(letrasSongUrl(match), 'https://www.letras.mus.br/coldplay/8091/');
  assert.equal(letrasTranslationUrl(match, 'pt'), 'https://www.letras.mus.br/coldplay/8091/traducao.html');
  assert.equal(letrasTranslationUrl(match, 'en'), 'https://www.letras.com/coldplay/8091/english.html');
  assert.equal(parseLetrasSearch('{"response":{"docs":[{"t":"2","dns":"x","url":"y","txt":"Other"}]}}', 'Yellow'), null);
  assert.equal(parseLetrasSearch('{"response":{"docs":[{"t":"2","dns":"../x","url":"y","txt":"Yellow"}]}}', 'Yellow'), null);
});

test('Letras pages: original lines and verse pairs in server and browser markup', () => {
  const song = '<div class="lyric-original"><p>Estátuas e cofres<br>Ningu&#233;m sabe</p><p>Dorme agora</p></div><div>x</div>';
  assert.deepEqual(letrasLyricLines(song), ['Estátuas e cofres', 'Ninguém sabe', 'Dorme agora']);
  const server = '<div class="lyric-translation g-fix"><h3>Devagarinho</h3><p>'
    + '<span class = "verse"><span>Ai!</span><span class = "romanization">&#161;Ay!</span></span><br/>'
    + '<span class = "verse"><span>Me mostre o caminho</span><span class = "romanization">Muéstrame el camino</span></span></p></div>';
  assert.deepEqual(letrasVersePairs(server), [
    { original: '¡Ay!', translation: 'Ai!' },
    { original: 'Muéstrame el camino', translation: 'Me mostre o caminho' },
  ]);
  const browser = '<span class="verse"><span>Olhe para as estrelas</span><span class="romanization">Look at the stars</span></span>';
  assert.deepEqual(letrasVersePairs(browser), [{ original: 'Look at the stars', translation: 'Olhe para as estrelas' }]);
});

test('translations align to timed lines across ad-libs and joined verses', () => {
  const pairs = [
    { original: 'Your skin, oh yeah, your skin and bones', translation: 'Sua pele e ossos' },
    { original: 'Sabes que tu corazón conmigo', translation: 'Você sabe que seu coração comigo' },
    { original: 'Te hace bang-bang', translation: 'Faz tum-tum' },
  ];
  const lines = [
    { t: 1, text: '(Ah) Your skin, oh, yeah, your skin and bones' },
    { t: 2, text: 'Sabes que tu corazón conmigo te hace bang-bang' },
    { t: 3, text: '¡Oye!' },
    { t: 4, text: '' },
  ];
  assert.deepEqual(alignTranslations(lines, pairs), [
    'Sua pele e ossos',
    'Você sabe que seu coração comigo Faz tum-tum',
    '',
    '',
  ]);
});

test('modes, language detection and text helpers', () => {
  assert.equal(modeLanguage('original+pt'), 'pt');
  assert.equal(modeLanguage('en'), 'en');
  assert.equal(modeLanguage('original'), null);
  assert.equal(modeShowsOriginal('pt'), false);
  assert.equal(modeShowsOriginal('original+en'), true);
  const pt = Array.from({ length: 6 }, () => ({ text: 'Eu sei que você não está aqui comigo' }));
  const en = Array.from({ length: 6 }, () => ({ text: 'I know that you and me are in the dark' }));
  assert.equal(detectLanguage(pt), 'pt');
  assert.equal(detectLanguage(en), 'en');
  assert.equal(detectLanguage([{ text: 'la la la' }]), null);
  assert.equal(normalize('Ação, Já!'), 'acaoja');
  assert.equal(decodeEntities('&amp;&#xe9;&hellip;'), '&é…');
});

test('SponsorBlock non-music sections shift video time onto the song timeline', () => {
  const ranges = nonMusicRanges([
    { category: 'music_offtopic', segment: [0, 22] },
    { category: 'sponsor', segment: [30, 40] },
    { category: 'music_offtopic', segment: [120, 130] },
    { category: 'music_offtopic', segment: [125, 140] },
    { category: 'music_offtopic', segment: [50, 50] },
  ]);
  assert.deepEqual(ranges, [[0, 22], [120, 140]]);
  assert.equal(nonMusicLength(ranges), 42);
  assert.equal(songTime(10, ranges), null);
  assert.equal(songTime(22, ranges), 0);
  assert.equal(songTime(60, ranges), 38);
  assert.equal(songTime(130, ranges), null);
  assert.equal(songTime(150, ranges), 108);
  assert.equal(songTime(15, []), 15);
  // A short silence at the start belongs to the released track: keep it.
  assert.deepEqual(nonMusicRanges([{ category: 'music_offtopic', segment: [0, 2.1] }]), []);
  assert.deepEqual(nonMusicRanges([
    { category: 'music_offtopic', segment: [0, 2.1] },
    { category: 'music_offtopic', segment: [90, 95] },
  ]), [[90, 95]]);
});
