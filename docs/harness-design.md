# K 测试框架（harness）设计 v1

xxchan 08-05：测试框架要**提前设计成完整的一块**，不是随层补测试。本文是 harness 的架构设计；`test-plan.md` 是跑在它上面的计划。

## 0. 定位：harness = 框架的可执行规格（executable spec）

顺序反转：**先有 harness，后有功能层**。每个功能层落地的定义 = "它让 harness 里预先写好的那组齿从 RED 变 GREEN"。测试不是功能的附件，是功能的规格。三个推论：
1. M0（harness 自举）先于一切层实现；
2. **不允许 harness 外的 ad-hoc 测试**——新齿必须进 registry（否则齿的 must-red/分档/自验纪律管不到它）；
3. harness 只吃 core 的公共 API + HostAdapter ⇒ 它同时是 **API 的第一个消费者**（dogfood：API 不好用，harness 先痛）。

## 1. 组件架构

```
harness/
├─ fake-host/        假宿主（两种形态）
│   ├─ inproc.ts     进程内 HostAdapter 实现（快速单元级）
│   └─ daemon.ts     可 spawn 的真进程假 daemon（kill -9 是真的）
├─ fake-server/      本地静态发布服务器 + 篡改 API
├─ artifact-factory/ 版本工件工厂（一次构建多次盖戳 + behavior 旋钮 + 签名链）
├─ scenario/         场景运行器（隔离沙箱 + 虚拟时钟）
├─ crash/            崩溃注入编排器（枚举生成，禁手列）
├─ teeth/            齿注册表 + 分档 + 自验
└─ cli.ts            `k-harness` 入口（含 --adapter 接入方模式）
```

### 1.1 fake-host（假宿主）
- **两形态**：`inproc`（进程内实现，跑快速逻辑齿）+ `process`（编译成真二进制、真 spawn、真 PID/startId —— kill -9、双跑检测、probe 活性都必须在真进程上验，mock 验不了崩溃）。
- **故障注入开关**（per 方法）：`fail-on-quiesce / hang-on-stop / wrong-version-probe / stale-startId-probe / crash-during-start ...`——每颗齿测"故障被抓"，开关关掉齿必须转绿（证明齿测的是故障不是常态）。
- **虚拟负载账本**：假宿主维护一个确定性"会话状态"文件（计数器+校验和）；`quiesce↔resume` 等价断言 = 账本逐字节比对（**含 rolled-back 后 resume**）。这是"会话保留"的可机械判定形态。

### 1.2 fake-server（假发布端）
- 本地静态文件服务 + manifest 构造器 + 测试密钥签名助手（root/signing 全套测试链）。
- **篡改 API**：`corruptByte(file, offset) / swapSig / serveOlderVersion / dropFile` —— 供应链齿全部走"真篡改→真拒绝"，不 mock 校验函数。

### 1.3 scenario（场景运行器）
- **一场景一沙箱**：独立 temp stateDir + 独立 fake-server 端口 → 全部并行安全、可重复。
- **虚拟时钟注入**：core 的超时/重试全走注入 clock（框架级 clock seam —— 我们 web 侧 clock-ratchet 的同款纪律），场景可快进；无真实 sleep。
- 场景 = 声明式脚本（步骤 + 期望 outcome + 期望 journal 尾部），跑完输出结构化 receipt（给 CI 和人两用）。

### 1.4 crash（崩溃注入编排器，承重件）
- **覆盖面由代码生成**：从 core 导入状态机迁移表，自动枚举 `迁移边 × kill 点`（每个动作的 journal-写前/写后至少两点）→ 生成场景矩阵。**手列 kill 点非法**。
- **完备性齿**：core 新增一个 phase/迁移而矩阵没覆盖 ⇒ harness 自身 RED（枚举器数量对账）。防"加了状态忘了测崩溃"。
- 每格断言同一组不变式：重启后 = 恢复 stable 或完成迁移；**永不双跑**（真进程存活探测）；**永不砖**（stable 可再启动）；journal 可重放。

### 1.45 DST：确定性模拟测试（xxchan 08-05 提议；与崩溃矩阵互补）

**两条腿**：崩溃矩阵 = **枚举穷举**（在它的粒度上完备，给保证）；DST = **种子随机深探**（FoundationDB/TigerBeetle 手法，找枚举想不到的交错，给发现）。

- **前提（对 txn 引擎的架构约束，写引擎前就定）**：L1 引擎 = **纯状态机 + Effects 接口**——journal append/fsync、槽操作、宿主调用、时钟全部经注入的 effects 层，引擎本体零直接 IO/时间/随机。这**不是**测试后门（§1.8 自洽）：effects 层就是平台适配器的天然挂点（各平台 fsync/swap 本来就不同实现），是产品级抽象。
- **模拟器**：SimEffects = 内存盘（可模拟 partial write / fsync 丢失 / 重排）+ VirtualClock + **种子 PRNG 故障调度器**（在任意 effect 点注入 crash/fail/delay，按种子决定）。跑 N 千个种子 × 每种子一条完整升级/回滚剧本 → 断言同一组不变式（永不双跑/永不砖/journal 可重放/谓词诚实）。
- **可复现**：任何失败 = 一个种子号，`k-harness sim --seed X` 逐字节重放。**失败种子沉淀为枚举矩阵的新固定格**（发现→保证的转化管道）。
- **跑法**：PR 门跑固定 smoke 种子集（快、确定）；夜跑扩大随机种子量；语料库（历史失败种子）永久保留。
- 范围诚实：DST 覆盖 txn/converge 的逻辑交错；真进程/真 OS 面（信号、真 fsync 语义）仍归崩溃矩阵与真机轮——**模拟不替代真进程层，两者叠加**。

### 1.5 teeth（齿注册表）
每颗齿是一条注册记录，声明即纪律（缺任一字段注册失败）：
```ts
registerTooth({
  id: "txn.no-dual-run",
  profiles: ["service", "hosted"],          // 分档
  kind: "invariant",                        // 或 { kind: "baseline", failureCondition: "..." }
  mustRed: [                                // mutation 契约：≥1 条，且答得出"不被我抓还会被谁抓"
    { mutate: "skip journal fsync before handover", caughtOnlyBy: "this" },
  ],
  run: async (ctx) => { ... },
});
```
- **分档执行**：`--profile swap|daemon|managed` 选齿集；cli 档误挂 L2 齿 ⇒ 注册期报错（档界齿）。
- **断言二分机械化**：`kind` 必填 invariant 或 baseline-带失效条件；CI 扫无标注断言（#395 纪律的执行器）。
- **mutation-runner 对接**：registry 导出齿清单 + must-red 表，Lincan 的 runner 直接消费（未变异 baseline 0 失败 / 每齿变异必红 / 全红也不发结论）。

### 1.6 自验（M0 出口，harness 的上岗证）
harness 判定别人之前先判自己，三样本缺一不可：
- **known-green**：正确实现走完整升级 → 必须全绿；
- **known-red**：注入一个已知故障 → 对应齿必须红、且只红该红的；
- **对抗样本**：**结构上能过齿的检查、但违反真实 oracle** 的假实现（例：probe 换 pid 不换 startId 报新版本；quiesce 把账本备份再恢复伪装等价）→ 必须被抓。对抗样本清单随齿长（每次真实逃逸事后加一条）。
自验不过 ⇒ harness 拒绝运行任何评审（exit 非零 + typed 原因）。

### 1.7 接入方模式（`k-harness --profile X --adapter path`）
同一套齿对**外部真 adapter** 跑合规子集（不跑需要故障开关的齿，跑契约齿：quiesce↔resume 等价、probe 活性、ownership 响应）。绿 = 接入方契约达标；这也是 examples 三 demo 的验收方式——**demo 和接入方走同一道门**。

## 1.75 两个测试平面：黑盒优先（xxchan 08-05："就像启动一个 CLI、跑它的命令"）

harness 有两个平面，**默认用外面那个**：

- **黑盒平面（主平面）**：spawn **真实打包好的二进制**，只通过它的命令行驱动（`mytool self upgrade` / `mytool status`），从外面断言：exit code、输出、盘上文件、进程状态、下次运行的版本。**就是用户的用法** —— 它顺带真正验证了"每个入口构造同一 Upgrader"这类 claim（library 平面验不了打包/入口接线）。examples 三 demo 都是真 CLI，端到端齿全在这层写。
- **library 平面（辅助）**：import core API 直驱 Upgrader——只留给黑盒够不着的内部齿（如 journal 重放细节）。

**规则：能在黑盒层表达的齿必须写在黑盒层**；library 层是例外、要说明为什么外面够不着。（同我们 symptom-layer 教义：用户层的红是最不可伪造的 oracle。）

接入方黑盒模式随之而来：`k-harness --profile swap --bin ./mytool` —— **零代码集成**：给你的真二进制，harness 起 fake-server、跑你的升级命令、断言下次运行版本/回滚/held。比 `--adapter` 还轻（cli 档接入方连 adapter 都不用给）。

## 1.76 黑盒 CLI 契约（xxchan 08-05："需要定义查版本子命令、状态 predicate 之类"）

黑盒平面要从外面问二进制三类问题，因此有一个**小的 CLI 契约** —— 但它是"声明"不是"每家自己发明"：

**① core 白送命令实现**（app 只做一行接线）：
- `versionCommand()` → 打印二进制自身版本（cli 档够用）；
- `statusCommand()` → **问活进程**（走宿主 socket，同 same-PID 纪律）输出机读 JSON：`{ProcessEvidence, TxnState, ConvergenceReport}` —— 就是 core 已有的三个类型，不另造 schema；
- `selfUpgradeCommand()` → 包装 `upgrader.upgrade()`，outcome 四态按结构化输出。

**② app 声明命令名**（K 不规定你的 CLI 长相，但声明是**必须的**——harness 不猜命令，缺声明立即 typed FAIL）：二进制旁边放一个 `k.target.ts`（或 `--target <path>`），default export typed `BlackBoxTarget`，命令名全部显式声明：
```ts
import type { BlackBoxTarget } from "@k-carrier/harness";

export default {
  version: ["--version"],
  status: ["k-status", "--json"],      // 可选
  selfUpgrade: ["self", "upgrade"],
  env: { K_RELEASE_BASE: "..." },       // 可选
} satisfies BlackBoxTarget;
```
`k-harness --bin ./mytool` 动态 import 它来驱动（node 原生跑 TS，不用 build）。**没有 `k.target.ts` = 立即 typed FAIL（`BLACKBOX_TARGET_REQUIRED`），不探测、不猜**——猜对了省一行配置，猜错了给出的是一个可信的错误结论（xxchan 08-05 裁定：不确定时要求显式声明，不替用户发明规矩）。

**③ 与透明性原则自洽**：这些不是测试后门，是**产品本来就该有的面**（用户和 support 一样需要 `status --json`）——harness 只是恰好消费它们。cli 档最小契约 = `version` + `selfUpgrade` 两条；daemon/managed 档 + `status`（活进程 JSON）。

**齿**：契约自身可验 —— `k.target.ts` 声明的命令跑不通 / status 输出不合 schema ⇒ 黑盒验收直接 FAIL（typed，不进齿评审）；缺 target 文件 ⇒ 必 FAIL 且信息可操作（齿 `blackbox.missing-target-fails`）。

## 1.77 版本工件工厂 + 清场（xxchan 08-05："准备相应版本的二进制？删除清空？"）

**① artifact-factory（升级测试需要"同一个 app 的 vX 和 vY"）**：
- `makeRelease({version, behavior})` → 产出**盖了版本戳的真二进制** + manifest + 完整测试签名链，落到 fake-server。实现 = **一次构建、多次盖戳**（构建 demo 源码一次，post-build 往二进制里注入版本串——与真 SEA 嵌版本同型，快且真实；不用"版本写在旁边文件"那种假形态）。
- `behavior` 旋钮让某个"新版本"**故意坏**：`crash-on-start / wrong-probe / hang-on-quiesce ...` —— 回滚齿、known-red、对抗样本的 fixture 都从这来（"升到坏版本→自动回滚→stable 完好"整条链可黑盒复现）。
- 内容寻址缓存（key = demo 源 hash × version × behavior），跨场景复用，不重复构建。

**② 清场（teardown）**：
- 沙箱边界即清场边界：install dir + stateDir + fake-server 存储全在场景沙箱内。teardown = **杀进程树并确认真死**（按沙箱标记 pgrep 复核零残留——僵尸 `__service` 是我们的真实产线教训，"发了 kill"≠"死了"）→ 删沙箱目录。崩溃场景故意留下的中间态也被同一动作清干净（一切都在沙箱里，所以 rm 恒有效）。
- **越界写齿**：core 在任何场景中写沙箱外任何路径 ⇒ RED。这颗齿顺带保证了产品级卫生（升级器不污染全局 HOME/系统目录），也让"清空"永远可信——**能一键删干净，是因为先机械保证了它只写在自己地盘**。
- 顺带的产品映射：沙箱清单 = 将来"干净卸载"要删的东西的权威地图（卸载功能本身另立，不在本期）。

## 1.8 透明性原则（xxchan 08-05：测试框架对升级框架透明）

**core 对 harness 零感知，机械强制**：
- **禁 test-conditional**：core 内不得存在 "if under test" 任何形态（环境变量开关/测试模式 flag/AllowUnsigned 之类后门）。CI ratchet 扫 core 源码（同我们 clock-ratchet 手法），出现即红。
- harness 需要的一切必须走**产品级注入面**——这些面是产品本来就需要的，不是为测试开的：
  - `HostAdapter`：产品 API 本体，fake-host 只是又一个 adapter；
  - `releaseBase`：指向 localhost 是配置，不是测试感知；
  - `rootKeys`：注入是产品需求（每个 app 编译自己的根），测试链只是另一组真钥匙——**签名验证永不可关**；
  - `clock`：时钟 seam 是正当的生产抽象（默认真时钟），不是测试后门；
  - `stateDir`：本就按 app 配置。
- 崩溃注入 = 对真进程 kill -9，零 core 配合；故障注入全在 fake-host（harness 侧代码）；对抗样本 = 假 adapter——全部外部。
- **反向信号**：若某颗齿写不出来、除非给 core 开后门 ⇒ 判定为**公共 API 不足**（dogfood 信号），修 API 而不是开门。透明性由此与 forcing-function 同构：测试框架也只能是 core 的一个普通消费者。

## 2. 关键设计决定（为什么这样）
1. **真进程优先**：崩溃/双跑/probe 活性只在真 spawn 的假 daemon 上验——mock 崩溃 = 没测崩溃。inproc 只服务快速逻辑齿。
2. **枚举生成覆盖面**：kill 矩阵、齿-档对账、断言标注扫描全由代码生成/校验，**人列清单在这三处非法**（人会漏，且漏的方向总是"看起来覆盖够了"）。
3. **虚拟时钟 + 沙箱**：决定论优先；flaky 即 bug。
4. **齿注册表是唯一入口**：declaration = 纪律载体（分档/must-red/二分标注都在注册时强制），绕开注册表的测试 CI 拒收。
5. **对抗样本制度化**：自验含"骗过检查但违反 oracle"的样本，且逃逸事后必须沉淀为新对抗样本——今天 #397 那套 BLIND 对抗采样的教训直接机械化。

## 3. 实现顺序（M0 内部）
1. teeth 注册表 + 分档执行器 + 二分标注检查（纯逻辑，先立规矩）；
2. scenario 沙箱 + 虚拟时钟；
3. fake-server + 测试签名链；
4. fake-host inproc → fake-host daemon（真进程）；
5. crash 枚举器（吃 core 状态机表——此时 core 只需 `txn/state.ts` 的类型，已存在）；
6. 自验三样本 → **M0 出口**。
此后每个功能层（M1–M6）的落地 = 先在 registry 写该层的齿（RED）→ 实现层 → 齿转 GREEN。

## 4. 边界
- harness 不测 UI/产品语义（壳仓库自己的事）；只测 core 契约 + 接入方 adapter 合规。
- 真机/平台矩阵（mac launchd、Windows 服务）走 Testbed 轮，harness 出可移植齿、Testbed 供真床。
