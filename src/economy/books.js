// 统一账本：所有"当日 / 本年 / 累计"三段记账都用这里的工具。
// holder 是挂着 day、year、cumulative 三个对象的任意实体（公司 accounts、店铺 accounts、批发市场、家庭生活账等）。
// 跨日、跨年时由各系统把对应 period 换成新的空白对象即可。

export const PERIODS = Object.freeze(["day", "year", "cumulative"]);

// 三段同时累加一个数值字段。
export function bookAdd(holder, key, amount) {
  for (const period of PERIODS) {
    const row = (holder[period] ||= {});
    row[key] = (row[key] || 0) + (amount || 0);
  }
}

// 三段同时累加一个按物品（或任意子键）细分的字段。
export function bookAddMap(holder, key, itemId, amount) {
  for (const period of PERIODS) {
    const row = (holder[period] ||= {});
    const map = (row[key] ||= {});
    map[itemId] = (map[itemId] || 0) + (amount || 0);
  }
}

// 一次累加多个字段：bookAddAll(holder, { acres: 3, workDays: 10 })。
export function bookAddAll(holder, fields) {
  for (const [key, amount] of Object.entries(fields)) bookAdd(holder, key, amount);
}

// 保证三段都存在：缺的用 blank() 生成，已有的原地补齐缺失字段（不替换对象，别处持有的引用仍有效）。
export function ensureBook(holder, blank) {
  for (const period of PERIODS) {
    const row = (holder[period] ||= blank());
    for (const [key, value] of Object.entries(blank())) if (row[key] === undefined) row[key] = value;
  }
  return holder;
}
