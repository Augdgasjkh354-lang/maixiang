# 0.1.5-r02 验证记录

本修订暂停新增玩法，只验证持久化改造及既有 0.1.5 回归。

## 实际根因

0.1.5-r01 虽然去掉了“首次保存立即复制同内容备份”，但核心持久化仍把完整存档 JSON 写入 `localStorage`。真实新局主存档约 **107,773 UTF-8 字节**，按浏览器字符串的 UTF-16 粗估约 **210–213 KB**；在用户实机上该写入被浏览器直接以 `QuotaExceededError` 拒绝。

因此 r01 的根因不是错误提示本身，而是仍把大体积、持续增长且需要轮换备份的游戏状态放在 `localStorage`。同时还有两个恢复缺口：

- 旧单存档、r01 多存档及历史备份没有统一展示和清理入口，遗留数据可继续占用 localStorage。
- “重试本机存储”只读取存档列表，没有真实写入、读回和删除探测，会把“可读但不可写”误判为恢复。

r02 将主存档、轮换备份和存档目录迁移到 IndexedDB；localStorage 不再承担新存档正文。

## Node 回归

命令：

```bash
npm test
```

结果：**171/171 通过**。

其中新增 3 项 r02 持久化测试：

- 遗留扫描正确区分 r01 主档、旧单存档、历史/自动备份和目录，并忽略无关 localStorage 键。
- localStorage 探测必须完成独立小键的“写入 → 读回 → 删除 → 确认删除”，不残留探测键。
- localStorage 仍可读取但写入抛 `QuotaExceededError` 时，探测明确失败，不因读取成功判定恢复。

原 0.1.5 银行、统一支付层、公司/店铺、v12 迁移及 r04 口粮精度回归继续通过。

## 真实 Chromium 持久化链

使用构建后的 `dist/` 在真实 Chromium 页面环境执行 IndexedDB/localStorage、DOM 点击、刷新与文件下载。不是“始终写入成功”的内存存储模拟。

### 1. 正常新局、保存与自动备份

- 空页面启动后，localStorage 中没有 `maixiang-save-*` 或 `maixiang-town-save-v1` 完整存档键。
- “新游戏 → 确认”后 IndexedDB 创建 1 个主槽并激活，首存不生成自动备份。
- 实测首个 IndexedDB 主槽正文：**107,773 UTF-8 字节**。
- 再次保存后才生成上一版本轮换备份。
- 人工破坏 IndexedDB 当前主槽后刷新，成功从 IndexedDB 自动备份恢复。

结果：**通过**。

### 2. 遗留 localStorage 完全不可写，仍能新建/保存/刷新恢复

场景：

- localStorage 预置 1 份旧单存档 + 6 份历史备份，共 **751,924 字节 / 7 个游戏遗留键**。
- 随后强制所有 `localStorage.setItem` 抛 `QuotaExceededError`，模拟“旧数据占用后 localStorage 只读、不可继续写入”。

结果：

- 7 个遗留键全部逐项原样归档到 IndexedDB 并完成读回校验。
- 相同内容的历史备份去重为可玩的迁移槽，但每个原始键仍保留独立 IndexedDB 归档记录；本场景生成 2 个可玩迁移槽。
- 在 localStorage **完全不可写**的状态下仍成功新建第 3 个 IndexedDB 存档。
- 再次保存成功；刷新页面后当前 IndexedDB 存档仍能恢复。
- 整个过程没有向 localStorage 写入新完整存档。

结果：**通过**。

### 3. 恢复按钮必须通过真实写入探测

强制 IndexedDB 所有 `readwrite` 事务抛 `SecurityError`：

- 页面记录失败步骤 `indexeddb_probe_write_read_delete` 和原始 `SecurityError`。
- 点击“真实写入探测”时仍然失败，错误状态保持，**不会显示“本机存储已恢复”**。
- 恢复 IndexedDB 写权限后再次点击，独立探测键完成“写入 → 读回 → 删除 → 确认删除”，错误状态才解除。

结果：**通过**。

### 4. 新局真实写入被拒

在启动探测已经成功后，再强制 IndexedDB `readwrite` 事务抛 `QuotaExceededError`，然后新建游戏：

- 新局持久化失败，失败步骤记录为 `create_slot_write_verify`。
- 故障详情包含待写入大小、IndexedDB 主档/轮换备份/遗留归档占用，以及 localStorage r01 主档/旧单存档/历史备份/目录占用。
- 显示原始 `QuotaExceededError`，不输出存档正文。
- IndexedDB 中没有留下半成品新槽，也没有错误激活目录。
- 页面仍提供临时游玩入口和当前进度导出。

结果：**通过**。

### 5. 遗留数据导出与确认清理

- 旧单存档迁移并读回校验后，存档管理显示“遗留 localStorage 数据”。
- “导出遗留数据”实际下载 JSON。
- 点击清理后，确认前原 localStorage 数据仍存在。
- 玩家再次确认后只删除所选 localStorage 项；IndexedDB 中已验证的原始归档继续保留。

结果：**通过**。

## 迁移与失败语义

- 识别范围：r01 多存档主槽、r01 自动备份、r01 目录、旧单存档、旧单存档历史备份。
- 迁移顺序：原样写入 IndexedDB `legacy` 归档 → 读回逐字节比对 → 可读取进度接入 IndexedDB 存档槽 → 目录写入并读回 → 记录迁移完成信息。
- 任一步失败都保留原 localStorage 数据；不会自动清空或删除唯一进度。
- 清理只允许针对已经完成 IndexedDB 读回校验的单个遗留项，并要求玩家确认。
- IndexedDB 不可用时明确保留原始异常、失败步骤和占用信息，同时保留临时游玩与导出。

## 构建

```bash
npm run build
```

最终交付前重新生成 `dist/`，并核对源码与 `dist/src/` 同步。
