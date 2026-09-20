import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { once } from "node:events";
import test from "node:test";
import { buildServer } from "../src/api.js";
import { createEngine } from "../src/index.js";

test("领域资料样例可以解析", async () => {
  const files = (await readdir(new URL("../fixtures/", import.meta.url))).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const data = JSON.parse(await readFile(new URL(`../fixtures/${file}`, import.meta.url), "utf8"));
    assert.equal(typeof data.scenario, "string");
    assert.ok(Array.isArray(data.records ?? data.edges ?? data.requests ?? data.people));
  }
});

test("健康接口返回可用状态", async (context) => {
  const engine = await createEngine({ store: new (await import("../src/domain/store.js")).MemoryEventStore() });
  const server = buildServer(engine).listen(0, "127.0.0.1");
  context.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});
