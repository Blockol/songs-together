// Raum-Logik, die im Browser des Hosts läuft.
// Der Host ist maßgeblich: Er speichert Song, Position (mit Zeitstempel seiner Uhr), Play/Pause und Warteschlange
// und entscheidet, wann ein Song zu Ende ist. Alle Änderungen gehen als "state" an alle Teilnehmer.

const MAX_QUEUE = 500;
const MAX_HISTORY = 30;
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const uid = () => crypto.randomUUID();

function cleanTrack(t, addedBy) {
  if (!t || typeof t !== 'object' || !TRACK_URI.test(t.uri)) return null;
  const durationMs = Number(t.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 6 * 3600 * 1000) return null;
  const image = str(t.image, 500);
  return {
    uid: typeof t.uid === 'string' ? t.uid.slice(0, 64) : uid(),
    uri: t.uri,
    id: t.uri.split(':')[2],
    name: str(t.name) || 'Unbekannter Titel',
    artists: str(t.artists),
    album: str(t.album),
    image: /^https:\/\//.test(image) ? image : '',
    durationMs,
    addedBy: str(addedBy ?? t.addedBy, 60),
  };
}

export class HostRoom {
  /**
   * @param {string} id Raumcode
   * @param {(to: string|null, msg: object) => void} emit Nachricht an einen Teilnehmer (to) oder alle (null)
   * @param {object|null} snapshot Zustand des vorherigen Hosts (bei Host-Übergabe), Position bereits umgerechnet
   */
  constructor(id, emit, snapshot = null) {
    this.id = id;
    this.emit = emit;
    this.members = new Map(); // cid -> user
    this.queue = [];
    this.history = [];
    this.current = null;
    this.playing = false;
    this.positionMs = 0;
    this.refTime = Date.now();
    this.syncId = 0;
    this.timer = null;

    if (snapshot) {
      this.queue = (snapshot.queue || []).map((t) => cleanTrack(t)).filter(Boolean);
      this.history = (snapshot.history || []).map((t) => cleanTrack(t)).filter(Boolean);
      this.current = cleanTrack(snapshot.current);
      this.syncId = (Number(snapshot.syncId) || 0) + 1;
      this.setPlayback(Number(snapshot.positionMs) || 0, snapshot.playing);
    }
  }

  destroy() { clearTimeout(this.timer); }

  // ------------------------------------------------ Wiedergabe

  currentPosition() {
    if (!this.current) return 0;
    const pos = this.playing ? this.positionMs + (Date.now() - this.refTime) : this.positionMs;
    return Math.max(0, Math.min(pos, this.current.durationMs));
  }

  setPlayback(positionMs, playing) {
    this.positionMs = this.current ? Math.max(0, Math.min(positionMs, this.current.durationMs)) : 0;
    this.refTime = Date.now();
    this.playing = Boolean(playing && this.current);
    this.syncId++;
    this.scheduleAdvance();
  }

  scheduleAdvance() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.playing || !this.current) return;
    const remaining = this.current.durationMs - this.currentPosition();
    this.timer = setTimeout(() => { this.advance(); this.broadcastState(); }, Math.max(0, remaining) + 250);
  }

  advance() {
    const wasPlaying = this.playing || !this.current;
    if (this.current) {
      this.history.push(this.current);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.current = this.queue.shift() || null;
    this.setPlayback(0, wasPlaying);
  }

  goBack() {
    if (this.currentPosition() > 3000 || this.history.length === 0) {
      this.setPlayback(0, this.playing);
      return;
    }
    if (this.current) this.queue.unshift(this.current);
    this.current = this.history.pop();
    this.setPlayback(0, true);
  }

  // ------------------------------------------------ Kommunikation

  state() {
    return {
      type: 'state',
      room: this.id,
      current: this.current,
      playing: this.playing,
      positionMs: this.positionMs,
      refTime: this.refTime,
      syncId: this.syncId,
      queue: this.queue,
      history: this.history,
      users: [...this.members].map(([cid, u]) => ({ ...u, cid })),
      serverTime: Date.now(),
    };
  }

  broadcastState() { this.emit(null, this.state()); }
  notify(text) { this.emit(null, { type: 'event', text }); }

  join(cid, user, { silent = false } = {}) {
    this.members.set(cid, {
      name: str(user?.name, 60) || 'Gast',
      image: /^https:\/\//.test(str(user?.image, 500)) ? str(user.image, 500) : '',
      host: Boolean(user?.host),
    });
    this.broadcastState();
    if (!silent) this.notify(`${this.members.get(cid).name} ist dem Raum beigetreten`);
  }

  leave(cid) {
    const u = this.members.get(cid);
    if (!u) return;
    this.members.delete(cid);
    this.broadcastState();
    this.notify(`${u.name} hat den Raum verlassen`);
  }

  handle(cid, msg) {
    const user = this.members.get(cid);
    if (!user || !msg || typeof msg.type !== 'string') return;
    const who = user.name;

    switch (msg.type) {
      case 'add': {
        const list = Array.isArray(msg.tracks) ? msg.tracks : [];
        const space = Math.max(0, MAX_QUEUE - this.queue.length);
        const tracks = list.slice(0, space).map((t) => cleanTrack({ ...t, uid: undefined }, who)).filter(Boolean);
        if (!tracks.length) return;
        if (msg.next) this.queue.unshift(...tracks); else this.queue.push(...tracks);
        if (!this.current) this.advance();
        this.broadcastState();
        this.notify(tracks.length === 1
          ? `${who} hat „${tracks[0].name}“ hinzugefügt`
          : `${who} hat ${tracks.length} Songs hinzugefügt`);
        return;
      }
      case 'remove': {
        const i = this.queue.findIndex((t) => t.uid === msg.uid);
        if (i < 0) return;
        this.queue.splice(i, 1);
        this.broadcastState();
        return;
      }
      case 'move': {
        const from = this.queue.findIndex((t) => t.uid === msg.uid);
        const to = Math.max(0, Math.min(Number(msg.to) | 0, this.queue.length - 1));
        if (from < 0 || from === to) return;
        const [item] = this.queue.splice(from, 1);
        this.queue.splice(to, 0, item);
        this.broadcastState();
        return;
      }
      case 'clear':
        this.queue = [];
        this.broadcastState();
        this.notify(`${who} hat die Warteschlange geleert`);
        return;
      case 'shuffle':
        for (let i = this.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
        this.broadcastState();
        this.notify(`${who} hat die Warteschlange gemischt`);
        return;
      case 'playNow': {
        const i = this.queue.findIndex((t) => t.uid === msg.uid);
        if (i < 0) return;
        const [item] = this.queue.splice(i, 1);
        if (this.current) this.history.push(this.current);
        this.current = item;
        this.setPlayback(0, true);
        this.broadcastState();
        return;
      }
      case 'play':
        if (!this.current) { if (this.queue.length) this.advance(); else return; }
        this.setPlayback(this.currentPosition(), true);
        this.broadcastState();
        return;
      case 'pause':
        if (!this.current) return;
        this.setPlayback(this.currentPosition(), false);
        this.broadcastState();
        return;
      case 'seek': {
        const pos = Number(msg.positionMs);
        if (!this.current || !Number.isFinite(pos)) return;
        this.setPlayback(pos, this.playing);
        this.broadcastState();
        return;
      }
      case 'next':
        if (!this.current && !this.queue.length) return;
        this.advance();
        this.broadcastState();
        this.notify(`${who} hat übersprungen`);
        return;
      case 'prev':
        this.goBack();
        this.broadcastState();
        return;
    }
  }
}
