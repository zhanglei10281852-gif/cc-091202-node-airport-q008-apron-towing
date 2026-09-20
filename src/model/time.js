// 时间一律以 epoch 毫秒在引擎内部流转；fixture / API 使用带偏移量的 ISO8601。

export function ts(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw Object.assign(new Error(`无法解析时间: ${value}`), { code: "bad_time", value });
  }
  return t;
}

export const seconds = (n) => Math.round(n * 1000);
export const minutes = (n) => seconds(n * 60);

export function iso(ms, timeZone = "Asia/Shanghai") {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  // 固定输出机场本地偏移，便于管制员阅读；UTC 用 isoZ。
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`;
}

export const isoZ = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export function within(t, windowMs) {
  return t >= windowMs[0] && t <= windowMs[1];
}
