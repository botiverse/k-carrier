# K (k-carrier) 升级框架 设计文档 v1.2（通用核 + Raft 壳）

作者 archer · 2026-08-05 (v1.2: +§2.5 三档 profile 与 install-ownership 检测、双真实壳[raft-shell managed 档 + raft CLI cli 档 `raft self upgrade`]、examples 每档一 demo 入架构图；v1.1: 定名 k-carrier、决定记录、接口落码衔接) · 基于 xxchan DM 收敛的方向（开源 forcing-function / 并集定位 / 边做开源边做自己的）+ 源码调研（`k-updater-research-tailscale-datadog.md`）+ #395 冻结 spec + #376 载体无关不变式。

---

## 0. 定位（一句话）

**「个人设备上的受管常驻服务」的升级框架** —— 需求 = 并集：Datadog 级的管理能力（事务/回滚/读回/远程驱动/fleet 观测）**全要** + Tailscale 级的个人设备恭敬（同意/通知/安装所有权）**也全要** + 独有的宿主负载（agent 会话）保留。市场图两头有界（下界 self_update/CC-updater 已解决、上界 Datadog fleet 已解决），中间整段无人做。

**形态**：一个仓库（= 本仓库 `botiverse/k-carrier`）、`core`（通用框架，按开源标准写，任何 daemon 可用）+ harness/examples；**壳（Raft Computer / raft CLI）住 slock 仓库、消费 core 作依赖**。发布时机独立决定，不挡开工。

---

## 1. 能力清单（六层，每层：要什么 · 怎么设计 · 抄谁/自研）

### L0 工件层（商品层，不差异化）
**要**：版本解析（channel: `latest | alpha | pinned:X`）→ 下载 → 完整性校验 → 原子换字节（含 Windows 换运行中 exe）。
**设计**：静态文件协议 —— server 只需 `manifest.json`（version/targets/sha256/size）+ 工件 + 签名文件；客户端轮询/被动触发。API 形状对齐 `self_update` 类库的社区习惯。
**来源**：= 现有 `upgradeSea` lane 通用化；对齐 jaemk/self_update、minio/selfupdate 的成熟形状，可部分吃现成。

### L0.5 供应链层
**要**：不只 sha256 —— 密钥签名，离线 root，可轮换。
**设计**：抄 **Tailscale distsign 思路自写**（BSD-3，按思路不搬码）：两级 Ed25519 —— 离线 root keys **编译期烧进 core 客户端** → 签轮换 signing keys（`signing.pub` + root 签名）→ 签每个工件（`$file.sig`）。server 仍纯静态。root 轮换 = 发新客户端（多 root 并存支持轮换期）。
**补充**：in-env 可复现构建作为独立复验手段（我们 1.0.15 实测：匹配 CI 环境逐字节命中发布体）；发布流水线拆「传 immutable 快照 → 验 exact → 翻指针」（1.0.16 已立项的天窗）。

### L1 事务层（核心，抄 Datadog 两槽）
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
- 降级规则：新格式状态被旧二进制读到 = **fail-closed**（拒绝启动并指引，不静默破坏）——#376 已定。

### L2 服务生命周期层（我们独有的核心难点之一）
**要**：常驻服务换版本时的交接：停旧起新、自杀顺序、宿主负载（agent 会话/工作区）保留。
**设计**：
- **Host adapter 接口**（宿主必须实现的最小面）：`quiesce()`（负载可安全暂停/落盘）、`stop()`、`start(slot)`、`healthProbe() → {version, pid, startId}`、`resume()`。core 只调接口，不知宿主细节 —— 这就是"任何 daemon 可用"的机械保证。
- 自替换顺序显式化（Datadog 的教训直接抄）：先落盘 journal 意图 → 交接进程树（detached owner 模式，= 我们 direction-B）→ 新进程自证（见 L3）→ 才清旧。
- 会话保留 = 宿主契约的一部分：`quiesce` 前后负载状态等价（Raft 壳里 = agent 的 MEMORY/工作区/连接恢复；核心层只保证调用时序与回滚时的对称恢复）。

### L3 收敛与回读层（#395 直接平移，两家都没有）
**要**：升级"说做到了"必须可机械证明。
**设计**：两谓词 + 同源回读（#395 冻结 spec 原样）：
- `binary_at_target`：新进程 **same-PID version-probe**（healthProbe 返回的 version/startId 绑定同一进程，杜绝 live-PID 假成功 —— #5245 已落的机制）；
- `host_lifecycle_converged`：OS-supervisor/自启等宿主生命周期面按 SSOT 写并回读一致（**点名读回面**，如 macOS = Electron `app.getLoginItemSettings().openAtLogin`；不可读面不得自称 same-source）；
- **禁投影**：版本号/渠道字段机制上不得充当任一谓词（version⊥supervisor-state 已实测）；
- **fail-closed 退役序**：退旧管理器只在新面回读 PASS 之后（#395 裁定原样）。

### L4 同意与通知层（Tailscale 侧恭敬，做成可验的）
**要**：个人设备上不静默改行为；升级策略归属主明确。
**设计**：
- 策略 knob：`auto | confirm | notify-only`（对应 TS 的 Confirm 回调形状），策略本身是被管配置（走 L1 事务）；
- **通知可验齿**（Hipp 判据原样入验收）：构造真实失败 → 断言用户面**真收到**可观测物（不是"代码调用了通知"）→ 去掉通知 ⇒ RED；
- 行为变化通告面 = 框架内建能力（我们 1.0.15 的教训：Computer 无用户面通告渠道是产品缺口，核心层把"有一个可注册的通告 sink"做成接口）。

### L5 Fleet 驱动与观测层（Datadog 侧能力，尊重 L4）
**要**：server 可推升级、可读 fleet 状态；来路可追。
**设计**：
- 驱动 = 可选组件（不用 server 也能全功能本地升级 —— 个人设备优先）；驱动命令集 = L1 状态机操作的远程投影（stage/promote/rollback），**必须过 L4 策略门**；
- 状态上报 = `{stable, experiment, 两谓词, 策略}` 逐机读回（= Datadog GetState 形状 + 我们谓词）；
- **install-provenance journal**（我们独有，两端洞的修法）：每次 reconcile 本地先记（谁/哪个载体/何时/何 channel），forward-only；**存量机 genesis = 永久 NOT_OBSERVED，指标机制上禁止把"已记录"与"未观测"合并**。

---

## 2. 整体架构

```
┌────────────────────────── 一个仓库 ──────────────────────────┐
│  core/                                                       │
│   ├─ artifact/      L0: manifest·channel·download·swap       │
│   ├─ distsign/      L0.5: 两级签名 client（root 编译期注入）  │
│   ├─ txn/           L1: 两槽 repo + journal + 状态机          │
│   ├─ lifecycle/     L2: HostAdapter 接口 + 交接编排           │
│   ├─ converge/      L3: 谓词 + 同源回读 + fail-closed 序      │
│   ├─ policy/        L4: auto/confirm/notify + 通告 sink 接口  │
│   ├─ drive/         L5(可选): 远程命令投影 + 状态上报          │
│   └─ platform/      mac(launchd/login-item)·linux(systemd/    │
│                     detached)·windows(service/自拷贝) 适配器   │
│  harness/           通用验收床：fake-host daemon + 全套齿      │
│                     （按 profile 分档跑；managed 假宿主与       │
│                      examples/managed-host 共用）              │
│  examples/          每档一个可跑 demo（cli-tool /              │
│                     plain-daemon / managed-host）——            │
│                     哪档没绿 demo，那档的支持 claim 不存在      │
└──────────────────────────────────────────────────────────────┘
两个真实壳都**不在本仓库**（xxchan 08-05 裁定：壳代码住产品仓库、消费 core 作依赖，
k-carrier 保持零 Raft 概念；本仓库的 managed 档证明 = examples/managed-host）：
- 壳1（managed 档）= slock 仓库 packages/computer：HostAdapter 实现 +
  upgradeSea/upgradeCli/install.sh 三入口全委托同一 core（#395 canonical executor）
- 壳2（cli 档）= slock 仓库 raft CLI：`raft self upgrade`；Computer 注入份被
  ownership 检测 held
server 侧最小要求 = 静态文件（manifest+工件+签名）；drive 为可选增量。
```

关键架构决定：
1. **单 core 多入口**（daemon 内嵌 / CLI / installer 脚本全委托同一 core）—— 消灭"installer 收敛而 upgrade 不收敛"这类分叉（我们 v1.0.11–1.0.15 的实病）。
2. **core 不含任何 Raft 概念**（无 SLOCK_HOME/机器身份/server 协议）—— 全部经 HostAdapter/配置注入；这是开源 forcing-function 的机械落点。
3. **每层可单独关**：不用 drive = 纯本地；不用 L2 = 退化成 CLI 自升级（= 向下兼容到商品层，路径清晰）。

## 2.5 组合性：三档接入 profile（能力可组合，不要求 Raft Computer 级复杂度）

**任何 CLI 应用都能用**，从最小档起步、按需长上去；每层都有退化实现，缺哪层就自动降到哪档：

| Profile | 适用 | 用哪些层 | 要写什么 | 得到什么 |
|---|---|---|---|---|
| **cli** | 随便一个 CLI 工具（无常驻进程） | L0 + L0.5 + L1'（简化槽：换字节即 promote，下次运行生效）| **零 HostAdapter**（内置 `NoResidentHost` 空适配器）；只给 releaseBase/channel/rootKeys | self_update 同款体验 + 白送签名链/journal/provenance；`binary_at_target` 下次运行自证 |
| **daemon** | 有常驻进程、无托管负载（如普通 agent/服务） | + 完整 L1 两槽 + L2（quiesce/resume 可为 no-op，stop/start/probe 实做）+ L3 binary 谓词 | HostAdapter 三个真方法 | 事务/回滚/crash-safe + 进程级收敛证明 |
| **managed** | Raft Computer 级（托管负载、OS 生命周期面、fleet） | 全部六层 | HostAdapter 五方法 + 平台读回面注册 + （可选）drive | 全套：会话保留、lifecycle 收敛、同意/通知、fleet 观测 |

机制保证：`UpgraderConfig.host` 缺省 = `NoResidentHost`；harness 按 profile 分档跑（cli 档只跑 L0/L1' 齿）。**这同时是开源的 adoption funnel**：简单应用从 cli 档零成本进来，长成 daemon/managed 档不换框架。

**install-ownership 检测（框架级规则，Tailscale 原则机械化）**：升级前先判"这份安装归谁管"——**受管副本禁自升**：被别的管理器（OS 包管理器 / 上级 supervisor / 注入器）拥有的安装，自升会与管理器错位 ⇒ 返回 typed `held: managed-elsewhere`（不静默、指向真正的管理者），只有 standalone 安装才走自升。ownership 探测面由壳声明（如 raft CLI：检测 Computer 注入 wrapper 标记）。
**第二个真实壳 = raft CLI（cli 档，xxchan 08-05）**：standalone 安装的 raft CLI 接 cli 档拿 `raft self upgrade`（rustup `self update` 惯例：CLI 本身管别的可升级物时，裸 `upgrade` 语义歧义，`self` 子命令明确"升的是我自己"）（签名链/journal/provenance 白送）；Computer 注入份 → `held: managed-elsewhere`。cli 档由此有真实 adopter，非玩具 demo。

## 3. 怎么测试（QA 面 = 框架的一半价值）

按我们的 QA 教义（un-fakeable、失效条件、named-surface）：

1. **通用床（harness/）**：fake-host daemon（实现 HostAdapter 的最小假宿主）+ 静态文件假 server —— 全部验收在"任意宿主"上跑，**测试本身证明通用性**（xxchan 的 forcing-function 落在这）。
2. **崩溃注入矩阵**（L1 承重齿）：状态机每条迁移边上 kill -9 / 断电模拟 → 重启后必须恢复到 stable 或完成 promote；断言**永不双跑、永不砖**。逐边全覆盖，覆盖面由脚本枚举状态机生成，不由人列。
3. **谓词齿**（L3）：删任一"入口→core 委托" ⇒ RED；删回读 ⇒ RED；version/channel 字段灌真值而谓词面造假 ⇒ 必须不绿（禁投影齿）。
4. **通知可验齿**（L4）：真实失败 → 用户面真收到 → 去掉通知 ⇒ RED（Hipp 判据）。
5. **mutation-runner 契约**（Lincan 工具直接用）：未变异 baseline 0 失败；每颗齿带 must-red 清单；"这条不被此齿抓还会被谁抓"判据；全红也不发结论。
6. **断言纪律**：承重齿 = invariant；锁当前实现的辅助断言 = baseline-带失效条件（#395 已入 spec 的二分）。
7. **跨版本矩阵**：old-core 读 new-state = fail-closed；new-core 收养 old 布局 = 无损迁移；混合版本窗口显式建模。
8. **真机验收协议**：Testbed 床跑全矩阵；个人真机只做 consent 后的读回抽样（1.0.15 建立的惯例）；in-env 复现构建核发布字节。

## 4. 边界（不做什么）
- 不替代 OS 包管理器：PM 拥有的安装交给 PM（TS 矩阵思路），core 的主 lane 是自有安装（SEA 类）；
- 不做 OS 镜像/嵌入式 OTA（Mender/RAUC 领域）；
- 发布时机/法务 = 开源那步的独立决定（License 已定 Apache-2.0）；
- `host_lifecycle_converged` 作为**发布字段**上报 fleet = 另立任务（#395 边界原样）。

## 5. 与现状的衔接（Raft 壳落地顺序）
1. 1.0.16（已冻 #395）= L2/L3 在 Raft 壳内的第一次真实现（upgrade 入口接线 + 自启迁移 + 谓词回读）——**不等 core 成型，按本仓库已落的接口形状写**（`core/src/lifecycle/hostAdapter.ts` / `txn/state.ts` / `converge/predicates.ts` / `upgrader.ts`），之后平移进 core；
2. K 既有产物直接归位：dark policy-row fixture（已建验）→ L5 drive 的门；channel file → L0；distsign → L0.5 新建；
3. 本仓库 = 原"release/publish 侧 spec"的上位替代；接入方视角见 `docs/integration.md`。

## 6. 决定记录（原开放问题，已拍部分）
1. **名字/仓库 ✅（xxchan 08-05）**：公开名 **k-carrier**（`github.com/botiverse/k-carrier`，private 孵化），口头名 **K**。理由：单字母不可检索 + kframework/k 撞名；k-carrier 自解释。
2. **core 语言 = TS 起步 ✅（默认成立，未被否）**：与 daemon 同栈、Raft 壳复用最快、测试教义全在 TS 生态；留 FFI/重写门。
3. **并行方式 = 1.0.16 先行 ✅（默认成立）**：按本仓库接口形状写，core 骨架随后收编。
4. **drive 协议（仍开放）**：对齐现有远程配置生态 vs 自定义最小集 —— 到 L5 动工时拍。
5. **License = Apache-2.0 ✅（xxchan 08-05）**：LICENSE 已入库。
