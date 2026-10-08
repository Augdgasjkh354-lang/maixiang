// mod 模板 · 行为。只在需要"内容之外的逻辑"时才写这个文件；纯内容 mod（加商品、建筑、外镇商品）不需要。
// 只能读写 state.mods[本 mod id]；收付钱货一律用经济底层工具（economy/accounts、trade、payment、books，systems/employer）。
import { defineMod, modState } from "../api.js";

export default defineMod({
  id: "_template",

  // 每日步骤：插在核心步骤 after 之后（可用的 id 见 src/systems/daily.js 的 CORE_DAILY_STEPS）。
  dailySteps: [
    { id: "tally", after: "industryExperience", run(state, content) {
      const mine = modState(state, "_template");
      mine.pickedTotalUnits = state.industries?.tea?.cumulative?.producedUnits?.tea_leaf || 0;
    } }
  ],

  // 玩家命令：返回 { ok, reason?, message? }。界面按钮：
  // <button data-mod="_template" data-mod-command="reset">  或带数字输入 data-mod-input="草稿键"。
  commands: {
    reset(state) {
      modState(state, "_template").pickedTotalUnits = 0;
      return { ok: true, message: "已清零" };
    }
  },

  // 只读视图：界面里是 view.mods["_template"]。不能写 state。
  select(state, content) {
    return { pickedJin: (state.mods?._template?.pickedTotalUnits || 0) / content.precision.inventoryUnitsPerJin };
  },

  ui: {
    economySection: {
      title: "茶叶（模板）",
      render: (view, mine) => `<div class="row"><span class="label">累计采茶</span><strong class="value">${mine?.pickedJin ?? 0}斤</strong></div>`
    },
    buildingSections: {
      tea_garden: (view, building, mine) => `<div class="subtle">茶园 ${building.level} 级，全镇累计采茶 ${mine?.pickedJin ?? 0} 斤。</div>`
    }
  },

  // 建筑美术：返回 SVG 片段（坐标与 ui/building-art.js 一致，约 120 宽、底部中心在 0,36）。
  art: {
    tea_garden: () => `<g><ellipse cy="20" rx="56" ry="20" fill="#b9c79a" stroke="#7b7c66"/><g fill="#6f8f5a">${[-36, -12, 12, 36].map(x => `<ellipse cx="${x}" cy="16" rx="10" ry="6"/>`).join("")}</g></g>`
  },

  validate(state) {
    const value = state.mods?._template?.pickedTotalUnits ?? 0;
    return Number.isFinite(value) && value >= 0 ? [] : ["累计采茶量无效"];
  },

  // 舒心值加成（家庭当日）：日用品已由 rules.householdGoods 自动处理，这里是额外的。
  comfort() { return 0; }
});
