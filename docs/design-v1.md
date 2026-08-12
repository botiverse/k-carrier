# K (k-carrier) 升级框架 设计文档 v1.2（通用核 + 宿主壳）

随代码更新；删除决定见文内标注。
依据：设计方向（开源 forcing-function / 并集定位）+ 源码调研（`docs/prior-art.md`）+ OS-supervisor 退役设计 + 载体无关不变式。

---

## 0.0 前提（08-05，写在最前面，因为它决定了 K 适合谁）

**K 假设"服务死了重开"不是昂贵的事。** K 的目的是**保证能把你拉起来**，接受中间断一小会儿。
**它保证的是"你会回来"，不是"你从没下去过"。**
⇒ 需要严格保活（零停机/连续可用）的场景，**不该用 K** —— 这句写死在这里，好过让人从行为里发现。
⇒ 这条前提直接推出后面的一切：exclusive handoff（有停机窗口）、两槽事务（宁可回滚也不带病运行）、收敛回读（宁可判失败也不假装成功）。

## 0. 定位（一句话）

**「个人设备上的受管常驻服务」的升级框架** —— 需求 = 并集：Datadog 级的管理能力（事务/回滚/读回/远程驱动/fleet 观测）**全要** + Tailscale 级的个人设备恭敬（同意/通知/安装所有权）**也全要** + 独有的宿主负载（agent 会话）保留。市场图两头有界（下界 self_update/CC-updater 已解决、上界 Datadog fleet 已解决），中间整段无人做。

**形态**：一个仓库（本仓库）、`core`（通用框架，按开源标准写，任何 daemon 可用）+ harness/examples；**壳（参考宿主（reference host） / 宿主 CLI）住 宿主产品仓库、消费 core 作依赖**。发布时机独立决定，不挡开工。

---

## 1. 能力清单（六层，每层：要什么 · 怎么设计 · 抄谁/自研）

### L0 工件层（商品层，不差异化）
**要**：向 **ReleaseSource** 问"该到哪版/这一版在哪" → 下载 → 完整性校验 → 原子换字节（含 Windows 换运行中 exe）。
**设计**：**K 不持有版本策略**——`ReleaseSource` 两个方法（`checkForUpdate` 策略 / `fetchRelease` 指名）由接入方实现；channel 名字、"latest"的定义、版本方案（semver/日期）、长期 pin **全在他的 source 里**。K 附 `staticManifestSource({baseUrl})`（静态 manifest + semver + 不自动降级）作为**一种策略**，manifest 格式属于它、不属于 K。
**来源**：= 现有 `upgradeSea` lane 通用化；对齐 jaemk/self_update、minio/selfupdate 的成熟形状，可部分吃现成。

### L0.5 供应链层 —— **不做（2026-08-06 决定）**

**K 验完整性，不验来源真实性。** `downloadVerified` 检查 sha256 + size；**没有签名验证，没有信任根**。原先实现过的两级 Ed25519（`core/src/distsign/`）与四颗 `m2.*` 齿**已全部删除**，而不是留着半用。

**为什么删而不是留着不用**：一个存在但没人接的签名接口，会让接入方以为"K 管了来源真实性"。**未实现要么不存在，要么显式声明**——留个空壳是最坏的第三种。

⚠️ **所以要清楚 sha256 现在保护了什么、没保护什么**：
```
防住   传输损坏（而 HTTPS 已经防了同一件事）
没防   发布点本身发错字节 —— CI/部署凭证泄漏 · 桶权限配错 · 流水线被污染 · 有写权限者作恶
⇒ 因为 sha256 写在 manifest.json 里，而 manifest 与二进制【同源同链路】
  ⇒ 能改二进制的人同样能改那个 digest ⇒ 这道校验对该场景保护约等于 0
```

#### 这类签名与「操作系统代码签名」的区别（常被当成同一件事）

| | OS 代码签名（Authenticode / codesign / notarization） | 分发签名（Tailscale distsign 那类，K **未实现**） |
|---|---|---|
| 谁验 | 操作系统／安装器，在**它认可的安装路径**上 | **应用自己**，在下载之后、落盘之前 |
| 信任根 | 系统证书库 + 厂商 CA | 自带的离线 root 公钥，**编译进客户端** |
| 覆盖面 | 平台各异：Windows 查发布者名；macOS 靠 codesign/公证；Linux 基本没有 | 跨平台一致，**与分发渠道无关** |
| 防的是 | "这个程序是不是一个可识别的厂商签的" | "**这份字节是不是我们发布的那一份**" |
| 对我们 | ⚠️ **不自动成立**：computer 是 SEA 二进制走 CDN，不走 App Store/系统安装器 | 就是这一格空着 |

⇒ **两者不互相替代**：OS 签名回答"系统认不认这个程序"，分发签名回答"这是不是我们发的那一份"。`electron-updater` 走的是前者（实测：仅 Windows 一处 `Get-AuthenticodeSignature` 比对发布者名，macOS 交给 Squirrel/codesign，其余只有 sha512）。

**将来要补时怎么补**（结论已经调研完，不用重来）：两级 Ed25519 —— 离线 root 公钥编译进客户端 → 签可轮换的 signing key → 签每个工件；**服务端仍是纯静态文件**，不需要新服务。⚠️ 且必须记住那个已经踩过的坑：**"未签名"只能由客户端代码显式承担，绝不能由 manifest 声明** —— manifest 由发布源提供，而发布源正是签名链要防的那一方。

### L1 事务层（核心，抄 Datadog 两槽）
**降级 vs 回滚（v0 定调）**：**回滚** = 回刚才的 stable 槽（那份字节刚在本机跑过，天然安全，已实现）；**降级** = 从 server 取更老版本装上——事务机器天生支持（两槽对新旧无感，入口 = `upgradeTo(version)`——指名版本由 source 的 fetchRelease 决定；"pinned" 是 source 内部概念，K 侧就是显式点名版本；channel 概念已于 2026-08-06 从 K 移除，provenance 改用 version），但两道闸必须显式过：① **状态格式**（新版本可能已迁状态；老二进制读新状态 = `STATE_FORMAT_VERSION` fail-closed → 降级只在格式兼容/有下迁移时可行，这是真约束）；② **安全**（K 验证的是 sha256+size——字节完整，不是来源；能控制 source 的攻击者本来就能发任意合法版本，降级保护不来自字节验证，而来自策略门 + 显式同意：`upgradeTo(旧版本)` 与任何升级走同一套门（confirm/ownership/compat）；自动降级永不做；显式降级 = 人点名版本 + 策略门 + ① 的格式检查）。⇒ **v0：指名版本安装在；自动降级永不做；显式降级 = 点名版本 + 策略门 + 格式检查，无需新机制、不欠架构债。**
**要**：升级 = 可回滚的事务；崩溃任意点可恢复；状态可读回。
**设计**：每个受管单元双槽 `{stable, experiment}` + 状态机：
```
idle → staged（experiment 槽已下载+验签）
     → running-experiment（已交接到新版本，探针未过）
     → readback（谓词判定中）
     → promoted（experiment→stable，旧 stable 进 GC）
     | rolled-back（回 stable，experiment 删除，原因入 journal）
```
- 所有迁移写 **journal**（append-only，先写意图后动作）；进程在任意点被 kill -9 → 重启后按 journal 决定“继续或回滚”，**永不双跑、永不砖**。
- 配置变更走同一套（config 也有 experiment/promote/rollback —— Datadog 已证明这个统一是对的）。
- 降级规则：新格式状态被旧二进制读到 = **fail-closed**（拒绝启动并指引，不静默破坏）——载体无关不变式已定。

### L2 服务生命周期层（我们独有的核心难点之一）
**要**：常驻服务换版本时的交接：停旧起新、自杀顺序、宿主负载（agent 会话/工作区）保留。
**设计**：
- **Host adapter 接口**（宿主必须实现的最小面）：`quiesce()`（负载可安全暂停/落盘）、`stop()`、`start(slot)`、`healthProbe() → {version, pid, startId}`、`resume()`。core 只调接口，不知宿主细节 —— 这就是"任何 daemon 可用"的机械保证。
- 自替换顺序显式化（Datadog 的教训直接抄）：先落盘 journal 意图 → 交接进程树（detached owner 模式，= 我们 direction-B）→ 新进程自证（见 L3）→ 才清旧。
- 会话保留 = **宿主自己的能力**，`quiesce/resume` 只保证**调用时序**与回滚时的对称恢复；**K 不会让不具备连续性的宿主凭空获得连续性。**
  ⚠️ **08-05 核实纠正**：example-host **今天并不保留 agent**——升级时 `serviceShutdown` 会把所有 runner 子进程 SIGTERM 掉，接班人重新拉起它们。⇒ 所以对 computer 而言 `workload-preservation` **是一项未来能力，不是现状**；要连续性得单独做（例如 runner 不随服务生命周期而死），**不是接了 K 就顺手拿到**。

**⭐ 一等模型（08-05 提升，原本按边角情况处理）：升级事务可以比发起它的进程活得久。**
很多宿主**起不动自己**——它们通过**退出**被替换，由外部的东西（supervisor / OS 安装器）按新字节把它拉起来：
- **example-host**（我们第一个真实 service 档用户）= 退出后由 detached owner 拉起；
- **electron-updater**（08-05 读源码核实）= 把安装交给 Squirrel.Mac / NSIS / dpkg，安装器替换并重启 app。
⇒ **所以这不是怪癖，是这个领域的主流形状。**
```
后果   成功路径上，驱动事务的那个进程【死在 handover 中间】
       ⇒ 后继者看到的 journal 与"崩溃"完全一样
判定   只能靠【证据】：活进程报 experiment 版本，且 startId ≠ handover 时记下的那个
       ⇒ 后继者接着跑谓词 → promote / rollback
⚠️ 绝不用"这次重启是计划内的"标志位：崩溃路径同样能设这个标志。
   标志是一句声明，incarnation 不同是一件发生过的事。
```
⇒ `start()` 的语义随之收紧：**只表示"已请求后继者"，不表示"后继者在跑"**——后者只有 `healthProbe()` 能回答。

**⚠️ 一个【记录但暂不实现】的观察（08-05，读 computer 真实升级链后）**：
computer 的交接**比 K 现在的 `stop→start` 强**——在位进程释放 IPC 归属但**不死**，spawn 接班人，验完凭证（pid / 托管集合与机器身份 / 版本）**才**退出；失败就杀掉接班人、拿回归属、继续服务。
```
stop→start   中间有一段【什么都没跑】的窗口；回滚要【重新起动旧的】，而重启本身可能失败
computer     旧的从没停过 ⇒ 回滚不需要重启任何东西 ⇒ 撤销代价为零
⚠️ 这【不是】K 拒绝做的零停机 overlap：那里 overlap 买的是【可用性】，这里买的是【可撤销性】。
```
⇒ **曾实现过一个可选的 `handOver()`，当天 revert 了**（过度设计——是从"读代码"推出来的接口，不是从"真接入时表达不了"推出来的）。
⇒ **等真接入 computer 时若确实表达不了，更便宜的解法多半是一个"允许重叠"的能力位**（core 改成 `start → probe → stop`），**而不是让宿主替 core 完成整个交接**。

### L3 收敛与回读层（直接平移自 OS-supervisor 退役设计，两家都没有）
**要**：升级"说做到了"必须可机械证明。
**设计**：两谓词 + 同源回读（OS-supervisor 退役设计的冻结 spec）：
- `binary_at_target`：新进程 **same-PID version-probe**（healthProbe 返回的 version/startId 绑定同一进程，杜绝 live-PID 假成功 —— same-PID 就绪核 已落的机制）；
- `host_lifecycle_converged`：OS-supervisor/自启等宿主生命周期面按 SSOT 写并回读一致（**点名读回面**，如 macOS = Electron `app.getLoginItemSettings().openAtLogin`；不可读面不得自称 same-source）；
- **禁投影**：版本号等元数据字段机制上不得充当任一谓词（version⊥supervisor-state 已实测）；
- **fail-closed 退役序**：退旧管理器只在新面回读 PASS 之后（OS-supervisor 退役设计裁定）。

### L4 同意与通知层（Tailscale 侧恭敬，做成可验的）
**要**：个人设备上不静默改行为；升级策略归属主明确。
**设计**：
- 策略 knob：`auto | confirm | notify-only`（对应 TS 的 Confirm 回调形状），策略本身是被管配置（走 L1 事务）；
- **通知可验齿**（Hipp 判据原样入验收）：构造真实失败 → 断言用户面**真收到**可观测物（不是"代码调用了通知"）→ 去掉通知 ⇒ RED；
- 行为变化通告面 = 框架内建能力（我们 1.0.15 的教训：Computer 无用户面通告渠道是产品缺口，核心层把"有一个可注册的通告 sink"做成接口）。
- **进度上报 = 内建能力**（08-06："包括整个升级进度的报告，都值得做成 native 的功能"）。理由与通告同源：升级要用户同意/等待，就欠他一个"现在到哪了"，这不该让每个接入方各自重造。
  - 词汇 = **阶段 + 可选字节进度**（`core/src/progress.ts`）：`checking → downloading → verifying → staging → handing-over → probing → promoted | rolled-back`。阶段直接由 L1 事务相位映射（`stageForPhase`），**不是另一套并行状态**——否则进度条能显示一个事务里不存在的状态。
  - 只有下载有分母，所以只有它带字节；其余阶段给不出百分比就不假装能给。
  - **两条机械规则**（各有测试钉住）：① 进度 sink 抛异常不得让升级失败——观测面不能变成失败面；② 续传时字节数**从磁盘已有的 partial 起算**，否则用户看到进度条从 60% 跳回 0，读起来就是"它把我下的东西弄丢了"。

### L5 Fleet 驱动与观测层（Datadog 侧能力，尊重 L4）
**要**：server 可推升级、可读 fleet 状态；来路可追。
**设计**：
- 驱动 = 可选组件（不用 server 也能全功能本地升级 —— 个人设备优先）；驱动命令集 = L1 状态机操作的远程投影（stage/promote/rollback），**必须过 L4 策略门**；
- 状态上报 = `{stable, experiment, 两谓词, 策略}` 逐机读回（= Datadog GetState 形状 + 我们谓词）；**进行中的机器附 L4 的 `UpgradeProgress`**——fleet 面的"卡住了吗"与本机面的"到哪了"是同一份词汇，不另造一套；
- **install-provenance journal**（我们独有，两端洞的修法）：每次 reconcile 本地先记（谁/哪个载体/何时/哪个版本），forward-only；**存量机 genesis = 永久 NOT_OBSERVED，指标机制上禁止把"已记录"与"未观测"合并**。

---

## 2. 整体架构

```
┌────────────────────────── 一个仓库 ──────────────────────────┐
│  core/                                                       │
│   ├─ artifact/      L0: manifest·download（含续传）·swap      │
│   ├─ txn/           L1: 两槽 repo + journal + 状态机          │
│   ├─ lifecycle/     L2: HostAdapter 接口 + 交接编排           │
│   ├─ converge/      L3: 谓词 + 同源回读 + fail-closed 序      │
│   ├─ policy/        L4: auto/confirm/notify + 通告 sink 接口  │
│   ├─ drive/         L5(可选): 远程命令投影 + 状态上报          │
│   ├─ platform/      mac·linux·windows 适配器                  │
│   └─ progress.ts    L4/L5 共用的进度词汇（见 L4）             │
│  harness/           通用验收床：fake-host daemon + 全套齿      │
│                     （按 profile 分档跑；managed 假宿主与       │
│                      examples/hosted-service 共用）              │
│  examples/          每档一个可跑 demo（swap-tool /              │
│                     service-daemon / hosted-service）——            │
│                     哪档没绿 demo，那档的支持 claim 不存在      │
└──────────────────────────────────────────────────────────────┘
两个真实壳都**不在本仓库**（壳代码住产品仓库、消费 core 作依赖，
k-carrier 保持零 宿主特定概念；本仓库的 managed 档证明 = examples/hosted-service）：
- 壳1（managed 档）= 宿主产品仓库的 computer 包：HostAdapter 实现 +
  upgradeSea/upgradeCli/install.sh 三入口全委托同一 core（canonical executor 原则）
- 壳2（cli 档）= 宿主产品仓库 宿主 CLI：`<host> self upgrade`；Computer 注入份被
  ownership 检测 held
server 侧最小要求 = 静态文件（manifest + 工件）；drive 为可选增量。
```

关键架构决定：
1. **单 core 多入口**（daemon 内嵌 / CLI / installer 脚本全委托同一 core）—— 消灭"installer 收敛而 upgrade 不收敛"这类分叉（我们 v1.0.11–1.0.15 的实病）。
2. **core 不含任何 宿主特定概念**（无宿主特定环境/机器身份/server 协议）—— 全部经 HostAdapter/配置注入；这是开源 forcing-function 的机械落点。
3. **每层可单独关**：不用 drive = 纯本地；不用 L2 = 退化成 CLI 自升级（= 向下兼容到商品层，路径清晰）。

## 2.35 lint 强度与 type-aware

**已开**：correctness/suspicious = error；pedantic = warn + `--deny-warnings`；`no-explicit-any`；import 插件（`no-cycle`/`no-self-import`）；`no-console` 在 core 是 error（库不许打印，harness CLI 与 examples 用 path override 例外）。
**不开**：`restriction` 类风格禁令，与设计冲突。
**type-aware（`--tsgolint`）：装了、跑了、暂不开。** 它解析不到 `@types/node`（`path.join` 都判 unsafe），2800+ 条绝大多数是假阳性；更危险的是 `no-floating-promises` 这类高价值规则报 **0**——**一个瞎了的检查器的"沉默"不是通过**（同 empty-suite 假绿）。写下来是免得有人看见"装了"就以为在生效。

## 2.4 类型与接口设计原则（08-05："写出来就是对的，问题发生在静态检查阶段"）
- **非法状态不可表示**：discriminated union 优先（`ToothKind`/`CaughtOnlyBy`/`EngineOutcome`/`UpgradeOutcome` 已示范）——"baseline 没有失效条件"这类状态在类型上就不存在，不靠运行时查。
- **证据绑定进类型**：`ProcessEvidence{version,pid,startId}` 三件一体——不能只传 version（谓词函数签名逼你带上进程身份）。
- **typed error/outcome，禁裸 throw string**；**禁 any/断言逃生舱**（ratchet + oxlint 双层机械封死）。
- **构造期校验**（registerTooth 模式）：违纪律的对象根本注册不进去，不是注册进去再警告。
- 静态查不了的（时序/持久性）才交给运行时齿——两层分工同我们 illegal-state 教义。

## 2.5 组合性：三档接入 profile（能力可组合，不要求 托管宿主级复杂度）

**任何 CLI 应用都能用**，从最小档起步、按需长上去；每层都有退化实现，缺哪层就自动降到哪档：

| Profile | 适用 | 用哪些层 | 要写什么 | 得到什么 |
|---|---|---|---|---|
| **cli** | 随便一个 CLI 工具（无常驻进程） | L0 + L1'（简化槽：换字节即 promote，下次运行生效）| **零 HostAdapter**（内置 `NoResidentHost` 空适配器）；只给 source | self_update 同款体验 + 白送 journal/provenance；`binary_at_target` 下次运行自证 |
| **daemon** | 有常驻进程、无托管负载（如普通 agent/服务） | + 完整 L1 两槽 + L2（quiesce/resume 可为 no-op，stop/start/probe 实做）+ L3 binary 谓词 | HostAdapter 三个真方法 | 事务/回滚/crash-safe + 进程级收敛证明 |
| **managed** | 托管宿主级（托管负载、OS 生命周期面、fleet） | 全部六层 | HostAdapter 五方法 + 平台读回面注册 + （可选）drive | 全套：会话保留、lifecycle 收敛、同意/通知、fleet 观测 |

机制保证：`UpgraderConfig.host` 缺省 = `NoResidentHost`；harness 按 profile 分档跑（cli 档只跑 L0/L1' 齿）。**这同时是开源的 adoption funnel**：简单应用从 cli 档零成本进来，长成 daemon/managed 档不换框架。

**install-ownership 检测（框架级规则，Tailscale 原则机械化）**：升级前先判"这份安装归谁管"——**受管副本禁自升**：被别的管理器（OS 包管理器 / 上级 supervisor / 注入器）拥有的安装，自升会与管理器错位 ⇒ 返回 typed `held: managed-elsewhere`（不静默、指向真正的管理者），只有 standalone 安装才走自升。ownership 探测面由壳声明（如 宿主 CLI：检测 Computer 注入 wrapper 标记）。
**第二个真实壳 = 宿主 CLI（cli 档 08-05）**：standalone 安装的 宿主 CLI 接 cli 档拿 `<host> self upgrade`（rustup `self update` 惯例：CLI 本身管别的可升级物时，裸 `upgrade` 语义歧义，`self` 子命令明确"升的是我自己"）（journal/provenance 白送）；Computer 注入份 → `held: managed-elsewhere`。cli 档由此有真实 adopter，非玩具 demo。

## 3. 怎么测试（QA 面 = 框架的一半价值）

按我们的 QA 教义（un-fakeable、失效条件、named-surface）：

1. **通用床（harness/）**：fake-host daemon（实现 HostAdapter 的最小假宿主）+ 静态文件假 server —— 全部验收在"任意宿主"上跑，**测试本身证明通用性**（的 forcing-function 落在这）。
2. **崩溃注入矩阵**（L1 承重齿）：状态机每条迁移边上 kill -9 / 断电模拟 → 重启后必须恢复到 stable 或完成 promote；断言**永不双跑、永不砖**。逐边全覆盖，覆盖面由脚本枚举状态机生成，不由人列。
3. **谓词齿**（L3）：删任一"入口→core 委托" ⇒ RED；删回读 ⇒ RED；version 字段灌真值而谓词面造假 ⇒ 必须不绿（禁投影齿）。
4. **通知可验齿**（L4）：真实失败 → 用户面真收到 → 去掉通知 ⇒ RED（Hipp 判据）。
5. **mutation-runner 契约**（Lincan 工具直接用）：未变异 baseline 0 失败；每颗齿带 must-red 清单；"这条不被此齿抓还会被谁抓"判据；全红也不发结论。
6. **断言纪律**：承重齿 = invariant；锁当前实现的辅助断言 = baseline-带失效条件（已入 spec 的二分）。
7. **跨版本矩阵**：old-core 读 new-state = fail-closed；new-core 收养 old 布局 = 无损迁移；混合版本窗口显式建模。
8. **真机验收协议**：Testbed 床跑全矩阵；个人真机只做 consent 后的读回抽样（1.0.15 建立的惯例）；in-env 复现构建核发布字节。

## 3.5 与 electron-updater 的对照（08-05 读源码，v6.8.9 ≈4200 行）

**两个互相独立的轴**（此前混为一谈的"复杂度"）：**交付**（把字节放到位有多难）与**保证**（放完之后承诺什么）。
```
rustup self update  交付低 / 保证低    换一个文件、退出
electron-updater    交付高 / 保证低    4200 行几乎全在交付：feed 源 ~800 · 增量下载 ~800
                                     · 各平台安装 ~800（mac 起本地 HTTP 服务器把 zip 喂给
                                       Squirrel.Mac，因为它只肯接 URL）· 编排 ~730
K                   交付低 / 保证高    单二进制；事务 + 回读 + 回滚
```
- **核实**：全包**零 rollback / 零 revert / 零装后健康检查**；签名靠**系统代码签名**（Windows Authenticode 发布者名 / mac codesign），不是自己的链。⇒ **"这一类没人做事务回滚与回读"成立。**
- **不长成它**：`.app` / MSI / deb 的安装脏活是平台特有的，交给那些工具；K 只管事务与回滚，通过 `PlatformOps` / `HostAdapter` 调它们。
- **灰度百分比不进核心**：按 K 自己的边界，"我该升到哪个版本"是 `ReleaseSource` 的问题 ⇒ 灰度天然属于那一层。**（这条算边界划对了的证据。）**
- ✅ **曾经的真差距已补**：下载可续传（Range + 全量校验，齿 `m1.download-resumes-after-kill`）。computer 的 SEA ≈150MB，进程死一次就重下的代价是真的。

## 4. 边界（不做什么）
- 不替代 OS 包管理器：PM 拥有的安装交给 PM（TS 矩阵思路），core 的主 lane 是自有安装（SEA 类）。**v0 范围：只假设官方 installer 安装；deb/RPM 等 PM 装的副本 = ownership 检测 → `held: managed-elsewhere` 即正确终态，不做接管/收编**；
- 不做 OS 镜像/嵌入式 OTA（Mender/RAUC 领域）；
- 发布时机/法务 = 开源那步的独立决定（License 已定 Apache-2.0）；
- `host_lifecycle_converged` 作为**发布字段**上报 fleet = 另立任务（同上边界）。

## 5. 与现状的衔接（宿主壳落地顺序）

### 5.0 依赖机制
- **K 是编译进宿主二进制的库，无独立运行时**：core build 进 Computer SEA / 宿主 CLI 二进制 → "谁升级 K" = 升级宿主即升级内嵌的 K。
- **孵化期**：git 依赖钉 commit SHA（pnpm：`"@botiverse/k-carrier": "github:botiverse/k-carrier#<sha>&path:core"`）→ 可复现 + 供应链干净；**升 K = 改 SHA 的 PR**（依赖变更 review 可见）；CI 同 org 已有权限。
- **API 稳定后**：发 `@botiverse/k-carrier` 到公共 npm 按 semver。
- **两壳接法（都在 宿主产品仓库）**：packages/computer（managed 档）= 五方法 HostAdapter（quiesce=park agent runners / stop·start=`__service` / probe=复用 same-PID 就绪核 same-PID 证据 / resume）+ Electron login-item 读回面 + 三入口同一 Upgrader，状态 `HOST_HOME/computer/k/`；packages/cli（cli 档）= 零 adapter + ownership 探测（Computer 注入 wrapper 标记）+ `<host> self upgrade`，状态 CLI 自有目录。**同 monorepo 吃同一 core 版本**（两壳永不错位）；两壳状态目录分离互不干扰。
1. 1.0.16（已冻结）= L2/L3 在 宿主壳内的第一次真实现（upgrade 入口接线 + 自启迁移 + 谓词回读）——**不等 core 成型，按本仓库已落的接口形状写**（`core/src/lifecycle/hostAdapter.ts` / `txn/state.ts` / `converge/predicates.ts` / `upgrader.ts`），之后平移进 core；
2. K 既有产物直接归位：dark policy-row fixture（已建验）→ L5 drive 的门；
3. 本仓库 = 原"release/publish 侧 spec"的上位替代；接入方视角见 `docs/integration.md`。

## 6. 决定记录（原开放问题，已拍部分）
1. **名字/仓库 ✅（08-05）**：公开名 **k-carrier**（`github.com/botiverse/k-carrier`，private 孵化），口头名 **K**。理由：单字母不可检索 + kframework/k 撞名；k-carrier 自解释。
2. **core 语言 = TS 起步 ✅（默认成立，未被否）**：与 daemon 同栈、宿主壳复用最快、测试教义全在 TS 生态；留 FFI/重写门。
3. **并行方式 = 1.0.16 先行 ✅（默认成立）**：按本仓库接口形状写，core 骨架随后收编。
4. **drive 协议（仍开放）**：对齐现有远程配置生态 vs 自定义最小集 —— 到 L5 动工时拍。
5. **License = Apache-2.0 ✅（08-05）**：LICENSE 已入库。
