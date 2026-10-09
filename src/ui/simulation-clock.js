export class SimulationClock {
  constructor(content) {
    this.daysPerSecond = content.rules.dailyDaysPerSecond;
    this.speedChoices = content.rules.speedChoices.slice();
    this.speed = 1;
    this.paused = true;
    this.fractionalDays = 0;
  }

  setSpeed(speed) {
    if (!this.speedChoices.includes(speed)) throw new RangeError("不支持的时光速度");
    this.speed = speed;
    this.paused = false;
    this.fractionalDays = 0;
  }

  pause() {
    this.paused = true;
    this.fractionalDays = 0;
  }

  resume() {
    this.paused = false;
  }

  // 分段推进（app.js 把一天拆到多帧跑）：先累计时间，再由调用方每开一天前问 canStartDay、开始时 startDay。
  accrue(seconds) {
    if (this.paused || !(seconds > 0)) return;
    this.fractionalDays += seconds * this.daysPerSecond * this.speed;
  }

  canStartDay() {
    return !this.paused && this.fractionalDays >= 1;
  }

  startDay() {
    this.fractionalDays -= 1;
  }

  // 积压最多 1 天（与 advanceFrame 超预算时的处理一致）。
  capBacklog() {
    if (this.fractionalDays > 1) this.fractionalDays = 1;
  }

  // budgetMs：本帧单次调用内最多连跑的耗时（至少跑一天）。超时后停止追加，
  // 未跑的进度最多保留 1 天积压，多出的丢弃（等价于自动降速），日结果不受影响。
  advanceFrame(seconds, stepDay, { budgetMs = Infinity, now = defaultNow } = {}) {
    if (this.paused || seconds <= 0) return 0;
    this.fractionalDays += seconds * this.daysPerSecond * this.speed;
    const startedAt = now();
    let advanced = 0;
    while (!this.paused && this.fractionalDays >= 1) {
      if (advanced > 0 && now() - startedAt > budgetMs) {
        this.fractionalDays = Math.min(this.fractionalDays, 1);
        break;
      }
      this.fractionalDays -= 1;
      stepDay();
      advanced += 1;
    }
    return advanced;
  }
}

function defaultNow() {
  return globalThis.performance ? globalThis.performance.now() : Date.now();
}

