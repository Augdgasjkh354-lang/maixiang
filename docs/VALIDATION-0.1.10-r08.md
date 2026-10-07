# 0.1.10-r08 定向验证

本修订按风险只验证批发市场、综合商店、学堂/饭店及其直接跨系统流程，不重复跑长期经济模拟。

## 本轮专用回归

`node --test tests/v0110-r08-wholesale-commerce.test.js`

覆盖：居民面粉/面包/盐零售渠道限制；批发价×1.2；综合商店50店员/1000客流/30天解雇保护；镇营原料必须经过批发；民营、公司、商店统一批发采购；学堂容量与调价；饭店耗麦与抵粮。

## 直接受影响旧流程

最终执行：

`node --test tests/v0110-r08-wholesale-commerce.test.js tests/v011-industry-supply-demand.test.js tests/v016-agriculture-services.test.js tests/v16-households-commerce.test.js tests/v0110-r07-dangerous-fixes.test.js`

结果：36项中35项通过。唯一失败为“就业换券额度按实际在岗成员每日生成”旧测试；对照 r07 原包，同一测试同样失败，原因是测试夹具没有给镇库预置足够的已发行粮券余额，不属于 r08 回归。r08 新增5项专用回归全部通过，r07 三项危险修复回归全部通过。

## 未扩大验证

本轮未修改人口权威模型、全局支付顺序或存档版本，因此不跑二十年长期模拟，也不以定向测试冒充全量通过。
