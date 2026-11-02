// YTArk lyrics captions.
//
// Shows a song's lyrics as synced captions, for music videos that have no
// subtitles. Timed lyrics come from LRCLIB; translations are the community
// translations published on Letras.mus.br (Portuguese) and letras.com
// (English), read through the APK's loopback-only Letras reader because the
// YouTube TV page cannot read those sites directly (CORS). Google Translate is
// only used when the user turns on machine translation.
//
// Entry points: a "Song lyrics" section added to the captions popups, the
// Subtitles page of YTArk Settings, and the optional automatic mode.

import { configRead, configWrite, configChangeEmitter } from '../config.js';
import { showToast } from '../ui/ytUI.js';
import { tx } from '../translations/text.js';
import {
  LYRICS_MODES, modeLanguage, modeShowsOriginal, lyricsQueries, pickLrclibResult,
  songFromLrclib, parseLetrasSearch, letrasSongUrl, letrasTranslationUrl,
  letrasLyricLines, letrasVersePairs, alignTranslations, detectLanguage,
  activeLineIndex, plainLines,
} from './lyricsData.js';

export const LETRAS_READER = 'http://127.0.0.1:38917';
export const LYRICS_ACTION = 'YTARK_LYRICS';
const REQUEST_TIMEOUT_MS = 12000;
const TICK_MS = 200;

const state = {
  active: false,
  mode: 'original+pt',
  videoId: '',
  song: null,
  letras: undefined,
  translations: {},
  generation: 0,
  lineIndex: -2,
  offset: 0,
  timer: null,
  autoCheckedId: '',
  cache: new Map(),
};

function log(...args) {
  console.warn('[YTArk lyrics]', ...args);
}

function toast(text) {
  try { showToast(tx('ytark.lyrics.title', 'Song lyrics'), text); } catch (_) { /* optional */ }
}

function currentMode() {
  const mode = configRead('lyricsMode');
  return LYRICS_MODES.indexOf(mode) >= 0 ? mode : 'original+pt';
}

export function modeTitle(mode) {
  switch (mode) {
    case 'pt': return tx('ytark.lyrics.modePt', 'Lyrics in Portuguese');
    case 'en': return tx('ytark.lyrics.modeEn', 'Lyrics in English');
    case 'original+pt': return tx('ytark.lyrics.modeOriginalPt', 'Original + Portuguese');
    case 'original+en': return tx('ytark.lyrics.modeOriginalEn', 'Original + English');
    default: return tx('ytark.lyrics.modeOriginal', 'Original lyrics');
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (controller) controller.abort();
          reject(new Error('timeout'));
        }, REQUEST_TIMEOUT_MS);
      });
      const response = await Promise.race([
        fetch(url, controller ? { signal: controller.signal } : {}),
        timeout,
      ]);
      // LRCLIB answers 503 "busy, retry in a moment" under load.
      if ((response.status === 429 || response.status === 503) && attempt < retries) {
        await delay(1500);
        continue;
      }
      if (!response.ok) {
        log('request failed', response.status, url.split('?')[0]);
        return null;
      }
      return await Promise.race([response.text(), timeout]);
    } catch (error) {
      log('request error', url.split('?')[0], error && error.message);
      if (attempt >= retries) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function getJson(url) {
  const text = await getText(url);
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function query(params) {
  return Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
}

function letrasPage(url) {
  if (!url) return Promise.resolve(null);
  return getText(`${LETRAS_READER}/letras?u=${encodeURIComponent(url)}`, 0);
}

async function letrasFind(artist, track) {
  const body = await getText(`https://solr.sscdn.co/letras/m1/?${query({
    q: `${artist || ''} ${track || ''}`.trim(), wt: 'json',
  })}`);
  return body ? parseLetrasSearch(body, track) : null;
}

async function machineTranslate(texts, target) {
  const output = [];
  let chunk = [];
  let length = 0;
  const chunks = [];
  for (const text of texts) {
    if (chunk.length && length + text.length > 1500) {
      chunks.push(chunk);
      chunk = [];
      length = 0;
    }
    chunk.push(text);
    length += text.length + 1;
  }
  if (chunk.length) chunks.push(chunk);
  for (const part of chunks) {
    const root = await getJson(`https://translate.googleapis.com/translate_a/single?${query({
      client: 'gtx', sl: 'auto', tl: target, dt: 't', q: part.join('\n'),
    })}`);
    const segments = Array.isArray(root) && Array.isArray(root[0]) ? root[0] : [];
    const joined = segments.map(segment => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '')).join('');
    const pieces = joined.split('\n').map(piece => piece.trim());
    while (pieces.length > part.length && !pieces[pieces.length - 1]) pieces.pop();
    const aligned = joined && pieces.length === part.length;
    part.forEach((_, index) => output.push(aligned ? pieces[index] : ''));
  }
  return output;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

function playerElement() {
  return document.querySelector('.html5-video-player');
}

function videoData() {
  try {
    const player = playerElement();
    return player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
  } catch (_) {
    return null;
  }
}

function videoElement() {
  return document.querySelector('video');
}

function onWatchPage() {
  return /\/watch/.test(location.hash || '');
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

async function findSong(data, generation) {
  const video = videoElement();
  const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
  const queries = lyricsQueries(data.title, data.author);
  log('queries', JSON.stringify(queries));
  for (const item of queries) {
    const params = item.artist ? { track_name: item.track, artist_name: item.artist } : { q: item.track };
    const results = await getJson(`https://lrclib.net/api/search?${query(params)}`);
    if (generation !== state.generation) return null;
    const song = songFromLrclib(pickLrclibResult(results, item, duration), item);
    if (song) {
      log('LRCLIB', song.artist, '-', song.track, 'synced', song.synced, 'lines', song.lines.length);
      return song;
    }
  }
  // Letras.mus.br has more Brazilian songs but no timing.
  for (const item of queries.slice(0, 3)) {
    const match = await letrasFind(item.artist, item.track);
    if (generation !== state.generation) return null;
    if (!match) continue;
    const lines = letrasLyricLines(await letrasPage(letrasSongUrl(match)));
    if (generation !== state.generation) return null;
    if (lines.length) {
      log('Letras', letrasSongUrl(match), 'lines', lines.length);
      return {
        artist: item.artist, track: item.track, lines: plainLines(lines.join('\n')),
        synced: false, source: 'Letras.mus.br', letras: match,
      };
    }
  }
  return null;
}

async function ensureTranslation(language, generation) {
  const song = state.song;
  if (!language || !song || state.translations[language] !== undefined) return;
  if (detectLanguage(song.lines) === language) {
    state.translations[language] = 'same';
    return;
  }
  if (state.letras === undefined) {
    state.letras = song.letras || await letrasFind(song.artist, song.track) || null;
    if (generation !== state.generation) return;
  }
  let aligned = song.lines.map(() => '');
  if (state.letras) {
    const pairs = letrasVersePairs(await letrasPage(letrasTranslationUrl(state.letras, language)));
    if (generation !== state.generation) return;
    log('Letras', language, 'verses', pairs.length);
    if (pairs.length) aligned = alignTranslations(song.lines, pairs);
  }
  if (configRead('lyricsMachineTranslation')) {
    const missing = [];
    song.lines.forEach((line, index) => {
      if (line.text && !aligned[index] && missing.indexOf(line.text) < 0) missing.push(line.text);
    });
    if (missing.length) {
      const translated = await machineTranslate(missing, language);
      if (generation !== state.generation) return;
      song.lines.forEach((line, index) => {
        const position = missing.indexOf(line.text);
        if (!aligned[index] && position >= 0 && translated[position]) aligned[index] = translated[position];
      });
    }
  }
  // An empty list means no translation was published for this song.
  state.translations[language] = aligned.some(Boolean) ? aligned : [];
}

function remember() {
  if (!state.videoId || !state.song) return;
  if (state.cache.size > 30) state.cache.delete(state.cache.keys().next().value);
  state.cache.set(state.videoId, {
    song: state.song, letras: state.letras, translations: { ...state.translations },
  });
}

function songLabel() {
  const song = state.song;
  if (!song) return '';
  return song.artist ? `${song.artist} — ${song.track}` : song.track;
}

async function applyMode(userInitiated, generation) {
  const language = modeLanguage(state.mode);
  if (language && state.translations[language] === undefined && userInitiated) {
    toast(tx('ytark.lyrics.findingTranslation', 'Finding translation…'));
  }
  await ensureTranslation(language, generation);
  if (generation !== state.generation || !state.active) return;
  remember();
  state.lineIndex = -2;
  const translations = language ? state.translations[language] : null;
  if (!state.song.synced) {
    if (userInitiated) toast(tx('ytark.lyrics.untimed', 'These lyrics have no timing, so they cannot be shown as captions.'));
  } else if (userInitiated && Array.isArray(translations) && translations.length === 0) {
    toast(tx('ytark.lyrics.noTranslation', 'Letras has no translation for this song — showing the original'));
  } else if (userInitiated) {
    toast(`${tx('ytark.lyrics.on', 'Lyrics on')} (${modeTitle(state.mode)}) · ${songLabel()}`);
  }
  tick();
}

async function load(videoId, data, userInitiated) {
  const generation = ++state.generation;
  state.videoId = videoId;
  state.song = null;
  state.letras = undefined;
  state.translations = {};
  state.offset = 0;
  state.lineIndex = -2;
  render('', '');
  const cached = state.cache.get(videoId);
  let song = cached ? cached.song : null;
  if (!song) {
    if (userInitiated) toast(tx('ytark.lyrics.searching', 'Searching lyrics…'));
    song = data && data.title ? await findSong(data, generation) : null;
    if (generation !== state.generation) return;
  }
  if (!song) {
    log('no lyrics for', videoId);
    if (userInitiated) toast(tx('ytark.lyrics.notFound', 'No lyrics found for this video'));
    return;
  }
  if (cached) {
    state.letras = cached.letras;
    Object.assign(state.translations, cached.translations);
  }
  state.song = song;
  await applyMode(userInitiated, generation);
}

// ---------------------------------------------------------------------------
// Captions view
// ---------------------------------------------------------------------------

let overlay = null;
let primaryLine = null;
let secondaryLine = null;

function ensureOverlay() {
  if (overlay && overlay.parentNode) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'ytark-lyrics';
  const style = overlay.style;
  style.position = 'fixed';
  style.left = '50%';
  style.bottom = '11vh';
  style.transform = 'translateX(-50%)';
  style.maxWidth = '84vw';
  style.padding = '0.8vh 2vw';
  style.borderRadius = '1vh';
  style.background = 'rgba(0, 0, 0, 0.62)';
  style.textAlign = 'center';
  style.zIndex = '2147483000';
  style.pointerEvents = 'none';
  style.display = 'none';
  style.fontFamily = 'Roboto, Arial, sans-serif';
  primaryLine = document.createElement('div');
  primaryLine.style.color = '#ffffff';
  primaryLine.style.fontSize = '4.4vh';
  primaryLine.style.fontWeight = '600';
  primaryLine.style.lineHeight = '1.25';
  primaryLine.style.textShadow = '0 0.2vh 0.4vh rgba(0,0,0,0.8)';
  secondaryLine = document.createElement('div');
  secondaryLine.style.color = '#ffd659';
  secondaryLine.style.fontSize = '3.6vh';
  secondaryLine.style.fontWeight = '500';
  secondaryLine.style.lineHeight = '1.25';
  secondaryLine.style.marginTop = '0.4vh';
  secondaryLine.style.textShadow = '0 0.2vh 0.4vh rgba(0,0,0,0.8)';
  overlay.appendChild(primaryLine);
  overlay.appendChild(secondaryLine);
  document.body.appendChild(overlay);
  return overlay;
}

function render(primary, secondary) {
  if (!primary) {
    if (overlay) overlay.style.display = 'none';
    return;
  }
  ensureOverlay();
  primaryLine.textContent = primary;
  secondaryLine.textContent = secondary || '';
  secondaryLine.style.display = secondary ? 'block' : 'none';
  overlay.style.display = 'block';
}

function translationAt(index) {
  const language = modeLanguage(state.mode);
  const list = language ? state.translations[language] : null;
  if (!Array.isArray(list) || !list[index]) return '';
  const original = state.song.lines[index].text;
  return list[index].trim().toLowerCase() === original.trim().toLowerCase() ? '' : list[index];
}

function tick() {
  if (!state.active) return;
  const data = videoData();
  const id = data && data.video_id;
  if (id && id !== state.videoId) {
    // Next video in a playlist or queue: look up its lyrics too.
    load(id, data, false);
    return;
  }
  const song = state.song;
  if (!song || !song.synced || !onWatchPage()) {
    render('', '');
    state.lineIndex = -2;
    return;
  }
  const video = videoElement();
  const index = activeLineIndex(song.lines, (video ? video.currentTime : 0) + state.offset);
  if (index === state.lineIndex) return;
  state.lineIndex = index;
  const original = index >= 0 ? song.lines[index].text : '';
  if (!original) {
    render('', '');
    return;
  }
  const translation = translationAt(index);
  if (modeShowsOriginal(state.mode)) render(original, translation);
  else render(translation || original, '');
}

function startTimer() {
  if (state.timer !== null) return;
  state.timer = setInterval(tick, TICK_MS);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function startLyrics(mode, userInitiated = true) {
  if (!configRead('enableLyricsCaptions')) return;
  const data = videoData();
  const id = data && data.video_id;
  if (!id) {
    if (userInitiated) toast(tx('ytark.lyrics.noVideo', 'Open a video first'));
    return;
  }
  const nextMode = LYRICS_MODES.indexOf(mode) >= 0 ? mode : currentMode();
  if (userInitiated && nextMode !== configRead('lyricsMode')) configWrite('lyricsMode', nextMode);
  state.mode = nextMode;
  const sameSong = state.active && state.song && state.videoId === id;
  state.active = true;
  startTimer();
  if (sameSong) {
    applyMode(userInitiated, state.generation);
  } else {
    load(id, data, userInitiated);
  }
}

export function stopLyrics() {
  state.active = false;
  state.generation += 1;
  state.song = null;
  state.videoId = '';
  if (state.timer !== null) clearInterval(state.timer);
  state.timer = null;
  render('', '');
}

export function lyricsActive() {
  return state.active;
}

/** Custom action YTARK_LYRICS: {mode} starts, {off: true} stops, {offset} shifts timing. */
export function handleLyricsAction(parameters) {
  const p = parameters || {};
  if (p.off) {
    stopLyrics();
    toast(tx('ytark.lyrics.off', 'Lyrics off'));
  } else if (typeof p.offset === 'number') {
    state.offset += p.offset;
    state.lineIndex = -2;
    toast(`${tx('ytark.lyrics.sync', 'Lyrics timing')}: ${state.offset > 0 ? '+' : ''}${state.offset.toFixed(1)}s`);
  } else {
    startLyrics(p.mode, true);
  }
  return true;
}

function popupItem(title, parameters, selected) {
  return {
    compactLinkRenderer: {
      // This popup style does not draw radio icons, so mark the active mode.
      title: { simpleText: selected ? `✓ ${title}` : title },
      secondaryIcon: { iconType: selected ? 'RADIO_BUTTON_CHECKED' : 'RADIO_BUTTON_UNCHECKED' },
      serviceEndpoint: {
        commandExecutorCommand: {
          commands: [
            { signalAction: { signal: 'POPUP_BACK' } },
            { customAction: { action: LYRICS_ACTION, parameters } },
          ],
        },
      },
    },
  };
}

function popupItems(cmd) {
  try {
    return cmd.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer
      .actionPanel.overlayPanelRenderer.content.overlayPanelItemListRenderer.items;
  } catch (_) {
    return null;
  }
}

/**
 * Adds a "Song lyrics" section to the top of a captions popup (the language
 * list next to "Auto-generated" and the auto-translate list).
 */
export function addLyricsToCaptionsPopup(cmd) {
  const uniqueId = cmd && cmd.openPopupAction && cmd.openPopupAction.uniqueId;
  if (typeof uniqueId !== 'string' || uniqueId.indexOf('CAPTION') < 0) return false;
  log('captions popup', uniqueId);
  if (!configRead('enableLyricsCaptions')) return false;
  const items = popupItems(cmd);
  const heading = tx('ytark.lyrics.section', 'Song lyrics (Letras.mus.br)');
  if (!Array.isArray(items) || items.some(item => item && item.overlayMessageRenderer
      && item.overlayMessageRenderer.subtitle && item.overlayMessageRenderer.subtitle.simpleText === heading)) {
    return false;
  }
  const section = [{
    overlayMessageRenderer: {
      title: { simpleText: '' },
      subtitle: { simpleText: heading },
      style: 'OVERLAY_MESSAGE_STYLE_SUBSECTION_TITLE',
    },
  }];
  const showing = state.active && state.song && state.song.synced;
  for (const mode of LYRICS_MODES) {
    section.push(popupItem(modeTitle(mode), { mode }, state.active && state.mode === mode));
  }
  if (showing) {
    section.push(popupItem(tx('ytark.lyrics.earlier', 'Lyrics earlier (−0.5s)'), { offset: 0.5 }, false));
    section.push(popupItem(tx('ytark.lyrics.later', 'Lyrics later (+0.5s)'), { offset: -0.5 }, false));
  }
  if (state.active) section.push(popupItem(tx('ytark.lyrics.turnOff', 'Turn off lyrics'), { off: true }, false));
  items.unshift(...section);
  return true;
}

// ---------------------------------------------------------------------------
// Automatic mode and settings
// ---------------------------------------------------------------------------

function autoWatch() {
  if (state.active || !configRead('enableLyricsCaptions') || !configRead('lyricsAutoShow')) return;
  if (!onWatchPage()) return;
  const data = videoData();
  const id = data && data.video_id;
  if (!id || id === state.autoCheckedId) return;
  state.autoCheckedId = id;
  startLyrics(currentMode(), false);
}

configChangeEmitter.addEventListener('configChange', (event) => {
  const key = event.detail && event.detail.key;
  if (key === 'enableLyricsCaptions' && !event.detail.value) stopLyrics();
  if (key === 'lyricsMode' && state.active && state.mode !== currentMode()) {
    state.mode = currentMode();
    applyMode(false, state.generation);
  }
  if (key === 'lyricsMachineTranslation') state.translations = {};
});

const autoTimer = setInterval(autoWatch, 1500);
// Host tests import this module; never keep their process alive.
if (autoTimer && typeof autoTimer.unref === 'function') autoTimer.unref();
log('module loaded');
