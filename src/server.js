// 服务启动：加载机场道路资料 + 事件日志重放，构建引擎与 HTTP 服务。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TowingEngine } from "./model/engine.js";
import { buildServer as buildApiServer } from "./api.js";

export async function buildApp({ logPath = process.env.LOG_PATH ?? null, airportPath = null, clock, config } = {}) {
  const airportFile = airportPath ?? fileURLToPath(new URL("../fixtures/airport.json", import.meta.url));
  const airportData = JSON.parse(await readFile(airportFile, "utf8"));
  const engine = await TowingEngine.create({ airport: airportData, logPath, clock, config });
  const server = buildApiServer(engine, airportData);
  server.engine = engine;
  return { server, engine, airportData };
}

// 测试/调用方便利封装：直接拿到已完成重放的 HTTP 服务。
export async function buildServer(options = {}) {
  return (await buildApp(options)).server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const logPath = process.env.LOG_PATH ?? new URL("../data/events.jsonl", import.meta.url).pathname;
  const { server, engine } = await buildApp({ logPath });
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({
      msg: "拖行许可引擎已启动", port,
      replayedEvents: engine.events.length,
      droppedTail: engine.droppedTail,
      logPath,
    }));
  });
}
