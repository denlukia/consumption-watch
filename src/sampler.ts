import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { addEnergySample } from "./db.ts";

const execFileAsync = promisify(execFile);

export type PowerReading = {
  ts: number;
  systemMw: number;
  wallMw: number;
  batteryMw: number;
  onAc: boolean;
  isCharging: boolean;
  voltageMv: number;
  amperageMa: number;
};

const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 5000);
/** Laptops won't realistically exceed this; reject SMC sentinel / overflow junk. */
const MAX_SANE_MW = 200_000;
const MAX_SANE_MA = 20_000;

function parseIoregBool(raw: string | undefined): boolean {
  return raw === "Yes" || raw === "true" || raw === "1";
}

/** ioreg often prints negative int64 values as unsigned uint64 decimals. */
function parseIoregInt(raw: string): number {
  const bi = BigInt(raw);
  const signed = bi > 0x7fffffffffffffffn ? bi - 0x10000000000000000n : bi;
  const n = Number(signed);
  return Number.isFinite(n) ? n : 0;
}

function extractInt(block: string, key: string): number | null {
  const match = block.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`));
  return match ? parseIoregInt(match[1]) : null;
}

function extractBool(block: string, key: string): boolean {
  const match = block.match(new RegExp(`"${key}"\\s*=\\s*(\\w+)`));
  return parseIoregBool(match?.[1]);
}

function extractTelemetry(block: string): Record<string, number> {
  const match = block.match(/"PowerTelemetryData"\s*=\s*\{([^}]*)\}/);
  if (!match) return {};
  const out: Record<string, number> = {};
  for (const [, key, value] of match[1].matchAll(/"(\w+)"\s*=\s*(-?\d+)/g)) {
    out[key] = parseIoregInt(value);
  }
  return out;
}

function sanePowerMw(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (Math.abs(value) > MAX_SANE_MW) return null;
  return value;
}

function saneAmperageMa(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  if (Math.abs(value) > MAX_SANE_MA) return 0;
  return value;
}

export async function readPower(): Promise<PowerReading> {
  const { stdout } = await execFileAsync(
    "/usr/sbin/ioreg",
    ["-rn", "AppleSmartBattery", "-w", "0"],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const text = stdout.toString();

  const telemetry = extractTelemetry(text);
  const voltageMv = extractInt(text, "Voltage") ?? 0;
  const amperageMa = saneAmperageMa(
    extractInt(text, "InstantAmperage") ?? extractInt(text, "Amperage"),
  );
  const onAc = extractBool(text, "ExternalConnected");
  const isCharging = extractBool(text, "IsCharging");

  const systemLoad = sanePowerMw(telemetry.SystemLoad);
  const systemPowerIn = sanePowerMw(telemetry.SystemPowerIn) ?? 0;
  const batteryPower = sanePowerMw(telemetry.BatteryPower) ?? 0;
  const packMw =
    voltageMv > 0 && amperageMa !== 0
      ? (voltageMv * Math.abs(amperageMa)) / 1000
      : 0;

  // SystemLoad is reliable on AC but often a uint64 sentinel on battery.
  // Prefer pack V*I / BatteryPower when SystemLoad is missing or absurd.
  let systemMw = 0;
  if (systemLoad != null && systemLoad > 0) {
    systemMw = systemLoad;
  } else if (!onAc) {
    systemMw = packMw > 0 ? packMw : Math.abs(batteryPower);
  } else {
    systemMw = systemPowerIn > 0 ? systemPowerIn : packMw;
  }
  systemMw = Math.min(Math.max(systemMw, 0), MAX_SANE_MW);

  const wallMw = onAc ? Math.min(Math.max(systemPowerIn, 0), MAX_SANE_MW) : 0;

  // Discharge: negative BatteryPower, or pack current while on battery.
  let batteryMw = 0;
  if (batteryPower < 0) {
    batteryMw = Math.abs(batteryPower);
  } else if (!onAc) {
    batteryMw = packMw > 0 ? packMw : systemMw;
  }
  batteryMw = Math.min(batteryMw, MAX_SANE_MW);

  return {
    ts: Date.now(),
    systemMw,
    wallMw,
    batteryMw,
    onAc,
    isCharging,
    voltageMv,
    amperageMa,
  };
}

function startOfLocalHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** mW × seconds → mWh */
function mwSecondsToMwh(mw: number, seconds: number): number {
  if (!Number.isFinite(mw) || !Number.isFinite(seconds) || mw < 0 || seconds <= 0) {
    return 0;
  }
  if (mw > MAX_SANE_MW) return 0;
  return (mw * seconds) / 3600;
}

let previous: PowerReading | null = null;

export async function tick() {
  const reading = await readPower();

  if (previous) {
    const dtSec = Math.max(0, (reading.ts - previous.ts) / 1000);
    // Cap dt so a sleep/wake gap doesn't dump a huge energy spike.
    const integrateSec = Math.min(dtSec, (SAMPLE_MS / 1000) * 3);
    const systemMwh = mwSecondsToMwh(previous.systemMw, integrateSec);
    const wallMwh = mwSecondsToMwh(previous.wallMw, integrateSec);
    const batteryDischargeMwh = mwSecondsToMwh(previous.batteryMw, integrateSec);

    addEnergySample({
      hourTs: startOfLocalHour(previous.ts),
      systemMwh,
      wallMwh,
      batteryDischargeMwh,
      onAcSeconds: previous.onAc ? integrateSec : 0,
      live: {
        ts: reading.ts,
        system_mw: reading.systemMw,
        wall_mw: reading.wallMw,
        battery_mw: reading.batteryMw,
        on_ac: reading.onAc ? 1 : 0,
        is_charging: reading.isCharging ? 1 : 0,
        voltage_mv: reading.voltageMv,
        amperage_ma: reading.amperageMa,
      },
    });
  } else {
    addEnergySample({
      hourTs: startOfLocalHour(reading.ts),
      systemMwh: 0,
      wallMwh: 0,
      batteryDischargeMwh: 0,
      onAcSeconds: 0,
      live: {
        ts: reading.ts,
        system_mw: reading.systemMw,
        wall_mw: reading.wallMw,
        battery_mw: reading.batteryMw,
        on_ac: reading.onAc ? 1 : 0,
        is_charging: reading.isCharging ? 1 : 0,
        voltage_mv: reading.voltageMv,
        amperage_ma: reading.amperageMa,
      },
    });
  }

  previous = reading;
  return reading;
}

export function startSampler() {
  const run = () => {
    tick().catch((err) => {
      console.error("[sampler]", err);
    });
  };
  run();
  return setInterval(run, SAMPLE_MS);
}

export { SAMPLE_MS };
