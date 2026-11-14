SONGS TOGETHER
==============

Gemeinsam Spotify hören: Raum erstellen, Link teilen, alle hören synchron.
Jeder kann Songs hinzufügen, skippen, zurückgehen und spulen.

- Die Musik läuft direkt im Browser (Spotify Web Playback SDK), nicht in der Spotify-App
- Gemeinsame Warteschlange: Songs, Alben und Playlists aus der Spotify-App reinziehen,
  Link mit Strg+V einfügen oder über die Suche hinzufügen
- Warteschlange per Drag & Drop umsortieren, Songs mischen, entfernen, "als Nächstes" einreihen
- Lautstärke gilt nur für dich
- Tastenkürzel:
    Leertaste                    Play/Pause
    Pfeil links/rechts           10 Sekunden spulen
    Shift + Pfeil links/rechts   vorheriger/nächster Song


VORAUSSETZUNGEN
---------------

- Node.js 20.12 oder neuer
- Spotify Premium für jeden, der mithört (das verlangt Spotify für die Wiedergabe im Browser)
- Desktop-Browser (Chrome, Edge oder Firefox). Auf Handys funktioniert das Web Playback SDK nicht.


EINRICHTUNG
-----------

1. Spotify-App anlegen
   a) https://developer.spotify.com/dashboard öffnen und auf "Create app" klicken
   b) Als Redirect URI genau das hier eintragen:
          http://127.0.0.1:3000/callback
      (Spotify akzeptiert "localhost" nicht mehr, deshalb 127.0.0.1)
   c) Bei den APIs "Web API" und "Web Playback SDK" anhaken
   d) Die Client ID kopieren (das Client Secret brauchst du nicht)

2. Konfigurieren und starten
   Im Projektordner ausführen:
          npm install
          copy .env.example .env
   Dann in der Datei .env die Zeile SPOTIFY_CLIENT_ID= mit deiner Client ID ergänzen und starten:
          npm start
   Danach http://127.0.0.1:3000 im Browser öffnen.

3. Freunde freischalten
   Neue Spotify-Apps laufen im "Development Mode". Dort können sich nur Nutzer anmelden,
   die du im Dashboard unter "User Management" einträgst (Name + E-Mail ihres Spotify-Accounts).
   Spotify begrenzt die Zahl dieser Nutzer.


MIT FREUNDEN ÜBER DAS INTERNET
------------------------------

Deine Freunde müssen den Server erreichen können, und Spotify verlangt für alles
außer 127.0.0.1 HTTPS.

Variante A: kostenlos hosten (empfohlen), z. B. bei Render (https://render.com)
   1. Das Projekt in ein GitHub-Repo hochladen
   2. Bei Render einen "Web Service" anlegen:
          Build-Befehl:  npm install
          Start-Befehl:  npm start
   3. Die Umgebungsvariable SPOTIFY_CLIENT_ID setzen
   4. Im Spotify-Dashboard zusätzlich diese Redirect URI eintragen:
          https://DEIN-NAME.onrender.com/callback

Variante B: Tunnel vom eigenen PC, z. B. mit:
          cloudflared tunnel --url http://127.0.0.1:3000
   Die angezeigte https://...trycloudflare.com-Adresse + /callback musst du jedes Mal
   als Redirect URI eintragen, weil sich die Adresse bei jedem Start ändert.


SO FUNKTIONIERT DIE SYNCHRONISIERUNG
------------------------------------

- Der Server ist maßgeblich: Er speichert pro Raum den Song, die Position und einen
  Zeitstempel und entscheidet, wann ein Song zu Ende ist. So gibt es keine Konflikte,
  wenn mehrere gleichzeitig klicken.
- Jeder Browser misst laufend den Uhrzeit-Unterschied zum Server (wie bei NTP).
  Dadurch weiß jeder Client auf ein paar Millisekunden genau, an welcher Stelle der Song
  gerade sein sollte.
- Jede Sekunde wird die eigene Position mit dem Sollwert verglichen. Liegt die Abweichung
  über 180 ms, wird nachjustiert. Die Verzögerung beim Spulen wird gemessen und beim
  nächsten Mal mit eingerechnet (Seek-Ausgleich).
- Skip, Spulen, Play und Pause lösen bei allen sofort eine Synchronisierung aus.
- Die Statusanzeige oben rechts zeigt die aktuelle Abweichung; der Tooltip zeigt Ping
  und Seek-Ausgleich.

Räume liegen im Arbeitsspeicher des Servers. Startet der Server neu, sind die
Warteschlangen weg.
