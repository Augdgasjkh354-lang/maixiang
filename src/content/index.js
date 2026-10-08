import { AGRICULTURE, INITIAL, PRECISION, RULES } from "./rules.js";
import { ITEMS } from "./items.js";
import { CORE_ROLES } from "./roles.js";
import { RECIPES } from "./recipes.js";
import { BUILDINGS } from "./buildings.js";
import { PLOTS } from "./world.js";
import { OUTSIDE_TOWNS } from "./outside-towns.js";
import { assembleContent } from "./assemble.js";
import { MOD_CONTENTS } from "../mods/content-registry.js";

// 核心内容（不含 mod）。测试单独组装某个 mod 时用：assembleContent(CORE_CONTENT, [modContent])。
export const CORE_CONTENT = Object.freeze({
  agriculture: AGRICULTURE,
  initial: INITIAL,
  precision: PRECISION,
  rules: RULES,
  items: ITEMS,
  roles: CORE_ROLES,
  recipes: RECIPES,
  buildings: BUILDINGS,
  plots: PLOTS,
  outsideTowns: OUTSIDE_TOWNS
});

// 核心内容 + 已启用 mod 的内容（见 assemble.js、MODDING.md）。
export const CONTENT = assembleContent(CORE_CONTENT, MOD_CONTENTS);

export function extendContent(base, additions) {
  return Object.freeze({
    ...base,
    items: Object.freeze({ ...base.items, ...(additions.items || {}) }),
    roles: Object.freeze({ ...base.roles, ...(additions.roles || {}) }),
    recipes: Object.freeze({ ...base.recipes, ...(additions.recipes || {}) }),
    buildings: Object.freeze({ ...base.buildings, ...(additions.buildings || {}) })
  });
}
