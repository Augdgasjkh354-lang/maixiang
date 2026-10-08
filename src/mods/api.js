// mod 行为侧的公共工具（见 MODDING.md）。
//
// 一个 mod 的 mod.js 默认导出：
// {
//   id: "tea",                                     与 content.js 的 id 相同
//   dailySteps: [{ id, after, run(state, content, day) }],   插进每日结算表 after 那一步之后（after 见 systems/daily.js 的 DAILY_STEPS id）
//   commands: { name(state, content, ...args) => { ok, reason, ... } },   玩家操作；界面按钮 data-mod-command 调用
//   select(state, content) => 对象,                 只读视图数据，界面里是 view.mods[id]
//   ui: {
//     economySection: { title, render(view, modView) => html },          经营页里的一个可折叠卡片
//     buildingSections: { <buildingTypeId>: (view, building, modView) => html }   建筑详情里追加的卡片
//   },
//   art: { <buildingTypeId>: (options) => svg },   建筑美术（options 同 ui/building-art.js 的 renderBuildingArt）
//   validate(state, content) => [错误信息...],       状态校验；不合法时返回中文错误
//   comfort(state, household, people, dayBook, content) => 舒心值加分（家庭当日，0—几分；dayBook 是家庭当日生活账）
// }
//
// mod 只能读写自己的 state.mods[id]，以及通过经济底层工具（accounts / trade / employer / books / payment）收付钱货；
// 不要直接改别的 mod 或核心系统的状态字段。

export function defineMod(definition) {
  if (!definition?.id) throw new Error("mod 缺少 id");
  for (const step of definition.dailySteps || []) {
    if (!step.id || typeof step.run !== "function" || !step.after) throw new Error(`mod「${definition.id}」的每日步骤需要 id、after 和 run`);
  }
  return Object.freeze(definition);
}

export function modState(state, modId) {
  state.mods ||= {};
  state.mods[modId] ||= {};
  return state.mods[modId];
}

// 把 mod 的每日步骤插进核心表：每步放在 after 指定的那一步之后（同一位置按 mod 顺序排）。
export function assembleDailySteps(coreSteps, mods) {
  const steps = coreSteps.slice();
  for (const mod of mods) {
    for (const step of mod.dailySteps || []) {
      const index = steps.findIndex(row => row.id === step.after);
      if (index < 0) throw new Error(`mod「${mod.id}」的每日步骤「${step.id}」找不到插入位置「${step.after}」`);
      let insertAt = index + 1;
      while (insertAt < steps.length && steps[insertAt].insertedAfter === step.after) insertAt += 1;
      steps.splice(insertAt, 0, { id: `${mod.id}:${step.id}`, when: step.when, run: step.run, insertedAfter: step.after });
    }
  }
  return steps;
}

// 引擎门面：simulation.mods[modId][command](state, ...args)
export function bindModCommands(mods, content) {
  return Object.fromEntries(mods.map(mod => [mod.id, Object.fromEntries(
    Object.entries(mod.commands || {}).map(([name, fn]) => [name, (state, ...args) => fn(state, content, ...args)])
  )]));
}

export function selectModViews(state, content, mods) {
  return Object.fromEntries(mods.filter(mod => typeof mod.select === "function").map(mod => [mod.id, mod.select(state, content)]));
}

export function validateMods(state, content, mods) {
  return mods.flatMap(mod => (typeof mod.validate === "function" ? mod.validate(state, content) || [] : []).map(error => `[${mod.id}] ${error}`));
}

export function modArt(mods, typeId) {
  for (const mod of mods) if (typeof mod.art?.[typeId] === "function") return mod.art[typeId];
  return null;
}

export function modComfortPoints(state, household, people, dayBook, content, mods) {
  let points = 0;
  for (const mod of mods) if (typeof mod.comfort === "function") points += Math.max(0, Number(mod.comfort(state, household, people, dayBook, content)) || 0);
  return points;
}
