import {
  DISPATCH_JOB_SYNCS,
  DISPATCH_SINGLETON_KEY,
  startBoss,
} from "../src/worker/queues.js";

// Queues one job sync dispatch now instead of waiting for the 2am run. The worker (npm run worker) does the fetching.
async function main(): Promise<void> {
  const boss = await startBoss();
  try {
    const jobId = await boss.send(
      DISPATCH_JOB_SYNCS,
      {},
      { singletonKey: DISPATCH_SINGLETON_KEY },
    );
    console.log(
      jobId
        ? `Queued backfill dispatch (job ${jobId}), the worker will pick it up`
        : "A dispatch is already queued or running, nothing queued",
    );
  } finally {
    await boss.stop({ graceful: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
