// 事件日志存储：JSONL 只追加文件。写入采用“追加后 fsync 目录项”的保守方式，
// 单进程内由引擎串行锁保证不会交错。重启时整段读回重放。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export class FileEventStore {
  constructor(path) {
    this.path = path;
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  }

  async append(event) {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  async readEvents() {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    const events = [];
    for (const [lineNo, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        throw new Error(`corrupt event log at ${this.path}:${lineNo + 1}: ${error.message}`);
      }
    }
    return events;
  }
}

/** 测试与演示用内存存储。 */
export class MemoryEventStore {
  constructor(events = []) {
    this.events = [...events];
  }
  async append(event) {
    this.events.push(event);
  }
  async readEvents() {
    return [...this.events];
  }
}
