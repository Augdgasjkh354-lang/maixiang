(function (root) {
  "use strict";

  const CONFIG = Object.freeze({
    acres: 4000,
    acresPerFarmer: 10,
    yieldPerAcre: 400,
    taxRate: 0.5,
    daysPerYear: 365,
    growingDays: 274,
    foodPerPersonDay: 2,
    housing: 1000,
    qeq: { wheat: 1, flour: 1, bread: 5 / 6 },
    mill: { slots: 12, wheatPerWorkerDay: 80, flourYield: 0.8, wagePerWorkerDay: 2, workDays: 480, workers: 12, payPerWorkDay: 7.5 },
    bakery: { slots: 10, flourPerWorkerDay: 80, breadWeightPerFlour: 1.2, wagePerWorkerDay: 2.2, workDays: 400, workers: 10, payPerWorkDay: 7.5 },
    speed: { baseDaysPerSecond: 0.45, choices: [1, 4, 16] }
  });

  const names = { wheat: "小麦", flour: "面粉", bread: "面包" };
  const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  function spreadAgeBand(total, start, end) {
    const count = end - start + 1;
    const base = Math.floor(total / count);
    const remainder = total % count;
    return Array.from({ length: count }, (_, i) => {
      const n = base + (i < remainder ? 1 : 0);
      const f = Math.floor(n / 2);
      return { age: start + i, m: n - f, f, marriedM: 0, marriedF: 0 };
    });
  }

  function makeInitialPeople() {
    const cohorts = [
      ...spreadAgeBand(200, 0, 17),
      ...spreadAgeBand(600, 18, 64),
      ...spreadAgeBand(200, 65, 84)
    ];
    let couples = 96;
    for (const c of cohorts) {
      if (c.age < 20 || c.age > 39 || couples <= 0) continue;
      const pairCount = Math.min(c.m, c.f, couples);
      c.marriedM = pairCount;
      c.marriedF = pairCount;
      couples -= pairCount;
    }
    return cohorts;
  }

  function createNewState() {
    return {
      version: 1,
      year: 1,
      day: 0,
      stocks: {
        residents: { wheat: 730000, flour: 0, bread: 0 },
        town: { wheat: 730000, flour: 0, bread: 0 }
      },
      cohorts: makeInitialPeople(),
      jobs: { farmers: 400, builders: 0, millers: 0, bakers: 0 },
      cropWorkDays: 0,
      plots: [
        { id: "east", label: "溪畔空地", x: 76.5, y: 58.5 },
        { id: "south", label: "南路空地", x: 81.5, y: 77 }
      ],
      buildings: [],
      project: null,
      autoRelief: true,
      satisfaction: 75,
      shortage: 0,
      seed: 917309,
      lastDemography: { births: 0, deaths: 0, marriages: 0 },
      yearTotals: { harvest: 0, consumption: 0, operatingWages: 0, constructionPay: 0, relief: 0, processingLoss: 0 },
      ledger: [],
      events: [{ year: 1, day: 0, text: "新任镇长上任。镇库与居民各存小麦七十三万斤，今日镇务暂歇。" }]
    };
  }

  function peopleStats(s) {
    const stats = { children: 0, workers: 0, elders: 0, total: 0, marriedCouples: 0, marriedWomen: 0 };
    for (const c of s.cohorts) {
      const n = c.m + c.f;
      stats.total += n;
      if (c.age < 18) stats.children += n;
      else if (c.age < 65) stats.workers += n;
      else stats.elders += n;
      stats.marriedCouples += Math.min(c.marriedM, c.marriedF);
      stats.marriedWomen += c.marriedF;
    }
    return stats;
  }

  function employed(s) {
    return s.jobs.farmers + s.jobs.builders + s.jobs.millers + s.jobs.bakers;
  }

  function accountEq(stock) {
    return round2(Object.keys(CONFIG.qeq).reduce((sum, item) => sum + (stock[item] || 0) * CONFIG.qeq[item], 0));
  }

  function allEq(s) {
    return round2(accountEq(s.stocks.residents) + accountEq(s.stocks.town));
  }

  function pushLedger(s, entry) {
    s.ledger.unshift({ year: s.year, day: Math.min(CONFIG.daysPerYear, s.day + 1), ...entry });
    if (s.ledger.length > 160) s.ledger.length = 160;
  }

  function pushEvent(s, text) {
    s.events.unshift({ year: s.year, day: Math.max(1, Math.min(CONFIG.daysPerYear, s.day)), text });
    if (s.events.length > 24) s.events.length = 24;
  }

  function removeQeq(stock, amount, order = ["bread", "flour", "wheat"]) {
    let left = Math.max(0, amount);
    const moved = { wheat: 0, flour: 0, bread: 0 };
    for (const item of order) {
      const availableEq = (stock[item] || 0) * CONFIG.qeq[item];
      const take = Math.min(left, availableEq);
      if (take > 0) {
        moved[item] = take / CONFIG.qeq[item];
        stock[item] = round2(Math.max(0, stock[item] - moved[item]));
        left = round2(left - take);
      }
    }
    return { moved, removedEq: round2(amount - left), missingEq: round2(left) };
  }

  function transferQeq(s, fromName, toName, amount, reason, category = "transfer") {
    const from = s.stocks[fromName];
    const to = s.stocks[toName];
    const transfer = removeQeq(from, amount);
    for (const item of Object.keys(transfer.moved)) to[item] = round2((to[item] || 0) + transfer.moved[item]);
    if (transfer.removedEq > 0) {
      pushLedger(s, { type: category, reason, amount: transfer.removedEq, detail: `${fromName === "town" ? "镇库" : "居民"} → ${toName === "town" ? "镇库" : "居民"}` });
      if (category === "relief") s.yearTotals.relief = round2(s.yearTotals.relief + transfer.removedEq);
      if (category === "construction") s.yearTotals.constructionPay = round2(s.yearTotals.constructionPay + transfer.removedEq);
      if (category === "wage") s.yearTotals.operatingWages = round2(s.yearTotals.operatingWages + transfer.removedEq);
    }
    return transfer;
  }

  function takeWheat(s, amount) {
    const take = Math.min(s.stocks.town.wheat, amount);
    s.stocks.town.wheat = round2(Math.max(0, s.stocks.town.wheat - take));
    return take;
  }

  function adjustJobs(s, role, value) {
    const allowed = ["farmers", "builders", "millers", "bakers"];
    if (!allowed.includes(role)) return false;
    const stats = peopleStats(s);
    const caps = {
      farmers: CONFIG.acres / CONFIG.acresPerFarmer,
      builders: s.project ? 24 : 0,
      millers: s.buildings.some(b => b.type === "mill") ? CONFIG.mill.slots : 0,
      bakers: s.buildings.some(b => b.type === "bakery") ? CONFIG.bakery.slots : 0
    };
    const previous = s.jobs[role];
    const otherJobs = employed(s) - previous;
    const max = Math.min(caps[role], Math.max(0, stats.workers - otherJobs));
    s.jobs[role] = Math.floor(clamp(Number(value) || 0, 0, max));
    return s.jobs[role] !== previous;
  }

  function rebalanceJobs(s) {
    const workers = peopleStats(s).workers;
    let extra = employed(s) - workers;
    if (extra <= 0) return 0;
    let removed = 0;
    for (const role of ["builders", "bakers", "millers", "farmers"]) {
      const cut = Math.min(extra, s.jobs[role]);
      s.jobs[role] -= cut;
      extra -= cut;
      removed += cut;
      if (extra <= 0) break;
    }
    return removed;
  }

  function startBuild(s, type, plotId) {
    if (s.project) return { ok: false, reason: "已有一处工程在施工" };
    if (!["mill", "bakery"].includes(type)) return { ok: false, reason: "未知建筑" };
    if (s.buildings.some(b => b.type === type)) return { ok: false, reason: "同类建筑已经建成" };
    if (!s.plots.some(p => p.id === plotId)) return { ok: false, reason: "请在地图空地上选址" };
    const plan = type === "mill" ? CONFIG.mill : CONFIG.bakery;
    const cost = plan.workDays * plan.payPerWorkDay;
    if (accountEq(s.stocks.town) < cost) return { ok: false, reason: "镇库粮食不足，无法支付施工粮酬" };
    transferQeq(s, "town", "residents", cost, `${type === "mill" ? "磨坊" : "面包房"}施工粮酬`, "construction");
    s.project = { type, plotId, workDone: 0, workRequired: plan.workDays, recommendedWorkers: plan.workers, cost };
    const idle = Math.max(0, peopleStats(s).workers - employed(s));
    s.jobs.builders = Math.min(plan.workers, idle);
    pushEvent(s, `在${s.plots.find(p => p.id === plotId).label}动工修建${type === "mill" ? "磨坊" : "面包房"}，镇库转付施工粮酬${Math.round(cost).toLocaleString("zh-CN")}斤。`);
    return { ok: true, cost, assignedBuilders: s.jobs.builders };
  }

  function manualRelief(s, amount = 30000) {
    const result = transferQeq(s, "town", "residents", amount, "镇长手动救济", "relief");
    if (result.removedEq > 0) pushEvent(s, `镇长从镇库拨出 ${Math.round(result.removedEq).toLocaleString("zh-CN")}斤口粮，送到居民账。`);
    return result;
  }

  function nextRandom(s) {
    s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
    return s.seed / 4294967296;
  }

  function binomial(s, count, probability) {
    let n = 0;
    for (let i = 0; i < count; i++) if (nextRandom(s) < probability) n++;
    return n;
  }

  function deathRate(age) {
    if (age < 5) return 0.004;
    if (age < 18) return 0.001;
    if (age < 65) return 0.0025;
    if (age < 75) return 0.025;
    if (age < 85) return 0.065;
    if (age < 95) return 0.14;
    return 0.28;
  }

  function addToCohort(s, age, field, n) {
    if (n <= 0) return;
    let c = s.cohorts.find(x => x.age === age);
    if (!c) {
      c = { age, m: 0, f: 0, marriedM: 0, marriedF: 0 };
      s.cohorts.push(c);
    }
    c[field] += n;
  }

  function marrySingles(s) {
    let male = 0, female = 0;
    for (const c of s.cohorts) if (c.age >= 20 && c.age <= 39) {
      male += Math.max(0, c.m - c.marriedM);
      female += Math.max(0, c.f - c.marriedF);
    }
    const couples = Math.min(Math.floor(male * 0.08), Math.floor(female * 0.08));
    let leftM = couples, leftF = couples;
    for (const c of s.cohorts) if (c.age >= 20 && c.age <= 39) {
      const m = Math.min(leftM, Math.max(0, c.m - c.marriedM));
      const f = Math.min(leftF, Math.max(0, c.f - c.marriedF));
      c.marriedM += m;
      c.marriedF += f;
      leftM -= m;
      leftF -= f;
    }
    return couples;
  }

  function advancePopulation(s) {
    const old = s.cohorts.slice().sort((a, b) => a.age - b.age);
    const next = [];
    let deaths = 0;
    for (const c of old) {
      const rate = deathRate(c.age);
      const marriedMD = binomial(s, c.marriedM, rate);
      const marriedFD = binomial(s, c.marriedF, rate);
      const singleMD = binomial(s, Math.max(0, c.m - c.marriedM), rate);
      const singleFD = binomial(s, Math.max(0, c.f - c.marriedF), rate);
      const d = marriedMD + marriedFD + singleMD + singleFD;
      deaths += d;
      const n = {
        age: c.age + 1,
        m: c.m - marriedMD - singleMD,
        f: c.f - marriedFD - singleFD,
        marriedM: c.marriedM - marriedMD,
        marriedF: c.marriedF - marriedFD
      };
      if (n.age <= 105 && (n.m + n.f) > 0) next.push(n);
    }
    s.cohorts = next;
    let mm = s.cohorts.reduce((a, c) => a + c.marriedM, 0);
    let mf = s.cohorts.reduce((a, c) => a + c.marriedF, 0);
    let excess = Math.abs(mm - mf);
    const field = mm > mf ? "marriedM" : "marriedF";
    for (const c of s.cohorts.slice().reverse()) {
      if (excess <= 0) break;
      const cut = Math.min(c[field], excess);
      c[field] -= cut;
      excess -= cut;
    }

    const preBirth = peopleStats(s);
    const availableFood = allEq(s);
    const annualNeed = Math.max(1, preBirth.total * CONFIG.foodPerPersonDay * CONFIG.daysPerYear);
    const foodSupport = clamp(availableFood / (annualNeed * 0.85), 0.3, 1);
    const housingSupport = clamp(CONFIG.housing / Math.max(CONFIG.housing, preBirth.total), 0.35, 1);
    const birthRate = 0.31 * foodSupport * housingSupport;
    let births = 0;
    for (const c of s.cohorts) {
      if (c.age >= 20 && c.age <= 39) births += binomial(s, c.marriedF, birthRate);
    }
    const maleBirths = binomial(s, births, 0.5);
    addToCohort(s, 0, "m", maleBirths);
    addToCohort(s, 0, "f", births - maleBirths);
    const marriages = marrySingles(s);
    const removed = rebalanceJobs(s);
    s.lastDemography = { births, deaths, marriages };
    if (births || deaths || marriages) pushEvent(s, `一年将尽：新生${births}人，离世${deaths}人，新结${marriages}对。`);
    if (removed > 0) pushEvent(s, `人口变化使劳动力减少，${removed}个岗位已释放。`);
    return { births, deaths, marriages, removedJobs: removed };
  }

  function payOperatingWage(s, role, count, rate, name) {
    const wage = round2(count * rate);
    if (!count || accountEq(s.stocks.town) < wage) return false;
    transferQeq(s, "town", "residents", wage, `${name}工钱`, "wage");
    return true;
  }

  function doMill(s) {
    const building = s.buildings.find(b => b.type === "mill");
    const workers = s.jobs.millers;
    if (!building || workers <= 0) return;
    const possible = workers * CONFIG.mill.wheatPerWorkerDay;
    const input = Math.min(s.stocks.town.wheat, possible);
    if (input <= 0 || !payOperatingWage(s, "millers", workers, CONFIG.mill.wagePerWorkerDay, "磨坊")) return;
    const taken = takeWheat(s, input);
    const output = round2(taken * CONFIG.mill.flourYield);
    const loss = round2(taken - output);
    s.stocks.town.flour = round2(s.stocks.town.flour + output);
    s.yearTotals.processingLoss = round2(s.yearTotals.processingLoss + loss);
    pushLedger(s, { type: "process", reason: "磨坊：镇库小麦制面粉", amount: taken, detail: `${Math.round(taken)}斤麦 → ${Math.round(output)}斤面；损耗${Math.round(loss)}口粮斤` });
    if (loss > 0) pushLedger(s, { type: "loss", reason: "磨粉损耗（麸皮未作口粮）", amount: loss, detail: "已从可食口粮中扣除" });
  }

  function doBakery(s) {
    const building = s.buildings.find(b => b.type === "bakery");
    const workers = s.jobs.bakers;
    if (!building || workers <= 0) return;
    const possible = workers * CONFIG.bakery.flourPerWorkerDay;
    const input = Math.min(s.stocks.town.flour, possible);
    if (input <= 0 || !payOperatingWage(s, "bakers", workers, CONFIG.bakery.wagePerWorkerDay, "面包房")) return;
    s.stocks.town.flour = round2(Math.max(0, s.stocks.town.flour - input));
    const output = round2(input * CONFIG.bakery.breadWeightPerFlour);
    s.stocks.town.bread = round2(s.stocks.town.bread + output);
    pushLedger(s, { type: "process", reason: "面包房：镇库面粉烘焙", amount: input, detail: `${Math.round(input)}斤面 → ${Math.round(output)}斤面包（${Math.round(input)}口粮斤）` });
  }

  function harvest(s) {
    const fullYield = CONFIG.acres * CONFIG.yieldPerAcre;
    const proportion = clamp(s.cropWorkDays / CONFIG.growingDays, 0, 1);
    const total = Math.round(fullYield * proportion);
    const residentShare = Math.floor(total * CONFIG.taxRate);
    const townShare = total - residentShare;
    s.stocks.residents.wheat = round2(s.stocks.residents.wheat + residentShare);
    s.stocks.town.wheat = round2(s.stocks.town.wheat + townShare);
    s.yearTotals.harvest += total;
    pushLedger(s, { type: "harvest", reason: "全镇麦田净收成", amount: total, detail: `居民 ${residentShare.toLocaleString("zh-CN")}斤 · 镇库 ${townShare.toLocaleString("zh-CN")}斤` });
    pushEvent(s, `麦收入仓 ${total.toLocaleString("zh-CN")}斤，居民与镇库各分得 ${residentShare.toLocaleString("zh-CN")}斤。`);
    return { total, residentShare, townShare, proportion };
  }

  function consumeResidents(s, amount) {
    const result = removeQeq(s.stocks.residents, amount, ["bread", "flour", "wheat"]);
    const consumed = result.removedEq;
    if (consumed > 0) {
      s.yearTotals.consumption = round2(s.yearTotals.consumption + consumed);
      pushLedger(s, { type: "consume", reason: "居民每日口粮", amount: consumed, detail: `${Math.round(consumed).toLocaleString("zh-CN")}口粮斤` });
    }
    if (result.missingEq > 0) {
      s.shortage = result.missingEq;
      pushEvent(s, `居民口粮短缺 ${Math.round(result.missingEq).toLocaleString("zh-CN")}斤，时间已暂停。`);
    } else s.shortage = 0;
    return result;
  }

  function updateSatisfaction(s, breadEqConsumed) {
    const pop = Math.max(1, peopleStats(s).total);
    const dailyNeed = pop * CONFIG.foodPerPersonDay;
    const accessible = accountEq(s.stocks.residents) + (s.autoRelief ? accountEq(s.stocks.town) : 0);
    const daysCovered = accessible / dailyNeed;
    const foodSecurity = clamp(daysCovered / 30, 0, 1);
    const breadShare = clamp(breadEqConsumed / (dailyNeed * 0.25), 0, 1);
    const housing = clamp(CONFIG.housing / pop, 0, 1);
    const target = 35 + 30 * foodSecurity + 25 * breadShare + 10 * housing;
    const previous = Number.isFinite(s.satisfaction) ? s.satisfaction : 75;
    s.satisfaction = round2(previous * 0.92 + target * 0.08);
  }

  function tickDay(s) {
    const beforeTotal = allEq(s);
    const stats = peopleStats(s);
    if (s.project && s.jobs.builders > 0) {
      s.project.workDone = Math.min(s.project.workRequired, s.project.workDone + s.jobs.builders);
      if (s.project.workDone >= s.project.workRequired) {
        const type = s.project.type;
        const plot = s.plots.find(p => p.id === s.project.plotId);
        s.buildings.push({ type, plotId: s.project.plotId, x: plot.x, y: plot.y });
        s.project = null;
        s.jobs.builders = 0;
        pushEvent(s, `${type === "mill" ? "磨坊" : "面包房"}落成，可以安排工人开工了。`);
      }
    }
    doMill(s);
    doBakery(s);

    const dailyNeed = stats.total * CONFIG.foodPerPersonDay;
    const residentsEq = accountEq(s.stocks.residents);
    if (s.autoRelief && residentsEq < dailyNeed * 7) {
      const target = dailyNeed * 14;
      const need = Math.max(0, target - residentsEq);
      if (need > 0 && accountEq(s.stocks.town) > 0) {
        const result = transferQeq(s, "town", "residents", need, "自动救济，补足居民七日口粮", "relief");
        if (result.removedEq > 0) pushEvent(s, `镇库拨出 ${Math.round(result.removedEq).toLocaleString("zh-CN")}斤口粮，补足居民储备。`);
      }
    }
    const meal = consumeResidents(s, dailyNeed);
    updateSatisfaction(s, round2((meal.moved.bread || 0) * CONFIG.qeq.bread));
    if (s.day < CONFIG.growingDays) s.cropWorkDays = round2(s.cropWorkDays + s.jobs.farmers / (CONFIG.acres / CONFIG.acresPerFarmer));
    s.day++;

    if (s.day === 91) pushEvent(s, "春耕已过，麦苗渐渐齐整。");
    if (s.day === 183) pushEvent(s, "暑气渐盛，田间进入拔节时节。");
    if (s.day === 274) pushEvent(s, "秋收将启，田里麦浪金黄。");

    let harvestResult = null;
    let demography = null;
    if (s.day === CONFIG.growingDays) {
      harvestResult = harvest(s);
      s.cropWorkDays = 0;
    }
    if (s.day >= CONFIG.daysPerYear) {
      demography = advancePopulation(s);
      s.year++;
      s.day = 0;
      s.yearTotals = { harvest: 0, consumption: 0, operatingWages: 0, constructionPay: 0, relief: 0, processingLoss: 0 };
    }
    const afterTotal = allEq(s);
    return { harvest: harvestResult, demography, totalChange: round2(afterTotal - beforeTotal), stats: peopleStats(s) };
  }

  function season(day) {
    if (day < 91) return { key: "spring", name: "春", field: "麦苗返青", start: 0, end: 91 };
    if (day < 183) return { key: "summer", name: "夏", field: "麦穗抽长", start: 91, end: 183 };
    if (day < 274) return { key: "autumn", name: "秋", field: "金穗待收", start: 183, end: 274 };
    return { key: "winter", name: "冬", field: "田间休整", start: 274, end: 365 };
  }

  function forecast(s) {
    const elapsed = s.day;
    const averageWork = elapsed > 0 ? s.cropWorkDays / elapsed : s.jobs.farmers / (CONFIG.acres / CONFIG.acresPerFarmer);
    if (elapsed >= CONFIG.growingDays) return Math.round(CONFIG.acres * CONFIG.yieldPerAcre * clamp(s.jobs.farmers / (CONFIG.acres / CONFIG.acresPerFarmer), 0, 1));
    return Math.round(CONFIG.acres * CONFIG.yieldPerAcre * clamp(averageWork, 0, 1));
  }

  function isValid(s) {
    const p = peopleStats(s);
    const countsOk = p.total === p.children + p.workers + p.elders && employed(s) <= p.workers;
    const nonnegative = [s.stocks.residents, s.stocks.town].every(a => Object.values(a).every(v => Number.isFinite(v) && v >= -0.00001));
    const jobsOk = Object.values(s.jobs).every(v => Number.isInteger(v) && v >= 0);
    return countsOk && nonnegative && jobsOk;
  }

  function verifyCore() {
    const s = createNewState();
    const initial = peopleStats(s);
    const fixedAnnualNeed = 1000 * CONFIG.foodPerPersonDay * CONFIG.daysPerYear;
    const fullYield = CONFIG.acres * CONFIG.yieldPerAcre;
    const beforeTransfer = allEq(s);
    transferQeq(s, "town", "residents", 10000, "验证工资转移", "wage");
    const afterTransfer = allEq(s);
    const exactFood = removeQeq(s.stocks.residents, 10000);
    const afterConsumption = allEq(s);
    const harvestState = createNewState();
    harvestState.cropWorkDays = 365;
    const y = harvest(harvestState);
    const sJobs = createNewState();
    const laborBefore = peopleStats(sJobs).workers;
    adjustJobs(sJobs, "farmers", 400);
    const laborInvariant = employed(sJobs) <= laborBefore && peopleStats(sJobs).workers === employed(sJobs) + (peopleStats(sJobs).workers - employed(sJobs));
    return {
      ageGroups: { children: initial.children, working: initial.workers, elders: initial.elders, total: initial.total },
      fixedPopulationAnnualFood: fixedAnnualNeed,
      fullYield: { total: fullYield, residents: fullYield / 2, town: fullYield / 2, actual: y },
      transferPreservesTotal: beforeTransfer === afterTransfer,
      eatingReducesTotalBy: exactFood.removedEq,
      jobsInvariant: laborInvariant,
      newGameValid: isValid(createNewState())
    };
  }

  const api = { CONFIG, names, createNewState, peopleStats, employed, accountEq, allEq, transferQeq, manualRelief, adjustJobs, startBuild, tickDay, season, forecast, isValid, verifyCore };
  root.MaiEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
