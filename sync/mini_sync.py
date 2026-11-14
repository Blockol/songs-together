"""Songs Together Sync

Koppelt den Mini-Player von Songs Together an die Spotify-App für Windows:
  * Spotify-Fenster offen            -> Mini-Player ist sichtbar (egal welches Fenster im Fokus ist)
  * Spotify minimiert / geschlossen  -> Mini-Player wird sofort ausgeblendet
  * Spotify-Fenster wird verschoben -> Mini-Player wandert mit
  * Spotify-Fenster wird größer/kleiner -> Mini-Player skaliert im selben Verhältnis mit
  * Mini-Player neu geöffnet         -> erscheint wieder an derselben Stelle im Spotify-Fenster
  * Nicht angepinnt                  -> liegt trotzdem immer vor dem Spotify-Fenster
  * Angepinnt in Firefox/Opera       -> wird über alle anderen Fenster gelegt (dort gibt es kein
                                        Document Picture-in-Picture)

Läuft unsichtbar im Hintergrund mit einem Symbol im Infobereich der Taskleiste.
Nur Windows. Nutzt die Windows-API direkt über ctypes.
"""

import ctypes
import json
import math
import os
import sys
import threading
import time
import winreg
from ctypes import wintypes

import pystray
from PIL import Image, ImageDraw

APP_NAME = "Songs Together Sync"
MINI_MARKER = "Songs Together Mini-Player"  # steht im Fenstertitel des Mini-Players
PIN_MARKER = MINI_MARKER + " (angepinnt)"    # Popup, das wir selbst anpinnen sollen
SPOTIFY_EXE = "spotify.exe"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "SongsTogetherSync"

TICK = 0.02          # Sekunden zwischen zwei Prüfungen (flüssiges Mitwandern)
RESCAN = 0.5         # Sekunden zwischen zwei Fenstersuchen, solange etwas fehlt

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

SW_HIDE, SW_SHOWNOACTIVATE = 0, 4
SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_NOACTIVATE = 0x0001, 0x0002, 0x0004, 0x0010
SWP_NOOWNERZORDER = 0x0200
HWND_TOP, HWND_TOPMOST = 0, -1
GW_HWNDPREV = 3
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
ERROR_ALREADY_EXISTS = 183

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetWindow.restype = wintypes.HWND
user32.GetForegroundWindow.restype = wintypes.HWND
user32.MonitorFromRect.argtypes = [ctypes.POINTER(wintypes.RECT), wintypes.DWORD]
user32.MonitorFromRect.restype = wintypes.HANDLE
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CreateMutexW.restype = wintypes.HANDLE

EVENT_SYSTEM_FOREGROUND = 0x0003
EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND = 0x0016, 0x0017
WINEVENT_OUTOFCONTEXT = 0
WINEVENTPROC = ctypes.WINFUNCTYPE(None, wintypes.HANDLE, wintypes.DWORD, wintypes.HWND,
                                  wintypes.LONG, wintypes.LONG, wintypes.DWORD, wintypes.DWORD)
user32.SetWinEventHook.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.HMODULE, WINEVENTPROC,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.DWORD]
user32.SetWinEventHook.restype = wintypes.HANDLE


# ------------------------------------------------------------------ Windows-Helfer

def window_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if not n:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def window_pid(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


_exe_cache = {}


def process_exe(pid):
    """Dateiname der .exe zu einer Prozess-ID (klein geschrieben)."""
    if pid in _exe_cache:
        return _exe_cache[pid]
    name = ""
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if h:
        try:
            size = wintypes.DWORD(1024)
            buf = ctypes.create_unicode_buffer(size.value)
            if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                name = os.path.basename(buf.value).lower()
        finally:
            kernel32.CloseHandle(h)
    if len(_exe_cache) > 500:
        _exe_cache.clear()
    _exe_cache[pid] = name
    return name


def rect(hwnd):
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def all_windows():
    found = []

    def cb(hwnd, _):
        found.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def find_spotify():
    """Das Hauptfenster der Spotify-App (größtes Fenster mit Titel, ohne Besitzer)."""
    best, best_area = None, 0
    for hwnd in all_windows():
        if not user32.IsWindowVisible(hwnd) or not window_title(hwnd):
            continue
        if user32.GetWindow(hwnd, 4):  # GW_OWNER: Dialoge/Menüs überspringen
            continue
        if process_exe(window_pid(hwnd)) != SPOTIFY_EXE:
            continue
        _, _, w, h = rect(hwnd)
        if w * h >= best_area:
            best, best_area = hwnd, w * h
    return best


BROWSERS = {"chrome.exe", "msedge.exe", "brave.exe", "opera.exe", "vivaldi.exe", "firefox.exe"}
WS_EX_TOPMOST = 0x0008
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]


def is_topmost(hwnd):
    return bool(user32.GetWindowLongW(hwnd, -20) & WS_EX_TOPMOST)


def is_below(hwnd, other, limit=2000):
    """True, wenn hwnd in der Fensterreihenfolge hinter other liegt."""
    h = hwnd
    for _ in range(limit):
        h = user32.GetWindow(h, GW_HWNDPREV)
        if not h:
            return False
        if h == other:
            return True
    return False


def raise_above(hwnd, other):
    """hwnd direkt vor other legen, ohne den Fokus zu verändern und ohne andere Fenster zu verdecken."""
    prev = user32.GetWindow(other, GW_HWNDPREV)
    # Liegt direkt vor Spotify ein „immer im Vordergrund“-Fenster (oder gar keins), ist Spotify das
    # oberste normale Fenster -> ganz nach oben (bei den normalen Fenstern).
    after = prev if prev and prev != hwnd and not is_topmost(prev) else HWND_TOP
    user32.SetWindowPos(hwnd, after, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)


def find_mini():
    """Das Mini-Player-Fenster (auch wenn es gerade von uns ausgeblendet ist).

    Angepinnt (Document Picture-in-Picture) gibt Chrome dem Fenster den Titel des Haupt-Tabs,
    z. B. „Songs Together“ – erkennbar ist es daran, dass es immer im Vordergrund liegt.
    Als normales Popup trägt es den Titel „… Songs Together Mini-Player“.
    """
    for hwnd in all_windows():
        title = window_title(hwnd)
        if "Songs Together" not in title:
            continue
        if process_exe(window_pid(hwnd)) not in BROWSERS:
            continue
        if is_topmost(hwnd) or MINI_MARKER in title:
            return hwnd
    return None


def on_some_monitor(x, y, w, h):
    """True, wenn die Titelleiste des Fensters an dieser Stelle auf einem Bildschirm läge."""
    r = wintypes.RECT(x, y, x + w, y + 30)
    return bool(user32.MonitorFromRect(ctypes.byref(r), 0))  # MONITOR_DEFAULTTONULL


# ------------------------------------------------------------------ Gemerkte Position

def _data_dir():
    return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Programs", "SongsTogetherSync")


POSITION_FILE = os.path.join(_data_dir(), "position.json")


def load_position():
    try:
        with open(POSITION_FILE, encoding="utf-8") as f:
            d = json.load(f)
        kinds = {"x": int, "y": int, "dx": int, "dy": int, "ax": str, "ay": str, "rw": float, "rh": float}
        return {k: kinds[k](v) for k, v in d.items() if k in kinds}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def save_position(pos):
    try:
        os.makedirs(os.path.dirname(POSITION_FILE), exist_ok=True)
        with open(POSITION_FILE, "w", encoding="utf-8") as f:
            json.dump(pos, f)
    except OSError:
        pass


def relative_to(mini, spotify):
    """Lage des Mini-Players im Spotify-Fenster, gemessen von der nächstgelegenen Ecke.

    Liegt der Mini-Player z. B. unten rechts, bleibt er auch bei anderer Fenstergröße
    mit demselben Abstand unten rechts.
    """
    mx, my, mw, mh = mini
    sx, sy, sw, sh = spotify
    if mx + mw / 2 < sx + sw / 2:
        ax, dx = "left", mx - sx
    else:
        ax, dx = "right", (mx + mw) - (sx + sw)
    if my + mh / 2 < sy + sh / 2:
        ay, dy = "top", my - sy
    else:
        ay, dy = "bottom", (my + mh) - (sy + sh)
    return {"ax": ax, "dx": dx, "ay": ay, "dy": dy}


MIN_W, MIN_H = 120, 80   # kleiner wird der Mini-Player beim Mitskalieren nicht


def scale_ref(spotify):
    """Bezugsgröße des Spotify-Fensters fürs Mitskalieren (Wurzel der Fläche):
    wird Spotify nur schmaler oder nur niedriger, schrumpft der Mini-Player ein wenig mit,
    behält aber sein eigenes Seitenverhältnis."""
    _, _, sw, sh = spotify
    return math.sqrt(max(1, sw) * max(1, sh))


def scaled_size(scale, spotify):
    rw, rh = scale
    ref = scale_ref(spotify)
    _, _, sw, sh = spotify
    w = max(MIN_W, min(round(rw * ref), sw))
    h = max(MIN_H, min(round(rh * ref), sh))
    return w, h


def place_relative(rel, mini_size, spotify):
    mw, mh = mini_size
    sx, sy, sw, sh = spotify
    x = sx + rel["dx"] if rel["ax"] == "left" else sx + sw + rel["dx"] - mw
    y = sy + rel["dy"] if rel["ay"] == "top" else sy + sh + rel["dy"] - mh
    return x, y


# ------------------------------------------------------------------ Autostart

def exe_command():
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --autostart'
    return f'"{sys.executable}" "{os.path.abspath(__file__)}" --autostart'


def autostart_enabled():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, RUN_VALUE)
            return True
    except OSError:
        return False


def set_autostart(on):
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            winreg.SetValueEx(k, RUN_VALUE, 0, winreg.REG_SZ, exe_command())
        else:
            try:
                winreg.DeleteValue(k, RUN_VALUE)
            except FileNotFoundError:
                pass


# ------------------------------------------------------------------ Kopplung

class Sync:
    def __init__(self):
        self.enabled = True
        self.running = True
        self.spotify = None
        self.mini = None
        self.hidden = False          # haben WIR den Mini-Player ausgeblendet?
        self.last_rect = None        # letzte Position/Größe von Spotify
        self.minimizing = False
        self.next_scan = 0.0
        self.first_scan = True       # beim Programmstart schon offene Mini-Player nicht verschieben
        self.saved_pos = load_position()
        self.pending_pos = None      # zuletzt beobachtete, noch nicht gespeicherte Position
        self.pending_since = 0.0
        p = self.saved_pos
        self.scale = (p["rw"], p["rh"]) if "rw" in p and "rh" in p else None
        self.applied_size = None     # Größe, die WIR dem Mini-Player zuletzt gegeben haben
        self.min_size = (0, 0)       # von Chrome erzwungene Mindestgröße (wird gelernt)
        self.anchor = None           # Ecke/Abstand, festgehalten während Spotify skaliert wird

    def scale_of(self, mini_r, spotify_r):
        """Größe des Mini-Players im Verhältnis zum Spotify-Fenster.

        Solange er noch genau so groß ist, wie wir ihn zuletzt gesetzt haben, bleibt das gemerkte
        Verhältnis bestehen (sonst würden Runden und Mindestgröße es nach und nach verfälschen).
        Hat ihn jemand selbst größer/kleiner gezogen, gilt ab jetzt das neue Verhältnis."""
        size = tuple(mini_r[2:])
        if self.scale and size == self.applied_size:
            return self.scale
        ref = scale_ref(spotify_r)
        self.scale = (size[0] / ref, size[1] / ref)
        self.applied_size = size
        return self.scale

    def place_mini(self, rel, size, spotify):
        """Mini-Player in dieser Größe an die gemerkte Ecke des Spotify-Fensters setzen.

        Chrome erzwingt eine Mindestgröße: Ist das Fenster danach größer als verlangt, wird es
        mit der echten Größe neu ausgerichtet – sonst ragt es über die Ecke hinaus und
        wandert bei jedem Schritt ein Stück weiter weg."""
        w, h = max(size[0], self.min_size[0]), max(size[1], self.min_size[1])
        x, y = place_relative(rel, (w, h), spotify)
        if not on_some_monitor(x, y, w, h):
            return
        user32.SetWindowPos(self.mini, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE)
        _, _, aw, ah = rect(self.mini)
        if (aw, ah) != (w, h):
            if aw > w or ah > h:  # Mindestgröße von Chrome merken
                self.min_size = (max(self.min_size[0], aw if aw > w else 0),
                                 max(self.min_size[1], ah if ah > h else 0))
            x, y = place_relative(rel, (aw, ah), spotify)
            user32.SetWindowPos(self.mini, None, x, y, 0, 0,
                                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
        self.applied_size = (aw, ah)

    def show_mini(self):
        if self.mini and self.hidden:
            user32.ShowWindow(self.mini, SW_SHOWNOACTIVATE)
            self.hidden = False
            self.keep_in_front()

    def keep_in_front(self):
        """Angepinntes Popup (Firefox/Opera) über alle Fenster legen; nicht angepinnten
        Mini-Player zumindest immer vor dem Spotify-Fenster halten."""
        if not self.mini or self.hidden:
            return
        if is_topmost(self.mini):
            return  # Document Picture-in-Picture oder schon von uns angepinnt
        if PIN_MARKER in window_title(self.mini):
            user32.SetWindowPos(self.mini, HWND_TOPMOST, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
            return
        if self.spotify and not user32.IsIconic(self.spotify) and is_below(self.mini, self.spotify):
            raise_above(self.mini, self.spotify)

    def hide_mini(self):
        if self.mini and not self.hidden:
            user32.ShowWindow(self.mini, SW_HIDE)
            self.hidden = True

    def release(self):
        """Mini-Player wieder sichtbar machen (z. B. beim Beenden oder Pausieren)."""
        self.show_mini()

    def refresh_handles(self, now):
        if self.spotify and not user32.IsWindow(self.spotify):
            self.spotify = None
            self.last_rect = None
        if self.mini and not user32.IsWindow(self.mini):
            self.mini = None
            self.hidden = False
        # Spotify kann sein Hauptfenster austauschen (z. B. beim Schließen in den Infobereich)
        if self.spotify and not user32.IsWindowVisible(self.spotify):
            self.spotify = None
            self.last_rect = None
        if (not self.spotify or not self.mini) and now >= self.next_scan:
            self.next_scan = now + RESCAN
            if not self.spotify:
                self.spotify = find_spotify()
                self.last_rect = rect(self.spotify) if self.spotify else None
            if not self.mini:
                self.mini = find_mini()
                self.hidden = bool(self.mini) and not user32.IsWindowVisible(self.mini)
                if self.mini and not self.first_scan:
                    self.restore_position()
            self.first_scan = False

    def restore_position(self):
        """Neu geöffneten Mini-Player an dieselbe Stelle im Spotify-Fenster setzen
        (ist Spotify gerade nicht offen: an dieselbe Stelle auf dem Bildschirm)."""
        p = self.saved_pos
        _, _, w, h = rect(self.mini)
        if self.spotify and not user32.IsIconic(self.spotify) and "ax" in p:
            sp = rect(self.spotify)
            if self.scale:  # Größe an das jetzige Spotify-Fenster anpassen
                w, h = scaled_size(self.scale, sp)
            self.place_mini(p, (w, h), sp)
            return
        elif "x" in p:
            x, y = p["x"], p["y"]
        else:
            return
        if on_some_monitor(x, y, w, h):
            user32.SetWindowPos(self.mini, None, x, y, 0, 0,
                                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)

    def remember_position(self, now):
        """Position des Mini-Players speichern, sobald sie sich eine Sekunde nicht mehr ändert."""
        if user32.IsIconic(self.mini) or self.hidden:
            return
        r = rect(self.mini)
        pos = dict(self.saved_pos, x=r[0], y=r[1])
        if self.spotify and not user32.IsIconic(self.spotify):
            sp = rect(self.spotify)
            pos.update(relative_to(r, sp))
            rw, rh = self.scale_of(r, sp)
            pos.update(rw=round(rw, 5), rh=round(rh, 5))
        if pos == self.saved_pos:
            self.pending_pos = None
            return
        if pos != self.pending_pos:
            self.pending_pos, self.pending_since = pos, now
        elif now - self.pending_since >= 1.0:
            self.saved_pos, self.pending_pos = pos, None
            save_position(pos)

    def follow_spotify(self):
        """Verschiebt den Mini-Player um dieselbe Strecke wie das Spotify-Fenster und
        skaliert ihn mit, wenn Spotify größer oder kleiner wird."""
        if not self.spotify or user32.IsIconic(self.spotify):
            return
        cur = rect(self.spotify)
        prev, self.last_rect = self.last_rect, cur
        if not prev or not self.mini or cur[2:] == prev[2:]:
            self.anchor = None  # Skalieren ist vorbei -> beim nächsten Mal Lage neu bestimmen
        if not prev or not self.mini or cur == prev:
            return
        dx, dy = cur[0] - prev[0], cur[1] - prev[1]
        mr = rect(self.mini)
        if cur[2:] == prev[2:]:  # nur verschoben
            user32.SetWindowPos(self.mini, None, mr[0] + dx, mr[1] + dy, 0, 0,
                                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
            return
        if self.hidden or user32.IsIconic(self.mini):
            return
        # Größe geändert (auch Maximieren): gleiche Ecke, gleicher Abstand, gleiches Größenverhältnis
        # Die Lage wird zu Beginn einmal bestimmt und bleibt während des Skalierens fest,
        # damit sich keine Abweichungen von Schritt zu Schritt aufaddieren.
        if self.anchor is None:
            self.anchor = relative_to(mr, prev)
        self.place_mini(self.anchor, scaled_size(self.scale_of(mr, prev), cur), cur)

    def tick(self):
        now = time.monotonic()
        self.refresh_handles(now)
        if not self.mini:
            return
        self.follow_spotify()
        self.remember_position(now)

        if self.minimizing and self.spotify and user32.IsIconic(self.spotify):
            self.minimizing = False
        if self.minimizing:
            return  # Minimieren läuft gerade (Animation) -> ausgeblendet lassen
        if self.spotify and not user32.IsIconic(self.spotify):
            self.show_mini()
            self.keep_in_front()
        else:
            self.hide_mini()

    def on_win_event(self, event, hwnd):
        """Windows meldet Beginn/Ende des Minimierens und Fensterwechsel – schneller als jede Abfrage."""
        if not self.enabled or not self.mini:
            return
        if hwnd != self.spotify and process_exe(window_pid(hwnd)) != SPOTIFY_EXE:
            return
        if event == EVENT_SYSTEM_FOREGROUND:  # Spotify wurde angeklickt -> Mini-Player sofort davor
            if hwnd == self.spotify:
                self.keep_in_front()
        elif event == EVENT_SYSTEM_MINIMIZESTART:
            self.minimizing = True
            self.hide_mini()
        elif event == EVENT_SYSTEM_MINIMIZEEND:
            self.minimizing = False
            self.show_mini()

    def watch_events(self):
        """Eigener Thread: Windows-Ereignisse (Minimieren) empfangen."""
        def cb(_hook, event, hwnd, _obj, _child, _thread, _time):
            try:
                self.on_win_event(event, hwnd)
            except Exception:
                pass

        self._proc = WINEVENTPROC(cb)  # Referenz behalten, sonst räumt Python sie weg
        user32.SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, None,
                               self._proc, 0, 0, WINEVENT_OUTOFCONTEXT)
        user32.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None,
                               self._proc, 0, 0, WINEVENT_OUTOFCONTEXT)
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    def loop(self):
        while self.running:
            try:
                if self.enabled:
                    self.tick()
            except Exception:  # nie abstürzen, beim nächsten Durchlauf neu versuchen
                self.spotify = self.mini = None
            time.sleep(TICK)
        self.release()


# ------------------------------------------------------------------ Infobereich-Symbol

def make_icon():
    s = 64
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((2, 2, s - 2, s - 2), fill=(30, 215, 96, 255))
    ink = (4, 20, 10, 255)
    d.ellipse((17, 33, 31, 47), fill=ink)
    d.ellipse((35, 29, 49, 43), fill=ink)
    d.line([(29, 40), (29, 18), (49, 13), (49, 36)], fill=ink, width=4, joint="curve")
    return img


# ------------------------------------------------------------------ Einrichtung (Setup)
# Die exe enthält Python und alle Pakete bereits – installiert werden muss nichts.
# Beim ersten Start kopiert sie sich nach %LOCALAPPDATA%\Programs\SongsTogetherSync,
# damit sie auch dann weiterläuft, wenn die heruntergeladene Datei gelöscht wird.
# Eine neuere heruntergeladene Version ersetzt dabei die alte (= Update).

INSTALL_DIR = _data_dir()
INSTALL_EXE = os.path.join(INSTALL_DIR, "SongsTogether-Sync.exe")
FIRST_RUN_MARKER = os.path.join(INSTALL_DIR, "eingerichtet.txt")
MB_YESNO, MB_ICONQUESTION, MB_ICONINFO, IDYES = 0x04, 0x20, 0x40, 6


def message(text, flags=MB_ICONINFO):
    return user32.MessageBoxW(None, text, APP_NAME, flags)


def install_if_needed():
    """True, wenn sich diese (heruntergeladene) exe in den Programmordner kopiert hat und die Kopie starten soll."""
    if not getattr(sys, "frozen", False):
        return False
    me = os.path.normcase(os.path.abspath(sys.executable))
    if me == os.path.normcase(INSTALL_EXE):
        return False
    try:
        os.makedirs(INSTALL_DIR, exist_ok=True)
        import shutil
        shutil.copy2(sys.executable, INSTALL_EXE)
    except OSError:
        return False  # Kopieren klappt nicht -> einfach von hier aus laufen
    return True


def first_run_setup():
    """Nur beim allerersten Start: fragen, ob das Programm mit Windows starten soll."""
    if os.path.exists(FIRST_RUN_MARKER):
        return
    answer = message(
        "Songs Together Sync ist eingerichtet.\n\n"
        "Es zeigt den Mini-Player von Songs Together, solange die Spotify-App offen ist, blendet ihn "
        "beim Minimieren von Spotify aus und lässt ihn mit dem Spotify-Fenster mitwandern.\n\n"
        "Soll es automatisch mit Windows starten? (Empfohlen – lässt sich später über das "
        "Symbol unten rechts in der Taskleiste ändern.)",
        MB_YESNO | MB_ICONQUESTION)
    try:
        set_autostart(answer == IDYES)
    except OSError:
        pass
    try:
        os.makedirs(INSTALL_DIR, exist_ok=True)
        with open(FIRST_RUN_MARKER, "w", encoding="utf-8") as f:
            f.write("Songs Together Sync wurde eingerichtet.\n")
    except OSError:
        pass


def main():
    # Nur eine Instanz gleichzeitig
    mutex = kernel32.CreateMutexW(None, False, "SongsTogetherSyncMutex")
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        message(f"{APP_NAME} läuft bereits (Symbol unten rechts in der Taskleiste).\n\n"
                "Zum Aktualisieren: dort per Rechtsklick „Beenden“ und die neue Datei erneut starten.")
        return

    # Setup: in den festen Programmordner kopieren und von dort starten
    if install_if_needed():
        kernel32.CloseHandle(mutex)  # erst freigeben, damit die installierte Kopie starten darf
        import subprocess
        subprocess.Popen([INSTALL_EXE] + sys.argv[1:], close_fds=True)
        return
    first_run_setup()
    if autostart_enabled():
        set_autostart(True)  # Pfad im Autostart aktuell halten

    sync = Sync()
    worker = threading.Thread(target=sync.loop, daemon=True)
    worker.start()
    threading.Thread(target=sync.watch_events, daemon=True).start()

    def toggle_enabled(icon, _):
        sync.enabled = not sync.enabled
        if not sync.enabled:
            sync.release()

    def toggle_autostart(icon, _):
        try:
            set_autostart(not autostart_enabled())
        except OSError as e:
            icon.notify(f"Autostart konnte nicht geändert werden: {e}", APP_NAME)

    def quit_app(icon, _):
        sync.running = False
        worker.join(timeout=1)
        sync.release()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem(APP_NAME, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Mini-Player an Spotify koppeln", toggle_enabled, checked=lambda _: sync.enabled),
        pystray.MenuItem("Mit Windows starten", toggle_autostart, checked=lambda _: autostart_enabled()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Beenden", quit_app),
    )
    icon = pystray.Icon("songs-together-sync", make_icon(), APP_NAME, menu)

    def setup(icon):
        icon.visible = True
        if "--autostart" not in sys.argv:
            icon.notify("Läuft jetzt im Hintergrund. Öffne in Songs Together den Mini-Player – "
                        "er ist dann da, solange Spotify offen ist.", APP_NAME)

    try:
        icon.run(setup=setup)
    finally:
        sync.running = False
        sync.release()


if __name__ == "__main__":
    main()
