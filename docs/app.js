// Songs Together – Frontend
// Ablauf: Spotify-Login (PKCE) → Raum betreten → Web Playback SDK spielt im Browser,
// der Server gibt Song + Position vor, jeder Client korrigiert seine Abweichung laufend.

import { CLIENT_ID } from './config.js';
import { Net } from './net.js';

const $ = (s) => document.querySelector(s);
const SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
// Basis-Adresse der Seite (lokal: http://127.0.0.1:3000/, GitHub Pages: https://<name>.github.io/songs-together/)
const BASE = new URL('.', location.href).href;
const REDIRECT_URI = BASE;

// Sync-Parameter
const SYNC_INTERVAL_MS = 1000;   // wie oft die eigene Position geprüft wird
const DRIFT_THRESHOLD_MS = 180;  // ab dieser Abweichung wird nachjustiert
const SEEK_COOLDOWN_MS = 1200;

let me = null;          // Spotify-Profil
let room = null;        // letzter Raumzustand vom Server
let roomId = null;
let net = null;
let player = null;
let deviceId = null;
let volume = clampNum(Number(localStorage.getItem('volume') ?? 60), 0, 100);
let muted = false;

// ============================================================ Helpers

function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(text, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3500);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
  $('#view-' + view).classList.remove('hidden');
  $('#gear-float').classList.toggle('hidden', view === 'room');
}

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

function newRoomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = [...bytes].map((b) => chars[b % chars.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function setFill(range) {
  const pct = ((range.value - range.min) / (range.max - range.min)) * 100;
  range.style.setProperty('--fill', pct + '%');
}

// ============================================================ Auth (Authorization Code + PKCE)

const tokens = {
  get() { try { return JSON.parse(localStorage.getItem('sp_tokens')); } catch { return null; } },
  set(t) { localStorage.setItem('sp_tokens', JSON.stringify(t)); },
  clear() { localStorage.removeItem('sp_tokens'); },
};

async function login() {
  const verifier = randomString(64);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const state = randomString(16);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_state', state);
  if (!sessionStorage.getItem('returnTo')) sessionStorage.setItem('returnTo', location.search);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

async function handleCallback() {
  const p = new URLSearchParams(location.search);
  const returnTo = sessionStorage.getItem('returnTo') || '';
  sessionStorage.removeItem('returnTo');
  history.replaceState(null, '', BASE + returnTo);
  if (p.get('error')) throw new Error('Anmeldung abgebrochen: ' + p.get('error'));
  if (p.get('state') !== sessionStorage.getItem('pkce_state')) throw new Error('Ungültiger Login-Status, bitte erneut versuchen.');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.get('code'),
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: sessionStorage.getItem('pkce_verifier') || '',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Token-Fehler: ' + (data.error_description || data.error));
  saveTokenResponse(data);
}

function saveTokenResponse(data) {
  const old = tokens.get() || {};
  tokens.set({
    access_token: data.access_token,
    refresh_token: data.refresh_token || old.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
}

let refreshing = null;
async function getToken(forceRefresh = false) {
  const t = tokens.get();
  if (!t) throw new Error('Nicht angemeldet');
  if (!forceRefresh && t.expires_at - Date.now() > 60_000) return t.access_token;
  refreshing ??= (async () => {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT_ID }),
    });
    const data = await res.json();
    if (!res.ok) { tokens.clear(); throw new Error('Sitzung abgelaufen, bitte neu anmelden.'); }
    saveTokenResponse(data);
    return data.access_token;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function logout() {
  tokens.clear();
  location.href = BASE;
}

// ============================================================ Spotify Web API

async function api(path, { method = 'GET', body } = {}, retry = true) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + (await getToken()),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) { await getToken(true); return api(path, { method, body }, false); }
  if (res.status === 429 && retry) {
    await sleep((Number(res.headers.get('Retry-After')) || 1) * 1000);
    return api(path, { method, body }, false);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Spotify-Fehler ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function pickImage(images) {
  if (!images?.length) return '';
  // Bilder sind absteigend nach Größe sortiert → mittlere Größe (~300px) nehmen
  return (images[1] || images[0]).url;
}

function mapTrack(t, albumFallback) {
  if (!t || t.is_local || !t.uri?.startsWith('spotify:track:')) return null;
  const album = t.album || albumFallback;
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: album?.name || '',
    image: pickImage(album?.images),
    durationMs: t.duration_ms,
  };
}

const LINK_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?|spotify:)(track|album|playlist)[/:]([A-Za-z0-9]{22})/g;
const MAX_RESOLVE = 300;

function parseLinks(text) {
  return [...String(text || '').matchAll(LINK_RE)].map((m) => ({ type: m[1], id: m[2] }));
}

async function collectPaged(firstPath, pick, out) {
  let next = firstPath;
  while (next && out.length < MAX_RESOLVE) {
    const page = await api(next);
    for (const item of page.items || []) {
      const tr = pick(item);
      if (tr) out.push(tr);
    }
    next = page.next;
  }
}

async function resolveLinks(links) {
  const out = [];
  for (let i = 0; i < links.length && out.length < MAX_RESOLVE; i++) {
    const { type, id } = links[i];
    if (type === 'track') {
      // aufeinanderfolgende Einzeltracks parallel (in 5er-Blöcken) laden
      const block = [];
      while (i < links.length && links[i].type === 'track' && block.length < 5) block.push(links[i++].id);
      i--;
      const results = await Promise.all(block.map((tid) => api(`/tracks/${tid}`).catch(() => null)));
      for (const t of results) { const m = mapTrack(t); if (m) out.push(m); }
    } else if (type === 'album') {
      const album = await api(`/albums/${id}`);
      for (const t of album.tracks?.items || []) { const m = mapTrack(t, album); if (m) out.push(m); }
      if (album.tracks?.next) await collectPaged(album.tracks.next, (t) => mapTrack(t, album), out);
    } else if (type === 'playlist') {
      const pick = (it) => mapTrack(it.item || it.track);
      try {
        await collectPaged(`/playlists/${id}/items?limit=50`, pick, out);
      } catch (e) {
        if (e.status !== 404 && e.status !== 403) throw e;
        await collectPaged(`/playlists/${id}/tracks?limit=50`, pick, out);
      }
    }
  }
  return out.slice(0, MAX_RESOLVE);
}

async function addFromText(text, { next = false } = {}) {
  const links = parseLinks(text);
  if (!links.length) { toast('Kein Spotify-Song-, Album- oder Playlist-Link erkannt.', true); return; }
  try {
    if (links.length > 1 || links[0].type !== 'track') toast('Songs werden geladen…');
    const tracks = await resolveLinks(links);
    if (!tracks.length) { toast('Keine abspielbaren Songs gefunden.', true); return; }
    send({ type: 'add', tracks, next });
  } catch (e) {
    toast('Konnte nicht hinzufügen: ' + e.message, true);
  }
}

// ============================================================ Verbindung + Uhrzeit-Sync

const serverNow = () => (net ? net.serverNow() : Date.now());

function send(msg) { net?.send(msg); }

function connect(isNew) {
  net = new Net({
    roomId,
    isNew,
    user: { name: me.display_name || me.id, image: me.images?.[0]?.url || '' },
    onMessage: (msg) => {
      if (msg.type === 'state') onState(msg);
      else if (msg.type === 'event') toast(msg.text);
      else if (msg.type === 'error') toast(msg.text, true);
    },
    onStatus: (level, text) => setStatus(level, text),
    onRole: (isHost) => $('#host-badge').classList.toggle('hidden', !isHost),
  });
  net.start();
}

window.addEventListener('pagehide', () => net?.stop());

function onState(s) {
  const prevSync = room?.syncId;
  room = s;
  renderRoom();
  if (s.syncId !== prevSync) runSync(true); // Seek/Skip/Play/Pause → sofort umsetzen
}

function expectedPos() {
  if (!room?.current) return 0;
  const pos = room.playing ? room.positionMs + (serverNow() - room.refTime) : room.positionMs;
  return clampNum(pos, 0, room.current.durationMs);
}

// ============================================================ Player + Synchronisation

let sdkReady = null;
function loadSdk() {
  sdkReady ??= new Promise((resolve) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    document.head.append(s);
  });
  return sdkReady;
}

function createPlayer() {
  player = new window.Spotify.Player({
    name: 'Songs Together',
    getOAuthToken: (cb) => getToken().then(cb).catch(() => {}),
    volume: volume / 100,
  });
  // Muss direkt im Klick-Handler passieren, sonst blockiert der Browser das Audio
  player.activateElement?.();

  player.addListener('ready', async ({ device_id }) => {
    deviceId = device_id;
    try { await api('/me/player', { method: 'PUT', body: { device_ids: [device_id], play: false } }); } catch { /* egal */ }
    runSync(true);
  });
  player.addListener('not_ready', () => { deviceId = null; setStatus('bad', 'Player offline'); });
  player.addListener('player_state_changed', (st) => {
    if (!st && sync.wasActive) {
      sync.detached = true;
      showPlayerError('Die Wiedergabe wurde auf ein anderes Gerät übertragen. Drücke Play, um hier weiterzuhören.');
    }
    if (st) sync.wasActive = true;
  });
  player.addListener('autoplay_failed', () => toast('Der Browser hat Autoplay blockiert – klicke einmal auf Play.', true));
  player.addListener('initialization_error', ({ message }) => showPlayerError('Player konnte nicht starten: ' + message));
  player.addListener('authentication_error', ({ message }) => showPlayerError('Anmeldefehler: ' + message));
  player.addListener('account_error', () => showPlayerError('Für die Wiedergabe im Browser brauchst du Spotify Premium.'));
  player.addListener('playback_error', ({ message }) => console.warn('playback_error', message));
  player.connect();
}

function showPlayerError(text) {
  const el = $('#player-error');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

const sync = {
  busy: false, again: false, againForce: false,
  lastSeekAt: 0, strikes: 0,
  lead: clampNum(Number(localStorage.getItem('seekLead') ?? 0), -200, 1500), // Ausgleich für Seek-Latenz
  measure: null,       // { syncId } – nach einem Seek die Latenz nachmessen
  loading: null, loadingAt: 0, justLoaded: false,
  wasActive: false, detached: false,
  lastDrift: null,
};

async function runSync(force = false) {
  if (sync.busy) { sync.again = true; sync.againForce ||= force; return; }
  sync.busy = true;
  try {
    await doSync(force);
  } catch (e) {
    console.warn('sync', e);
    if (e.status === 404) deviceId && setStatus('warn', 'Gerät wird gesucht…');
  } finally {
    sync.busy = false;
    if (sync.again) {
      const f = sync.againForce;
      sync.again = false; sync.againForce = false;
      runSync(f);
    }
  }
}

async function doSync(force) {
  if (!room) return;
  if (!player || !deviceId) { setStatus('warn', 'Player startet…'); return; }
  if (sync.detached) { setStatus('warn', 'Auf anderem Gerät'); return; }

  const cur = room.current;
  const st = await player.getCurrentState();

  if (!cur) {
    if (st && !st.paused) await player.pause();
    setStatus('ok', 'Bereit');
    return;
  }

  const lt = st?.track_window?.current_track;
  const matches = lt && [lt.uri, lt.id, lt.linked_from?.uri, lt.linked_from?.id].some((x) => x && (x === cur.uri || x === cur.id));

  // Falscher (oder kein) Song geladen → richtigen Song an der richtigen Stelle starten
  if (!matches) {
    const key = cur.uid + ':' + room.syncId;
    if (sync.loading === key && Date.now() - sync.loadingAt < 4000) return;
    sync.loading = key; sync.loadingAt = Date.now();
    setStatus('warn', 'Lade Song…');
    await api(`/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      body: { uris: [cur.uri], position_ms: Math.round(expectedPos()) },
    });
    sync.justLoaded = true;
    setTimeout(() => runSync(false), 600);
    return;
  }
  sync.loading = null;
  if (sync.justLoaded) { force = true; sync.justLoaded = false; }

  // Kurz vor Songende nicht mehr eingreifen – der Server schaltet gleich weiter
  if (room.playing && expectedPos() > cur.durationMs - 1500) { setStatus('ok', 'Synchron'); return; }

  if (room.playing && st.paused) {
    await player.resume();
    setTimeout(() => runSync(true), 400);
    return;
  }
  if (!room.playing && !st.paused) await player.pause();

  const expected = expectedPos();
  const drift = st.position - expected; // positiv = wir sind voraus
  sync.lastDrift = drift;

  if (!room.playing) {
    if (Math.abs(drift) > 300) await player.seek(Math.round(expected));
    setStatus('ok', 'Pausiert');
    return;
  }

  // Nach einem Seek: tatsächliche Verzögerung messen und künftigen Vorlauf anpassen
  if (sync.measure && Date.now() - sync.lastSeekAt > 700) {
    if (sync.measure.syncId === room.syncId && Math.abs(drift) < 1500) {
      sync.lead = clampNum(sync.lead - drift * 0.6, -200, 1500);
      localStorage.setItem('seekLead', String(Math.round(sync.lead)));
    }
    sync.measure = null;
  }

  if (Math.abs(drift) > DRIFT_THRESHOLD_MS) {
    sync.strikes++;
    const cooldownOver = Date.now() - sync.lastSeekAt > SEEK_COOLDOWN_MS;
    // Einzelne Ausreißer ignorieren: erst bei 2 Messungen in Folge (oder großer Abweichung) korrigieren
    if (force || (cooldownOver && (sync.strikes >= 2 || Math.abs(drift) > 1500))) {
      const target = clampNum(expected + sync.lead, 0, cur.durationMs - 500);
      await player.seek(Math.round(target));
      sync.lastSeekAt = Date.now();
      sync.measure = { syncId: room.syncId };
      sync.strikes = 0;
      setTimeout(() => runSync(false), 900);
    }
    setStatus('warn', `Gleiche ab… (${Math.round(drift)} ms)`);
  } else {
    sync.strikes = 0;
    setStatus('ok', `Synchron (±${Math.abs(Math.round(drift))} ms)`);
  }
}

setInterval(() => { if (roomId) runSync(false); }, SYNC_INTERVAL_MS);

function setStatus(level, text) {
  const dot = $('#sync-dot');
  dot.className = 'dot ' + level;
  $('#sync-text').textContent = text;
  dot.title = net?.rtt != null ? `Ping zum Host: ${net.rtt} ms · Seek-Ausgleich: ${Math.round(sync.lead)} ms` : '';
}

// ============================================================ Rendering

function trackRow(t, { index, queue } = {}) {
  const li = document.createElement('li');
  li.className = 'track';
  li.draggable = true;
  li.dataset.uid = t.uid || '';
  li.innerHTML = `
    ${queue ? `<span class="idx">${index + 1}</span>` : ''}
    <img src="${esc(t.image)}" alt="" loading="lazy" draggable="false">
    <div class="meta">
      <div class="t" title="${esc(t.name)}">${esc(t.name)}</div>
      <div class="a">${esc(t.artists)}${queue && t.addedBy ? ` · von ${esc(t.addedBy)}` : ''}</div>
    </div>
    <div class="actions">
      ${queue
        ? `<button data-act="playNow" title="Jetzt abspielen">▶</button>
           <button data-act="top" title="Als Nächstes">⤒</button>
           <button data-act="remove" title="Entfernen">✕</button>`
        : `<button data-act="next" title="Als Nächstes abspielen">⤒</button>
           <button data-act="add" title="Zur Warteschlange hinzufügen">＋</button>`}
    </div>`;
  return li;
}

function renderRoom() {
  if (!room) return;
  const cur = room.current;

  $('#np-title').textContent = cur ? cur.name : 'Nichts läuft';
  $('#np-artist').textContent = cur ? cur.artists : 'Füge Songs zur Warteschlange hinzu';
  $('#np-added').textContent = cur?.addedBy ? `hinzugefügt von ${cur.addedBy}` : '';
  $('#np-cover').src = cur?.image || '';
  $('#np-cover').classList.toggle('hidden', !cur?.image);
  $('#np-empty').classList.toggle('hidden', Boolean(cur?.image));
  $('#ic-play').classList.toggle('hidden', room.playing);
  $('#ic-pause').classList.toggle('hidden', !room.playing);
  document.title = cur ? `${cur.name} · Songs Together` : 'Songs Together';

  const list = $('#queue');
  list.replaceChildren(...room.queue.map((t, i) => trackRow(t, { index: i, queue: true })));
  $('#queue-empty').classList.toggle('hidden', room.queue.length > 0);
  $('#queue-count').textContent = room.queue.length ? `(${room.queue.length})` : '';

  $('#users').replaceChildren(...room.users.map((u) => {
    const a = document.createElement('div');
    a.className = 'avatar';
    a.title = u.name;
    if (u.image) a.style.backgroundImage = `url("${u.image.replace(/"/g, '')}")`;
    else a.textContent = (u.name || '?').slice(0, 1).toUpperCase();
    return a;
  }));
  renderProgress();
}

let seeking = false;
function renderProgress() {
  if (!room) return;
  const dur = room.current?.durationMs || 0;
  const pos = expectedPos();
  $('#time-dur').textContent = fmt(dur);
  if (!seeking) {
    $('#time-cur').textContent = fmt(pos);
    $('#seek').value = dur ? Math.round((pos / dur) * 1000) : 0;
    setFill($('#seek'));
  }
}
setInterval(renderProgress, 250);

// ============================================================ Steuerung

function togglePlay() {
  if (!room) return;
  if (sync.detached) { sync.detached = false; showPlayerError(''); sync.loading = null; }
  player?.activateElement?.();
  send({ type: room.playing ? 'pause' : 'play' });
}

function seekBy(deltaMs) {
  if (!room?.current) return;
  send({ type: 'seek', positionMs: clampNum(expectedPos() + deltaMs, 0, room.current.durationMs - 1000) });
}

function applyVolume() {
  const v = muted ? 0 : volume;
  $('#volume').value = volume;
  $('#volume-val').textContent = muted ? 'stumm' : volume + '%';
  setFill($('#volume'));
  player?.setVolume(v / 100).catch?.(() => {});
}

function bindControls() {
  $('#btn-play').onclick = togglePlay;
  $('#btn-next').onclick = () => send({ type: 'next' });
  $('#btn-prev').onclick = () => send({ type: 'prev' });
  $('#btn-shuffle').onclick = () => send({ type: 'shuffle' });
  $('#btn-clear').onclick = () => { if (room?.queue.length && confirm('Warteschlange wirklich leeren?')) send({ type: 'clear' }); };

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    seeking = true;
    setFill(seek);
    $('#time-cur').textContent = fmt((seek.value / 1000) * (room?.current?.durationMs || 0));
  });
  seek.addEventListener('change', () => {
    seeking = false;
    if (room?.current) send({ type: 'seek', positionMs: Math.round((seek.value / 1000) * room.current.durationMs) });
  });

  $('#volume').addEventListener('input', (e) => {
    volume = Number(e.target.value);
    muted = false;
    localStorage.setItem('volume', String(volume));
    applyVolume();
  });
  $('#btn-mute').onclick = () => { muted = !muted; applyVolume(); };

  $('#btn-copy').onclick = async () => {
    const link = `${BASE}?room=${roomId}`;
    try { await navigator.clipboard.writeText(link); toast('Einladungslink kopiert'); }
    catch { prompt('Link zum Teilen:', link); }
  };
  $('#btn-leave').onclick = leaveRoom;

  // Queue-Aktionen
  $('#queue').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const uid = btn.closest('.track').dataset.uid;
    if (btn.dataset.act === 'remove') send({ type: 'remove', uid });
    if (btn.dataset.act === 'playNow') send({ type: 'playNow', uid });
    if (btn.dataset.act === 'top') send({ type: 'move', uid, to: 0 });
  });

  // Suchergebnis-Aktionen
  $('#results').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const t = searchResults[Number(btn.closest('.track').dataset.i)];
    if (!t) return;
    send({ type: 'add', tracks: [t], next: btn.dataset.act === 'next' });
  });

  // Tastatur
  document.addEventListener('keydown', (e) => {
    if (!roomId || e.target.closest('input, textarea') || !$('#settings').classList.contains('hidden')) return;
    if (e.code === 'Space') { e.preventDefault(); document.activeElement?.blur?.(); togglePlay(); }
    else if (e.key === 'ArrowRight' && e.shiftKey) send({ type: 'next' });
    else if (e.key === 'ArrowLeft' && e.shiftKey) send({ type: 'prev' });
    else if (e.key === 'ArrowRight') seekBy(10_000);
    else if (e.key === 'ArrowLeft') seekBy(-10_000);
  });

  // Links einfügen (Strg+V)
  document.addEventListener('paste', (e) => {
    if (!roomId || e.target.closest('input, textarea')) return;
    const text = e.clipboardData?.getData('text');
    if (text) { e.preventDefault(); addFromText(text); }
  });

  bindDragAndDrop();
  bindSearch();
}

// ============================================================ Drag & Drop

const INTERNAL = 'application/x-songs-together-uid';

function bindDragAndDrop() {
  const overlay = $('#drop-overlay');
  const zone = $('#dropzone');
  let depth = 0;
  const isInternal = (e) => e.dataTransfer?.types.includes(INTERNAL);
  const isExternal = (e) => !isInternal(e) && e.dataTransfer?.types.some((t) => t === 'text/plain' || t === 'text/uri-list' || t === 'URL');

  // Von außen (Spotify-App, Browser-Tab, Suchergebnisse) → überall auf der Seite ablegen
  document.addEventListener('dragenter', (e) => {
    if (!roomId || !isExternal(e)) return;
    depth++;
    overlay.classList.remove('hidden');
  });
  document.addEventListener('dragleave', (e) => {
    if (!roomId || !isExternal(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add('hidden');
  });
  document.addEventListener('dragover', (e) => {
    if (!roomId) return;
    if (isExternal(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  document.addEventListener('drop', (e) => {
    if (!roomId || !isExternal(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    const dt = e.dataTransfer;
    // Erste Datenquelle verwenden, die Spotify-Links enthält (sonst doppelte Einträge)
    for (const type of ['text/uri-list', 'text/plain', 'URL', 'text/x-moz-url']) {
      const text = dt.getData(type);
      if (parseLinks(text).length) { addFromText(text); return; }
    }
    toast('Kein Spotify-Link im gezogenen Element gefunden.', true);
  });

  // Suchergebnisse ziehbar machen
  $('#results').addEventListener('dragstart', (e) => {
    const li = e.target.closest('.track');
    const t = li && searchResults[Number(li.dataset.i)];
    if (!t) return;
    const link = `https://open.spotify.com/track/${t.uri.split(':')[2]}`;
    e.dataTransfer.setData('text/uri-list', link);
    e.dataTransfer.setData('text/plain', link);
    e.dataTransfer.effectAllowed = 'copy';
  });

  // Queue intern umsortieren
  const list = $('#queue');
  let dragUid = null;
  const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));

  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.track');
    if (!li) return;
    dragUid = li.dataset.uid;
    e.dataTransfer.setData(INTERNAL, dragUid);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  });
  list.addEventListener('dragend', (e) => {
    e.target.closest('.track')?.classList.remove('dragging');
    clearMarks();
    dragUid = null;
  });
  list.addEventListener('dragover', (e) => {
    if (!isInternal(e)) return;
    e.preventDefault();
    const li = e.target.closest('.track');
    clearMarks();
    if (!li) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (!isInternal(e)) return;
    e.preventDefault();
    const li = e.target.closest('.track');
    const uid = e.dataTransfer.getData(INTERNAL) || dragUid;
    clearMarks();
    if (!li || !uid || li.dataset.uid === uid) return;
    const from = room.queue.findIndex((t) => t.uid === uid);
    let to = room.queue.findIndex((t) => t.uid === li.dataset.uid);
    const r = li.getBoundingClientRect();
    if (e.clientY >= r.top + r.height / 2) to++;
    if (from < to) to--;
    send({ type: 'move', uid, to });
  });

  zone.addEventListener('dragover', (e) => { if (isExternal(e)) zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', () => zone.classList.remove('drag-over'));
}

// ============================================================ Suche

let searchResults = [];
function bindSearch() {
  const input = $('#search');
  let timer = null;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      const my = ++seq;
      if (!q) { searchResults = []; $('#results').replaceChildren(); return; }
      // Link ins Suchfeld eingefügt → direkt hinzufügen
      if (parseLinks(q).length) { input.value = ''; addFromText(q); return; }
      try {
        const data = await api(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
        if (my !== seq) return;
        searchResults = (data.tracks?.items || []).map((t) => mapTrack(t)).filter(Boolean);
        $('#results').replaceChildren(...searchResults.map((t, i) => {
          const li = trackRow(t);
          li.dataset.i = i;
          return li;
        }));
      } catch (e) {
        toast('Suche fehlgeschlagen: ' + e.message, true);
      }
    }, 300);
  });
}

// ============================================================ Räume betreten / verlassen

function roomFromPath() {
  const id = new URLSearchParams(location.search).get('room') || '';
  return /^[a-z0-9-]{3,40}$/i.test(id) ? id.toLowerCase() : null;
}

function goToRoom(id, isNew = false) {
  history.pushState(null, '', `${BASE}?room=${id}`);
  enterRoom(id, isNew);
}

async function enterRoom(id, isNew = false) {
  roomId = id;
  room = null;
  $('#room-code').textContent = id;
  show('room');
  applyVolume();
  // Player im Klick-Kontext erstellen (Autoplay-Regeln der Browser)
  if (window.Spotify) createPlayer();
  else loadSdk().then(createPlayer);
  connect(isNew);
}

function leaveRoom() {
  roomId = null;
  room = null;
  net?.stop();
  net = null;
  $('#host-badge').classList.add('hidden');
  player?.disconnect();
  player = null;
  deviceId = null;
  sync.wasActive = false;
  sync.detached = false;
  showPlayerError('');
  history.pushState(null, '', BASE);
  showLobby();
}

function showLobby() {
  $('#lobby-name').textContent = me.display_name || me.id;
  show('lobby');
}

function bindLobby() {
  $('#btn-login').onclick = login;
  $('#btn-logout').onclick = logout;
  $('#btn-create').onclick = () => goToRoom(newRoomId(), true);
  $('#form-join').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#input-room').value.trim();
    const id = (v.match(/room=([a-z0-9-]{3,40})/i)?.[1] || v).toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (id.length >= 3) goToRoom(id); else toast('Bitte einen gültigen Raumcode eingeben.', true);
  };
  $('#btn-enter').onclick = () => enterRoom($('#enter-room').textContent);
  $('#btn-back-lobby').onclick = () => { history.pushState(null, '', BASE); showLobby(); };
  window.addEventListener('popstate', () => {
    if (roomId) leaveRoom();
    route();
  });
}

function route() {
  const id = roomFromPath();
  if (id) {
    // Ein Klick ist nötig, damit der Browser Audio erlaubt
    $('#enter-room').textContent = id;
    show('enter');
  } else {
    showLobby();
  }
}

// ============================================================ Einstellungen / Design

const THEMES = [
  { id: 'green', name: 'Grün', bg: '#0b0f0c', panel: '#1d2621', accent: '#1ed760' },
  { id: 'blue', name: 'Blau', bg: '#0a0e14', panel: '#1b2431', accent: '#3b9dff' },
  { id: 'pink', name: 'Pink', bg: '#120b0f', panel: '#281a22', accent: '#ff5fa8' },
  { id: 'purple', name: 'Lila', bg: '#0e0b14', panel: '#221a2f', accent: '#a06bff' },
  { id: 'black', name: 'Schwarz', bg: '#000000', panel: '#181818', accent: '#f2f2f2' },
];

function setTheme(id) {
  if (!THEMES.some((t) => t.id === id)) id = 'green';
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem('theme', id); } catch { /* egal */ }
  for (const b of document.querySelectorAll('.theme-opt')) b.setAttribute('aria-checked', String(b.dataset.theme === id));
}

function bindSettings() {
  const modal = $('#settings');
  $('#themes').replaceChildren(...THEMES.map((t) => {
    const b = document.createElement('button');
    b.className = 'theme-opt';
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.theme = t.id;
    b.innerHTML = `<span class="preview" style="background:${t.bg}; border:1px solid ${t.panel}">
        <i style="width:40%; background:${t.accent}"></i><i style="width:25%; background:${t.panel}"></i></span>
      <span>${t.name}</span>`;
    b.onclick = () => setTheme(t.id);
    return b;
  }));
  setTheme(document.documentElement.dataset.theme);

  const open = () => { modal.classList.remove('hidden'); modal.querySelector('[aria-checked="true"]')?.focus(); };
  const close = () => modal.classList.add('hidden');
  for (const b of document.querySelectorAll('[data-open-settings]')) b.onclick = open;
  $('#settings-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ============================================================ Start

async function init() {
  // Spotify erlaubt "localhost" nicht als Redirect-URI → auf 127.0.0.1 umleiten
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }

  bindLobby();
  bindControls();
  bindSettings();

  const loginError = (text) => { $('#login-error').textContent = text; $('#login-error').classList.remove('hidden'); show('login'); };

  if (!CLIENT_ID) { loginError('Konfiguration fehlt: CLIENT_ID in config.js ist nicht gesetzt (siehe README).'); return; }

  const q = new URLSearchParams(location.search);
  if ((q.has('code') || q.has('error')) && q.has('state')) {
    try { await handleCallback(); } catch (e) { loginError(e.message); return; }
  }

  if (!tokens.get()) {
    if (roomFromPath()) sessionStorage.setItem('returnTo', location.search);
    show('login');
    return;
  }

  try {
    me = await api('/me');
  } catch (e) {
    tokens.clear();
    loginError(e.status === 403
      ? 'Zugriff verweigert. Ist dein Spotify-Account in der Developer-App unter „User Management“ eingetragen?'
      : 'Anmeldung fehlgeschlagen: ' + e.message);
    return;
  }

  loadSdk(); // vorladen, damit der Player beim Klick sofort bereit ist
  if (me.product && me.product !== 'premium') toast('Hinweis: Ohne Spotify Premium kann die Musik nicht im Browser abgespielt werden.', true);
  route();
}

init().catch((e) => { console.error(e); toast('Fehler beim Start: ' + e.message, true); });
