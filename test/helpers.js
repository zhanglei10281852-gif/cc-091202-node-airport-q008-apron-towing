// 测试装配：内存事件存储 + 可推进时钟 + fixtures 资料。
import { Network } from "../src/domain/network.js";
import { CredentialRegistry } from "../src/domain/credentials.js";
import { TowingEngine } from "../src/domain/engine.js";
import { MemoryEventStore } from "../src/domain/store.js";
import { FakeClock } from "../src/domain/time.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function fixture(name) {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(fileURLToPath(url), "utf8"));
}

export async function newEngine({ start = "2026-09-12T02:00:00+08:00", events } = {}) {
  const [networkData, credentialData] = await Promise.all([fixture("airport-network.json"), fixture("credentials.json")]);
  const clock = new FakeClock(start);
  const store = new MemoryEventStore(events ?? []);
  const engine = new TowingEngine({
    network: new Network(networkData),
    credentials: CredentialRegistry.from(credentialData),
    store,
    clock,
  });
  await engine.load();
  return { engine, clock, store };
}

export const baseRequest = (overrides = {}) => ({
  requestId: "t-1",
  aircraft: { id: "B-1", type: "A320", wingspan: "C" },
  crew: ["P-001", "P-002"],
  vehicle: "TUG-01",
  from: "S12",
  to: "H21",
  window: { start: "2026-09-12T02:10:00+08:00", seconds: 1800 },
  intersectionSeparationSeconds: 60,
  ...overrides,
});

export { EngineError } from "../src/domain/engine.js";
