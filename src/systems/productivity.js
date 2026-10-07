import { industryTypeIds } from "../content/buildings.js";
import { jobCount } from "./households.js";

// 熟练度记账：每天把各产业生产岗位上的在岗人数（镇营 + 民营 + 公司）累加为"工日"。
// 生产率系数的计算见 economy/productivity.js。
export function accrueIndustryExperience(state, content) {
  state.industryExperience ||= {};
  const added = {};
  for (const typeId of industryTypeIds(content)) {
    const roleId = content.buildings[typeId].productionRoleId || content.buildings[typeId].jobs?.[0]?.id;
    let workers = 0;
    for (const building of state.buildings || []) {
      if (building.typeId !== typeId) continue;
      for (const suffix of ["", "::private", "::listed"]) workers += jobCount(state, `${building.id}::${roleId}${suffix}`);
    }
    if (workers > 0) state.industryExperience[typeId] = (state.industryExperience[typeId] || 0) + workers;
    added[typeId] = workers;
  }
  return added;
}
