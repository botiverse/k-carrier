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
├─ scenario/         场景运行器（隔离沙箱 + 虚拟时钟）
├─ crash/            崩溃注入编排器（枚举生成，禁手列）
├─ teeth/            齿注册表 + 分档 + 自验
└─ cli.ts            `k-harness` 入口（含 --adapter 接入方模式）
```

### 1.1 fake-host（假宿主）
- **两形态**：`inproc`（进程内实现，跑快速逻辑齿）+ `daemon`（编译成真二进制、真 spawn、真 PID/startId —— kill -9、双跑检测、probe 活性都必须在真进程上验，mock 验不了崩溃）。
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

### 1.5 teeth（齿注册表）
每颗齿是一条注册记录，声明即纪律（缺任一字段注册失败）：
```ts
registerTooth({
  id: "txn.no-dual-run",
  profiles: ["daemon", "managed"],          // 分档
  kind: "invariant",                        // 或 { kind: "baseline", failureCondition: "..." }
  mustRed: [                                // mutation 契约：≥1 条，且答得出"不被我抓还会被谁抓"
    { mutate: "skip journal fsync before handover", caughtOnlyBy: "this" },
  ],
  run: async (ctx) => { ... },
});
```
- **分档执行**：`--profile cli|daemon|managed` 选齿集；cli 档误挂 L2 齿 ⇒ 注册期报错（档界齿）。
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
