import { ingestCompany, loadCompanies, type Company } from "./ingestJobs.js";
import {
  SYNC_JOBS_QUEUES,
  DISPATCH_JOB_SYNCS,
  DISPATCH_SINGLETON_KEY,
  startBoss,
} from "./queues.js";
import type { JobBoard } from "../services/ats/index.js";

const NIGHTLY_2AM = "0 2 * * *"; // CRON time for 2am every night.
const INSERT_BATCH_SIZE = 500; // insert 500 companies at a time (small & safe).

const boss = await startBoss();

// Nightly cron trigger with singleton key to dedup.
await boss.schedule(
  DISPATCH_JOB_SYNCS,
  NIGHTLY_2AM,
  {},
  { tz: "Australia/Sydney", singletonKey: DISPATCH_SINGLETON_KEY },
);

// Reads the triggered message above and gets companies and puts them in job-specific queues.
await boss.work(DISPATCH_JOB_SYNCS, async () => {
  const companies = await loadCompanies();

  const byBoard = new Map<JobBoard, Company[]>();
  for (const company of companies) {
    const boardCompanies = byBoard.get(company.job_board) ?? [];
    boardCompanies.push(company);
    byBoard.set(company.job_board, boardCompanies);
  }

  // Queues each company in the required board queue in batches.
  for (const [board, boardCompanies] of byBoard) {
    let queued = 0;
    for (
      let start = 0;
      start < boardCompanies.length;
      start += INSERT_BATCH_SIZE
    ) {
      const ids = await boss.insert(
        SYNC_JOBS_QUEUES[board],
        boardCompanies
          .slice(start, start + INSERT_BATCH_SIZE)
          .map((company) => ({
            data: company,
            singletonKey: `company:${company.id}`, // per-company/board singleton key so same one isn't repeated concurrently.
          })),
      );
      queued += ids?.length ?? 0;
    }
    console.log(
      `Queued ${queued}/${boardCompanies.length} companies in ${SYNC_JOBS_QUEUES[board]}`,
    );
  }
});

// Sets up one worker per queue to drain each (we can test incrementing workers per queue later on to improve concurrency -> latency).
for (const queue of Object.values(SYNC_JOBS_QUEUES)) {
  await boss.work<Company>(queue, async ([job]) => ingestCompany(job!.data));
}
console.log(
  `Worker started, "${DISPATCH_JOB_SYNCS}" scheduled at 2am Australia/Sydney`,
);

// Graceful shutdown to stop the workers, db conns, timers.
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

// OS stops for quick shutdown.
process.on("SIGINT", (signal) => void shutdown(signal));
process.on("SIGTERM", (signal) => void shutdown(signal));
