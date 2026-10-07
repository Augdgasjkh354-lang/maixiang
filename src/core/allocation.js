export function allocateIntegerByWeight(totalUnits, recipients, weightFor) {
  if (!Number.isSafeInteger(totalUnits) || totalUnits < 0) {
    return { ok: false, reason: "分配数量无效", rows: [], unallocatedUnits: totalUnits };
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { ok: totalUnits === 0, reason: totalUnits === 0 ? null : "没有可接收者", rows: [], unallocatedUnits: totalUnits };
  }
  if (totalUnits === 0) return { ok: true, rows: [], unallocatedUnits: 0 };

  const eligible = [];
  let totalWeight = 0n;
  for (let index = 0; index < recipients.length; index += 1) {
    const recipient = recipients[index];
    const rawWeight = weightFor(recipient, index);
    if (!Number.isSafeInteger(rawWeight) || rawWeight < 0) {
      return { ok: false, reason: "分配权重无效", rows: [], unallocatedUnits: totalUnits };
    }
    if (rawWeight === 0) continue;
    totalWeight += BigInt(rawWeight);
    eligible.push({ recipient, index, weight: BigInt(rawWeight), units: 0, remainder: 0n });
  }
  if (eligible.length === 0 || totalWeight === 0n) {
    return { ok: false, reason: "总权重为0，无法分配", rows: [], unallocatedUnits: totalUnits };
  }

  const total = BigInt(totalUnits);
  let assigned = 0;
  for (const row of eligible) {
    const numerator = total * row.weight;
    row.units = Number(numerator / totalWeight);
    row.remainder = numerator % totalWeight;
    assigned += row.units;
  }

  let remainderUnits = totalUnits - assigned;
  if (remainderUnits > 0) {
    const remainderOrder = eligible.slice().sort((a, b) => {
      if (a.remainder === b.remainder) return a.index - b.index;
      return a.remainder > b.remainder ? -1 : 1;
    });
    for (let i = 0; i < remainderUnits; i += 1) remainderOrder[i].units += 1;
  }

  const rows = eligible
    .filter(row => row.units > 0)
    .sort((a, b) => a.index - b.index)
    .map(row => ({ recipient: row.recipient, units: row.units, weight: Number(row.weight) }));
  const distributed = rows.reduce((sum, row) => sum + row.units, 0);
  if (distributed !== totalUnits) {
    throw new Error(`加权分配守恒失败：期望${totalUnits}，实际${distributed}`);
  }
  return { ok: true, rows, unallocatedUnits: 0 };
}
