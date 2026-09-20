import { fileURLToPath } from "node:url";
import { buildServer } from "./api.js";
import { createEngine } from "./index.js";

let sweepTimer = null;

export async function main() {
  const eventLogPath = process.env.EVENT_LOG
    ?? fileURLToPath(new URL("../data/events.jsonl", import.meta.url));
  const engine = await createEngine({ eventLogPath });
  const server = buildServer(engine);
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));

  // 每 15 秒扫描一次超时未激活的许可并自动释放。
  sweepTimer = setInterval(() => {
    engine.sweepExpired().catch((error) => console.error("sweep failed:", error));
  }, 15_000);
  sweepTimer.unref();

  return { server, engine };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(() => {
    console.log(`towing permit engine listening on port ${process.env.PORT ?? 3000}`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
