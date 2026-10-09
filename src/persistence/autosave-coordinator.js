export function createAutosaveCoordinator({ capture, save, onSuccess = () => {}, onFailure = () => {} }) {
  let running = null;
  let requested = false;
  let requestedForce = false;
  let suspendDepth = 0;
  let failedKey = null;

  function snapshotKey(snapshot) {
    if (!snapshot) return "";
    return `${snapshot.session ?? 0}:${snapshot.slotId ?? ""}:${snapshot.revision ?? 0}`;
  }

  async function saveSnapshot(force = false) {
    const snapshot = capture();
    if (!snapshot || (!snapshot.dirty && !force)) return true;
    const key = snapshotKey(snapshot);
    if (!force && failedKey === key) return false;
    try {
      const result = await save(snapshot);
      failedKey = null;
      onSuccess(snapshot, result);
      return true;
    } catch (error) {
      failedKey = key;
      onFailure(snapshot, error);
      return false;
    }
  }

  async function drain() {
    let ok = true;
    try {
      while (requested && suspendDepth === 0) {
        const force = requestedForce;
        requested = false;
        requestedForce = false;
        ok = await saveSnapshot(force);
        if (!ok) break;
        // 不因"存完后又变脏"自动再存：快进时日结一直在推进，状态永远是脏的，
        // 原来会一存完就接着存（每秒一两次整局存档，快进卡顿的主因）。存档期间有新的
        // request 时 requested 已被置位，会照常补存；其余交给自动存档周期与玩家操作。
      }
      return ok;
    } finally {
      running = null;
      if (requested && suspendDepth === 0 && !running) running = drain();
    }
  }

  function request({ force = false } = {}) {
    requested = true;
    requestedForce = requestedForce || force;
    if (suspendDepth > 0) return Promise.resolve(true);
    if (!running) running = drain();
    return running;
  }

  async function waitForIdle() {
    while (running) await running;
  }

  function suspend() {
    suspendDepth += 1;
  }

  function resume() {
    suspendDepth = Math.max(0, suspendDepth - 1);
    if (suspendDepth === 0 && requested && !running) running = drain();
  }

  async function flushSuspended({ force = false } = {}) {
    if (suspendDepth <= 0) throw new Error("flushSuspended requires autosave suspension");
    await waitForIdle();
    let first = true;
    while (true) {
      const snapshot = capture();
      if (!snapshot || (!snapshot.dirty && !(force && first))) return true;
      const ok = await saveSnapshot(force && first);
      first = false;
      if (!ok) return false;
    }
  }

  function clearFailure() {
    failedKey = null;
  }

  return {
    request,
    waitForIdle,
    suspend,
    resume,
    flushSuspended,
    clearFailure,
    get inFlight() { return Boolean(running); },
    get suspended() { return suspendDepth > 0; }
  };
}
