import { ensureProjectAccessor } from "../src/core/state.js";

/**
 * 深拷贝一份共享夹具（{ state, ... }）给某个用例独占使用。
 * 注意 state.project 是不可枚举访问器（单工程兼容入口，见 core/state.js），structuredClone 会丢掉它，
 * 所以拷贝后要补回；否则 state.project 变成 undefined，依赖它的代码（升级、建造进度）会悄悄走错分支。
 */
export function cloneFixture(fixture) {
  const copy = structuredClone(fixture);
  if (copy.state) ensureProjectAccessor(copy.state);
  return copy;
}
