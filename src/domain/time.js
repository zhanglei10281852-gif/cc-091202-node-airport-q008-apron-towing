// 时间工具：对外全部使用带偏移的 ISO-8601 字符串，引擎内部统一为 epoch 毫秒。

/** ISO 字符串 -> epoch 毫秒；非法输入抛错。 */
export function toMs(value, field = "time") {
  if (typeof value === "number") return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid ${field}: ${String(value)}`);
  return ms;
}

/** epoch 毫秒 -> ISO 字符串（UTC，比较与传输无歧义）。 */
export function toIso(ms) {
  return new Date(ms).toISOString();
}

export function seconds(ms) {
  return Math.round(ms / 1000);
}

/** 可手动推进的时钟，供演示与测试使用；生产环境传入 Date.now。 */
export class FakeClock {
  constructor(start) {
    this.t = start === undefined ? Date.now() : toMs(start, "clock start");
  }
  now() {
    return this.t;
  }
  advance(durationMs) {
    this.t += durationMs;
    return this.t;
  }
  set(value) {
    this.t = toMs(value, "clock set");
    return this.t;
  }
}
