# K (k-carrier) 测试计划 v1

> 跑在 `harness-design.md` 设计的测试框架上；harness 先于功能层（executable-spec 顺序），本计划的每颗齿都进 harness 的 teeth 注册表。

对应 design v1.2 §3 的教义，这里是**可执行计划**：按里程碑排、每格给"测什么 / 怎么算过 / 必须会红的例子(must-red)"。规矩承自 mutation-runner 契约：**每颗齿声明时同时声明它的 must-red；全绿或全红都不发结论；先跑已知红/已知绿自验，harness 自己不合格不准验别人。**

里程碑与 profile 绑定：**每个里程碑的出口 = 对应 example demo 变绿**（没绿 demo 就没那档的支持 claim）。

---

## M0 — harness 自举（先于一切功能层）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| fake-host（实现 HostAdapter 的最小假宿主，带可注入故障开关） | 五方法可被编排调用、故障开关能让任一方法定点失败 | 关掉故障开关注入 ⇒ 对应齿必须转绿（证明齿测的是故障不是常态） |
| fake 静态 server（manifest+工件，认 Range，可篡改） | 正常链路可走通 | 篡改任一字节 ⇒ 下游校验齿红 |
| **harness 自验**（mutation 契约 §自验承重墙） | 内置已知红/已知绿样例各≥1 + **1 个对抗样例**（结构过 fixture、违真 oracle） | 对抗样例被判 EFFECTIVE ⇒ harness 不上线 |
| profile 分档执行器 | `--profile swap|daemon|managed` 只跑该档齿集 | cli 档误跑 L2 齿 ⇒ 计划红（档界齿） |

## M1 — L1 事务 + L0 工件（出口：`examples/swap-tool` 绿 = cli 档成立）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| 状态机合法迁移 | 7 相全部合法路径逐条走通 | 非法迁移（如 idle→readback）被拒 |
| **崩溃注入矩阵**（承重） | **迁移边×kill 点由脚本枚举生成**（禁手列）；每点 kill -9 → 重启后 = 恢复 stable 或完成迁移 | 任一点出现双跑（两 incarnation 同活）或砖（起不来）⇒ 红；**journal 写后动作前的窗口必须被覆盖** |
| journal 性质 | append-only、意图先于动作（WAL）、重放幂等 | 乱序/覆写 journal ⇒ 重放拒绝 |
| 回滚对称性 | rolled-back 后 stable 完整可跑、experiment 槽清空、原因入 journal | 回滚后 experiment 残留可执行 ⇒ 红 |
| config 同轨 | 配置 experiment/promote/rollback 走同一状态机 | config 绕过状态机直写 ⇒ 红 |
| L0 校验+原子换 | sha256 不符拒装；换字节原子（半写不可见）；Windows 运行中自替换 | 篡改工件 ⇒ 拒；swap 中途 kill ⇒ 旧字节完好 |
| cli 档端到端 | swap-tool demo：升级→下次运行是新版；`held/rolled-back/up-to-date` 四态出口都可构造 | — |

已落地齿以 `k-harness --list` 为准——本文件**不手抄齿名**（手抄清单是 `--list` 的副本，只会漂向'少列一颗'；ratchet 7 只能查'写下来的存在'，查不了'该写的没写'）。逐颗齿（层/档/must-red/定义位置）直接 `k-harness --list`。 本层判据形状：篡改工件 ⇒ 拒装；原子换（半写不可见、中途 kill 旧字节完好）；未知平台/指名版本 ⇒ 拒；cli 档闭环（真升级 → 下次运行新版本 → state promoted）；坏版本 ⇒ 自动回滚 + 旧可用 + experiment 清空；下载中途死 ⇒ Range 续传 + 全量验证。**下载层 8 洞**（archer L0 接入方挖出，每洞一齿）：deadline **竞速**而非仅信号（注入不理会 AbortSignal 的 fetch 也必须超时）；Rosetta 下 platform key **问硬件**（x64 Node 在 arm64 硬件选 arm64 target，探针只在 darwin+x64 被问）；无 resumeDir 进度也必须动（单调收尾到全量）；无 body 响应**两臂**（内存 + resume）都报 typed "no readable body"、绝不当作空前缀；静默被限界不是总时长（慢而正常存活、卡死点名 stall）；主动放弃的 stall 是 typed DOWNLOAD_FAILED 点名原因；mid-body 的 stall 说 mid-body。

## M2 — L0.5 供应链：**不做**

L0.5 已于 2026-08-06 移除（xxchan 决定：不支持签名）。K 只验完整性（sha256 +
size），不验来源真实性；原两级签名链、`m2.*` 四颗齿与 harness 的测试密钥链一并
删除。留一个没人接的签名接口比没有更糟——接入方会以为来路已经有人管了。理由，
以及它与 OS 代码签名的区别，见 `docs/design-v1.md` §L0.5。

**防回滚不在这层**：manifest 版本低于当前且非 pinned ⇒ 默认拒，这是 L0 的
`source-fails-closed` 管的，与签名无关。

## M3 — L2 生命周期 + L3 收敛（出口：`examples/service-daemon` 绿 = daemon 档成立）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| **HostAdapter 契约一致性套件**（对任意 adapter 可跑，接入方复用） | quiesce↔resume 状态等价（含 **rolled-back 后 resume**）；probe 证据同进程（pid+startId） | resume 后负载状态漂移 ⇒ 红；probe 返回缓存/文件拼的证据 ⇒ 红（换 pid 不换 startId 的假 probe 必须被抓） |
| 交接顺序 | journal 意图→交接→新进程自证→才清旧，顺序断言 | 颠倒任两步 ⇒ 红 |
| `binary_at_target` | same-PID probe：version+startId 绑同一 incarnation | 旧进程活着报新版本号 ⇒ 不绿（#5245 反假绿） |
| `host_lifecycle_converged` | 点名面读回一致；**面在 allowlist 才可作证** | 用不可读面（模拟 System Events 类）自称 same-source ⇒ 拒 |
| **禁投影齿** | version/channel/升级次数灌真值、谓词面造假 ⇒ 必须不绿 | 任一元数据字段能把谓词转绿 ⇒ 红（version⊥state 实测教训） |
| fail-closed 退役序 | 未过 host_lifecycle_converged 前退旧管理器 ⇒ 拒 + typed HOLD | 强行退役路径存在 ⇒ 红 |
| ownership 检测 | 受管标记存在 ⇒ `held: managed-elsewhere`（typed、指向管理者） | 受管副本完成自升 ⇒ 红 |

已落地齿以 `k-harness --list` 为准——本文件**不手抄齿名**（手抄清单是 `--list` 的副本，只会漂向'少列一颗'；ratchet 7 只能查'写下来的存在'，查不了'该写的没写'）。逐颗齿（层/档/must-red/定义位置）直接 `k-harness --list`。 本层判据形状：quiesce↔resume 账本逐字节等价（含回滚后 resume）；probe 证据**绑定活化身**（探针说谎/报旧 startId ⇒ 红）；每开关故障关掉齿必须绿；service 升级两种宿主形状（spawn 自起 / respawn 交给 owner）——真停旧、真起新、旧 pid 验证死、新化身 fresh startId；坏版本 ⇒ 旧版**真的拉回来在跑**（不是槽位回退）；卡死 driver ⇒ 宿主调用预算超时 → 锁释放 → successor 凭**证据**（v2 + fresh startId）判交接完成，凭标志不恢复。`host_lifecycle_converged` / 禁投影 / 退役序 → M5 齿。

## M4 — L4 同意与通知

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| 策略门 | confirm 未答 ⇒ 零副作用；notify-only ⇒ 只通知不动 | confirm 前有任何盘面写 ⇒ 红 |
| **通知可验齿**（Hipp 判据原样） | 构造真实失败（迁移写失败/readback 不一致）⇒ sink **真收到**结构化事件 | 删通知调用 ⇒ 此齿必须红；"代码调用了通知"但 sink 没收到 ⇒ 红 |

已落地齿以 `k-harness --list` 为准——本文件**不手抄齿名**（手抄清单是 `--list` 的副本，只会漂向'少列一颗'；ratchet 7 只能查'写下来的存在'，查不了'该写的没写'）。逐颗齿（层/档/must-red/定义位置）直接 `k-harness --list`。 本层判据形状：confirm 未答 ⇒ **磁盘零副作用**（无 journal/slots/incoming，不是"没 promote"是"没 staged"）；同意只装**当初同意的那个版本**（中途服务器换版 ⇒ 拒装，不装"当前版"）；notify-only 通知带**真能装的那个版本** + 零副作用。

## M5 — platform 适配器 + managed 档（出口：`examples/hosted-service` 绿）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| mac/linux/windows 适配器 | 各平台读回面 allowlist 注册齐 + CI 矩阵跑（linux 真跑；mac/win 至少接口级+Testbed 真机轮） | 未注册面被引用 ⇒ 拒 |
| managed 端到端 | hosted-service demo：带活"会话"的完整升级→会话保留断言→回滚路径同样保留 | 升级后会话丢失/回滚后会话丢失 ⇒ 红 |
| ownership 迁移场景 | **DEFERRED（xxchan 08-05 范围裁定：v0 只假设官方 installer 安装，不做 deb/RPM 接管）**——PM 装的副本走 ownership 检测 → `held: managed-elsewhere` 即为正确终态（有齿，M3）；接管(adopt)留给将来需要时再立项 | —（deferred） |

已落地齿以 `k-harness --list` 为准——本文件**不手抄齿名**（手抄清单是 `--list` 的副本，只会漂向'少列一颗'；ratchet 7 只能查'写下来的存在'，查不了'该写的没写'）。逐颗齿（层/档/must-red/定义位置）直接 `k-harness --list`。 本层判据形状：**面在 allowlist 才可作证**（未注册面被引用 ⇒ typed UNREGISTERED_SURFACE 拒）；读回新工件路径才 promote（读回旧路径仍 promote ⇒ 红）；**禁投影**——版本串/元数据永远不能绿收敛谓词；**退役序**——未过收敛前 `retireLegacyManager()` 是 typed HOLD（无条件退役 ⇒ 红）。`ConvergenceReport.hostLifecycleConverged` 为 `PredicateResult | null`——**未声明面 = null = 从未被观测 = 不等于通过**（沉默不能当证据花）。

## M6 — L5 drive（可选层，最后）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| 远程命令过策略门 | drive 的 stage/promote/rollback 全部经 L4 | drive 绕过 confirm 直接动 ⇒ 红（设备主人永远赢） |
| 状态上报 | {stable, experiment, 两谓词, 策略} 与本地读回一致 | 上报值可与本地不一致 ⇒ 红 |
| provenance journal | forward-only 记 reconcile 来路；**"已记录"与 NOT_OBSERVED 机制上不可合并** | 存量机被计入"已记录" ⇒ 红 |

**已落地齿**（三包全合，main 296 绿 / 56 齿）：以 `k-harness --list` 为准，本文件不手抄（手抄是 `--list` 的副本，只会漂向少列一颗）。本层判据形状：
- provenance：journal **三态** genesis/observed/unreadable（只有 ENOENT 是 genesis；unreadable 上 append 拒——截断视图绝不能重发 seq）；记录 {who, carrier, when, version} **写前**（回滚的 reconcile 也留痕，证明写前）；聚合把 genesis 与 NOT_OBSERVED 机械分离（"没数据"≠"没记录"）。
- status：机器自报是**读回不是发明**；谓词带**版本戳 join key**（真结论贴错版本比造假更难看出）；跨重启持久化（"观测过、只是我重启了"≠"从没观测过"）；读不了 ≠ 从没有（第三态）。
- drive + 政策门：服务器下发的命令和本地升级走**同一套门**；**ownership 门画在动作性质上**——settle 在飞事务永远允许（在飞 + ownership 翻转必须收敛，不许 held——held 在开了头的机器上是砖），只有"休息态 + managed-elsewhere"的新改装才 typed held（三个终态 idle/promoted/rolled-back 都断言）；已 promote 版本的 push-rollback 在 confirm 下必须 HOLD（安全方向是字节安全不是权威）；K 自己的 in-transaction 自动回滚**绝不问同意**（配对互相控制）。

## 跨里程碑（一直在跑）

- **跨版本矩阵**：`STATE_FORMAT_VERSION` 升档后旧 core 读新状态 ⇒ fail-closed 拒 + 指引；新 core 收养旧布局 ⇒ 无损；混合窗口显式建模。
- **mutation-runner**（Lincan 工具就绪即接）：对本计划全部齿跑变异；换说法+整段删两变体默认；杀不掉先排除"没杀对"再删守卫。
- **断言纪律标注**：每个测试文件头标 `@invariant` 或 `@baseline(failure-condition: ...)`；CI 检查无标注的 implementation-locking 断言（#395 二分的机械化）。
- **真机轮**（Testbed）：每里程碑收口跑一轮真机抽样；个人真机仅 consent 后读回抽样。
- **DST 夜跑**（§1.45）：种子随机故障调度跑 txn/converge 剧本；PR 门固定 smoke 种子集；失败种子进语料库并转成枚举矩阵固定格。
- **时间戳锚定断言**（借 Datadog）：scenario receipt 的事件断言一律"标记之后发生了 X"（取 marker → assert-since），防旧事件/上一场景残留冒充新证据。

## 完成定义
计划本身的验收 = **三个 example demo 全绿 + M0 harness 自验含对抗样例 + 崩溃矩阵零人工枚举**。任何"支持 X"的 README claim 若无对应绿齿，按"没绿 demo 就没 claim"规则视为未支持。
