import {
  TAG_JOB_TITLES,
  TAG_SINGLETON_KEY,
  startBoss,
} from "../src/worker/queues.js";

// Queues one title tagging run now instead of waiting for the 4am run. The worker (npm run worker) does the tagging.
async function main(): Promise<void> {
  const boss = await startBoss();
  try {
    const jobId = await boss.send(
      TAG_JOB_TITLES,
      {},
      { singletonKey: TAG_SINGLETON_KEY },
    );
    console.log(
      jobId
        ? `Queued title tagging (job ${jobId}), the worker will pick it up`
        : "A tagging run is already queued, nothing queued",
    );
  } finally {
    await boss.stop({ graceful: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
