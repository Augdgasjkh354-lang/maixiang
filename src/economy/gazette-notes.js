// 镇报素材库（state.gazette.notes）：当年发生的重要事件，年终由 systems/gazette.js 编成镇报后清空。
// 只有 recordEvent 带 gazette 标记的消息才进来（见 economy/ledger.js）。每年最多 GAZETTE_NOTES_PER_YEAR 条：
// 满了就替换掉权重最低的一条（同权重保留先发生的），新条目权重不高于最低的就丢弃。
export const GAZETTE_NOTES_PER_YEAR = 40;
export const GAZETTE_ISSUE_LIMIT = 12;

export function addGazetteNote(state, note) {
  const gazette = (state.gazette ||= { notes: [], issues: [], readYear: 0, marks: null });
  const notes = (gazette.notes ||= []);
  const row = {
    year: note.year,
    day: note.day,
    kind: String(note.kind || "other"),
    weight: Math.max(1, Math.floor(Number(note.weight) || 1)),
    text: String(note.text)
  };
  if (notes.length < GAZETTE_NOTES_PER_YEAR) {
    notes.push(row);
    return;
  }
  let lowest = 0;
  for (let i = 1; i < notes.length; i += 1) {
    if (notes[i].weight < notes[lowest].weight) lowest = i;
  }
  if (row.weight > notes[lowest].weight) notes[lowest] = row;
}
