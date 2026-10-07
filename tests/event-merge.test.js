import test from "node:test";
import assert from "node:assert/strict";
import { simulation, CONTENT } from "../src/engine.js";
import { recordEvent } from "../src/economy/ledger.js";
import { legacyVoucherState } from "./helpers-monetary.js";

// 0.1.11 事件合并机制补回：同 mergeKey 在窗口内折叠为一条
test("事件合并：同key窗口内折叠，untilDay/mergeCount/mergeAmount正确", () => {
  const state = legacyVoucherState({ seed: 110601 });
  state.events = []; // 清空fixture自带事件
  state.day = 5;

  recordEvent(state, "挖人1", CONTENT, {
    mergeKey: "labor-poach", mergeWindowDays: 30, amount: 2,
    mergedText: (c, a) => `近来${c}次共挖走${a}人`
  });
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].mergeCount, 1);
  assert.equal(state.events[0].mergeAmount, 2);

  state.day = 10;
  recordEvent(state, "挖人2", CONTENT, {
    mergeKey: "labor-poach", mergeWindowDays: 30, amount: 3,
    mergedText: (c, a) => `近来${c}次共挖走${a}人`
  });
  // 应该折叠，不新增
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].mergeCount, 2);
  assert.equal(state.events[0].mergeAmount, 5);
  assert.equal(state.events[0].untilDay, 10);
  assert.equal(state.events[0].text, "近来2次共挖走5人");
});

test("事件合并：超出窗口不折叠，跨年不折叠", () => {
  const state = legacyVoucherState({ seed: 110602 });
  state.events = [];
  state.day = 5;
  recordEvent(state, "事件1", CONTENT, { mergeKey: "test", mergeWindowDays: 3 });
  state.day = 10; // 超出3天窗口
  recordEvent(state, "事件2", CONTENT, { mergeKey: "test", mergeWindowDays: 3 });
  assert.equal(state.events.length, 2);
});

test("事件合并：无mergeKey时正常unshift", () => {
  const state = legacyVoucherState({ seed: 110603 });
  state.events = [];
  recordEvent(state, "普通事件", CONTENT);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].mergeKey, undefined);
  assert.equal(state.events[0].text, "普通事件");
});
