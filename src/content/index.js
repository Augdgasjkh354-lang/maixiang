import { AGRICULTURE, INITIAL, PRECISION, RULES } from "./rules.js";
import { ITEMS } from "./items.js";
import { CORE_ROLES } from "./roles.js";
import { RECIPES } from "./recipes.js";
import { BUILDINGS } from "./buildings.js";
import { PLOTS } from "./world.js";

export const CONTENT = Object.freeze({
  agriculture: AGRICULTURE,
  initial: INITIAL,
  precision: PRECISION,
  rules: RULES,
  items: ITEMS,
  roles: CORE_ROLES,
  recipes: RECIPES,
  buildings: BUILDINGS,
  plots: PLOTS
});

export function extendContent(base, additions) {
  return Object.freeze({
    ...base,
    items: Object.freeze({ ...base.items, ...(additions.items || {}) }),
    roles: Object.freeze({ ...base.roles, ...(additions.roles || {}) }),
    recipes: Object.freeze({ ...base.recipes, ...(additions.recipes || {}) }),
    buildings: Object.freeze({ ...base.buildings, ...(additions.buildings || {}) })
  });
}
