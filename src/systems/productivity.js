import { industryTypeIds } from "../content/buildings.js";
import { jobCount } from "./households.js";

// 教育记账：今天学堂实际接待了学生（服务步骤之后调用）才算一天办学；没有学堂、没教员或没学生则不计。不衰减。
export function accrueEducationDay(state) {
  state.education ||= { schoolDays: 0 };
  if ((state.services?.day?.servedUses?.school || 0) > 0) state.education.schoolDays = (state.education.schoolDays || 0) + 1;
}

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
