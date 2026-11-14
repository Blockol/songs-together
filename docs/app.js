// Songs Together – Frontend
// Ablauf: Spotify-Login (PKCE) → Raum betreten → Web Playback SDK spielt im Browser,
// der Server gibt Song + Position vor, jeder Client korrigiert seine Abweichung laufend.

import { CLIENT_ID } from './config.js?v=12';
import { Net } from './net.js?v=14';
import { ColorWheel, deriveTheme, hexToRgb } from './colorwheel.js?v=12';

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
  const box = mini?.m('toasts');
  if (box) {
    const copy = mini.doc.importNode(el, true);
    box.append(copy);
    setTimeout(() => copy.remove(), 3500);
    while (box.children.length > 3) box.firstChild.remove();
  }
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

// ------------------------------------------------ Sitzung sichern (Song + Warteschlange)
const BACKUP_PREFIX = 'SongsTogether-Sitzung:';

function backupText() {
  const slim = (t) => t && ({ uri: t.uri, name: t.name, artists: t.artists, album: t.album, image: t.image, durationMs: t.durationMs, addedBy: t.addedBy });
  return BACKUP_PREFIX + JSON.stringify({
    v: 1,
    current: slim(room.current),
    positionMs: Math.round(expectedPos()),
    playing: room.playing,
    queue: room.queue.map(slim),
    history: (room.history || []).map(slim),
  });
}

function parseBackup(text) {
  const i = text.indexOf(BACKUP_PREFIX);
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i + BACKUP_PREFIX.length).trim()); } catch { return null; }
}

async function copyBackup() {
  if (!room || (!room.current && !room.queue.length)) { toast('Es gibt nichts zu sichern.', true); return; }
  const text = backupText();
  try { await navigator.clipboard.writeText(text); toast('Song und Warteschlange kopiert – nach dem Neuladen wieder einfügen'); }
  catch { prompt('Kopiere diesen Text:', text); }
}

function restoreBackup(backup) {
  if (!backup || (!backup.current && !backup.queue?.length)) { toast('Die Sicherung ist leer oder ungültig.', true); return; }
  if ((room?.current || room?.queue.length) && !confirm('Aktuellen Song und Warteschlange durch die Sicherung ersetzen?')) return;
  send({ type: 'restore', backup });
}

async function pasteBackup() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (!parseBackup(text)) text = prompt('Gesicherte Sitzung hier einfügen:') || '';
  if (!text) return;
  const backup = parseBackup(text);
  if (!backup) { toast('Keine gültige Sicherung gefunden.', true); return; }
  restoreBackup(backup);
}

async function addFromText(text, { next = false, before } = {}) {
  const backup = parseBackup(text);
  if (backup) { restoreBackup(backup); return; }
  const links = parseLinks(text);
  if (!links.length) { toast('Kein Spotify-Song-, Album- oder Playlist-Link erkannt.', true); return; }
  try {
    if (links.length > 1 || links[0].type !== 'track') toast('Songs werden geladen…');
    const tracks = await resolveLinks(links);
    if (!tracks.length) { toast('Keine abspielbaren Songs gefunden.', true); return; }
    // before: uid des Songs, vor dem eingefügt wird (null = ans Ende)
    send(before !== undefined ? { type: 'add', tracks, before } : { type: 'add', tracks, next });
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

window.addEventListener('pagehide', () => { if (mini) saveMiniRect(mini.win); net?.stop(); });

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
  setMainTitle();

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
  renderMini();
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
  renderMiniProgress();
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
  if (mini) { mini.m('vol').value = volume; setFill(mini.m('vol')); }
  player?.setVolume(v / 100).catch?.(() => {});
}

function onQueueAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const uid = btn.closest('.track').dataset.uid;
  if (btn.dataset.act === 'remove') send({ type: 'remove', uid });
  if (btn.dataset.act === 'playNow') send({ type: 'playNow', uid });
  if (btn.dataset.act === 'top') send({ type: 'move', uid, to: 0 });
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
  $('#queue').addEventListener('click', onQueueAction);

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
    const before = queueDropBefore($('#queue'), e); // über der Warteschlange: genau dort einfügen
    // Erste Datenquelle verwenden, die Spotify-Links enthält (sonst doppelte Einträge)
    for (const type of ['text/uri-list', 'text/plain', 'URL', 'text/x-moz-url']) {
      const text = dt.getData(type);
      if (parseLinks(text).length) { addFromText(text, { before }); return; }
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

  // Queue intern umsortieren; von außen gezogene Songs zwischen zwei Songs einfügen
  const hint = overlay.querySelector('div');
  bindQueueReorder($('#queue'), (over) => { hint.textContent = over ? 'Loslassen zum Einfügen an dieser Stelle' : 'Loslassen zum Hinzufügen'; });

  zone.addEventListener('dragover', (e) => { if (isExternal(e)) zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', () => zone.classList.remove('drag-over'));
}

// Song in der Warteschlange unter dem Mauszeiger: { li, after } (after = untere Hälfte)
function queueDropTarget(list, e) {
  const li = e.target.closest?.('.track');
  if (!li || !list.contains(li)) return null;
  const r = li.getBoundingClientRect();
  return { li, after: e.clientY >= r.top + r.height / 2 };
}

// Von außen gezogene Songs: uid des Songs, vor dem eingefügt wird (null = ans Ende,
// undefined = nicht über der Warteschlange → wie bisher ans Ende)
function queueDropBefore(list, e) {
  const t = queueDropTarget(list, e);
  if (!t) return undefined;
  return t.after ? (t.li.nextElementSibling?.dataset.uid ?? null) : t.li.dataset.uid;
}

// Warteschlange per Drag & Drop umsortieren (Hauptseite und Mini-Player). Beim Reinziehen von
// außen zeigt ein Strich, wo die Songs landen (eingefügt wird im Drop-Handler des Dokuments).
function bindQueueReorder(list, onExternalOver = () => {}) {
  const isInternal = (e) => e.dataTransfer?.types.includes(INTERNAL);
  const isExternal = (e) => !isInternal(e) && e.dataTransfer?.types.some((t) => t === 'text/plain' || t === 'text/uri-list' || t === 'URL');
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
    const internal = isInternal(e);
    if (!internal && !isExternal(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    const t = queueDropTarget(list, e);
    clearMarks();
    if (!internal) onExternalOver(Boolean(t));
    if (t) t.li.classList.add(t.after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('dragleave', (e) => {
    if (list.contains(e.relatedTarget)) return;
    clearMarks();
    onExternalOver(false);
  });
  list.addEventListener('drop', (e) => {
    if (!isInternal(e)) { clearMarks(); onExternalOver(false); return; }
    e.preventDefault();
    const li = e.target.closest('.track');
    const uid = e.dataTransfer.getData(INTERNAL) || dragUid;
    clearMarks();
    if (!li || !uid || li.dataset.uid === uid) return;
    const from = room.queue.findIndex((t) => t.uid === uid);
    let to = room.queue.findIndex((t) => t.uid === li.dataset.uid);
    if (from < 0 || to < 0) return;
    const r = li.getBoundingClientRect();
    if (e.clientY >= r.top + r.height / 2) to++;
    if (from < to) to--;
    send({ type: 'move', uid, to });
  });
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
  closeMini();
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
  { id: 'pink', name: 'Pink', bg: '#120b0f', panel: '#281a22', accent: '#ff5fa8' },
  { id: 'purple', name: 'Lila', bg: '#0e0b14', panel: '#221a2f', accent: '#a06bff' },
  { id: 'black', name: 'Schwarz', bg: '#000000', panel: '#181818', accent: '#f2f2f2' },
  { id: 'spotify', name: 'Spotify', bg: '#121212', panel: '#242424', accent: '#1ed760' },
];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } },
};

let customColor = hexToRgb(store.get('customColor')) ? store.get('customColor') : '#ff8a3d';
let wheel = null;

function applyCustomColor(hex) {
  customColor = hex;
  const vars = deriveTheme(hex);
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  store.set('customColor', hex);
  store.set('themeVars', JSON.stringify(vars));
  $('#custom-dot')?.style.setProperty('background', hex);
  updateFavicon();
  if ($('#hex') && document.activeElement !== $('#hex')) $('#hex').value = hex;
  renderColorSlots();
}

// Eine Farbe übernehmen und Farbrad, Helligkeit und Hex-Feld nachziehen
function pickCustomColor(hex) {
  applyCustomColor(hex.toLowerCase());
  if (!wheel) return;
  wheel.setHex(hex);
  $('#brightness').value = Math.round(wheel.v * 100);
  setFill($('#brightness'));
}

// ---------- 3 Speicherplätze für eigene Farben
const SLOT_COUNT = 3;
let colorSlots = (() => {
  try {
    const arr = JSON.parse(store.get('colorSlots') || '[]');
    return Array.from({ length: SLOT_COUNT }, (_, i) => (hexToRgb(arr[i]) ? arr[i] : null));
  } catch { return Array(SLOT_COUNT).fill(null); }
})();

function saveColorSlots() { store.set('colorSlots', JSON.stringify(colorSlots)); renderColorSlots(); }

function renderColorSlots() {
  const box = $('#color-slots');
  if (!box) return;
  box.replaceChildren(...colorSlots.map((hex, i) => {
    const slot = document.createElement('div');
    slot.className = 'color-slot' + (hex ? '' : ' empty');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot-main';
    if (hex) {
      b.style.background = hex;
      b.title = `${hex} übernehmen`;
      b.setAttribute('aria-label', `Gespeicherte Farbe ${i + 1} (${hex}) übernehmen`);
      if (hex === customColor) slot.classList.add('current');
      b.onclick = () => pickCustomColor(hex);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'slot-del';
      del.textContent = '×';
      del.title = 'Platz leeren';
      del.setAttribute('aria-label', `Speicherplatz ${i + 1} leeren`);
      del.onclick = () => { colorSlots[i] = null; saveColorSlots(); };
      slot.append(b, del);
    } else {
      b.textContent = '+';
      b.title = 'Aktuelle Farbe hier speichern';
      b.setAttribute('aria-label', `Aktuelle Farbe in Platz ${i + 1} speichern`);
      b.onclick = () => { colorSlots[i] = customColor; saveColorSlots(); toast('Farbe gespeichert'); };
      slot.append(b);
    }
    return slot;
  }));
}

function clearCustomColor() {
  for (const k of Object.keys(deriveTheme('#000000'))) document.documentElement.style.removeProperty(k);
}

// Tab-Symbol (Favicon) in der aktuellen Designfarbe
function updateFavicon() {
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#1ed760';
  const ink = css.getPropertyValue('--on-accent').trim() || '#04140a';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="${accent}"/>`
    + `<circle cx="24" cy="40" r="7" fill="${ink}"/><circle cx="42" cy="36" r="7" fill="${ink}"/>`
    + `<path d="M29 40V18l20-5v23" fill="none" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/></svg>`;
  $('#favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  syncMiniTheme();
}

function setTheme(id) {
  if (id !== 'custom' && !THEMES.some((t) => t.id === id)) id = 'green';
  document.documentElement.dataset.theme = id;
  store.set('theme', id);
  if (id === 'custom') applyCustomColor(customColor); else clearCustomColor();
  for (const b of document.querySelectorAll('.theme-opt')) b.setAttribute('aria-checked', String(b.dataset.theme === id));
  updateFavicon();
  const panel = $('#custom-color');
  panel.classList.toggle('hidden', id !== 'custom');
  if (id === 'custom') {
    wheel ??= new ColorWheel($('#wheel'), (hex) => applyCustomColor(hex));
    wheel.setHex(customColor);
    $('#brightness').value = Math.round(wheel.v * 100);
    setFill($('#brightness'));
  }
}

function bindSettings() {
  const modal = $('#settings');
  const tiles = THEMES.map((t) => {
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
  });
  // Eigene Farbe
  const custom = document.createElement('button');
  custom.className = 'theme-opt';
  custom.type = 'button';
  custom.setAttribute('role', 'radio');
  custom.dataset.theme = 'custom';
  custom.innerHTML = `<span class="preview rainbow"><i id="custom-dot" class="dot-big" style="background:${customColor}"></i></span>
    <span>Eigene Farbe</span>`;
  custom.onclick = () => setTheme('custom');
  $('#themes').replaceChildren(...tiles, custom);

  const brightness = $('#brightness');
  brightness.addEventListener('input', () => { setFill(brightness); wheel?.setBrightness(brightness.value / 100); });
  $('#hex').addEventListener('input', (e) => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (hexToRgb(v)) pickCustomColor(v);
  });

  setTheme(document.documentElement.dataset.theme);
  renderColorSlots();

  const open = () => {
    modal.classList.remove('hidden');
    $('#session-backup').classList.toggle('hidden', !roomId);
    if (document.documentElement.dataset.theme === 'custom') setTheme('custom'); // Farbrad zeichnen, sobald sichtbar
    modal.querySelector('[aria-checked="true"]')?.focus();
  };
  const close = () => modal.classList.add('hidden');
  for (const b of document.querySelectorAll('[data-open-settings]')) b.onclick = open;
  $('#btn-backup-copy').onclick = copyBackup;
  $('#btn-backup-paste').onclick = () => { close(); pasteBackup(); };
  $('#settings-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ============================================================ Mini-Player
// Kleines Extra-Fenster mit Player, Warteschlange und Drop-Fläche.
// Angepinnt (Chrome/Edge): Document Picture-in-Picture → bleibt über allen anderen Fenstern.
// Angepinnt in anderen Browsern (Firefox, Opera …): normales Popup mit Markierung im Titel,
// „Songs Together Sync“ legt es dann über alle anderen Fenster.
// Sonst: normales Popup-Fenster. Die Musik läuft weiter im Haupt-Tab, das Mini-Fenster steuert ihn nur.

const PIP_SUPPORTED = 'documentPictureInPicture' in window;
const miniPinned = () => store.get('miniPin') !== '0';
let mini = null; // { win, doc, $, seeking }
const MINI_TITLE = 'Songs Together Mini-Player';
const PIN_MARK = ' (angepinnt)'; // daran erkennt Sync, dass es das Popup selbst anpinnen soll
const miniTitle = () => MINI_TITLE + (mini?.pinPopup ? PIN_MARK : '');
// Nicht angepinnter Picture-in-Picture-Player (Chrome/Edge): Chrome gibt dem Fenster den Titel des
// Haupt-Tabs. Ein unsichtbares Zeichen darin sagt „Songs Together Sync“, dass es ihn nicht über allen
// Fenstern lassen soll, sondern nur vor Spotify.
const UNPIN_MARK = '⁠';

function setMainTitle() {
  const cur = room?.current;
  document.title = (cur ? `${cur.name} · Songs Together` : 'Songs Together') + (mini?.pipUnpinned ? UNPIN_MARK : '');
}

const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';

const MINI_HTML = `
  <div class="mini">
    <div class="mini-now">
      <img class="mini-cover hidden" data-m="cover" alt="" draggable="false">
      <div class="mini-cover" data-m="cover-ph">♪</div>
      <div class="mini-meta">
        <div class="mini-title" data-m="title">Nichts läuft</div>
        <div class="mini-artist" data-m="artist"></div>
      </div>
    </div>
    <div class="progress">
      <span class="time" data-m="cur">0:00</span>
      <input type="range" min="0" max="1000" value="0" data-m="seek" aria-label="Position">
      <span class="time" data-m="dur">0:00</span>
    </div>
    <div class="mini-controls">
      <span></span>
      <div class="buttons">
        <button class="icon-btn small" data-m="prev" aria-label="Zurück"><svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
        <button class="icon-btn play" data-m="play" aria-label="Play/Pause"><svg viewBox="0 0 24 24" data-m="play-icon">${ICON_PLAY}</svg></button>
        <button class="icon-btn small" data-m="next" aria-label="Weiter"><svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
      </div>
      <div class="mini-vol">
        <svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9zM16.5 12a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
        <input type="range" min="0" max="100" data-m="vol" aria-label="Lautstärke">
      </div>
    </div>
    <div class="mini-drop">
      <span class="drop-long">Songs, Alben oder Playlists aus Spotify <strong>hierher ziehen</strong><br>oder Link mit Strg+V einfügen</span>
      <span class="drop-short"><b>+</b>Songs hierher ziehen</span>
    </div>
    <div class="mini-head" data-m="qhead">Als Nächstes</div>
    <ol class="tracklist mini-queue" data-m="queue"></ol>
    <div class="empty muted" data-m="qempty">Die Warteschlange ist leer.</div>
  </div>
  <div class="toasts mini-toasts" data-m="toasts"></div>`;

// Letzte Position/Größe des Mini-Players (bleibt auch nach dem Schließen der Website erhalten)
function loadMiniRect() {
  try {
    const r = JSON.parse(store.get('miniRect'));
    if (r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) return r;
  } catch { /* egal */ }
  return null;
}

function saveMiniRect(win) {
  try {
    if (!win || win.closed || !win.innerWidth || !win.innerHeight) return;
    const r = { x: win.screenX, y: win.screenY, w: win.innerWidth, h: win.innerHeight };
    const prev = loadMiniRect();
    if (prev && prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h) return;
    store.set('miniRect', JSON.stringify(r));
  } catch { /* egal */ }
}

function miniPlacement() {
  const r = loadMiniRect();
  const W = clampNum(r?.w ?? 360, 200, 1200), H = clampNum(r?.h ?? 600, 150, 1600);
  // Liegt die Position außerhalb aller Bildschirme, schiebt der Browser das Fenster selbst zurück
  const pos = r ? `,left=${Math.round(r.x)},top=${Math.round(r.y)}` : '';
  return { W, H, pos };
}

// Wartet, bis mini.html im Popup fertig geladen ist (vorher steht dort kurz about:blank)
function miniPageLoaded(win) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      let ready = false;
      try { ready = win.location.pathname.endsWith('/mini.html') && win.document.readyState === 'complete'; }
      catch { /* Seite wechselt gerade */ }
      if (ready || win.closed || Date.now() - start > 5000) resolve();
      else setTimeout(check, 30);
    };
    check();
  });
}

async function openMini() {
  if (mini) { closeMini(); return; }
  const { W, H, pos } = miniPlacement();
  let win = null;
  const pinned = miniPinned();
  let pinPopup = pinned && !PIP_SUPPORTED;
  let pip = false;
  try {
    if (PIP_SUPPORTED) {
      // Chrome/Edge: immer der echte Picture-in-Picture-Player (ohne Adresszeile).
      // Manche Browser (z. B. Opera) kennen die Funktion, öffnen aber kein Fenster →
      // dann normales Popup (angepinnt übernimmt das „Songs Together Sync“)
      try { win = await window.documentPictureInPicture.requestWindow({ width: W, height: H }); }
      catch (e) { console.warn('Picture-in-Picture nicht möglich:', e); win = null; }
      if (win?.document?.body) pip = true;
      else { win = null; pinPopup = pinned; }
    }
    if (!win) {
      // Echte Seite statt leerem Fenster: in der Adresszeile steht dann die Website statt „about:blank“
      win = window.open('mini.html', 'songs-together-mini', `popup,width=${W},height=${H}${pos}`);
      if (win) await miniPageLoaded(win);
    }
  } catch (e) {
    toast('Mini-Player konnte nicht geöffnet werden: ' + e.message, true);
    return;
  }
  if (!win) { toast('Das Fenster wurde blockiert – bitte Popups für diese Seite erlauben.', true); return; }

  const doc = win.document;
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.title = MINI_TITLE + (pinPopup ? PIN_MARK : ''); // fester Titel, daran erkennt „Songs Together Sync“ das Fenster
  const meta = doc.createElement('meta'); meta.setAttribute('charset', 'utf-8');
  const css = doc.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('style.css?v=12', location.href).href;
  const icon = doc.createElement('link'); icon.rel = 'icon'; icon.href = $('#favicon').href;
  doc.head.append(meta, css, icon);
  doc.documentElement.lang = 'de';
  doc.body.className = 'mini-body';
  doc.body.innerHTML = MINI_HTML;

  const m = (k) => doc.querySelector(`[data-m="${k}"]`);
  mini = { win, doc, m, seeking: false, pinPopup, pipUnpinned: pip && !pinned };
  setMainTitle();
  syncMiniTheme();

  m('play').onclick = togglePlay;
  m('prev').onclick = () => send({ type: 'prev' });
  m('next').onclick = () => send({ type: 'next' });
  const seek = m('seek');
  seek.addEventListener('input', () => {
    mini.seeking = true;
    setFill(seek);
    m('cur').textContent = fmt((seek.value / 1000) * (room?.current?.durationMs || 0));
  });
  seek.addEventListener('change', () => {
    mini.seeking = false;
    if (room?.current) send({ type: 'seek', positionMs: Math.round((seek.value / 1000) * room.current.durationMs) });
  });
  m('vol').addEventListener('input', (e) => {
    volume = Number(e.target.value);
    muted = false;
    store.set('volume', String(volume));
    applyVolume();
  });
  m('queue').addEventListener('click', onQueueAction);
  bindQueueReorder(m('queue')); // Songs hoch und runter ziehen

  // Songs reinziehen (z. B. aus der Spotify-App)
  let depth = 0;
  const isExt = (e) => !e.dataTransfer?.types.includes(INTERNAL)
    && e.dataTransfer?.types.some((t) => t === 'text/plain' || t === 'text/uri-list' || t === 'URL');
  doc.addEventListener('dragenter', (e) => { if (isExt(e)) { depth++; doc.body.classList.add('drag-over'); } });
  doc.addEventListener('dragleave', (e) => { if (isExt(e) && --depth <= 0) { depth = 0; doc.body.classList.remove('drag-over'); } });
  doc.addEventListener('dragover', (e) => { if (isExt(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  doc.addEventListener('drop', (e) => {
    depth = 0;
    doc.body.classList.remove('drag-over');
    if (!isExt(e)) return;
    e.preventDefault();
    const before = queueDropBefore(m('queue'), e); // über der Warteschlange: genau dort einfügen
    for (const type of ['text/uri-list', 'text/plain', 'URL']) {
      const text = e.dataTransfer.getData(type);
      if (parseLinks(text).length) { addFromText(text, { before }); return; }
    }
    toast('Kein Spotify-Link im gezogenen Element gefunden.', true);
  });
  doc.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (text) { e.preventDefault(); addFromText(text); }
  });
  doc.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input')) return;
    if (e.code === 'Space') { e.preventDefault(); doc.activeElement?.blur?.(); togglePlay(); }
    else if (e.key === 'ArrowRight' && e.shiftKey) send({ type: 'next' });
    else if (e.key === 'ArrowLeft' && e.shiftKey) send({ type: 'prev' });
    else if (e.key === 'ArrowRight') seekBy(10_000);
    else if (e.key === 'ArrowLeft') seekBy(-10_000);
  });

  win.addEventListener('pagehide', () => { saveMiniRect(win); if (mini?.win === win) miniClosed(); });
  mini.watch = setInterval(() => {
    if (win.closed) { if (mini?.win === win) miniClosed(); return; }
    saveMiniRect(win);
  }, 1000);
  $('#btn-mini').classList.add('active');
  $('#btn-mini').title = 'Mini-Player schließen';
  applyVolume();
  renderMini();
}

function miniClosed() {
  clearInterval(mini?.watch);
  mini = null;
  setMainTitle();
  $('#btn-mini').classList.remove('active');
  $('#btn-mini').title = 'Mini-Player öffnen';
}

function closeMini() {
  if (!mini) return;
  const { win } = mini;
  saveMiniRect(win);
  miniClosed();
  try { win.close(); } catch { /* egal */ }
}

function syncMiniTheme() {
  if (!mini) return;
  const root = mini.doc.documentElement;
  root.dataset.theme = document.documentElement.dataset.theme;
  root.setAttribute('style', document.documentElement.getAttribute('style') || '');
  const icon = mini.doc.querySelector('link[rel=icon]');
  if (icon) icon.href = $('#favicon').href;
}

function renderMini() {
  if (!mini || !room) return;
  const { m } = mini;
  const cur = room.current;
  m('title').textContent = cur ? cur.name : 'Nichts läuft';
  m('artist').textContent = cur ? cur.artists : 'Füge Songs hinzu';
  m('cover').src = cur?.image || '';
  m('cover').classList.toggle('hidden', !cur?.image);
  m('cover-ph').classList.toggle('hidden', Boolean(cur?.image));
  m('play-icon').innerHTML = room.playing ? ICON_PAUSE : ICON_PLAY;
  mini.doc.title = cur ? `${cur.name} · ${miniTitle()}` : miniTitle();
  m('queue').replaceChildren(...room.queue.map((t, i) => {
    const li = trackRow(t, { index: i, queue: true });
    return mini.doc.importNode(li, true);
  }));
  m('qempty').classList.toggle('hidden', room.queue.length > 0);
  m('qhead').textContent = room.queue.length ? `Als Nächstes (${room.queue.length})` : 'Als Nächstes';
  renderMiniProgress();
}

function renderMiniProgress() {
  if (!mini || !room) return;
  const { m } = mini;
  const dur = room.current?.durationMs || 0;
  const pos = expectedPos();
  m('dur').textContent = fmt(dur);
  if (!mini.seeking) {
    m('cur').textContent = fmt(pos);
    m('seek').value = dur ? Math.round((pos / dur) * 1000) : 0;
    setFill(m('seek'));
  }
}

function bindMini() {
  $('#btn-mini').onclick = openMini;
  const pin = $('#mini-pin');
  pin.checked = miniPinned();
  $('#mini-pin-note').textContent = PIP_SUPPORTED
    ? 'Angepinnt bleibt der Mini-Player über allen anderen Fenstern, auch über Spotify. Nicht angepinnt bleibt er nur vor Spotify – dafür muss Songs Together Sync laufen (siehe unten), sonst bleibt er trotzdem über allen Fenstern. Der Haupt-Tab muss geöffnet bleiben (er darf im Hintergrund sein).'
    : 'Angepinnt bleibt der Mini-Player über allen anderen Fenstern – in diesem Browser übernimmt das Songs Together Sync (siehe unten), es muss dafür laufen. Der Haupt-Tab muss geöffnet bleiben (er darf im Hintergrund sein).';
  pin.addEventListener('change', () => {
    store.set('miniPin', pin.checked ? '1' : '0');
    // Offenes Fenster mit neuer Einstellung neu öffnen
    if (mini) { closeMini(); openMini(); }
  });
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
  bindMini();

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
