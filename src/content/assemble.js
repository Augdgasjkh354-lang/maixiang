// 把核心内容和各 mod 的内容（src/mods/<id>/content.js）合成一份 CONTENT。
// mod 内容是纯数据，可提供：
//   items / recipes / buildings / roles      新定义（id 不能和已有的重复）
//   rules                                    规则参数；对象型参数逐键合并（如 marketPricesVoucherPerUnit、householdGoods）
//   outsideTowns                             新外镇档案
//   outsideTownGoods: { <townId>: { <itemId>: 商品档案 } }   给已有外镇加商品
//   initialState                             mod 自己的状态初值（开局放进 state.mods[<id>]）
//   save: { entityMaps: [], renames: [] }    存档兼容登记（见 persistence/save-compat.js）
// 综合商店货架、批发市场经营品、只能经商店零售的商品都由物品标记推导：
//   item.retail（综合商店卖）、item.storeOnly（只能经综合商店卖给居民）、item.wholesale（批发市场做市）

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addDefinitions(target, additions, kind, modId) {
  for (const [id, definition] of Object.entries(additions || {})) {
    if (id in target) throw new Error(`mod「${modId}」的${kind}「${id}」与已有定义重名`);
    target[id] = definition;
  }
}

function mergeRules(base, additions) {
  const result = { ...base };
  for (const [key, value] of Object.entries(additions || {})) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? { ...base[key], ...value } : value;
  }
  return result;
}

export function assembleContent(core, modContents = []) {
  const items = { ...core.items };
  const recipes = { ...core.recipes };
  const buildings = { ...core.buildings };
  const roles = { ...core.roles };
  const outsideTowns = Object.fromEntries(Object.entries(core.outsideTowns).map(([id, town]) => [id, { ...town, goods: { ...town.goods } }]));
  let rules = { ...core.rules };
  const modStates = {};
  for (const mod of modContents) {
    if (!mod?.id) throw new Error("mod 内容缺少 id");
    addDefinitions(items, mod.items, "物品", mod.id);
    addDefinitions(recipes, mod.recipes, "配方", mod.id);
    addDefinitions(buildings, mod.buildings, "建筑", mod.id);
    addDefinitions(roles, mod.roles, "岗位", mod.id);
    addDefinitions(outsideTowns, mod.outsideTowns, "外镇", mod.id);
    for (const [townId, goods] of Object.entries(mod.outsideTownGoods || {})) {
      if (!outsideTowns[townId]) throw new Error(`mod「${mod.id}」给不存在的外镇「${townId}」加商品`);
      outsideTowns[townId] = { ...outsideTowns[townId], goods: { ...outsideTowns[townId].goods } };
      addDefinitions(outsideTowns[townId].goods, goods, `${townId}商品`, mod.id);
    }
    rules = mergeRules(rules, mod.rules);
    modStates[mod.id] = mod.initialState || {};
  }
  // 综合商店货架 = 所有标了 retail 的物品。
  const general = rules.shopTypes?.general;
  if (general) {
    rules.shopTypes = { ...rules.shopTypes, general: { ...general, itemIds: Object.keys(items).filter(id => items[id].retail) } };
  }
  return Object.freeze({
    ...core,
    rules: Object.freeze(rules),
    items: Object.freeze(items),
    roles: Object.freeze(roles),
    recipes: Object.freeze(recipes),
    buildings: Object.freeze(buildings),
    outsideTowns: Object.freeze(outsideTowns),
    modStates: Object.freeze(modStates),
    modSave: Object.freeze({
      entityMaps: modContents.flatMap(mod => mod.save?.entityMaps || []),
      renames: modContents.flatMap(mod => mod.save?.renames || [])
    })
  });
}

// 推导出的物品清单（只读）。
export function wholesaleItemIds(content) {
  return Object.keys(content.items).filter(id => content.items[id].wholesale);
}

export function storeOnlyItemIds(content) {
  return Object.keys(content.items).filter(id => content.items[id].storeOnly);
}
