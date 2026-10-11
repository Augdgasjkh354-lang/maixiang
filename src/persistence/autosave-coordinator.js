// 自动存档协调器（单飞）。这里只做调度与失败退避，不碰 DOM、不碰存储细节。
// 失败退避：第 n 次连续失败后，等待 min(30 秒, 2 秒 × 2^(n-1)) 再由调用方发起强制重试。

export const AUTOSAVE_RETRY_MAX_MS = 30000;
export const AUTOSAVE_RETRY_BASE_MS = 2000;

export function autosaveRetryDelayMs(failures) {
  if (!(failures > 0)) return 0;
  return Math.min(AUTOSAVE_RETRY_MAX_MS, AUTOSAVE_RETRY_BASE_MS * 2 ** (failures - 1));
}

export function createAutosaveCoordinator({ capture, save, onSuccess = () => {}, onFailure = () => {}, now = () => Date.now() }) {
  let running = null;
  let requested = false;
  let requestedForce = false;
  let requestedManual = false;
  let suspendDepth = 0;
  let failedKey = null;
  let failures = 0;
  let retryAt = 0;

  function snapshotKey(snapshot) {
    if (!snapshot) return "";
    return `${snapshot.session ?? 0}:${snapshot.slotId ?? ""}:${snapshot.revision ?? 0}`;
  }

  // manual：由玩家操作触发的保存（失败要明确告知）；否则为自动存档。
  async function saveSnapshot(force = false, manual = false) {
    const snapshot = capture();
    if (!snapshot || (!snapshot.dirty && !force)) return true;
    const key = snapshotKey(snapshot);
    if (!force && failedKey === key) return false;
    // 自动存档在退避期内不写（否则每个新修订都会立刻再失败一次）；玩家主动保存与强制重试不受影响。
    if (!force && !manual && failures > 0 && now() < retryAt) return false;
    try {
      const result = await save(snapshot);
      failedKey = null;
      failures = 0;
      retryAt = 0;
      onSuccess(snapshot, result);
      return true;
    } catch (error) {
      failedKey = key;
      failures += 1;
      retryAt = now() + autosaveRetryDelayMs(failures);
      onFailure(snapshot, error, { manual, failures, retryAt });
      return false;
    }
  }

  async function drain() {
    let ok = true;
    try {
      while (requested && suspendDepth === 0) {
        const force = requestedForce;
        const manual = requestedManual;
        requested = false;
        requestedForce = false;
        requestedManual = false;
        ok = await saveSnapshot(force, manual);
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

  function request({ force = false, manual = false } = {}) {
    requested = true;
    requestedForce = requestedForce || force;
    requestedManual = requestedManual || manual;
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
      const ok = await saveSnapshot(force && first, true);
      first = false;
      if (!ok) return false;
    }
  }

  function clearFailure() {
    failedKey = null;
    failures = 0;
    retryAt = 0;
  }

  // 上次保存失败且退避时间已到、当前没有保存在进行：调用方应发起一次强制重试。
  function retryDue() {
    return failures > 0 && suspendDepth === 0 && !running && now() >= retryAt;
  }

  return {
    request,
    waitForIdle,
    suspend,
    resume,
    flushSuspended,
    clearFailure,
    retryDue,
    get failures() { return failures; },
    get retryAt() { return retryAt; },
    get inFlight() { return Boolean(running); },
    get suspended() { return suspendDepth > 0; }
  };
}
