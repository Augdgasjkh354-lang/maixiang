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

  advanceFrame(seconds, stepDay) {
    if (this.paused || seconds <= 0) return 0;
    this.fractionalDays += seconds * this.daysPerSecond * this.speed;
    let advanced = 0;
    while (!this.paused && this.fractionalDays >= 1) {
      this.fractionalDays -= 1;
      stepDay();
      advanced += 1;
    }
    return advanced;
  }
}
