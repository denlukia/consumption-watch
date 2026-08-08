import { dbPath, purgeCorruptBuckets } from "./db.ts";
import { SAMPLE_MS, startSampler } from "./sampler.ts";
import { startServer } from "./server.ts";

const purged = purgeCorruptBuckets();
if (purged > 0) {
  console.log(`[consumption-watch] purged ${purged} corrupt hour bucket(s)`);
}

startSampler();
const server = startServer();

console.log(`[consumption-watch] dashboard  http://127.0.0.1:${server.port}`);
console.log(`[consumption-watch] sqlite     ${dbPath()}`);
console.log(`[consumption-watch] sample every ${SAMPLE_MS}ms`);

function shutdown(signal: string) {
  console.log(`[consumption-watch] stopping (${signal})`);
  server.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
