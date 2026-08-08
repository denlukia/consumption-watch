# Consumption Watch

Background MacBook energy monitor. Samples Apple SMC / battery telemetry via `ioreg`, integrates power into watt-hours, stores buckets in SQLite, and serves a live dashboard.

Works with **Node.js ≥ 22.5** (`node:sqlite`) or **Bun**.

## What it tracks

| Series | Source | Meaning |
| --- | --- | --- |
| **System** | `PowerTelemetryData.SystemLoad` | Energy the machine itself uses |
| **Wall / plug** | `PowerTelemetryData.SystemPowerIn` while on AC | Energy drawn from the adapter (includes charging the pack) |
| **Battery** | discharge portion of `BatteryPower` | Energy leaving the battery on battery power |

Views: last 48 hours (hourly) and last 30 days (daily), all in **Wh**.

## Install

```bash
npm install
# or: bun install
```

## Run (foreground)

```bash
npm start          # Node
npm run start:bun  # Bun
```

Dashboard: [http://127.0.0.1:3847](http://127.0.0.1:3847)

Optional env:

- `PORT` — HTTP port (default `3847`)
- `SAMPLE_MS` — sample interval in ms (default `5000`)

SQLite file: `data/energy.sqlite`

## Background service scripts (LaunchAgent)

These install a macOS LaunchAgent so the monitor keeps running after you close the terminal / Cursor, and at login.

```bash
./scripts/register.sh     # install + start (auto-picks bun, else node)
./scripts/run.sh          # start or restart
./scripts/stop.sh         # stop (plist stays installed)
./scripts/unregister.sh   # stop + remove plist (won't start at login)
```

Runtime selection:

```bash
RUNTIME=node ./scripts/register.sh   # force Node
RUNTIME=bun ./scripts/register.sh    # force Bun
PORT=3847 ./scripts/register.sh
```

You can also set `NODE=/path/to/node` or `BUN=/path/to/bun`.

Logs: `/tmp/consumption-watch.log` and `/tmp/consumption-watch.err`

## Notes

- Requires macOS with `AppleSmartBattery` power telemetry (Apple Silicon Macs expose the richest fields).
- Wall energy is only accumulated while `ExternalConnected` is true.
- System energy is what the laptop consumes; wall energy is usually higher while charging because it includes pack charge + adapter path losses.
- Node uses the built-in `node:sqlite` module (no native addon). Bun uses `bun:sqlite`.
