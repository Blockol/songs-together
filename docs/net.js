// Peer-to-Peer-Verbindung (PeerJS / WebRTC) mit automatischer Host-Übergabe.
//
// - Der Host registriert beim PeerJS-Vermittlungsserver die feste ID  "<PREFIX><raumcode>".
// - Alle anderen verbinden sich mit dieser ID.
// - Ist der Host weg, übernimmt der nächste Teilnehmer (Beitrittsreihenfolge) die ID und
//   startet mit dem letzten bekannten Zustand weiter. Die Musik läuft dabei bei allen einfach weiter.
// - Uhrzeit-Abgleich: Jeder Teilnehmer misst den Unterschied seiner Uhr zur Uhr des Hosts (wie NTP).

import { HostRoom } from './host-room.js?v=14';

const PREFIX = 'songs-together-v1-';
const CONNECT_TIMEOUT_MS = 7000;
const HOST_SILENCE_MS = 9000;     // so lange ohne Lebenszeichen → Host gilt als weg
const CLIENT_SILENCE_MS = 20000;  // so lange ohne Ping → Teilnehmer wird entfernt
const PING_INTERVAL_MS = 2500;
const PEER_OPTS = { debug: 1 };
// PeerJS lehnt JSON-Nachrichten ab ~16 KB ab ("Message too big") und meldet dann einen Verbindungsfehler.
// Große Nachrichten (z. B. Zustand mit langer Warteschlange) werden deshalb in Stücke geteilt.
// 5000 Zeichen ergeben auch bei Umlauten/Anführungszeichen höchstens ~15 KB pro Stück.
const CHUNK_CHARS = 5000;

function sendMsg(conn, msg) {
  const text = JSON.stringify(msg);
  if (text.length <= CHUNK_CHARS) { conn.send(msg); return; }
  const id = Math.random().toString(36).slice(2);
  const n = Math.ceil(text.length / CHUNK_CHARS);
  for (let i = 0; i < n; i++) conn.send({ type: 'chunk', id, i, n, d: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
}

// Liefert eine Funktion, die eingehende Nachrichten durchreicht und Stücke wieder zusammensetzt
// (gibt null zurück, solange eine Nachricht noch nicht vollständig ist).
function makeReceiver() {
  const parts = new Map(); // id -> { n, got, list }
  return (msg) => {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.type !== 'chunk') return msg;
    const n = Number(msg.n) | 0;
    const i = Number(msg.i) | 0;
    if (typeof msg.id !== 'string' || typeof msg.d !== 'string' || n < 1 || n > 2000 || i < 0 || i >= n) return null;
    let p = parts.get(msg.id);
    if (!p) {
      if (parts.size > 20) parts.delete(parts.keys().next().value); // verwaiste Reste begrenzen
      p = { n, got: 0, list: new Array(n) };
      parts.set(msg.id, p);
    }
    if (p.list[i] === undefined) { p.list[i] = msg.d; p.got++; }
    if (p.got < p.n) return null;
    parts.delete(msg.id);
    try { return JSON.parse(p.list.join('')); } catch { return null; }
  };
}

export class Net {
  /**
   * @param {object} o
   * @param {string} o.roomId
   * @param {{name: string, image: string}} o.user
   * @param {boolean} o.isNew   Raum wurde gerade erstellt → direkt Host werden
   * @param {(msg: object) => void} o.onMessage
   * @param {(level: string, text: string) => void} o.onStatus
   * @param {(isHost: boolean) => void} o.onRole
   */
  constructor({ roomId, user, isNew, onMessage, onStatus, onRole }) {
    Object.assign(this, { roomId, user, isNew, onMessage, onStatus, onRole });
    this.hostId = PREFIX + roomId;
    this.cid = null;          // eigene Peer-ID (Teilnehmer-Kennung)
    this.peer = null;         // eigener Peer (als Teilnehmer)
    this.hostPeer = null;     // Peer mit der Raum-ID, wenn wir Host sind
    this.conn = null;         // Verbindung zum Host (als Teilnehmer)
    this.room = null;         // HostRoom, wenn wir Host sind
    this.clients = new Map(); // cid -> { conn, lastSeen } (als Host)
    this.isHost = false;
    this.lastState = null;
    this.offset = 0;
    this.rtt = null;
    this.samples = [];
    this.clockReady = false;
    this.pending = null;      // Verbindungsversuch { conn, timer }
    this.migrateUntil = 0;
    this.timers = new Set();
    this.stopped = false;
  }

  serverNow() { return Date.now() + this.offset; }

  // ------------------------------------------------------------ Start / Stop

  start() {
    this.onStatus('warn', 'Verbinde…');
    this.peer = new window.Peer(PEER_OPTS);
    this.peer.on('open', (id) => {
      if (this.cid) return; // Reconnect zum Vermittlungsserver – nichts zu tun
      this.cid = id;
      if (this.isNew) this.claim(); else this.tryConnect();
    });
    this.peer.on('error', (err) => this.onPeerError(err));
    this.peer.on('disconnected', () => this.later(() => { if (!this.peer.destroyed) this.peer.reconnect(); }, 1500));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t), clearInterval(t);
    this.timers.clear();
    if (this.isHost) {
      for (const { conn } of this.clients.values()) { try { conn.send({ type: 'hostLeaving' }); } catch { /* ignore */ } }
      this.room?.destroy();
    }
    try { this.conn?.close(); } catch { /* ignore */ }
    // Kurz warten, damit "hostLeaving" noch rausgeht
    setTimeout(() => { this.hostPeer?.destroy(); this.peer?.destroy(); }, 150);
  }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  every(fn, ms) {
    const t = setInterval(() => { if (!this.stopped) fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  onPeerError(err) {
    if (this.stopped) return;
    if (err.type === 'peer-unavailable') { this.connectFailed(); return; }
    console.warn('peer error', err.type, err);
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      this.onStatus('bad', 'Vermittlungsserver nicht erreichbar – neuer Versuch…');
      if (!this.cid) {
        // Noch nie verbunden → komplett neu starten
        this.later(() => { this.peer.destroy(); this.start(); }, 3000);
      }
    }
    if (err.type === 'browser-incompatible') this.onStatus('bad', 'Dieser Browser unterstützt kein WebRTC.');
  }

  // ------------------------------------------------------------ Als Teilnehmer verbinden

  tryConnect() {
    if (this.stopped || this.isHost || this.pending || this.conn) return;
    this.onStatus('warn', 'Verbinde mit Raum…');
    const conn = this.peer.connect(this.hostId, { serialization: 'json', reliable: true });
    const timer = this.later(() => { conn.close(); this.connectFailed(); }, CONNECT_TIMEOUT_MS);
    this.pending = { conn, timer };
    conn.on('open', () => {
      if (this.pending?.conn !== conn) { conn.close(); return; }
      clearTimeout(timer);
      this.pending = null;
      this.becomeClient(conn);
    });
  }

  connectFailed() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
    // Während einer Host-Übergabe: erst mal weiter versuchen, den neuen Host zu erreichen
    if (Date.now() < this.migrateUntil) { this.later(() => this.tryConnect(), 800); return; }
    // Niemand da → selbst Host werden
    this.claim();
  }

  rankDelay() {
    if (!this.lastState) return 0;
    const order = (this.lastState.users || []).filter((u) => !u.host).map((u) => u.cid);
    const i = order.indexOf(this.cid);
    return (i < 0 ? order.length : i) * 2500;
  }

  becomeClient(conn) {
    this.conn = conn;
    this.isHost = false;
    this.samples = [];
    this.clockReady = false;
    let bufferedState = null;
    let lastHostMsg = Date.now();
    this.onRole(false);
    this.onStatus('warn', 'Verbunden – gleiche Uhr ab…');

    const ping = () => { try { conn.send({ type: 'ping', t0: Date.now() }); } catch { /* ignore */ } };
    // Ping vor dem Join senden: Die Antwort kommt dann vor dem ersten Zustand an
    for (let i = 0; i < 5; i++) this.later(ping, i * 120);
    conn.send({ type: 'join', user: this.user });

    const receive = makeReceiver();
    conn.on('data', (raw) => {
      lastHostMsg = Date.now();
      const msg = receive(raw);
      if (!msg) return;
      if (msg.type === 'pong') {
        this.onPong(msg);
        if (!this.clockReady) {
          this.clockReady = true;
          if (bufferedState) { this.onMessage(bufferedState); bufferedState = null; }
        }
        return;
      }
      if (msg.type === 'hostLeaving') { this.hostLost(conn); return; }
      if (msg.type === 'state') {
        this.lastState = msg;
        if (!this.clockReady) { bufferedState = msg; return; }
      }
      this.onMessage(msg);
    });
    conn.on('close', () => this.hostLost(conn));
    conn.on('error', () => this.hostLost(conn));

    const pinger = this.every(ping, PING_INTERVAL_MS);
    const watchdog = this.every(() => { if (Date.now() - lastHostMsg > HOST_SILENCE_MS) this.hostLost(conn); }, 1000);
    conn._cleanup = () => { clearInterval(pinger); clearInterval(watchdog); this.timers.delete(pinger); this.timers.delete(watchdog); };
  }

  onPong({ t0, serverTime }) {
    const rtt = Date.now() - t0;
    this.samples.push({ rtt, offset: serverTime - (t0 + rtt / 2) });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)); // kleinste Laufzeit = genaueste Messung
    this.offset = best.offset;
    this.rtt = best.rtt;
  }

  hostLost(conn) {
    if (this.conn !== conn || this.stopped) return;
    conn._cleanup?.();
    this.conn = null;
    try { conn.close(); } catch { /* ignore */ }
    this.onStatus('warn', 'Host ist weg – Raum wird übernommen…');
    const delay = this.rankDelay();
    // Der Nächste in der Reihe übernimmt sofort. Die anderen verbinden sich mit ihm und
    // übernehmen erst selbst, wenn bis zu ihrer Reihe niemand erreichbar war.
    this.migrateUntil = Date.now() + delay;
    if (delay === 0) this.later(() => this.claim(), 300);
    else this.later(() => this.tryConnect(), 800);
  }

  // ------------------------------------------------------------ Host werden

  claim() {
    if (this.stopped || this.isHost || this.conn || this.claiming) return;
    this.claiming = true;
    this.onStatus('warn', 'Übernehme Raum…');
    const hp = new window.Peer(this.hostId, PEER_OPTS);
    hp.on('open', () => { this.claiming = false; this.becomeHost(hp); });
    hp.on('error', (err) => {
      if (this.isHost) { console.warn('host peer error', err.type); return; }
      this.claiming = false;
      hp.destroy();
      // ID ist vergeben → es gibt (schon/noch) einen Host → als Teilnehmer verbinden
      this.later(() => this.tryConnect(), err.type === 'unavailable-id' ? 1000 + Math.random() * 1000 : 3000);
    });
    hp.on('disconnected', () => this.later(() => { if (!hp.destroyed) hp.reconnect(); }, 1500));
  }

  becomeHost(hp) {
    this.hostPeer = hp;
    this.isHost = true;

    // Zustand des vorherigen Hosts übernehmen; Position in die eigene Uhr umrechnen
    let snapshot = null;
    const s = this.lastState;
    if (s) {
      const pos = s.playing ? s.positionMs + (this.serverNow() - s.refTime) : s.positionMs;
      snapshot = { ...s, positionMs: pos };
    }
    this.offset = 0;
    this.rtt = 0;
    this.clockReady = true;

    this.room = new HostRoom(this.roomId, (to, msg) => this.emit(to, msg), snapshot);
    this.onRole(true);
    this.room.join(this.cid, { ...this.user, host: true }, { silent: true });
    if (snapshot) this.room.notify(`${this.user.name} ist jetzt Host`);

    hp.on('connection', (conn) => this.acceptClient(conn));

    this.every(() => {
      const now = Date.now();
      for (const [cid, c] of this.clients) {
        if (now - c.lastSeen > CLIENT_SILENCE_MS) { try { c.conn.close(); } catch { /* ignore */ } this.dropClient(cid, c.conn); }
      }
    }, 5000);
  }

  acceptClient(conn) {
    const cid = conn.peer;
    const receive = makeReceiver();
    conn.on('open', () => {
      const old = this.clients.get(cid);
      if (old && old.conn !== conn) { try { old.conn.close(); } catch { /* ignore */ } }
      this.clients.set(cid, { conn, lastSeen: Date.now() });
    });
    conn.on('data', (raw) => {
      const c = this.clients.get(cid);
      if (!c || c.conn !== conn) return;
      c.lastSeen = Date.now();
      const msg = receive(raw);
      if (!msg) return;
      if (msg.type === 'ping') { conn.send({ type: 'pong', t0: msg.t0, serverTime: Date.now() }); return; }
      if (msg.type === 'join') { this.room.join(cid, { ...msg.user, host: false }); return; }
      this.room.handle(cid, msg);
    });
    conn.on('close', () => this.dropClient(cid, conn));
    conn.on('error', () => this.dropClient(cid, conn));
  }

  dropClient(cid, conn) {
    const c = this.clients.get(cid);
    if (!c || c.conn !== conn) return;
    this.clients.delete(cid);
    this.room?.leave(cid);
  }

  emit(to, msg) {
    if (to === null || to === this.cid) {
      if (msg.type === 'state') this.lastState = msg;
      this.onMessage(msg);
    }
    for (const [cid, { conn }] of this.clients) {
      if ((to === null || to === cid) && conn.open) { try { sendMsg(conn, msg); } catch { /* ignore */ } }
    }
  }

  // ------------------------------------------------------------ Senden

  send(msg) {
    if (this.isHost) { this.room?.handle(this.cid, msg); return; }
    if (this.conn?.open) { try { sendMsg(this.conn, msg); } catch { /* ignore */ } }
  }
}
