# Laufbursche STREETBOOSTER unlock

A static web page that talks to STREETBOOSTER e-scooters over Web Bluetooth. Connect, read the live values and - straight from the browser - set the maximum speed, lock and unlock the scooter and change display settings. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** or **Edge** on Android or desktop.

> **This is a feasibility study - the speed write is sent, its effect on hardware is unconfirmed.** It exists to show what STREETBOOSTER's Bluetooth protocol makes possible, not to be a finished product; the protocol was reconstructed from the official app (`com.zydtech.streetbooster.enduser`, the ZYD Technology / Hobbywing controller engine) and is documented byte for byte. One generic profile covers every STREETBOOSTER model - there is no per-model code and no session authentication, only a CRC16, so any client that knows the frame format can read and write. The max-speed write (register `32` via the `0x17` RW-param frame on characteristic `F1F1`) is sent on request, but whether the firmware accepts a value above the 20 km/h eKFV limit - or enforces any auth of its own - sits in the controller and cannot be proven from the app: it must be tested on the device. **Reading works:** live telemetry, battery, speed, voltage, current, mileage, temperatures and the lock / light / cruise state are decoded from the `0xAB` stream and shown. Error-free operation is not promised and there is no warranty of any kind. Whatever you do with it, you do at your own risk - read the [Legal](#legal) section before you connect a scooter.

**Open the web app: [laufbursche42.github.io/streetbooster-unlock](https://laufbursche42.github.io/streetbooster-unlock/)**

Or run it yourself, no build step and no dependencies: clone the repo and serve the folder over a local HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/streetbooster-unlock.git
cd streetbooster-unlock
python -m http.server 8000
```

Any static server works. With Node installed, this does the same job:

```
npx serve .
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from connecting to the first send.

## What it does

- **Live values** - speed limit, speed, gear, battery, voltage, current, power, controller and motor temperature, trip and total mileage, fault code, and the lock / light / cruise / unit / start-mode / ambient-light state.
- **Speed** - an unlock/lock toggle (open value vs eKFV value) plus an exact km/h set. Writes register `32` (speed limit, km/h x10) via the `0x17` RW-param frame and confirms with a write to register `73`. The button labels itself from the limit the scooter reports.
- **Lock** - the immobilizer, via the live `0xAB` monitor frame (status bit 7).
- **More settings** - light, cruise, unit (km/mi), start mode and ambient light, all carried in the `0xAB` monitor frame.
- **Expert** - send a raw frame verbatim, or read/write a register by address (the `0x03` / `0x17` frame and CRC16 are built for you).
- **Shortcut** - a home-screen link that unlocks or locks in a single tap.

## Protocol (proven)

- Service `0xF1F0`, write characteristic `0xF1F1`, notify characteristic `0xF1F2`. No pairing, no PIN (an optional cleartext `AT+PWD` exists in the app but is not sent here).
- Checksum: CRC16/MODBUS (poly `0xA001`, init `0xFFFF`) in little-endian trailer.
- Frames: READ `[01 03 addr cnt crc]`, RW-param WRITE `[01 17 ...value... crc]` (register writes incl. speed limit), MONITOR `[AB 00 0A status limitCruise limitMode1 limitMode2 limitMode3 crc]` (live lock + status bits + per-gear limits), keep-alive `A5 02 FD 5A`.
- Telemetry (inbound `0xAB`): gear, battery %, speed, voltage, current, controller/motor temperature, trip, total mileage, fault, plus the status word (lock / light / cruise / unit / start-mode / ambient).

## Honesty

Device-untested by design - you test on your own scooter, which is exactly the point of a public tool. An echo in the log means the scooter **accepted** the frame; only the new limit appearing in the live values proves it actually took effect. Unproven device-side: whether a write is honored, the exact reply/ack framing, whether the scooter streams telemetry without a trigger, and whether a limit above eKFV is accepted.

## Legal

License: PolyForm Noncommercial, see [License](LICENSE.md). Privacy: nothing leaves your device, see [Privacy](PRIVACY.md). Trademarks: STREETBOOSTER is a trademark of its respective owner, this project is independent, see [Trademarks](TRADEMARKS.md).

Source: https://github.com/Laufbursche42/streetbooster-unlock
