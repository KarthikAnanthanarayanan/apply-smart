import path from "node:path";
import dotenv from "dotenv";
import { PgBoss } from "pg-boss";
import { ingestJobs } from "./ingestJobs.js";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error(
    "Missing required environment variable: DATABASE_URL. " +
      "Set it in backend/.env (see backend/.env.example).",
  );
}

const INGEST_JOBS = "ingest-jobs";
// Shared by the nightly and startup jobs so the exclusive queue never holds or runs two ingests at once.
const INGEST_SINGLETON_KEY = "ingest-jobs";
const NIGHTLY_2AM = "0 2 * * *";

const boss = new PgBoss(DATABASE_URL);
boss.on("error", (err) => console.error("pg-boss error:", err));

await boss.start();

await boss.createQueue(INGEST_JOBS, {
  policy: "exclusive",
  // A full run is ~3,600 companies at 1 request/second per board, well over the 15 minute default.
  expireInSeconds: 6 * 60 * 60,
  retryLimit: 1,
  retryDelay: 15 * 60,
});

await boss.work(INGEST_JOBS, async () => {
  await ingestJobs();
});

await boss.schedule(
  INGEST_JOBS,
  NIGHTLY_2AM,
  {},
  { tz: "Australia/Sydney", singletonKey: INGEST_SINGLETON_KEY },
);

const backfillId = await boss.send(
  INGEST_JOBS,
  {},
  { singletonKey: INGEST_SINGLETON_KEY },
);
console.log(
  backfillId
    ? `Queued startup ingest (job ${backfillId})`
    : "An ingest is already queued or running, skipped the startup ingest",
);
console.log(`Worker started, "${INGEST_JOBS}" scheduled at 2am Australia/Sydney`);

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, stopping pg-boss`);
  try {
    await boss.stop({ graceful: true });
  } catch (err) {
    console.error("pg-boss did not stop cleanly:", err);
    process.exitCode = 1;
  }
}

process.on("SIGINT", (signal) => void shutdown(signal));
process.on("SIGTERM", (signal) => void shutdown(signal));
