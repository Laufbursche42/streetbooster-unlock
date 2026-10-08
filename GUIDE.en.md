# Guide

> **Important for error reports:** switch on the **Diagnostic log** at the bottom of the page *before* you connect to the scooter. Only then is the full connection handshake captured - and those are exactly the lines we need in a [ticket](https://github.com/Laufbursche42/Laufbursche42/issues) to reproduce a problem.

## What you need
- A STREETBOOSTER e-scooter.
- A phone or computer with **Chrome**, **Edge**, or on iOS **Bluefy**. Safari and Firefox cannot do Web Bluetooth.

## Connecting
1. Turn on Bluetooth and wake the scooter.
2. Tap **Connect** and pick the scooter from the list.
3. If it is not listed, tick **Show all devices** and try again. The real check is the Bluetooth service found (F1F0), not the advertised name.
4. Once connected, the live-values, lock, speed and settings cards appear.

## Reading live values
The scooter streams its telemetry continuously (0xAB frames). Each tile appears once its value has arrived; a dash just means that value has not come in yet. Below the tiles, **All received frames** lets you follow the raw data per opcode.

## Setting the speed
- **Unlock** writes the value from the **Open** field, **Lock** writes the **eKFV / legal** field. Both write speed-limit register 32 (km/h x10) and confirm with a write to register 73. The button labels itself from the limit the scooter actually reports.
- **Set exact** writes any km/h value directly (1 to 60).
- Important: an echo in the log only means the scooter accepted the frame. Only when the speed limit changes in the live values is the value really active. Whether the firmware accepts more than the allowed 20 km/h is something you must test on your own device.

## Lock
In the **Lock** card you lock or unlock the scooter (immobilizer). The lock rides in the live monitor frame (0xAB, status bit 7). Note: a locked scooter can only be unlocked again over Bluetooth.

## More settings
Light, cruise control, unit (km/mi), start mode and ambient light. They all ride in the same 0xAB monitor frame that also carries the speed limits; the page rebuilds it from the last reported state. Only rows whose value the scooter reports are shown.

## Advanced settings (engine level)
**Send a raw frame** sends your hex bytes unchanged. **Read and write a register** takes a register address (hex) and value and builds a correct 0x03 read or 0x17 write frame with CRC16/MODBUS from it.

## Shortcuts
Copy the link to your home screen, then one tap unlocks or locks directly. On iOS via Bluefy, and the scooter must have been connected normally once before.

## If something does not work
- Cannot connect? Check that the browser supports Web Bluetooth, Bluetooth is on and the scooter is awake. Retry with **Show all devices**.
- Nothing happens after a command? Check the log: if it says "sent" but no "confirmed", the firmware did not acknowledge the frame.
- No live values? The scooter may only stream telemetry after the keep-alive the page sends automatically. If everything stays empty, your model may report values differently.
- **Diagnostics: list all devices** in the log area shows every Bluetooth service of a device without writing anything - useful for support.

## Contribute
Want to find out if and how tuning works on your scooter? Test this tool on your own vehicle and open a ticket on [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - with your model and what worked (or did not). That way we figure out together what is possible on which model.
