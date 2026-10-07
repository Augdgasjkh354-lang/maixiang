import test from "node:test";
import assert from "node:assert/strict";
import { createAutosaveCoordinator } from "../src/persistence/autosave-coordinator.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("0.1.10 自动保存单飞：保存中变化合并为一次最新快照，旧成功不清新dirty", async () => {
  let runtime = { slotId: "A", session: 1, revision: 1, dirty: true, state: { value: 1 } };
  const gates = [deferred(), deferred()];
  const saved = [];
  const disk = new Map([["A", 0]]);
  let active = 0;
  let maxActive = 0;
  const coordinator = createAutosaveCoordinator({
    capture: () => ({ ...runtime }),
    save: async snapshot => {
      active += 1; maxActive = Math.max(maxActive, active);
      saved.push({ slotId: snapshot.slotId, revision: snapshot.revision, value: snapshot.state.value });
      await gates[saved.length - 1].promise;
      disk.set(snapshot.slotId, snapshot.state.value);
      active -= 1;
      return { savedAt: `t${snapshot.revision}` };
    },
    onSuccess: snapshot => {
      if (snapshot.slotId === runtime.slotId && snapshot.session === runtime.session && snapshot.revision === runtime.revision) runtime.dirty = false;
    }
  });

  const first = coordinator.request();
  await Promise.resolve();
  runtime = { ...runtime, revision: 2, dirty: true, state: { value: 2 } };
  void coordinator.request();
  gates[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.dirty, true, "旧快照成功时新修订仍应保持dirty");
  gates[1].resolve();
  assert.equal(await first, true);
  await coordinator.waitForIdle();
  assert.deepEqual(saved, [
    { slotId: "A", revision: 1, value: 1 },
    { slotId: "A", revision: 2, value: 2 }
  ]);
  assert.equal(maxActive, 1);
  assert.equal(runtime.dirty, false);
  assert.equal(disk.get("A"), 2, "合并保存结束后磁盘必须是最新修订");
});

test("0.1.10 保存失败不立即无限重试；新修订或手动强制可恢复", async () => {
  let runtime = { slotId: "A", session: 1, revision: 1, dirty: true, state: { value: 1 } };
  let calls = 0;
  let fail = true;
  let diskValue = 0;
  const coordinator = createAutosaveCoordinator({
    capture: () => ({ ...runtime }),
    save: async snapshot => {
      calls += 1;
      if (fail) throw new Error("forced failure");
      diskValue = snapshot.state.value;
      return { savedAt: "ok", revision: snapshot.revision };
    },
    onSuccess: snapshot => { if (snapshot.revision === runtime.revision) runtime.dirty = false; }
  });
  assert.equal(await coordinator.request(), false);
  assert.equal(calls, 1);
  assert.equal(diskValue, 0, "失败保存不得破坏上一份可用进度");
  assert.equal(await coordinator.request(), false);
  assert.equal(calls, 1, "相同失败修订的自动保存不得立即反复写");
  fail = false;
  assert.equal(await coordinator.request({ force: true }), true);
  assert.equal(calls, 2);
  assert.equal(runtime.dirty, false);
  assert.equal(diskValue, 1);

  runtime = { ...runtime, revision: 2, dirty: true, state: { value: 2 } };
  assert.equal(await coordinator.request(), true);
  assert.equal(calls, 3, "新修订允许再次自动保存");
});

test("0.1.10 切档/新建/删除屏障等待在途保存，旧槽任务不会在操作后复活或写入新槽", async () => {
  let runtime = { slotId: "A", session: 1, revision: 1, dirty: true, state: { value: 1 } };
  const gate = deferred();
  const writes = [];
  const coordinator = createAutosaveCoordinator({
    capture: () => runtime ? ({ ...runtime }) : null,
    save: async snapshot => { writes.push(snapshot.slotId); if (writes.length === 1) await gate.promise; return { savedAt: "ok" }; },
    onSuccess: snapshot => {
      if (runtime && snapshot.slotId === runtime.slotId && snapshot.session === runtime.session && snapshot.revision === runtime.revision) runtime.dirty = false;
    }
  });

  void coordinator.request();
  await Promise.resolve();
  coordinator.suspend();
  const idle = coordinator.waitForIdle();
  runtime = { ...runtime, revision: 2, dirty: true, state: { value: 2 } };
  void coordinator.request();
  gate.resolve();
  await idle;
  assert.equal(await coordinator.flushSuspended({ force: true }), true);
  runtime = { slotId: "B", session: 2, revision: 0, dirty: false, state: { value: 0 } };
  coordinator.resume();
  await coordinator.waitForIdle();
  assert.deepEqual(writes, ["A", "A"]);

  coordinator.suspend();
  await coordinator.waitForIdle();
  runtime = null; // 删除当前槽后的界面状态
  coordinator.resume();
  await coordinator.request();
  assert.deepEqual(writes, ["A", "A"], "删除后不得由旧autosave重新创建槽位");
});
