import { CONTENT } from "../src/content/index.js";
import { createIndependentCompany } from "../src/systems/companies.js";

// 测试夹具：只建立一家“未上市”的公司（整栋划入，不经交易所）。
// 对外已取消“成立公司”，正式流程是 simulation.listBuilding（整栋上市一步完成）；这里只为经营类测试提供现成公司。
export function formCompany(state, buildingId, options = {}) {
  return createIndependentCompany(state, buildingId, options, CONTENT);
}
