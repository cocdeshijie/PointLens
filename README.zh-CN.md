<p align="center">
  <img src="pointlens/assets/icon.png" width="80" height="80" alt="PointLens 标志">
</p>

# PointLens

[English](README.md) | **简体中文**

**酒店积分值多少，一眼就知道。**

PointLens 是一款 Chrome 扩展，在你浏览酒店官网时，直接显示积分兑换价值。
在搜索结果、房型列表和地图中对比现金价与积分价，不用再打开多个标签页或手动计算。

[下载最新版本](https://github.com/cocdeshijie/PointLens/releases/latest) ·
[反馈问题](https://github.com/cocdeshijie/PointLens/issues) ·
[开发指南（英文）](pointlens/README.md)

## 显示效果

酒店价格旁会出现一个简洁的标签：

| 浏览现金价时 | 浏览积分价时 | 紧凑地图标记 |
| --- | --- | --- |
| `1.00¢/pt · 30,000 pts` | `1.00¢/pt · $300.00` | `1.00¢/pt` |

*示例：每晚现金价为 300 美元，或使用 30,000 积分兑换，且积分兑换无需额外支付现金。*

打开 **ⓘ** 可查看用于对比的现金价、积分、基础房价、费用和总价等已有数据。
标签颜色取决于你为各酒店会员计划设置的价值阈值。

## 支持的酒店会员计划

| 酒店官网 | 会员计划 |
| --- | --- |
| [希尔顿 Hilton](https://www.hilton.com/) | Hilton Honors |
| [洲际 IHG](https://www.ihg.com/) | IHG One Rewards |
| [万豪 Marriott](https://www.marriott.com/) | Marriott Bonvoy |
| [凯悦 Hyatt](https://www.hyatt.com/) | World of Hyatt |
| [温德姆 Wyndham](https://www.wyndhamhotels.com/) | Wyndham Rewards |
| [Choice Hotels](https://www.choicehotels.com/) | Choice Privileges |
| [Best Western](https://www.bestwestern.com/) | Best Western Rewards |
| [Sonesta](https://www.sonesta.com/) | Sonesta Travel Pass |

覆盖已适配的搜索结果、房型／房价和地图页面。不同网站的页面布局与可获取的价格数据有所不同。

## 功能

- **现金与积分同时看。** 浏览现金价时显示积分价，浏览积分价时显示用于对比的现金价。
- **地图上直接比较。** 通过紧凑的 CPP 标签快速浏览，打开酒店预览可查看更多详情。
  Best Western 的地图标记无需点击就能显示积分价值；Sonesta 的标签在地图更新时保持在各自的框内。
- **按房型匹配。** 数据允许时，匹配相应房型和房价选项。酒店层面的对比可使用最低可用替代价格，
  并在详情中标明。具体房型的可订状态处理因品牌而异，无法用积分预订的情况会明确显示。
- **价格明细。** 查看已有的基础房价、税费、住宿总价及积分兑换所需的现金费用。
  缺失的数据不会被当作已知价格，估算费用会明确标注。
- **自定义划算标准。** 为每个会员计划分别设置高、低 CPP 阈值，并选择税前或税后比较。
- **浅色、深色或跟随系统。** 按喜好设置扩展弹窗的外观。
- **便捷查看详情。** 支持鼠标悬停、键盘操作或点击打开对比提示框。
- **减少额外请求。** 优先复用酒店网站已加载的价格。需要补充查询时，通过缓存、请求额度和冷却时间
  减少重复请求，并兼顾网站的请求频率限制。Sonesta 不会额外发送价格查询请求。

## 在 Chrome 中安装

1. 从[最新版本页面](https://github.com/cocdeshijie/PointLens/releases/latest)
   下载 `point-lens-…-chrome.zip` 文件。
2. 解压到电脑上一个你会长期保留的文件夹。
3. 打开 `chrome://extensions`，开启 **开发者模式（Developer mode）**。
4. 点击 **加载已解压的扩展程序（Load unpacked）**，选择包含 `manifest.json` 的解压文件夹。
5. 在 Chrome 的扩展程序菜单中固定 PointLens，然后刷新已打开的酒店页面。

像平时一样在支持的酒店官网搜索即可。打开 PointLens 弹窗，可以调整当前会员计划的设置或切换到其他计划。

更新时，将新版本解压到同一个扩展文件夹，在 `chrome://extensions` 中点击
**重新加载（Reload）**，然后刷新酒店页面。

## CPP 如何计算

CPP 是 cents per point，即每积分对应的美分价值。

**每积分价值（美分）=（用于对比的现金价 − 积分兑换所需的现金费用）÷ 积分数 × 100。**

公式中的现金金额以美元计。PointLens 按相同住宿时长和你选择的税费口径进行比较。
例如，300 美元现金价与 30,000 积分相比，价值为 **1.00¢/pt**。
如果积分兑换还需支付 50 美元，价值则约为 **0.83¢/pt**。

外币价格会通过汇率换算，以美分表示 CPP。较高的 CPP 表示在该次比较中，每积分可节省更多现金；
它并不涵盖取消政策、附加服务或现金入住可赚取奖励等所有差异。预订前请确认酒店的最终条款与总价。

## 数据与权限

PointLens 读取支持的酒店页面及其价格响应，并将偏好设置和缓存数据存储在浏览器中。
当前扩展清单申请 HTTPS 网站访问权限，以及用于页面集成与弹窗的
`scripting`、`webRequest`、`tabs` 和 `storage` 权限。
货币换算会向 `open.er-api.com` 请求汇率，成功获取的汇率缓存 24 小时。

酒店网站经常更新。没有出现标签，可能是价格仍在加载、积分房不可订、请求失败，或页面适配需要更新。
Sonesta 积分兑换的税费目前仍为估算值，尚未验证登录后的积分预订结算流程。

## 开发与反馈

扩展使用 **TypeScript、React 和 Plasmo**，面向 Chrome Manifest V3。
每个酒店的适配代码位于 `pointlens/hotels/<brand>/`，包含各自的设置和弹窗组件。
构建命令、基于测试样本的测试及各网站的实现说明，请参阅[开发指南（英文）](pointlens/README.md)。

反馈问题时，请提供酒店网站、受影响的页面类型、入住日期、现金或积分模式、扩展版本以及预期效果。
附上已去除个人信息的截图会更有帮助。请勿在问题反馈中发布 Cookie、登录凭据或预订确认信息。

PointLens 是独立项目，与上述酒店品牌无隶属关系，也未获得其背书。品牌名称与标志归各自所有者所有。
