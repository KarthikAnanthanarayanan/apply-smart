import { ingestCompany, loadCompanies, type Company } from "./ingestJobs.js";
import {
  INGEST_COMPANY,
  INGEST_JOBS,
  INGEST_SINGLETON_KEY,
  startBoss,
} from "./queues.js";

const NIGHTLY_2AM = "0 2 * * *"; // CRON time for 2am every night.
const BOARD_COUNT = 3; // 3 job boards (ashby, lever, greenhouse).
const INSERT_BATCH_SIZE = 500; // insert 500 companies at a time (small & safe).

const boss = await startBoss();

await boss.work(INGEST_JOBS, async () => {
  const companies = await loadCompanies();
  let queued = 0;
  for (let start = 0; start < companies.length; start += INSERT_BATCH_SIZE) {
    const ids = await boss.insert(
      INGEST_COMPANY,
      companies.slice(start, start + INSERT_BATCH_SIZE).map((company) => ({
        data: company,
        singletonKey: `company:${company.id}`,
        group: { id: company.job_board },
      })),
    );
    queued += ids?.length ?? 0;
  }
  console.log(`Queued ${queued}/${companies.length} company ingests`);
});

// groupConcurrency 1 per job board keeps each board to one request at a time across all workers,
// while the three boards run in parallel.
await boss.work<Company>(
  INGEST_COMPANY,
  { localConcurrency: BOARD_COUNT, groupConcurrency: 1 },
  async ([job]) => ingestCompany(job!.data),
);

await boss.schedule(
  INGEST_JOBS,
  NIGHTLY_2AM,
  {},
  { tz: "Australia/Sydney", singletonKey: INGEST_SINGLETON_KEY },
);

console.log(
  `Worker started, "${INGEST_JOBS}" scheduled at 2am Australia/Sydney`,
);

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
