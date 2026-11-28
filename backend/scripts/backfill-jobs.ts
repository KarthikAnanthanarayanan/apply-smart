import {
  INGEST_JOBS,
  INGEST_SINGLETON_KEY,
  startBoss,
} from "../src/worker/queues.js";

// Queues one ingest fan-out now instead of waiting for the 2am run. The worker (npm run worker) does the fetching.
async function main(): Promise<void> {
  const boss = await startBoss();
  try {
    const jobId = await boss.send(
      INGEST_JOBS,
      {},
      { singletonKey: INGEST_SINGLETON_KEY },
    );
    console.log(
      jobId
        ? `Queued backfill ingest (job ${jobId}), the worker will pick it up`
        : "An ingest fan-out is already queued or running, nothing queued",
    );
  } finally {
    await boss.stop({ graceful: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
