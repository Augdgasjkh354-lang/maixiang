// 金银店（金银消费第一期 B）：每栋金银店建筑内置一个零售店（店型 jewelry，shop.jeweler = true，见 systems/shops.js）。
// 店员 = 建筑的首饰匠岗位，工资与岗位归业主（镇营 / 民营 / 公司，按建筑所有权的既有口径，见 ownership.js）。
// 本模块只读：在岗人数、接待能力、业主派生。开店、进货、结账在 shops.js。
import { buildingOwner, jobKeyForOwner } from "./ownership.js";
import { readJobCount } from "../selectors/labor.js";
import { productivityFactor } from "../economy/productivity.js";

export const JEWELER_ROLE_ID = "jewelers";

export function jewelerBuildingOf(state, shop) {
  return (state.buildings || []).find(building => building.id === shop.buildingId) || null;
}

// 当前业主（{ kind, id }）：镇营 kind town，民营 household，公司 company。
export function jewelerOwnerOf(state, building) {
  return buildingOwner(state, building);
}

// 在岗首饰匠人数：岗位键随当前业主变化（镇营 / 民营 / 公司各一把）。
export function jewelerStaffCount(state, shop) {
  const building = jewelerBuildingOf(state, shop);
  if (!building) return 0;
  const owner = buildingOwner(state, building);
  return readJobCount(state, jobKeyForOwner(owner.kind, building.id, JEWELER_ROLE_ID));
}

// 日接待件数 = 在岗人数 × 每人日件数 × 生产率系数（等级、熟练、教育；economy/productivity.js）。
export function jewelerCapacityPieces(state, shop, content) {
  const building = jewelerBuildingOf(state, shop);
  if (!building) return 0;
  const staff = jewelerStaffCount(state, shop);
  if (!(staff > 0)) return 0;
  const perWorker = Math.max(0, Number(content.rules.jewelerPiecesPerWorkerDay) || 0);
  return Math.floor(staff * perWorker * productivityFactor(state, "jeweler", building.level || 1));
}

// 业主派生字段（写回店铺，供结账与付款口径用）：镇营 → shop.town；民营 → ownerHouseholdId；公司 → companyId。
export function jewelerOwnerFields(owner) {
  return {
    town: owner.kind === "town",
    ownerHouseholdId: owner.kind === "household" ? owner.id : null,
    companyId: owner.kind === "company" ? owner.id : null
  };
}
