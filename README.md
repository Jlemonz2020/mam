# MAM — Trae / CodeBuddy 多账号管理系统

账号池集中管理、无侵入账号切换、每日定时签到、积分追踪、执行日志。
数据全部落在本地文件（加密凭据库 + 原子写入的 JSON 配置），支持断点恢复与无人值守运行。

**两种交付形态：**

| 形态 | 产物 | 适用场景 |
|---|---|---|
| 桌面安装版（Electron 原生窗口 + 托盘） | `release/MAM-Setup-0.3.1.exe`（约 90 MB） | 个人电脑，双击安装、开始菜单/桌面图标、无浏览器依赖 |
| 无界面服务器版（单文件可执行） | `dist/mam.exe` / `dist/mam`（约 90 MB） | Linux 服务器部署、CRON/systemd、纯命令行 |

> ⚠️ **合规提示**：多账号自动签到可能违反目标产品服务条款，请自行评估风险。系统内置随机抖动、账号间隔、单账号每日上限等节流措施，不提供批量注册/验证码破解能力。

---

## 1. 快速开始

### 1.1 桌面版（Windows，推荐给普通使用者）

```
1. 双击 release\MAM-Setup-0.3.1.exe 完成安装（默认装到 %LOCALAPPDATA%\Programs\MAM）
2. 从开始菜单/桌面启动「MAM 多账号管理」
3. 首次启动在面板中设置主口令（≥6 位，用于加密账号凭据）
4. 添加客户端登录态目录 → 在 Trae/CodeBuddy 里登录账号 → 面板「添加账号」
```

数据位置：`%APPDATA%\MAM\data`（卸载不删除，重装后数据仍在）。
关闭窗口 = 最小化到托盘（后台继续按计划签到）；托盘右键可「立即执行签到 / 开机自动启动 / 退出」。

### 1.2 服务器版（命令行）

```bash
./mam init                                   # 初始化并设置主口令
./mam config set adapters.trae.credential_dir "/home/user/.trae"
./mam add -t trae -n 账号A -g 工作           # 采集登录态
./mam key store                              # 托管口令（无人值守必需）
./mam task install --time 09:00              # 注册 systemd timer
# 或常驻：./mam serve
```

从源码运行：`npm install && npm run mam -- <命令>`。

---

## 2. 账号数据存储结构

数据目录：`MAM_HOME` 环境变量指定；默认 `exe 同目录/data`（源码模式为项目 `data/`）。
Linux 服务器建议 `MAM_HOME=/var/lib/mam`。

```
data/
├── accounts.json          结构化状态（账号/分组/活跃指针/自增序列）
├── accounts.json.bak      上一版本备份（校验失败时自动回退）
├── records.jsonl          追加型流水（签到记录 / 积分快照 / 任务日志）
├── records.jsonl.bak      流水文件压缩重写前的备份
├── config.json            应用配置（签到时间、策略、节流、接口地址）
├── vault.json             加密凭据库（AES-256-GCM，口令派生密钥）
├── master.key             托管的主口令（DPAPI / 机器绑定，见 §6）
├── switch.journal.json    账号切换事务日志（仅切换进行中存在）
├── instance.lock          单实例锁（进程 PID）
├── switch.lock            切换互斥锁（防并发切换）
├── logs/                  NDJSON 运行日志（按日轮转）
└── backups/               登录态目录备份（每次切换前，保留最近 5 份）
```

### accounts.json 结构

```jsonc
{
  "version": 1,
  "checksum": "sha256(JSON.stringify(data))",   // 完整性校验
  "data": {
    "version": 1,
    "updatedAt": 1795358203736,
    "accounts": [{
      "id": 1,
      "name": "账号A",
      "toolId": "trae",              // trae | codebuddy
      "credentialId": "cred-uuid",   // 指向 vault.json 中的加密凭据
      "status": "active",            // active | paused | invalid | banned
      "remark": null,
      "createdAt": 0, "updatedAt": 0, "deletedAt": null   // 软删除
    }],
    "groups": [{ "id": 1, "name": "工作" }],
    "accountGroups": { "1": ["工作"] },                    // 账号-分组多对多
    "active": { "trae": { "accountId": 1, "switchedAt": 0 } }, // 各工具活跃指针
    "seq": { "account": 1, "group": 1 }
  }
}
```

`records.jsonl` 每行一条独立记录，三种类型：

```jsonl
{"t":"checkin","r":{"id":1,"accountId":1,"checkinDate":"2026-11-22","status":"success","message":null,"reward":10,"retried":0,"executedAt":0}}
{"t":"snapshot","r":{"id":1,"accountId":1,"balance":1280,"capturedAt":0}}
{"t":"log","r":{"id":1,"taskType":"switch","accountId":1,"status":"ok","detail":"{...}","startedAt":0,"durationMs":0}}
```

**登录态本身不进 accounts.json**：凭据以「相对路径 → base64 文件内容」打包，用 AES-256-GCM 加密后存入 `vault.json`，账号表只保存 `credentialId` 引用。这样配置可读可迁移，密钥不入库。

---

## 3. 切换与状态保持机制

### 3.1 无侵入切换（不重新登录）

Trae / CodeBuddy 的登录态是本地文件。切换 = **备份当前目录 → 写入目标账号的凭据文件**，客户端重启后即为目标账号：

```
acquire 全局锁 (switch.lock)
  → 检测目标客户端进程（运行中则中止，除非 allow_while_running）
  → 写事务日志 phase=backup
  → 当前登录态目录 rename 到 backups/<tool>-<ts>
  → 写事务日志 phase=restored
  → 解密目标凭据并写入目录
  → validate()（有接口则探测，否则校验目录非空）
  → setActive(toolId, accountId)   ← 提交活跃指针
  → 重新采集回写凭据（保存 token 轮换后的最新态）
  → 写事务日志 phase=committed → 删除事务日志
失败：删除半成品目录 → 把备份 rename 回来 → 记录失败日志（不丢数据）
```

### 3.2 状态不丢失的三条保证

| 保证 | 实现 |
|---|---|
| 账号元数据不丢 | 所有变更先改内存对象，再**整文件原子写** `accounts.json` |
| 登录态不丢 | 切换前必须完整备份；失败或崩溃都走回滚；备份保留最近 5 份 |
| 并发不打架 | `switch.lock` 互斥切换；`instance.lock` 限定单实例（防止两个进程同时写配置） |

### 3.3 活跃账号指针

`accounts.json` 的 `active[toolId]` 记录每个工具当前指向哪个账号，切换成功后立即落盘。重启后 `mam active` / 面板可直接读到上次状态。

---

## 4. 配置读写的可靠性保障

1. **原子写**：写 `*.tmp` → `fsync` → 复制旧文件为 `.bak` → `rename` 覆盖。任何时刻文件要么是旧版本、要么是新版本，不会出现半截 JSON。
2. **完整性校验**：`accounts.json` 外层带 `checksum`，加载时校验；不匹配视为损坏。
3. **损坏回退**：校验/解析失败 → 自动读 `.bak`；仍失败 → 把损坏文件复制为 `.corrupt-<时间戳>` 保留证据，以空配置启动并在启动提示中告知。
4. **流水与状态分离**：签到/积分/日志写入 `records.jsonl`（append + fsync）。单行损坏只影响该行（加载时跳过并计数），不会拖垮整个配置。
5. **自动压缩**：流水超过 2 万行时整体重写（先原子写再替换），并对快照/日志做数量裁剪。
6. **单实例互斥**：`instance.lock` 内含 PID，进程退出后残留锁会被检测并接管。

---

## 5. 重启恢复逻辑

启动顺序（`createRuntime`）：

```
1. 加载 config.json（缺失则写默认值；结构校验）
2. 加载 accounts.json → 校验 checksum → 失败读 .bak → 失败隔离并以空配置启动
3. 检查 switch.journal.json
     ├─ 不存在            → 正常启动
     ├─ phase=committed   → 上次切换已提交，仅清理日志
     └─ phase=backup/restored
            ├─ 备份存在 → 删除半成品登录态目录 → 备份 rename 回来 → 写 recovery 日志
            └─ 备份丢失 → 记录失败日志并告警（备份路径写入日志）
4. 回放 records.jsonl 重建内存索引（签到记录/积分快照/日志）
5. 初始化凭据库（需口令）→ 组装服务 → 启动调度器
```

**实测验证**（`dist/mam.exe`）：手工破坏登录态目录并伪造 `phase=restored` 事务日志后再次启动：

```
⚠ 检测到未完成的账号切换（账号 #1，阶段 restored），已自动回滚到切换前登录态
storage.json 恢复: True   内容: {"token":"fake-token-exe",...}
残留 partial.txt: False   事务日志已清理: True
```

---

## 6. 主口令与无人值守

定时任务不能弹交互输入，因此提供口令托管：

| 平台 | 方式 | 说明 |
|---|---|---|
| Windows | `mam key store` → DPAPI（CurrentUser） | 仅当前 Windows 用户可解密；换用户/换机器失效 |
| Linux | `mam key store` → AES-256-GCM + `/etc/machine-id`+uid 派生 | 文件权限 0600；机器绑定（防跨机拷贝，非强度加密） |
| 任意 | `MAM_PASSWORD` 环境变量 / `MAM_PASSWORD_FILE` 文件 | 优先级最高，适合容器与 CI |

优先级：`MAM_PASSWORD` → `MAM_PASSWORD_FILE` → `master.key` → 交互输入。
`mam doctor` 会显示当前托管状态。

---

## 7. 定时签到的双端触发方式

### 7.1 Windows 桌面端（安装版，两种，可任选）

**A. 应用内调度（推荐，零配置）**

安装版启动后即为常驻进程：

- 关闭窗口 → 收进托盘，**调度器继续运行**（不会退出）
- 托盘右键：`打开主界面` / `立即执行签到` / `开机自动启动`（写注册表 Run 项）/ `退出`
- 每天 `schedule.checkin_time`（默认 09:00）触发，**先随机延迟 0~30 分钟再执行**
- 托盘「开机自动启动」勾选后，登录 Windows 即自动拉起，签到不会因忘记开程序而漏签

> 面板闲置 `security.auto_lock_minutes` 后会话锁定；托盘「立即执行签到」若处于锁定会提示先解锁（凭据库解锁状态仅在进程内，重启需再输一次口令；需要长期无人值守请用 B 或服务器版 `mam key store`）。

**B. 命令行版 + Windows 计划任务（进程不用常驻）**

```powershell
mam.exe key store                 # 先托管口令（DPAPI）
mam.exe task install --time 09:00 # 注册每日计划任务
mam.exe task status               # 查看下次运行时间
mam.exe task uninstall
```
等价脚本：`deploy/windows/install-task.ps1`（`-StartWhenAvailable` 支持错过后补跑）。

### 7.2 Linux 服务器

**A. 常驻守护进程**

```
MAM_HOME=/var/lib/mam ./mam serve        # 面板 + 内置调度
# systemd: deploy/systemd/mam-daemon.service
```

**B. systemd timer（推荐，无需常驻）**

```
./mam task install --time 09:00   # 写入 ~/.config/systemd/user 并启用 timer
# 或系统级：cp deploy/systemd/mam-checkin.* /etc/systemd/system/ && systemctl enable --now mam-checkin.timer
```
Timer 关键项：`OnCalendar=*-*-* 09:00:00`、`RandomizedDelaySec=1800`（抖动）、`Persistent=true`（**关机/重启错过触发点后开机补跑**）。

**C. cron 兜底**

```cron
0 9 * * * MAM_HOME=/var/lib/mam /opt/mam/mam checkin --scheduled >> /var/log/mam-checkin.log 2>&1
```

> `--scheduled` = 非交互模式：不打印表格，只写流水日志；失败时退出码为 1，便于 systemd/cron 判定。

---

## 8. 构建与跨平台

```bash
npm install

# ① Windows 桌面安装包（Electron + NSIS）
npm run dist          # → release/MAM-Setup-0.3.1.exe（含图标/开始菜单/桌面快捷方式/卸载项）
npm run dist:dir      # → release/win-unpacked（免安装便携目录）

# ② 无界面单文件（服务器）
npm run build         # → dist/mam.exe（Windows）或 dist/mam（Linux/macOS），用 Node SEA 注入
```

构建原理：

- 桌面版：`esbuild` 打包主进程（内嵌面板 HTML 与托盘图标）→ `electron-builder` 用本地 Electron 运行时组包 → NSIS 安装器。`package.json` 的 `build.electronDist` 指向 `node_modules/electron/dist`，离线/内网环境也能出包。
- 服务器版：`esbuild` 打包 CJS → Node SEA blob → `postject` 注入当前平台 `node` 二进制。**在哪个平台构建就得到哪个平台的二进制**。

运行期零外部依赖：面板 HTML 内嵌、数据为纯文件、无原生模块。

数据目录：

| 形态 | 默认位置 | 覆盖方式 |
|---|---|---|
| 桌面安装版 | `%APPDATA%\MAM\data` | 环境变量 `MAM_HOME` |
| 服务器版 | 可执行文件同目录 `data/` | `MAM_HOME`（建议 `/var/lib/mam`，权限 700） |

---

## 9. CLI 命令

```
mam init                       初始化（设置主口令）
mam add -t <tool> -n <name>    采集当前登录态并添加账号
mam list / edit / remove       账号列表 / 编辑 / 删除（--hard 彻底删除）
mam switch <id>                切换账号（事务日志 + 自动回滚）
mam active                     查看各工具当前账号
mam group add|rm|list|assign|unassign
mam checkin [--account id] [--group name] [--no-retry] [--interval lo,hi] [--scheduled]
mam points [--refresh]         积分查看 / 刷新
mam report [--month YYYY-MM]   签到与积分报表
mam doctor                     环境自检（存储/凭据/接口/进程/口令托管）
mam config show|get|set        配置读写（带校验）
mam key store|status|clear     主口令托管
mam task install|uninstall|status   系统定时任务
mam desktop                    桌面模式（面板 + 调度 + 窗口）
mam serve                      服务器守护模式（面板 + 调度，无窗口）
```

## 10. 主要配置项（data/config.json）

```jsonc
{
  "schedule": {
    "checkin_time": "09:00",           // 每日签到时间
    "jitter_minutes": 30,              // 随机抖动（风控）
    "points_poll_interval_hours": 6,   // 积分轮询周期（常驻模式生效）
    "health_check_interval_hours": 24
  },
  "switch": {
    "strategy": "round-robin",         // round-robin | least-points | undated-first
    "group_scope": "all",              // 签到范围分组
    "auto_switch_after_checkin": true,
    "account_interval_seconds": [30, 120],
    "allow_while_running": false       // 客户端运行时是否允许切换（不建议）
  },
  "limits": { "min_request_interval_ms": 5000, "max_checkin_per_day": 1, "retry_delays_seconds": [60,300,900] },
  "notify": { "channels": ["desktop"], "webhook_url": "", "on": ["checkin_failed_twice","account_invalid","points_drop"] },
  "adapters": {
    "trae": {
      "credential_dir": "",            // 登录态目录
      "checkin_url": "", "checkin_method": "POST",   // 空 = 手动模式
      "points_url": "",
      "auth": null                     // { "file":"...", "pattern":"...", "header":"Authorization", "prefix":"Bearer " }
    },
    "codebuddy": { "...": "同上" }
  }
}
```

**手动模式 vs 全自动**：未配置 `checkin_url` 时，系统只做「切到该账号 + 记录一条 skipped」，签到动作需人工在客户端完成；配置接口与 token 提取规则后即为全自动签到与积分拉取。

---

## 11. 安全说明

- 凭据 AES-256-GCM 加密，主密钥由口令经 scrypt 派生，明文只在操作内存中存在
- 面板仅监听 `127.0.0.1`，令牌解锁 + 闲置自动锁（默认 30 分钟）
- 面板不做多用户/远程访问；服务器远程使用请走 SSH 隧道或反向代理 + TLS
- `master.key` 是可用性妥协（无人值守必需）：Windows DPAPI 绑定当前用户；Linux 为机器绑定，建议配合文件权限与磁盘加密

## 12. 已知限制

1. 登录态目录需按实际客户端版本确认（`mam doctor` 会列出候选目录并标注存在项）
2. 若 token 存于 OS 密钥链而非文件，文件级采集无法覆盖
3. 私有签到/积分接口随版本可能变更，适配器对响应做了通用解析，失败详情见日志
4. 计划任务/serve 需保持用户会话（Windows）或开启 lingering（Linux 用户级 timer）：`loginctl enable-linger <user>`
