# sap-harmony-mcp — Claude 直连 SAP Harmony (Callidus CPQ)

**"用大白话告诉 Claude 你想在这个 Opp/Quote 上做什么,它去 Harmony 帮你办。"**

Harmony (Callidus CPQ) 是 SAP 内部所有 renewal / new business 单子的落地系统 —— 一切合同金额、审批、状态流转都在这里发生。这个 MCP 让你不必打开浏览器点来点去,直接用自然语言指挥 Claude 去 Harmony 里查、动、改。

---

## 你可以让 Claude 做这些事

### 🔍 我想看一个 Opp 到底怎么样

> "Opp 306192295 的完整情况是什么?"

Claude 一次拉齐:客户是谁 (Sold-to / ERP ID)、金额多少 (ACV/TCV/Cloud Revenue)、当前阶段 (ZP5 / Draft / In Approval …)、涉及哪些人 (AE / SE / renewal manager / partner)、卖的是什么产品 (Contractitems)、有几个 quote、每个 quote 卖多少钱、合同起止日期、Uplift 涨价百分比、还有几十条业务字段。

> "这个 opp 的 owner 是谁?" / "涨价多少?" / "OrderBaseValue 是多少?" / "预计什么时候关单?"

问一句给一句 —— 数据全在返回里,不需要再敲第二次。

### 📋 我想看某个 Quote 的所有细节

> "Quote 028981001204 里都有什么?"

拿到 quote 的 **18 张业务表**:
- **Contractitems** — 卖的产品行(SKU、数量、单价、Uplift、合同起止)
- **Deal_Review** — 5 类审批槽位 (General / HEC Cloud / PSSO / Delivery Approval / On Request Products) 及各自状态
- **PartnerFunctions** — Quote 涉及的角色(Sold-to / Ship-to / Bill-to / Payer / 内部销售角色)
- **Health_Discussion** — 客户健康度讨论记录
- **Price_Protection** — 价格保护条款
- **Error_Messages** — 系统提示的阻塞项
- **Pre_Approved_Terms / TC_Container / ContractDates** — 条款、合同期
- ...一共 18 张

> "这个 quote 的 Deal Review 状态是什么?哪几方还没批?"
> "Error_Messages 里有什么阻塞项?"
> "PartnerFunctions 里 renewal manager 是谁?"

### 📎 我想看一个 Opp 下面挂了几个 Quote

> "Opp 306192295 下面有哪些 quote?"

每个 quote 返回:composite number(下一步查详情的 key)、状态(Draft / In Approval / Approved …)、Description、Cloud/OnPrem/Service 三条业务线金额、Contract Start / End、Currency、IsECS、IsMain。

### 📄 我想看这个 Opp 关联的历史合同

> "这个 opp 关联了哪些已有合同?"

Claude 调 `GetContractsFromOpp` 拿合同列表 —— 续约类 opp 通常会关联 1-N 条老合同,判断续约健康度必看。

### 🚦 我想触发一个 Harmony 操作(RPC)

Harmony 有 40+ 个"函数式操作",Claude 都能直接调用:

| 你说 | Claude 触发的 FunctionImport |
|---|---|
| "把 opp 306192295 复制一份" | `CopyOpportunity` |
| "创建一个 deal" | `CreateDeal` |
| "取消这个 opp 的所有 quote" | `CancelAllQuotes` |
| "标记这个 opp 为 Discontinue" | `DiscontinueHDMOpp` |
| "重新计算 parties" | `RedetermineParties` |
| "刷新 Account Owner" | `RefreshAccountOwner` |
| "通知 Opp Owner" | `NotifyOpptOwner` |
| "触发 GRC 活动" | `TriggerGRCActivity` |
| ...(还有 32+ 个) | 见 metadata |

不确定有没有对应操作?让 Claude 先跑 `harmony_odata_metadata` 拉全 schema 就能看到所有可用的 FunctionImport 名字和参数签名。

### ✏️ 我想改一个字段

> "把 opp 306192295 的 DISCONTINUE_NOTES 改成 'Customer moved to competitor'"

Claude 走 OData MERGE(自动处理 CSRF token)。**注意 Harmony 的写路径有个特殊行为**:每次写都会跑整个 entity 的业务规则校验,常见结果是收到 501 + 具体规则名(比如 "No Competitor Involved selected"、"GDPR classification required")。这是**和 UI 完全一致**的行为,不是 API 限制。这时候的路径是:

1. 看清楚 error 里说要补哪些字段
2. 要么补齐再 MERGE,要么改走对应的 FunctionImport(带业务规则封装,不会误报)

### 🔬 我想 CLI-ify 一个 UI 里的操作

Harmony 里有些操作没有对应的 FunctionImport(比如某个特殊的字段变更、某个多步流程),这时候用**探针**:

1. 让 Claude 启动 `harmony_probe_capture(seconds=30)`
2. 你在浏览器里手动执行那个操作
3. Claude 拿回真实的请求 URL / method / body / CSRF 契约,而且每个 Cart REST 调用都自动关联到你刚点的按钮标签(`uiLabel` 字段)
4. 下次让 Claude 用 `harmony_odata_function` 或 `harmony_odata_merge` 直接调,不用再开浏览器

**批量 CLI-ify(新 v0.3)** —— 与其一个个手点探针,不如让 Claude 一次扫遍整个 Quote 页面:

1. `harmony_sweep_ui_actions(mode:"dryRun")` —— 枚举 CPQ iframe 里所有可点击元素,按标签自动分类(safe / probablySafe / destructive / unknown),返回一份"点击计划"给你审阅
2. `harmony_sweep_ui_actions(mode:"strict")` —— 只点安全动词(Refresh / Expand / Collapse / tab-switch),自动屏蔽 Save / Submit / Delete / Discontinue。每次点击后 2 秒窗口抓 request burst,把每个 Cart `actionId` 关联回按钮标签
3. `harmony_actionid_report({probeResult, write:true})` —— 把探针/扫描的结果整理成 Markdown 表格,自动去重已知的 actionId,append 到 `CPQ_REVERSE_ENGINEERING.md`

**一次扫描填几十行 actionId 表** —— 一个真实 Quote 页面上通常有 40-60 个可点击元素,手工探针每个都要 seconds=30,批量扫描 5 分钟解决。

> ⚠️ 需要活着的 Chrome (CDP :9222) 的工具:`harmony_probe_capture`、`harmony_sweep_ui_actions` 以及所有 `harmony_cart_*` / `harmony_configurator_*` / `harmony_cpq_direct_*` —— 其他所有工具都走 headless SSO,不需要浏览器在跑。
> 探针 + 扫描工具使用 Playwright over CDP,**自动跟随所有 iframe**(包括 Harmony 内嵌的 CPQ UI, `sap-ies-sales.cpq.cloud.sap`)—— 抓包完整度比传统 CDP 单 target 高一个数量级。
>
> 探针发现的 CPQ 后端 4 层 API 契约、脚本名、actionId 列表见 `CPQ_REVERSE_ENGINEERING.md`。`harmony_actionid_report(..., write:true)` 会自动 append 新行。

### 🔑 我想确认一下当前 auth 有没有问题

> "Harmony 能通吗?" / "帮我确认 auth"

Claude 跑 `harmony_whoami` —— 30 秒内如果没走过 SSO,会自动 headless 登录一次并把 cookie 存 `~/.sap-mcp/auth.json`,然后返回你的姓名、I-number、SAP scopes。之后 24 小时内所有工具秒速响应。

---

## 认证怎么运作

跟同 monorepo 里的 `sap-wiki`、`sap-outlook`、`sap-one360`、`sap-ekx` **完全一样**:

1. 第一次调用时,后台 headless 浏览器打开 Harmony 主页
2. SAP IdP 通过 SAML 完成 SSO,返回 cookie
3. Cookie 存 `~/.sap-mcp/auth.json`,24 小时 TTL,过期自动刷新
4. 后续所有 HTTP 请求直接带这个 cookie 走 → 秒级响应,无需 Chrome 打开

**你不需要**:配置密码、维护 token、开着 Chrome、跑 `quote-creation` skill 先登录。

**你需要**:第一次调用等 ~30 秒(headless SSO),之后全部是缓存命中。

---

## 已知边界

**读侧** — 覆盖率非常完整,任何在 UI 里能看到的字段基本都能通过 `harmony_opp_read` / `harmony_quote_read` / OData FunctionImport 拿到。

**写侧** — 三种情况:
- **有对应 FunctionImport 的**(状态流转、审批完成、复制、取消 …) → 直接调,稳定。
- **单纯字段更新**(备注、reason code …)→ 用 MERGE,但要接受可能被业务规则打回来。
- **没有对应 FunctionImport 又碰业务规则墙的**(比如强改 Quote* 系列表的字段)→ 走 UI 自动化(`quote-creation` skill)或用 probe 抓契约后再 CLI-ify。

---

## 一句话总结

**Opp / Quote 想看什么、想改什么、想触发什么,直接跟 Claude 说,不必打开 Harmony UI。**

想深入了解每个工具的入参出参?运行 `/mcp` 展开 `sap-harmony` 即可。想扩展新操作?见探针流程那节。
