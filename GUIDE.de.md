# Anleitung

> **Wichtig für Fehler-Reports:** Schalte unten auf der Seite den **Diagnose-Log** ein, *bevor* du dich mit dem Scooter verbindest. Nur dann wird der komplette Verbindungsaufbau mitgeschnitten - und genau diese Zeilen brauchen wir in einem [Ticket](https://github.com/Laufbursche42/Laufbursche42/issues), um ein Problem nachzuvollziehen.

## Was du brauchst
- Einen STREETBOOSTER E-Scooter.
- Ein Handy oder einen Rechner mit **Chrome**, **Edge** oder auf iOS **Bluefy**. Safari und Firefox können kein Web Bluetooth.

## Verbinden
1. Bluetooth am Gerät einschalten, den Scooter einschalten (wecken).
2. Auf **Verbinden** tippen und den Scooter in der Liste auswählen.
3. Taucht er nicht auf, setze den Haken bei **Alle Geräte zeigen** und verbinde erneut. Der echte Test ist der gefundene Bluetooth-Dienst (F1F0), nicht der angezeigte Name.
4. Nach dem Verbinden erscheinen die Karten für Live-Werte, Sperre, Geschwindigkeit und Einstellungen.

## Live-Werte lesen
Der Scooter sendet laufend seine Telemetrie (0xAB-Frames). Jede Kachel erscheint, sobald ihr Wert angekommen ist; ein Strich heißt nur, dass dieser Wert noch nicht kam. Unter den Kacheln kannst du mit **Alle empfangenen Frames** die Rohdaten pro Opcode mitlesen.

## Geschwindigkeit setzen
- **Entsperren** schreibt den Wert aus dem Feld **Offen**, **Sperren** den Wert aus **eKFV / legal**. Beide schreiben das Tempolimit-Register 32 (km/h x10) und bestätigen mit einem Schreibvorgang auf Register 73. Der Knopf beschriftet sich aus dem Limit, das der Scooter wirklich meldet.
- Mit **Genau setzen** schreibst du einen beliebigen km/h-Wert direkt (1 bis 60).
- Wichtig: Ein Echo im Log heißt nur, dass der Scooter das Frame angenommen hat. Erst wenn sich das Tempolimit in den Live-Werten ändert, ist der Wert wirklich aktiv. Ob die Firmware mehr als die erlaubten 20 km/h akzeptiert, musst du an deinem Gerät ausprobieren.

## Sperre
In der Karte **Sperre** sperrst oder entsperrst du den Scooter (Immobilizer). Die Sperre reitet im Live-Monitor-Frame (0xAB, Status-Bit 7). Beachte: Einen gesperrten Scooter kannst du nur über Bluetooth wieder entsperren.

## Weitere Einstellungen
Licht, Tempomat, Einheit (km/mi), Anfahrmodus und Ambientelicht. Alle reiten im selben 0xAB-Monitor-Frame, das auch die Geschwindigkeitsgrenzen trägt; die Seite baut es aus dem zuletzt gemeldeten Stand neu auf. Es erscheinen nur Zeilen, deren Wert der Scooter auch meldet.

## Erweiterte Einstellungen (Engine-Ebene)
**Rohes Frame** sendet deine Hex-Bytes unverändert. **Register lesen und schreiben** nimmt Registeradresse (hex) und Wert und baut daraus ein korrektes 0x03-Lese- oder 0x17-Schreib-Frame mit CRC16/MODBUS.

## Shortcuts
Kopiere den Link auf den Startbildschirm, dann ent- oder sperrt ein Tipp direkt. Auf iOS über Bluefy, und der Scooter muss vorher einmal normal verbunden gewesen sein.

## Wenn etwas nicht geht
- Kein Verbinden? Prüfe, dass der Browser Web Bluetooth kann, Bluetooth an ist und der Scooter wach ist. Mit **Alle Geräte zeigen** erneut versuchen.
- Nichts passiert nach einem Befehl? Schau ins Log: steht dort "gesendet" aber kein "bestätigt", hat die Firmware das Frame nicht quittiert.
- Keine Live-Werte? Der Scooter sendet die Telemetrie vielleicht erst nach dem Keep-Alive, das die Seite automatisch schickt. Bleibt alles leer, meldet dein Modell die Werte eventuell anders.
- **Diagnose: alle Geräte auflisten** im Log-Bereich zeigt alle Bluetooth-Dienste eines Geräts, ohne etwas zu schreiben - hilfreich für Support.

## Mithelfen
Willst du herausfinden, ob und wie Tuning bei deinem Scooter geht? Teste dieses Tool an deinem eigenen Fahrzeug und öffne ein Ticket auf [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - mit deinem Modell und was funktioniert hat (oder nicht). So finden wir gemeinsam heraus, was bei welchem Modell möglich ist.
