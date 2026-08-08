import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getHourlySince, getLive, getTotals, type HourBucket } from "./db.ts";
import { SRC_DIR } from "./paths.ts";

const PORT = Number(process.env.PORT ?? 3847);
const dashboardPath = join(SRC_DIR, "dashboard.html");

export type AppServer = {
  port: number;
  stop: () => void;
};

function startOfLocalDay(ms = Date.now()): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function startOfLocalHour(ms = Date.now()): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function sumBuckets(rows: HourBucket[]) {
  return rows.reduce(
    (acc, row) => {
      acc.system_mwh += row.system_mwh;
      acc.wall_mwh += row.wall_mwh;
      acc.battery_discharge_mwh += row.battery_discharge_mwh;
      return acc;
    },
    { system_mwh: 0, wall_mwh: 0, battery_discharge_mwh: 0 },
  );
}

function toDaily(rows: HourBucket[]) {
  const byDay = new Map<
    number,
    {
      day_ts: number;
      system_mwh: number;
      wall_mwh: number;
      battery_discharge_mwh: number;
      on_ac_seconds: number;
      sample_count: number;
    }
  >();

  for (const row of rows) {
    const dayTs = startOfLocalDay(row.hour_ts * 1000);
    const current = byDay.get(dayTs) ?? {
      day_ts: dayTs,
      system_mwh: 0,
      wall_mwh: 0,
      battery_discharge_mwh: 0,
      on_ac_seconds: 0,
      sample_count: 0,
    };
    current.system_mwh += row.system_mwh;
    current.wall_mwh += row.wall_mwh;
    current.battery_discharge_mwh += row.battery_discharge_mwh;
    current.on_ac_seconds += row.on_ac_seconds;
    current.sample_count += row.sample_count;
    byDay.set(dayTs, current);
  }

  return [...byDay.values()].sort((a, b) => a.day_ts - b.day_ts);
}

function sendJson(
  res: import("node:http").ServerResponse,
  data: unknown,
  status = 200,
) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function startServer(): AppServer {
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

      if (url.pathname === "/api/stats") {
        const hourSince = startOfLocalHour() - 47 * 3600;
        const daySince = startOfLocalDay() - 29 * 86400;
        const hourly = getHourlySince(hourSince);
        const hourlyForDays = getHourlySince(daySince - 2 * 86400);
        const daily = toDaily(hourlyForDays).filter((d) => d.day_ts >= daySince);
        const todayRows = hourly.filter((h) => h.hour_ts >= startOfLocalDay());

        sendJson(res, {
          live: getLive(),
          today: sumBuckets(todayRows),
          totals: getTotals(),
          hourly,
          daily,
        });
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(res, { ok: true, port: PORT });
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(dashboardPath);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": html.byteLength,
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (err) {
      console.error("[server]", err);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal server error");
    }
  });

  server.listen(PORT, "127.0.0.1");

  return {
    port: PORT,
    stop: () => {
      server.close();
    },
  };
}

export { PORT };
