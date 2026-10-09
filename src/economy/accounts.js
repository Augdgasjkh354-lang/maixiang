// 统一账户：所有经济主体都用一个账户名（owner）定位，这里集中回答"它的钱和货存在哪"。
//
//   账户名            粮券                          付款用小麦                      库存
//   town             currency.balances.town         accounts.town.wheat            accounts.town
//   residents        （有家庭时为各户汇总，只读）     accounts.residents.wheat       accounts.residents
//   household:<id>   household.voucherUnits         household.inventory.wheat      household.inventory
//   company:<id>     company.cashVoucherUnits       company.cashWheatUnits         company.inventory
//   shop:<id>        shop.cashVoucherUnits          shop.cashWheatUnits            shop.inventory
//   social           socialSecurity.cashVoucherUnits socialSecurity.cashWheatUnits  （无）
//   bank             bank.cashVoucherUnits           （无）                           （无）
//
//（存款不是银行的付款账户：住户存款在 bank.deposits 台账里，取款时由支付层先转回住户粮券。）
//
// 本模块只做查找、不改状态、不引用其他系统，避免循环依赖。
// 改了家庭余额后需要同步居民汇总，由调用方负责。

const PREFIXES = [["household:", "household"], ["company:", "company"], ["shop:", "shop"]];

// 结果按账户名缓存（付款链路每天调用数百万次）；返回冻结对象，调用方只读。
const parsedOwners = new Map();
const PARSED_OWNER_CACHE_LIMIT = 20000;
export function parseOwner(owner) {
  const cached = typeof owner === "string" ? parsedOwners.get(owner) : undefined;
  if (cached) return cached;
  let parsed = { kind: null, id: null };
  if (owner === "town" || owner === "residents" || owner === "social" || owner === "bank") parsed = { kind: owner, id: null };
  else {
    for (const [prefix, kind] of PREFIXES) {
      if (typeof owner === "string" && owner.startsWith(prefix)) { parsed = { kind, id: owner.slice(prefix.length) }; break; }
    }
  }
  Object.freeze(parsed);
  if (typeof owner === "string") {
    if (parsedOwners.size >= PARSED_OWNER_CACHE_LIMIT) parsedOwners.clear();
    parsedOwners.set(owner, parsed);
  }
  return parsed;
}

function entityOf(state, kind, id) {
  if (kind === "household") return state.households?.byId?.[id] || null;
  if (kind === "company") return state.companies?.[id] || null;
  if (kind === "shop") return state.shops?.[id] || null;
  if (kind === "social") return state.socialSecurity || null;
  if (kind === "bank") return state.bank || null;
  if (kind === "town" || kind === "residents") return state.accounts?.[kind] || null;
  return null;
}

export function accountExists(state, owner) {
  const { kind, id } = parseOwner(owner);
  return Boolean(entityOf(state, kind, id));
}

export function isHouseholdOwner(owner) {
  return parseOwner(owner).kind === "household";
}

// 账户名是一户人家时返回家庭 id，否则 null。
export function householdIdOf(owner) {
  const { kind, id } = parseOwner(owner);
  return kind === "household" ? id : null;
}

// 库存对象（物品 id → 库存单位）；没有库存的账户返回 null。
export function accountInventory(state, owner) {
  const { kind, id } = parseOwner(owner);
  if (kind === "town" || kind === "residents") return state.accounts?.[kind] || null;
  if (kind === "household" || kind === "company" || kind === "shop") return entityOf(state, kind, id)?.inventory || null;
  return null;
}

// 粮券余额存放位置 { holder, key }。居民汇总在有家庭时没有单一存放位置，返回 null。
export function voucherSlot(state, owner) {
  const { kind, id } = parseOwner(owner);
  if (kind === "town") {
    state.currency ||= {};
    state.currency.balances ||= {};
    return { holder: state.currency.balances, key: "town" };
  }
  if (kind === "residents") return state.currency?.balances ? { holder: state.currency.balances, key: "residents" } : null;
  if (kind === "bank") return state.bank ? { holder: state.bank, key: "cashVoucherUnits" } : null;
  const entity = entityOf(state, kind, id);
  if (!entity) return null;
  return { holder: entity, key: kind === "household" ? "voucherUnits" : "cashVoucherUnits" };
}

// 付款用小麦存放位置 { holder, key }：镇库、居民、家庭用库存里的小麦；公司、店铺、社保基金用单独的现金小麦。
export function paymentWheatSlot(state, owner) {
  const { kind, id } = parseOwner(owner);
  if (kind === "town" || kind === "residents") return state.accounts?.[kind] ? { holder: state.accounts[kind], key: "wheat" } : null;
  if (kind === "bank") return null;
  const entity = entityOf(state, kind, id);
  if (!entity) return null;
  if (kind === "household") return entity.inventory ? { holder: entity.inventory, key: "wheat" } : null;
  return { holder: entity, key: "cashWheatUnits" };
}

export function readSlot(slot) {
  return slot ? (slot.holder[slot.key] || 0) : 0;
}
