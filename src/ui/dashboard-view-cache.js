function selectionKey(selection = {}) {
  return [
    selection.panel || "",
    selection.site || "",
    selection.build || "",
    selection.plotId || "",
    selection.paused === false ? "run" : "paused",
    Number(selection.speed) || 1
  ].join("|");
}

export function createDashboardViewCache(selectDashboard) {
  let stateRevision = 0;
  let cached = null;
  let buildCount = 0;

  function invalidateState() {
    stateRevision += 1;
  }

  function clear() {
    stateRevision += 1;
    cached = null;
  }

  function get(state, selection) {
    if (!state) return null;
    const key = selectionKey(selection);
    if (cached && cached.state === state && cached.stateRevision === stateRevision && cached.selectionKey === key) {
      return cached.view;
    }
    const view = selectDashboard(state, selection);
    buildCount += 1;
    cached = { state, stateRevision, selectionKey: key, view };
    return view;
  }

  function stats() {
    return { stateRevision, buildCount, cached: Boolean(cached) };
  }

  return { get, invalidateState, clear, stats };
}
