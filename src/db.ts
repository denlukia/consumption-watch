import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "./paths.ts";

export type HourBucket = {
  hour_ts: number;
  system_mwh: number;
  wall_mwh: number;
  battery_discharge_mwh: number;
  on_ac_seconds: number;
  sample_count: number;
};

export type LiveState = {
  ts: number;
  system_mw: number;
  wall_mw: number;
  battery_mw: number;
  on_ac: number;
  is_charging: number;
  voltage_mv: number;
  amperage_ma: number;
};

type Stmt = {
  run: (...params: unknown[]) => { changes?: number };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type DbAdapter = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Stmt;
  run: (sql: string, params?: unknown[]) => { changes: number };
  transaction: <T>(fn: () => T) => T;
};

const DATA_DIR = join(ROOT_DIR, "data");
const DB_PATH = join(DATA_DIR, "energy.sqlite");

mkdirSync(DATA_DIR, { recursive: true });

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

async function openDb(): Promise<DbAdapter> {
  if (isBun()) {
    const { Database } = await import("bun:sqlite");
    const raw = new Database(DB_PATH, { create: true });
    return {
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => {
        const stmt = raw.prepare(sql);
        return {
          run: (...params) => stmt.run(...params),
          get: (...params) => stmt.get(...params),
          all: (...params) => stmt.all(...params),
        };
      },
      run: (sql, params = []) => {
        const result = raw.run(sql, params);
        return { changes: Number(result.changes ?? 0) };
      },
      transaction: (fn) => raw.transaction(fn)(),
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(DB_PATH);
  return {
    exec: (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...params) => {
          const result = stmt.run(...params);
          return { changes: Number(result.changes ?? 0) };
        },
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params) as unknown[],
      };
    },
    run: (sql, params = []) => {
      const stmt = raw.prepare(sql);
      const result = stmt.run(...params);
      return { changes: Number(result.changes ?? 0) };
    },
    transaction: (fn) => {
      raw.exec("BEGIN");
      try {
        const value = fn();
        raw.exec("COMMIT");
        return value;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const db = await openDb();

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS hourly (
    hour_ts INTEGER PRIMARY KEY,
    system_mwh REAL NOT NULL DEFAULT 0,
    wall_mwh REAL NOT NULL DEFAULT 0,
    battery_discharge_mwh REAL NOT NULL DEFAULT 0,
    on_ac_seconds REAL NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS live (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ts INTEGER NOT NULL,
    system_mw REAL NOT NULL,
    wall_mw REAL NOT NULL,
    battery_mw REAL NOT NULL,
    on_ac INTEGER NOT NULL,
    is_charging INTEGER NOT NULL,
    voltage_mv INTEGER NOT NULL,
    amperage_ma INTEGER NOT NULL
  );
`);

const upsertHour = db.prepare(`
  INSERT INTO hourly (
    hour_ts, system_mwh, wall_mwh, battery_discharge_mwh, on_ac_seconds, sample_count
  ) VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT(hour_ts) DO UPDATE SET
    system_mwh = system_mwh + excluded.system_mwh,
    wall_mwh = wall_mwh + excluded.wall_mwh,
    battery_discharge_mwh = battery_discharge_mwh + excluded.battery_discharge_mwh,
    on_ac_seconds = on_ac_seconds + excluded.on_ac_seconds,
    sample_count = sample_count + 1
`);

const upsertLive = db.prepare(`
  INSERT INTO live (
    id, ts, system_mw, wall_mw, battery_mw, on_ac, is_charging, voltage_mv, amperage_ma
  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    ts = excluded.ts,
    system_mw = excluded.system_mw,
    wall_mw = excluded.wall_mw,
    battery_mw = excluded.battery_mw,
    on_ac = excluded.on_ac,
    is_charging = excluded.is_charging,
    voltage_mv = excluded.voltage_mv,
    amperage_ma = excluded.amperage_ma
`);

export function addEnergySample(input: {
  hourTs: number;
  systemMwh: number;
  wallMwh: number;
  batteryDischargeMwh: number;
  onAcSeconds: number;
  live: LiveState;
}) {
  db.transaction(() => {
    upsertHour.run(
      input.hourTs,
      input.systemMwh,
      input.wallMwh,
      input.batteryDischargeMwh,
      input.onAcSeconds,
    );
    upsertLive.run(
      input.live.ts,
      input.live.system_mw,
      input.live.wall_mw,
      input.live.battery_mw,
      input.live.on_ac,
      input.live.is_charging,
      input.live.voltage_mv,
      input.live.amperage_ma,
    );
  });
}

export function getLive(): LiveState | null {
  return (
    (db
      .prepare(
        `SELECT ts, system_mw, wall_mw, battery_mw, on_ac, is_charging, voltage_mv, amperage_ma
         FROM live WHERE id = 1`,
      )
      .get() as LiveState | undefined) ?? null
  );
}

export function getHourlySince(sinceTs: number): HourBucket[] {
  return db
    .prepare(
      `SELECT hour_ts, system_mwh, wall_mwh, battery_discharge_mwh, on_ac_seconds, sample_count
       FROM hourly
       WHERE hour_ts >= ?
       ORDER BY hour_ts ASC`,
    )
    .all(sinceTs) as HourBucket[];
}

export function getTotals() {
  return (
    (db
      .prepare(
        `SELECT
           COALESCE(SUM(system_mwh), 0) AS system_mwh,
           COALESCE(SUM(wall_mwh), 0) AS wall_mwh,
           COALESCE(SUM(battery_discharge_mwh), 0) AS battery_discharge_mwh
         FROM hourly`,
      )
      .get() as {
      system_mwh: number;
      wall_mwh: number;
      battery_discharge_mwh: number;
    } | null) ?? { system_mwh: 0, wall_mwh: 0, battery_discharge_mwh: 0 }
  );
}

export function dbPath() {
  return DB_PATH;
}

/** Drop overflowed buckets from bad SMC sentinel samples. */
export function purgeCorruptBuckets(maxSystemMwhPerHour = 200_000) {
  const result = db.run(
    `DELETE FROM hourly
     WHERE system_mwh > ? OR wall_mwh > ? OR battery_discharge_mwh > ?
        OR system_mwh < 0 OR wall_mwh < 0 OR battery_discharge_mwh < 0`,
    [maxSystemMwhPerHour, maxSystemMwhPerHour, maxSystemMwhPerHour],
  );
  return result.changes;
}
