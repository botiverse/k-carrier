# K (k-carrier) 测试计划 v1

> 跑在 `harness-design.md` 设计的测试框架上；harness 先于功能层（executable-spec 顺序），本计划的每颗齿都进 harness 的 teeth 注册表。

对应 design v1.2 §3 的教义，这里是**可执行计划**：按里程碑排、每格给"测什么 / 怎么算过 / 必须会红的例子(must-red)"。规矩承自 mutation-runner 契约：**每颗齿声明时同时声明它的 must-red；全绿或全红都不发结论；先跑已知红/已知绿自验，harness 自己不合格不准验别人。**

里程碑与 profile 绑定：**每个里程碑的出口 = 对应 example demo 变绿**（没绿 demo 就没那档的支持 claim）。

---

## M0 — harness 自举（先于一切功能层）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| fake-host（实现 HostAdapter 的最小假宿主，带可注入故障开关） | 五方法可被编排调用、故障开关能让任一方法定点失败 | 关掉故障开关注入 ⇒ 对应齿必须转绿（证明齿测的是故障不是常态） |
| fake 静态 server（manifest+工件+签名，可篡改） | 正常链路可走通 | 篡改任一字节 ⇒ 下游校验齿红 |
| **harness 自验**（mutation 契约 §自验承重墙） | 内置已知红/已知绿样例各≥1 + **1 个对抗样例**（结构过 fixture、违真 oracle） | 对抗样例被判 EFFECTIVE ⇒ harness 不上线 |
| profile 分档执行器 | `--profile cli|daemon|managed` 只跑该档齿集 | cli 档误跑 L2 齿 ⇒ 计划红（档界齿） |

## M1 — L1 事务 + L0 工件（出口：`examples/cli-tool` 绿 = cli 档成立）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| 状态机合法迁移 | 7 相全部合法路径逐条走通 | 非法迁移（如 idle→readback）被拒 |
| **崩溃注入矩阵**（承重） | **迁移边×kill 点由脚本枚举生成**（禁手列）；每点 kill -9 → 重启后 = 恢复 stable 或完成迁移 | 任一点出现双跑（两 incarnation 同活）或砖（起不来）⇒ 红；**journal 写后动作前的窗口必须被覆盖** |
| journal 性质 | append-only、意图先于动作（WAL）、重放幂等 | 乱序/覆写 journal ⇒ 重放拒绝 |
| 回滚对称性 | rolled-back 后 stable 完整可跑、experiment 槽清空、原因入 journal | 回滚后 experiment 残留可执行 ⇒ 红 |
| config 同轨 | 配置 experiment/promote/rollback 走同一状态机 | config 绕过状态机直写 ⇒ 红 |
| L0 channel 解析 | latest/alpha/pinned:X 三态 + Version XOR Track 语义 | 未知 channel 值 fail-closed |
| L0 校验+原子换 | sha256 不符拒装；换字节原子（半写不可见）；Windows 运行中自替换 | 篡改工件 ⇒ 拒；swap 中途 kill ⇒ 旧字节完好 |
| cli 档端到端 | cli-tool demo：升级→下次运行是新版；`held/rolled-back/up-to-date` 四态出口都可构造 | — |

## M2 — L0.5 供应链

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| 两级签名链 | root→signing.pub→file 全链验过才装 | 篡改 file/sig/signing.pub 任一 ⇒ 拒；无签名 ⇒ 拒（**无 AllowUnsigned 后门——测试恒用完整测试签名链**，透明性原则） |
| root 轮换 | 多 root 并存期新旧 root 签的 signing.pub 都可验 | 已移除 root 签的 ⇒ 拒 |
| 防回滚 | manifest 版本低于当前且非 pinned ⇒ 默认拒（显式降级需 typed 确认） | 静默接受更低版本 ⇒ 红 |

## M3 — L2 生命周期 + L3 收敛（出口：`examples/plain-daemon` 绿 = daemon 档成立）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| **HostAdapter 契约一致性套件**（对任意 adapter 可跑，接入方复用） | quiesce↔resume 状态等价（含 **rolled-back 后 resume**）；probe 证据同进程（pid+startId） | resume 后负载状态漂移 ⇒ 红；probe 返回缓存/文件拼的证据 ⇒ 红（换 pid 不换 startId 的假 probe 必须被抓） |
| 交接顺序 | journal 意图→交接→新进程自证→才清旧，顺序断言 | 颠倒任两步 ⇒ 红 |
| `binary_at_target` | same-PID probe：version+startId 绑同一 incarnation | 旧进程活着报新版本号 ⇒ 不绿（#5245 反假绿） |
| `host_lifecycle_converged` | 点名面读回一致；**面在 allowlist 才可作证** | 用不可读面（模拟 System Events 类）自称 same-source ⇒ 拒 |
| **禁投影齿** | version/channel/升级次数灌真值、谓词面造假 ⇒ 必须不绿 | 任一元数据字段能把谓词转绿 ⇒ 红（version⊥state 实测教训） |
| fail-closed 退役序 | 未过 host_lifecycle_converged 前退旧管理器 ⇒ 拒 + typed HOLD | 强行退役路径存在 ⇒ 红 |
| ownership 检测 | 受管标记存在 ⇒ `held: managed-elsewhere`（typed、指向管理者） | 受管副本完成自升 ⇒ 红 |

## M4 — L4 同意与通知

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| 策略门 | confirm 未答 ⇒ 零副作用；notify-only ⇒ 只通知不动 | confirm 前有任何盘面写 ⇒ 红 |
| **通知可验齿**（Hipp 判据原样） | 构造真实失败（迁移写失败/readback 不一致）⇒ sink **真收到**结构化事件 | 删通知调用 ⇒ 此齿必须红；"代码调用了通知"但 sink 没收到 ⇒ 红 |

## M5 — platform 适配器 + managed 档（出口：`examples/managed-host` 绿）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| mac/linux/windows 适配器 | 各平台读回面 allowlist 注册齐 + CI 矩阵跑（linux 真跑；mac/win 至少接口级+Testbed 真机轮） | 未注册面被引用 ⇒ 拒 |
| managed 端到端 | managed-host demo：带活"会话"的完整升级→会话保留断言→回滚路径同样保留 | 升级后会话丢失/回滚后会话丢失 ⇒ 红 |
| ownership 迁移场景（借 Datadog e2e） | PM/别的管理器装的 → K 接管（adopt）→ 状态/谓词正确 | 接管后旧管理器仍认为自己拥有 ⇒ 红 |

## M6 — L5 drive（可选层，最后）

| 测什么 | 怎么算过 | must-red |
|---|---|---|
| 远程命令过策略门 | drive 的 stage/promote/rollback 全部经 L4 | drive 绕过 confirm 直接动 ⇒ 红（设备主人永远赢） |
| 状态上报 | {stable, experiment, 两谓词, 策略} 与本地读回一致 | 上报值可与本地不一致 ⇒ 红 |
| provenance journal | forward-only 记 reconcile 来路；**"已记录"与 NOT_OBSERVED 机制上不可合并** | 存量机被计入"已记录" ⇒ 红 |

## 跨里程碑（一直在跑）

- **跨版本矩阵**：`STATE_FORMAT_VERSION` 升档后旧 core 读新状态 ⇒ fail-closed 拒 + 指引；新 core 收养旧布局 ⇒ 无损；混合窗口显式建模。
- **mutation-runner**（Lincan 工具就绪即接）：对本计划全部齿跑变异；换说法+整段删两变体默认；杀不掉先排除"没杀对"再删守卫。
- **断言纪律标注**：每个测试文件头标 `@invariant` 或 `@baseline(failure-condition: ...)`；CI 检查无标注的 implementation-locking 断言（#395 二分的机械化）。
- **真机轮**（Testbed）：每里程碑收口跑一轮真机抽样；个人真机仅 consent 后读回抽样。
- **时间戳锚定断言**（借 Datadog）：scenario receipt 的事件断言一律"标记之后发生了 X"（取 marker → assert-since），防旧事件/上一场景残留冒充新证据。

## 完成定义
计划本身的验收 = **三个 example demo 全绿 + M0 harness 自验含对抗样例 + 崩溃矩阵零人工枚举**。任何"支持 X"的 README claim 若无对应绿齿，按"没绿 demo 就没 claim"规则视为未支持。
