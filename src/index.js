// 装配：从 fixtures 加载路网与台账，连接事件日志，构造引擎。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Network } from "./domain/network.js";
import { CredentialRegistry } from "./domain/credentials.js";
import { TowingEngine } from "./domain/engine.js";
import { FileEventStore, MemoryEventStore } from "./domain/store.js";

export async function loadJson(urlOrPath) {
  const url = fileURLToPath(new URL(urlOrPath, import.meta.url).href);
  return JSON.parse(await readFile(url, "utf8"));
}

export async function createEngine(options = {}) {
  const base = options.base ?? new URL("../", import.meta.url);
  const resolve = (p) => new URL(p, base);
  const [networkData, credentialData] = await Promise.all([
    loadJson(resolve("fixtures/airport-network.json")),
    loadJson(resolve("fixtures/credentials.json")),
  ]);
  const network = new Network(networkData);
  const credentials = CredentialRegistry.from(credentialData);
  const store = options.store
    ?? (options.eventLogPath
      ? new FileEventStore(options.eventLogPath)
      : new MemoryEventStore());
  const engine = new TowingEngine({
    network,
    credentials,
    store,
    clock: options.clock ?? (() => Date.now()),
  });
  await engine.load();
  return engine;
}
