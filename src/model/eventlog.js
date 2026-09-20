// 事件日志（事件溯源）：JSONL 追加写，每条事件包含 seq/type/time/actor 与净载荷。
// 重启时全量重放即可重建资源日历与在途位置。
// 崩溃残留的半行（最后一行无法解析）在加载时丢弃，保证重放起点一致。

import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";

let SEQ = 0;

export class EventLog {
  constructor(path) {
    this.path = path ?? null;
    this.listener = null;
    if (this.path) {
      const dir = this.path.slice(0, this.path.lastIndexOf("/"));
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  onEvent(fn) { this.listener = fn; }

  append(event) {
    const full = { seq: ++SEQ, time: Date.now(), ...event };
    if (this.path) {
      const fd = openSync(this.path, "a");
      try { appendFileSync(fd, JSON.stringify(full) + "\n"); }
      finally { closeSync(fd); } // close 触发内核 flush
    }
    this.listener?.(full);
    return full;
  }

  static async load(path) {
    if (!path || !existsSync(path)) return { events: [], droppedTail: 0 };
    const raw = await readFile(path, "utf8");
    const events = [];
    let droppedTail = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        events.push(ev);
        SEQ = Math.max(SEQ, ev.seq ?? 0);
      } catch {
        droppedTail += 1; // 仅末尾半行可能出现；保留计数用于启动告警
      }
    }
    return { events, droppedTail };
  }

  // 快照压缩：重写为指定事件序列（供维护工具使用，运行引擎不主动调用）。
  rewrite(events) {
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      for (const ev of events) appendFileSync(fd, JSON.stringify(ev) + "\n");
    } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }
}
