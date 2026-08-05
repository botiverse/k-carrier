# K 调研：Tailscale / Datadog 更新器源码 vs 我们的需求 (08-05, xxchan 指令)

Sources 全部一手（当日 fetch main 分支）：
- Tailscale: `tailscale/tailscale` → `clientupdate/` (clientupdate.go 1386L, _windows.go 322L, _downloads.go) + `clientupdate/distsign/` (distsign.go 476L)
- Datadog: `DataDog/datadog-agent` → `pkg/fleet/installer/` (installer.go 1036L, oci/, packages/, db/) + `pkg/fleet/daemon/` (daemon.go 849L, remote_config.go, local_api.go, task_db.go)

## Tailscale clientupdate 实况
- **单包双入口**：一个 `clientupdate` 包，`tailscaled`(daemon) 和 `tailscale`(CLI) 共用 —— 天然"同一 canonical executor"形状（我们 #395 的原则他们已实践）。
- **Track 模型**：stable/unstable/release-candidate；minor 奇偶决定 track；`Version XOR Track`；`Confirm(newVer)` 回调；`PkgsAddr` 可覆写（默认 pkgs.tailscale.com）。
- **平台分发 = "谁拥有安装就交给谁"矩阵**（`getUpdateFunction`）：apt→改 sources.list 的 track 再 apt-get；dnf/yum→改 repo 文件；apk/Synology SPK/QNAP/FreeBSD pkg 各走各；**macsys→Sparkle**（他们 mac GUI 版真用 Sparkle！）；Mac App Store→不能自更；Arch→只打印指引（尊重 pacman 所有权）；每分支带 `canAutoUpdate` bool。
- **Linux 裸二进制线**（`updateLinuxBinary`）：requireRoot → 解析版本 → confirm → **distsign 客户端下载+验签** tarball → 解包覆盖 → `systemctl daemon-reload+restart`（fallback init.d）。
- **⚠️ 他们的缺（= 我们的强项区）**：restart 是 **best-effort**——失败只打一行"请手动重启"（**非 fail-closed**）；**无升级后回读**（restart 命令发完即"Success"，不 probe 新 daemon 版本）；**无回滚**（旧二进制直接覆盖）；无 fleet 收敛观测。
- **Windows**：MSI + **自拷贝 trick**（把运行中的 tailscale.exe 拷到 temp 再从 temp 跑 msiexec，避免自锁）+ authenticode 验证 + `TS_UPDATE_WIN_MSI` 环境变量 re-entry。
- **distsign 签名（最值得抄的供应链层）**：两级 Ed25519 —— **离线 root keys 编译期烧进客户端** → 签轮换的 signing keys (`distsign.pub`) → 签文件；server 只是静态文件（`$file` + `$file.sig`）；每次下载前动态取 signing keys。root 轮换靠发新客户端。

## Datadog fleet installer 实况
- **自建包管理器**（`installer.go`: "a package manager that installs and uninstalls packages"），管 agent/injector/**installer 自身**（自己也是被管包）。
- **★ 两槽事务模型（最值得抄的核心）**：每包 `repository.State{Stable, Experiment}` 双槽 —— `InstallExperiment`(新版本装进 experiment 槽、hooks Pre/PostStartExperiment) → 跑实验 → **`PromoteExperiment`**(转正为 stable) 或 **`RemoveExperiment`**(回滚回 stable)。**升级 = 有回滚的蓝绿事务**，state 可读回。**连配置变更都走同一套 experiment/promote/rollback**（InstallConfigExperiment...）。
- **daemon 驱动面**：`remote_config`（服务端推 catalog + 升级任务）→ daemon 执行 → `task_db` 记任务 → `GetState` 逐包读回 {Stable, Experiment} —— **fleet 级"谁在什么版本/实验中"可观测**（我们 install_method/NOT_OBSERVED 缺口他们是解了的）。local API = unix socket / named pipe。
- **分发 = OCI 镜像**，digest 内容寻址（层按 Digest 校验；cosign 类签名未在 download.go 见到，未核实，不断言）。
- 细节：显式处理"self-kill 顺序"（Linux 上 preStopExperiment 会杀自己进程 → 先删 experiment 再停）。

## 逐维对比我们的需求
| 维度 | Tailscale | Datadog | 我们要的 (K/#395) | 判 |
|---|---|---|---|---|
| 执行者形态 | 单包双入口（daemon+CLI 共用）✅ | installer 独立组件+daemon 驱动 | 两入口→同一 canonical executor | **借 TS 形状** |
| 升级事务/回滚 | ❌ 覆盖式、无回滚 | ★ stable/experiment 两槽+promote/rollback | fail-closed + 可回滚 | **借 DD 两槽模型** |
| 升级后回读 | ❌ 无（restart 即 Success） | GetState 逐包读回 | binary_at_target/host_lifecycle_converged 同源回读 + 版本 probe（#5245） | DD 有骨架；我们的 predicate 层更严 |
| Fleet 观测 | ❌ | ★ remote-config+task_db+state | install_method/收敛遥测（缺口） | **借 DD 驱动面**（server 推+读回） |
| 渠道/钉版 | track(stable/unstable/rc)+Version XOR Track+Confirm | catalog+remote config | latest/alpha/pinned channel file（已有） | TS track 语义可参考 |
| 签名/供应链 | ★ distsign 两级离线root Ed25519 | OCI digest 寻址 | 现状 manifest sha256+TLS，无密钥层 | **借 TS distsign 补密钥层** |
| 平台矩阵 | ★ "谁拥有安装交给谁"+canAutoUpdate | OCI+MSI | SEA 自有安装→binary-swap 主线 | TS 矩阵=将来接包管理器的地图 |
| 服务交接/自杀顺序 | Win 自拷贝 trick | 显式 self-kill 顺序 | detached __service 交接+agent 会话保留 | 两家都只护"更新器自身"，**agent 会话保留是我们独有需求** |
| OS-supervisor/自启收敛 | ❌（各平台 service 原生管） | ❌ | launchd 退役+login-item 迁移+回读（#395 核心） | **两家都没有 = 我们独有** |
| 通用框架性 | ❌ 和 tailscale 产品耦合 | ❌ 和 datadog 包生态耦合 | 通用核+Raft壳（开源 forcing-function） | **空档 thesis 成立** |

## 给 K spec 的三条直接结论
1. **核心事务抄 Datadog 两槽**：K 的升级事务 = stable/experiment 双槽 + promote/rollback，天然满足 fail-closed + 回滚 + 可读回；我们再叠上 #395 的两 predicate 同源回读（他们没有的严格层）。
2. **执行者形状抄 Tailscale 单包双入口**：一个 core 包，daemon/CLI/installer 三入口共用 = #395 "同一 canonical executor" 的实现形状。
3. **供应链层抄 distsign**：两级离线 root Ed25519（root 编译期入客户端），静态文件 server 即可 —— 正好长在我们现有 CDN manifest 上，补掉"只有 sha256 没有密钥"的层。
- **我们独有、两家都没有的**（= 通用核的差异化）：agent/宿主会话保留、OS-supervisor 收敛（launchd/login-item）、un-fakeable 收敛回读牙、install-provenance 记录。开源"没有整框架"的 thesis 经代码核实成立。

## 形态定位（08-05 xxchan 追问后补，licenses 同步记）
- 形态差异有信息量：**Tailscale = 个人设备为主的系统服务** → 对安装所有权恭敬（包管理器归属矩阵、Confirm 回调、Arch 只打印指引）；**Datadog = 公司运维管的服务器/k8s 节点** → 才敢做 remote-config 中央推 + fleet 回读（机器无"个人意愿"）。
- **我们 = 并集，不是各占一半（xxchan 纠正，正确口径）**：「个人设备上的受管服务」= DD 那套管理能力（事务/回滚/读回/远程驱动/fleet 观测）**全要** + TS 那套个人设备恭敬（同意/通知/所有权归属）**也全要** + 我们独有的（agent 会话保留、收敛回读牙）。**推论：我们的问题严格比两家都难——他们各只做自己那半，我们是超集**；这也是"没有现成框架"的最干净解释：没人需要过这个并集。通用核定位即此。
- Licenses（repo-level 核实）：Tailscale **BSD-3-Clause** / Datadog agent **Apache-2.0**，均宽松；搬代码 Apache 侧带专利授权更稳；distsign 按思路自写不搬码；我们自己开源协议（惯例 Apache-2.0）到开源那步再定。

## Layer-0 = 商品层；缺口两头有界（08-05 xxchan CLI 追问后补）
- **CLI 自升级这层已解决**（核过 repo）：rust `jaemk/self_update`(954★) / Go `minio/selfupdate`(926★) / `creativeprojects/go-selfupdate` —— 查 release→下载→校验→原子自替换（含 Windows 换运行中 exe trick），库形态。**claude code / codex 的 updater = 此形态活例**（渠道查→下载→自替换、重启生效、无常驻服务要交接所以能这么简单）。
- **精确子集关系**：CLI 自升级 ≈ 只做 `binary_at_target` 一个谓词 = 我们 `upgradeSea` 换二进制 lane 的通用化；CC-updater 与 Raft Computer 需求之差 = 恰好那张清单（服务交接/会话保留/自启收敛/回读/fleet/同意通知）。
- **通用核分层结论**：**Layer 0（取/验/换字节）= 商品层，不差异化**（API 长得像 self_update 熟悉形状、甚至可吃现成库）；**价值全在上层**。**缺口边界**：下界 = self_update/CC-updater（个人 CLI，已解决），上界 = Datadog fleet（org 服务器，已解决），**中间「个人设备上的受管服务」整段无人做** —— 市场图完成。


## 附：两家的测试怎么设计（08-05 二次调研，xxchan 指令）

**Tailscale（`clientupdate_test.go` 1084L + `distsign_test.go` 585L）：纯单元层，零 e2e**
- 覆盖全是**纯函数/文件操作**：apt sources.list 改写（bytes-in/bytes-out 表驱动）、yum repo track、alpine/synology 版本解析、tarball 解包、文件覆盖/symlink、Confirm 回调；distsign 有像样的 key 轮换测试（TestRotateRoot/TestRotateSigning）+ 本地 server 的 TestDownload。
- **没有**：升级 e2e、进程交接、崩溃、回滚测试——**测试形状精确镜像设计缺口**（没有回滚/回读，自然没有需要 e2e 的东西）。
- 可借技术：把平台适配器的解析/改写逻辑做成纯函数表驱动测试（我们 platform/ 的 parser 部分照抄这个形态）。

**Datadog（in-package 单元 + `test/new-e2e/tests/installer/{host,script,unix,windows}` 真 VM e2e）：两层**
- e2e 跑在 **pulumi 现开的真云 VM**（真 systemd/包管理器）。技术亮点：
  - `host.` 助手 API：`AssertPackageInstalledByInstaller/ByPackageManager`、`WaitForUnitActive`、`WaitForFileExists(installer.sock)`、**`host.State()` 全快照断言**；
  - **journald 时间戳锚定**：`LastJournaldTimestamp()` 取标记 → 断言"标记之后发生了 X"（事件式 oracle，防旧事件冒充新证据）；
  - 场景含 **ownership 迁移**（deb/RPM 装的 → installer 接管）和**失败套件**（TestBackendFailure 等）；start/promote experiment 逐步断言版本。
- 成本：org 级 VM 基建，慢且贵。

**对我们 harness 的映射**：
1. 我们的 沙箱+真进程 本地层 ≈ Datadog 需要 VM 才能做的大部分（更便宜、决定性）；Testbed 只留真机轮。
2. **借**：时间戳锚定断言（scenario receipt 加 "events since marker"，防旧证据）；ownership-迁移场景（PM 装的→K 接管）进 test-plan；Tailscale 纯函数表驱动进 platform 适配器测试。
3. **两家都没有（验证我们 harness 的差异化）**：崩溃注入矩阵、对抗自验、mutation 契约、黑盒零集成模式、齿注册表纪律。Tailscale 的单元-only 再次说明：**测试形状跟着设计走——设计里没有回滚/回读，测试就永远不会要求它们**。
