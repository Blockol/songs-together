'use strict';

// Songs Together – Server
// - liefert das Frontend aus (public/)
// - hält pro Raum den maßgeblichen Wiedergabezustand (Song, Position, Play/Pause, Queue)
// - verteilt Änderungen per WebSocket an alle Teilnehmer
// - liefert die Serverzeit für die Uhren-Synchronisation der Clients

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* keine .env vorhanden */ }

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID || '').trim();
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_QUEUE = 500;
const MAX_HISTORY = 100;
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000; // leere Räume 6 h aufheben

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ clientId: CLIENT_ID }));
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA-Fallback
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------- Räume

/** @type {Map<string, Room>} */
const rooms = new Map();

function createRoom(id) {
  return {
    id,
    clients: new Set(),
    queue: [],
    history: [],
    current: null,
    playing: false,
    positionMs: 0,   // Position zum Zeitpunkt refTime
    refTime: Date.now(),
    syncId: 0,       // erhöht sich bei jedem "harten" Ereignis (Seek, Songwechsel, Play/Pause)
    timer: null,
    emptySince: null,
  };
}

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) { room = createRoom(id); rooms.set(id, room); }
  return room;
}

function currentPosition(room) {
  if (!room.current) return 0;
  const pos = room.playing ? room.positionMs + (Date.now() - room.refTime) : room.positionMs;
  return Math.max(0, Math.min(pos, room.current.durationMs));
}

function setPlayback(room, positionMs, playing) {
  room.positionMs = room.current ? Math.max(0, Math.min(positionMs, room.current.durationMs)) : 0;
  room.refTime = Date.now();
  room.playing = Boolean(playing && room.current);
  room.syncId++;
  scheduleAdvance(room);
}

// Der Server entscheidet, wann ein Song zu Ende ist – so gibt es keine Wettrennen zwischen Clients.
function scheduleAdvance(room) {
  clearTimeout(room.timer);
  room.timer = null;
  if (!room.playing || !room.current) return;
  const remaining = room.current.durationMs - currentPosition(room);
  room.timer = setTimeout(() => {
    advance(room);
    broadcastState(room);
  }, Math.max(0, remaining) + 250);
}

function advance(room) {
  const wasPlaying = room.playing || !room.current;
  if (room.current) {
    room.history.push(room.current);
    if (room.history.length > MAX_HISTORY) room.history.shift();
  }
  room.current = room.queue.shift() || null;
  setPlayback(room, 0, wasPlaying);
}

function goBack(room) {
  if (currentPosition(room) > 3000 || room.history.length === 0) {
    setPlayback(room, 0, room.playing);
    return;
  }
  if (room.current) room.queue.unshift(room.current);
  room.current = room.history.pop();
  setPlayback(room, 0, true);
}

function publicState(room) {
  return {
    type: 'state',
    room: room.id,
    current: room.current,
    playing: room.playing,
    positionMs: room.positionMs,
    refTime: room.refTime,
    syncId: room.syncId,
    queue: room.queue,
    historyCount: room.history.length,
    users: [...room.clients].map((c) => c.user).filter(Boolean),
    serverTime: Date.now(),
  };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
}

function broadcastState(room) { broadcast(room, publicState(room)); }

function notify(room, text) { broadcast(room, { type: 'event', text }); }

// ---------------------------------------------------------------- Validierung

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

function cleanTrack(t, addedBy) {
  if (!t || typeof t !== 'object' || !TRACK_URI.test(t.uri)) return null;
  const durationMs = Number(t.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 6 * 3600 * 1000) return null;
  const image = str(t.image, 500);
  return {
    uid: crypto.randomUUID(),
    uri: t.uri,
    id: t.uri.split(':')[2],
    name: str(t.name) || 'Unbekannter Titel',
    artists: str(t.artists),
    album: str(t.album),
    image: /^https:\/\//.test(image) ? image : '',
    durationMs,
    addedBy,
  };
}

function cleanRoomId(v) {
  const id = str(v, 40).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return id.length >= 3 ? id : null;
}

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  const client = { ws, user: null, room: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // Uhren-Synchronisation: sofort antworten, vor allem anderen
    if (msg.type === 'ping') {
      send(ws, { type: 'pong', t0: msg.t0, serverTime: Date.now() });
      return;
    }

    if (msg.type === 'join') {
      const roomId = cleanRoomId(msg.room);
      if (!roomId) { send(ws, { type: 'error', text: 'Ungültiger Raumname.' }); return; }
      if (client.room) leave(client);
      client.user = {
        id: str(msg.user?.id, 100) || crypto.randomUUID(),
        name: str(msg.user?.name, 60) || 'Gast',
        image: /^https:\/\//.test(str(msg.user?.image, 500)) ? str(msg.user.image, 500) : '',
      };
      const room = getRoom(roomId);
      room.emptySince = null;
      room.clients.add(client);
      client.room = room;
      broadcastState(room);
      notify(room, `${client.user.name} ist dem Raum beigetreten`);
      return;
    }

    const room = client.room;
    if (!room) return;
    const who = client.user.name;

    switch (msg.type) {
      case 'add': {
        const list = Array.isArray(msg.tracks) ? msg.tracks : [];
        const space = MAX_QUEUE - room.queue.length;
        const tracks = list.slice(0, Math.max(0, space)).map((t) => cleanTrack(t, who)).filter(Boolean);
        if (!tracks.length) return;
        if (msg.next) room.queue.unshift(...tracks); else room.queue.push(...tracks);
        if (!room.current) advance(room); // nichts läuft → direkt starten
        broadcastState(room);
        notify(room, tracks.length === 1
          ? `${who} hat „${tracks[0].name}“ hinzugefügt`
          : `${who} hat ${tracks.length} Songs hinzugefügt`);
        return;
      }
      case 'remove': {
        const i = room.queue.findIndex((t) => t.uid === msg.uid);
        if (i < 0) return;
        room.queue.splice(i, 1);
        broadcastState(room);
        return;
      }
      case 'move': {
        const from = room.queue.findIndex((t) => t.uid === msg.uid);
        const to = Math.max(0, Math.min(Number(msg.to) | 0, room.queue.length - 1));
        if (from < 0 || from === to) return;
        const [item] = room.queue.splice(from, 1);
        room.queue.splice(to, 0, item);
        broadcastState(room);
        return;
      }
      case 'clear': {
        room.queue = [];
        broadcastState(room);
        notify(room, `${who} hat die Warteschlange geleert`);
        return;
      }
      case 'shuffle': {
        for (let i = room.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [room.queue[i], room.queue[j]] = [room.queue[j], room.queue[i]];
        }
        broadcastState(room);
        notify(room, `${who} hat die Warteschlange gemischt`);
        return;
      }
      case 'playNow': {
        const i = room.queue.findIndex((t) => t.uid === msg.uid);
        if (i < 0) return;
        const [item] = room.queue.splice(i, 1);
        if (room.current) room.history.push(room.current);
        room.current = item;
        setPlayback(room, 0, true);
        broadcastState(room);
        return;
      }
      case 'play':
        if (!room.current) { if (room.queue.length) advance(room); else return; }
        setPlayback(room, currentPosition(room), true);
        broadcastState(room);
        return;
      case 'pause':
        if (!room.current) return;
        setPlayback(room, currentPosition(room), false);
        broadcastState(room);
        return;
      case 'seek': {
        if (!room.current) return;
        const pos = Number(msg.positionMs);
        if (!Number.isFinite(pos)) return;
        setPlayback(room, pos, room.playing);
        broadcastState(room);
        return;
      }
      case 'next':
        if (!room.current && !room.queue.length) return;
        advance(room);
        broadcastState(room);
        notify(room, `${who} hat übersprungen`);
        return;
      case 'prev':
        goBack(room);
        broadcastState(room);
        return;
      case 'getState':
        send(ws, publicState(room));
        return;
    }
  });

  ws.on('close', () => leave(client));
  ws.on('error', () => {});
});

function leave(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client);
  client.room = null;
  if (room.clients.size === 0) {
    // Niemand mehr da → anhalten, damit die Queue nicht "leer" weiterläuft
    if (room.playing) setPlayback(room, currentPosition(room), false);
    room.emptySince = Date.now();
  } else {
    broadcastState(room);
    if (client.user) notify(room, `${client.user.name} hat den Raum verlassen`);
  }
}

// Tote Verbindungen erkennen + leere Räume aufräumen
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      clearTimeout(room.timer);
      rooms.delete(id);
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Songs Together läuft auf http://127.0.0.1:${PORT}`);
  if (!CLIENT_ID) console.warn('⚠  SPOTIFY_CLIENT_ID fehlt – lege eine .env an (siehe .env.example).');
});
