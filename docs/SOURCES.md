# 数据、模型与玩法来源

更新日期：2026-10-15。记录官方数据、参考资料及本项目创作之间的关系。

## 官方服务与餐品

- [麦当劳 MCP Server](https://github.com/M-China/mcd-mcp-server)和[官方接入文档](https://open.mcd.cn/mcp/doc)说明餐品目录、门店菜单、餐品详情与核价能力。真实调用、参数范围及当前验证状态见 [MCP_INTEGRATION.md](../MCP_INTEGRATION.md)。
- 2026-10-15 本地真实调用 `list-nutrition-foods` 返回 158 项，匹配当前玩法的巨无霸、麦辣鸡腿汉堡、五块麦乐鸡、中薯条、麦香鱼 5 款。目录项确认产品身份，食材份额由游戏定义。
- [麦乐鸡商品页](https://www.mcdonalds.com.cn/product/chicken-mcnuggets)提供五块规格的产品信息；游戏中每块鸡块的轨迹、效果与奖励为独立规则。
- 门店价格必须使用官方查询结果的实际商品编码、门店、用餐方式和读取时间。当前门店价格接入的完成状态，以项目最新验收和页面标注为准。

## 名称核对的早期参考

早期原型使用第三方公开的 [maimai-restaurant-huiyan 餐品快照](https://github.com/Nothingsssss/maimai-restaurant-huiyan/blob/main/data/mcd-menu.json)核对商品名称。该文件自述更新时间为 2026-10-11T12:21:08.985Z，当时读取的 blob SHA 为 `95cfc80e19faf64bb2791d8b969ededb9d81f2c7`。

本项目只从这份资料核对产品名称与规格；当前已直接调用官方 MCP。第三方文件中的 `unknown-*` 标识不作为本项目菜单商品编码，也不用于核价或任何真实订单。

## 当前模型和场景

`src/food-models.js` 与 `src/ingredient-models.js` 使用 Three.js 几何体、材质、程序生成纹理构建玩具风格食物、包装及发射器。配餐图片由这些本地 3D 模型渲染生成；建筑、光照与布局由 `src/main.js` 组织，酱汁和碎屑效果由 `src/impact-fx.js` 生成。

ABC 是本游戏的虚构食物餐厅名称。建筑由概括的面包、肉饼、鸡块、薯条、酱汁、蛋挞、纸桶等食物与包装形态组成。其支撑、碰撞、消除和组合效果属于游戏创作。

早期食品外形研究参考过[肯德基中国官网](https://www.kfc.com.cn/)及[百胜中国的食品介绍](https://ir.yumchina.com/static-files/d9d4333b-d3c5-4640-8876-9d11034e0dd6)。保留链接用于说明研究出处；当前公开关卡与文案统一使用虚构 ABC，未将上述品牌的图片或模型导入游戏。

## 界面参考与权利归属

白黄配色、清晰餐品图及加减点餐交互参考[麦当劳中国官网](https://www.mcdonalds.com.cn/)和[官方 App 展示（2021）](https://www.mcdonalds.com.cn/news/20210518-App-new-launch/)。商品名称、品牌标识和相关服务仍归各自权利人。独立开发说明适用于本项目代码、程序化模型和游戏机制，品牌标识不被声明为本项目原创。

依赖许可见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。本项目没有因技术接入取得官方合作、品牌授权或比赛资格通过的证明；发布与参赛状态分别记录。

## 游戏数值

虚拟金币、初始预算、配装份额、食材数量、射速、碰撞范围、组合消除规则及得分由 `src/ingredient-rules.js`、`src/economy.js` 和游戏主逻辑定义。游戏金币不代表人民币价格，游戏食材份额不代表官方完整配方或原料重量。
