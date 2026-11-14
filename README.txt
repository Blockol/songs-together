SONGS TOGETHER
==============

Gemeinsam Spotify hören: Raum erstellen, Link teilen, alle hören synchron.
Jeder kann Songs hinzufügen, skippen, zurückgehen und spulen.

Online:  https://blockol.github.io/songs-together/

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

- Spotify Premium für jeden, der mithört (das verlangt Spotify für die Wiedergabe im Browser)
- Desktop-Browser (Chrome, Edge oder Firefox). Auf Handys funktioniert das Web Playback SDK nicht.
- Jeder Nutzer muss im Spotify-Dashboard unter "User Management" eingetragen sein
  (Name + E-Mail seines Spotify-Accounts), solange die App im Development Mode ist.


SPOTIFY-DASHBOARD EINSTELLUNGEN
-------------------------------

https://developer.spotify.com/dashboard -> App "SONGS TOGETHER" -> Settings -> Edit

Redirect URIs (genau so, mit Schrägstrich am Ende):
    https://blockol.github.io/songs-together/
    http://127.0.0.1:3000/            (nur für lokales Testen)

APIs: Web API + Web Playback SDK

Die Client ID steht in docs/config.js.


WIE ES FUNKTIONIERT (HOST UND HOST-ÜBERGABE)
--------------------------------------------

Es gibt keinen eigenen Server. Die Website liegt auf GitHub Pages, und die Teilnehmer
verbinden sich direkt miteinander (Peer-to-Peer über WebRTC, vermittelt durch den
kostenlosen PeerJS-Server).

- Wer einen Raum erstellt, ist der Host (Abzeichen "Host" oben neben dem Raumcode).
  Sein Browser verwaltet Warteschlange und Wiedergabestand.
- Jeder kann einen Raum erstellen und damit Host sein.
- Verlässt der Host den Raum, übernimmt automatisch der Nächste (in Beitrittsreihenfolge).
  Die Musik läuft weiter, die Warteschlange bleibt erhalten.
- Der Raum existiert, solange mindestens eine Person drin ist. Ist der Raum leer und
  jemand öffnet den Link wieder, startet ein neuer, leerer Raum mit demselben Code.


SO FUNKTIONIERT DIE SYNCHRONISIERUNG
------------------------------------

- Der Host ist maßgeblich: Er speichert den Song, die Position und einen Zeitstempel und
  entscheidet, wann ein Song zu Ende ist. So gibt es keine Konflikte, wenn mehrere
  gleichzeitig klicken.
- Jeder Browser misst laufend den Uhrzeit-Unterschied zum Host (wie bei NTP). Dadurch weiß
  jeder auf ein paar Millisekunden genau, an welcher Stelle der Song gerade sein sollte.
- Jede Sekunde wird die eigene Position mit dem Sollwert verglichen. Liegt die Abweichung
  über 180 ms, wird nachjustiert. Die Verzögerung beim Spulen wird gemessen und beim
  nächsten Mal mit eingerechnet (Seek-Ausgleich).
- Skip, Spulen, Play und Pause lösen bei allen sofort eine Synchronisierung aus.
- Die Statusanzeige oben rechts zeigt die aktuelle Abweichung; der Tooltip zeigt Ping
  und Seek-Ausgleich.


LOKAL TESTEN
------------

Node.js installieren, dann im Projektordner:
    npm start
und http://127.0.0.1:3000/ öffnen.


ÄNDERUNGEN VERÖFFENTLICHEN
--------------------------

Alles im Ordner docs/ ist die Website. Nach einem Push auf GitHub (Branch main) ist die
neue Version nach etwa einer Minute online.
