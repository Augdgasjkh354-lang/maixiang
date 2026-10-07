export const CORE_ROLES = Object.freeze({
  farmers: Object.freeze({
    id: "farmers", name: "务农", note: "每人照看10亩", scope: "core", wagePerWorkerDay: 0,
    capacity: "farmland", releasePriority: 10
  }),
  builders: Object.freeze({
    id: "builders", name: "营造", note: "建筑施工期间计日薪", scope: "core", wagePerWorkerDay: 5,
    capacity: "project", releasePriority: 100
  })
});
