import { itemQeqUnitsPerInventoryUnit } from "../economy/inventory.js";

export function validateContent(content) {
  const errors = [];
  if (!Number.isInteger(content.precision?.inventoryUnitsPerJin) ||
      content.precision.inventoryUnitsPerJin <= 0 ||
      !Number.isInteger(content.precision?.qeqUnitsPerJin) ||
      content.precision.qeqUnitsPerJin <= 0) {
    errors.push("库存与口粮当量精度必须是正整数");
  }
  for (const [key, item] of Object.entries(content.items || {})) {
    if (item.id !== key) errors.push("物品定义的 id 与注册键不同：" + key);
    if (!item.name || !item.unit) errors.push("物品缺少名称或单位：" + key);
    if (item.edible && (!item.qeq || item.qeq.numerator <= 0 || item.qeq.denominator <= 0)) {
      errors.push("可食物品必须定义正口粮当量：" + key);
    }
    try {
      itemQeqUnitsPerInventoryUnit(item, content);
    } catch (error) {
      errors.push(error.message);
    }
  }
  for (const [key, recipe] of Object.entries(content.recipes || {})) {
    if (recipe.id !== key) errors.push("配方定义的 id 与注册键不同：" + key);
    if (!recipe.outputs?.length || (!recipe.inputs?.length && recipe.kind !== "gather")) {
      errors.push("配方必须有产物；无原料配方须明确标为采集：" + key);
    }
    if (!Number.isInteger(recipe.batchesPerWorkerDay) || recipe.batchesPerWorkerDay <= 0) {
      errors.push("配方批次产能须为正整数：" + key);
    }
    for (const line of [...(recipe.inputs || []), ...(recipe.outputs || []), ...(recipe.losses || [])]) {
      if (!content.items[line.itemId] || !(line.quantity > 0)) {
        errors.push("配方使用未注册物品或无效数量：" + key);
      }
      const scaled = line.quantity * content.precision.inventoryUnitsPerJin;
      if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-9) {
        errors.push("配方数量超出库存精度：" + key);
      }
    }
  }
  const serviceTypes = content.rules?.serviceTypes || {};
  for (const [key, service] of Object.entries(serviceTypes)) {
    if (service.id !== key) errors.push("服务定义的 id 与注册键不同：" + key);
    if (!service.name || !["person", "household", "child"].includes(service.basis)) {
      errors.push("服务缺少名称或需求口径无效：" + key);
    }
    if (!Number.isInteger(service.cycleDays) || service.cycleDays <= 0 ||
        !Number.isFinite(service.priceVoucher) || service.priceVoucher <= 0 ||
        !Number.isFinite(service.merchantCapacity) || service.merchantCapacity <= 0 ||
        !Number.isFinite(service.clerkCapacity) || service.clerkCapacity <= 0 ||
        !Number.isFinite(service.comfort) || service.comfort < 0 ||
        !Number.isFinite(service.incomeSensitivity) || service.incomeSensitivity < 0) {
      errors.push("服务周期、价格、产能或舒心参数无效：" + key);
    }
    if (!Array.isArray(service.consumables)) {
      errors.push("服务耗材必须是数组：" + key);
    } else {
      for (const consumable of service.consumables) {
        if (!content.items[consumable.itemId] || !Number.isFinite(consumable.quantity) || consumable.quantity <= 0) {
          errors.push("服务耗材引用未注册物品或数量无效：" + key);
        }
      }
    }
  }
  if (!Number.isInteger(content.rules?.serviceDemandMaximumCycles) || content.rules.serviceDemandMaximumCycles <= 0 ||
      !Number.isFinite(content.rules?.serviceComfortDailyMaximum) || content.rules.serviceComfortDailyMaximum < 0) {
    errors.push("服务需求累计、预算或舒心上限参数无效");
  }
  for (const [key, shop] of Object.entries(content.rules?.shopTypes || {})) {
    if (shop.id !== key) errors.push("店铺定义的 id 与注册键不同：" + key);
    if (shop.aliasOf && !content.rules.shopTypes[shop.aliasOf]) errors.push("店铺别名引用不存在：" + key);
    if (shop.kind === "service" && !serviceTypes[shop.serviceId]) errors.push("服务店铺引用未注册服务：" + key);
    for (const itemId of shop.itemIds || []) if (!content.items[itemId]) errors.push("零售店铺引用未注册商品：" + key);
  }

  for (const [key, building] of Object.entries(content.buildings || {})) {
    if (building.id !== key) errors.push("建筑定义的 id 与注册键不同：" + key);
    if (building.recipeId && !content.recipes[building.recipeId]) {
      errors.push("建筑引用了未注册配方：" + key);
    }
    if (!building.construction || !(building.construction.workDays > 0) || !(building.construction.recommendedWorkers > 0)) {
      errors.push("建筑施工参数无效：" + key);
    }
    for (const material of building.materialRequirements || []) {
      if (!content.items[material.itemId] || !Number.isFinite(material.quantity) || material.quantity <= 0) {
        errors.push("建筑材料要求无效：" + key);
      }
    }
    if (building.upgrade) {
      if (!Number.isInteger(building.upgrade.maxLevel) || building.upgrade.maxLevel < 1 ||
          !Number.isInteger(building.upgrade.workDays) || building.upgrade.workDays <= 0) {
        errors.push("建筑升级参数无效：" + key);
      }
      for (const material of building.upgrade.materialRequirements || []) {
        if (!content.items[material.itemId] || !Number.isFinite(material.quantity) || material.quantity <= 0) {
          errors.push("升级材料要求无效：" + key);
        }
      }
    }
    if (building.housingCapacity !== undefined && (!Number.isInteger(building.housingCapacity) || building.housingCapacity <= 0)) {
      errors.push("建筑住房容量无效：" + key);
    }
    for (const job of building.jobs || []) {
      if (!job.id || job.slots <= 0 || job.wagePerWorkerDay < 0) {
        errors.push("建筑岗位参数无效：" + key);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
