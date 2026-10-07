const legacyPlots = [
  Object.freeze({ id: "east", label: "溪畔空地", x: 76.5, y: 58.5 }),
  Object.freeze({ id: "south", label: "南路空地", x: 81.5, y: 77 })
];
const expansionPlots = [];
const columns = [22, 34, 46, 58, 70, 82, 94];
const rows = [52, 65, 78, 91];
for (const y of rows) {
  for (const x of columns) {
    if ((x === 46 && y === 52) || (x === 58 && y === 52) || (x === 70 && y === 52) || (x === 82 && y === 52) ||
        (x === 70 && y === 65) || (x === 82 && y === 65) || (x === 82 && y === 78)) continue;
    const n = expansionPlots.length + 1;
    expansionPlots.push(Object.freeze({
      id: "village-" + String(n).padStart(2, "0"),
      label: "空地 " + n,
      x, y
    }));
  }
}
// Keep a western lane clear around the well; this replaces the site removed above.
expansionPlots.push(Object.freeze({
  id: "village-22",
  label: "空地 22",
  x: 10,
  y: 52
}));
const resourcePlots = [
  Object.freeze({ id: "forest-logging-01", label: "南林伐木资源点", x: 6, y: 82, feature: "logging_resource" }),
  Object.freeze({ id: "forest-salt-01", label: "南部盐矿资源点", x: 6, y: 96, feature: "salt_mine" })
];
// Keep all legacy IDs and coordinates stable; resource sites are appended as distinct plots.
export const PLOTS = Object.freeze([...legacyPlots, ...expansionPlots, ...resourcePlots]);

export const BUILDING_PRESENTATION = Object.freeze({
  granary: Object.freeze({ label: "共用粮仓", icon: "🌾", x: 48, y: 34 }),
  houses: Object.freeze({ label: "村舍", icon: "🏠", x: 58, y: 66 }),
  well: Object.freeze({ label: "古井", icon: "🪣", x: 41, y: 72 }),
  field: Object.freeze({ label: "镇有麦田", icon: "🌱", x: 24, y: 38 })
});
