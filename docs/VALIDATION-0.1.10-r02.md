# 0.1.10-r02 定向修复与验证

## 修复范围

1. **发布身份核对**
   - r01 ZIP 中 `src/ui/panel-settings.js` 与 `dist/src/ui/panel-settings.js` 的恢复按钮均为“真实写入探测”，源码与构建产物一致。
   - r02 设置页固定显示游戏版本、唯一构建号 `0110-r02-b001` 和浏览器当前 `location.href`；应用根节点同时暴露 `data-app-version` / `data-build-id`，页面标题也带构建号。
   - 仓库没有 Service Worker；因此截图仍出现“重试本机存储”时，可直接用构建号和页面地址判断是否打开了旧部署或旧缓存。本包不发布 Sites，未能从代码环境直接读取用户手机当前远端 URL 或浏览器缓存状态。

2. **公司岗位工资绑定**
   - `selectJobRows` 的 `listed` 岗位按建筑找到对应公司，工资读取 `company.settings.wagePerWorkerDay`。
   - `panel-jobs` 对企业岗位使用唯一 `company:<companyId>:wage` 草稿键，并提交 `company-wage` 到具体 `companyId`。
   - `app` 的数字输入提交入口调用 `simulation.configureCompanyWage`；不再对企业岗位调用全局 `setWageRate(roleId)`。
   - 地点详情中的企业岗位工资展示同步读取公司工资。

3. **遗留迁移故障隔离**
   - `createIndexedSaveManager` 先读取现有 IndexedDB，再尝试迁移遗留 localStorage。迁移失败仅生成独立 warning，并重新刷新 IndexedDB 缓存。
   - 迁移失败不删除或覆盖 localStorage 原始字节，也不阻断既有 IndexedDB 存档读取或新建存档。
   - 启动层仍执行 `probePersistentStorage` 的实际写入、读回、删除；若 IndexedDB 本身不可写，仍进入真实持久化故障状态，不假报恢复。

## 定向验证

实际执行：

```text
node --test \
  tests/v0110-r02-targeted.test.js \
  tests/v017-company-exchange.test.js \
  tests/v017-r02-fixes.test.js \
  tests/v018-dashboard-optimization.test.js \
  tests/v0110-persistence-history.test.js \
  tests/v0110-autosave-coordinator.test.js
```

结果：**35/35 通过**。

新增 r02 定向覆盖 4 项：

- 两家同工种公司工资分别为 20/30 时，就业 selector 和面板分别指向各自公司；修改甲公司为 25 后乙公司仍为 30、全局磨坊工资仍为 10；1 名工人的实际应付分别按 25/30 计提。
- 设置页显示 `0.1.10 / 0110-r02-b001 / 当前页面地址`，故障恢复按钮仍为“真实写入探测”。
- 强制 `legacy` object store 写入失败：管理器仍成功创建，原有 IndexedDB 活跃存档可读，可新建存档，原 localStorage 完整保留。
- 强制 IndexedDB 所有写入失败：管理器可暴露迁移警告，但真实持久化探测继续失败，不会报告存储恢复。

同时重跑公司/交易所、r02 经济修复、0.1.8 Dashboard、0.1.10 容器/年报与自动保存直接受影响回归。未运行全量经济测试或多年模拟。
