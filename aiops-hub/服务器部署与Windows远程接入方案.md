# 服务器部署 + Windows 远程接入完整方案

> 目标：在服务器上 7×24 运行统一账号运营中枢（控制面），Windows 电脑通过安全通道远程使用服务器号池，支持自动切号、自动签到/积分、状态与上下文持久化。
> 参考项目：`Jlemonz2020/mam`（本地凭据库、事务切换、systemd timer）、`smart-open/TraeWorkAssistant`、`ithtelab/workbuddy-manager`（网关与账号池）、本仓库 `aiops-hub`（统一控制面实现）。

---

## 0. 总体架构与角色划分

```text
┌────────────────────────── 服务器端（控制面/数据面） ──────────────────────────┐
│  AIOpsHub serve：Web 控制台 / 管理 API / 统一网关 / 调度器                    │
│  账号池(唯一事实源) + 加密凭据库 + 积分流水 + 任务状态 + 审计                 │
│  监听 127.0.0.1:8787，由 SSH 隧道或反向代理对外                                │
└───────────────┬──────────────────────────────┬────────────────────────────────┘
                │ HTTPS / SSH 隧道              │ 下发切换指令（可选 Agent 通道）
                ▼                              ▼
┌────────────────────────┐        ┌──────────────────────────────────────────┐
│ Windows 浏览器/CLI      │        │ Windows Agent（可选，执行面）             │
│ 查看/操作号池、报表      │        │ 接收命令 → 本机登录态切换 → 回传上下文     │
└────────────────────────┘        └──────────────────────────────────────────┘
```

关键结论：

- **账号池、凭据、签到积分、网关、审计全部在服务器**，Windows 端只做访问与展示。
- 若“自动切换账号”指的是**服务端网关/无界面调用**，服务器直接切换运行时即可，不需要 Agent。
- 若指的是**切换 Windows 本机 Trae/CodeBuddy 桌面客户端登录态**，必须在 Windows 上部署一个轻量 **Agent**，因为服务器无法直接写 Windows 本地文件。该 Agent 复用现有 `Switcher` + `Vault` 逻辑，下面给出契约与部署方式。

---

## 1. 运行环境与前置条件

### 1.1 服务器端

| 项目 | 要求 |
|---|---|
| 系统 | Ubuntu 22.04/24.04 LTS（或 Debian 12 / CentOS Stream 9），Linux x86_64 |
| 资源 | 2 vCPU / 4 GB 内存 / 20 GB 磁盘起；账号规模每 500 个再增加 2 GB |
| 运行时 | Python 3.10+（建议 3.12），`python3-venv`，`pip` |
| Python 依赖 | `cryptography>=41`（AES-256-GCM / scrypt） |
| 系统组件 | `systemd`、NTP/chrony、反向代理（Caddy 或 Nginx + certbot）、防火墙 |
| 网络 | 固定公网 IP 或 DNS；入站仅开放 22（管理）与 443（HTTPS）；出站允许访问平台接口与通知 Webhook |
| 存储 | `/var/lib/aiops-hub` 独立目录，权限 `0700`，建议挂载独立磁盘并做每日备份 |
| 时间 | 服务器与 Windows 客户端时间同步，误差 < 1 分钟（签到抖动与任务触发依赖时间） |

服务器初始化命令：

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip caddy rsync cron

sudo useradd --system --create-home --home-dir /var/lib/aiops-hub --shell /usr/sbin/nologin aiops
sudo install -d -m 700 -o aiops -g aiops /var/lib/aiops-hub /etc/aiops-hub

sudo cp -r aiops-hub /opt/aiops-hub
sudo chown -R aiops:aiops /opt/aiops-hub
sudo -u aiops python3 -m venv /opt/aiops-hub/venv
sudo -u aiops /opt/aiops-hub/venv/bin/pip install -r /opt/aiops-hub/requirements.txt

# 主口令文件（仅 root/aiops 可读，0600）
openssl rand -hex 24 | sudo tee /etc/aiops-hub/password >/dev/null
sudo chmod 600 /etc/aiops-hub/password
sudo chown aiops:aiops /etc/aiops-hub/password

# 初始化凭据库
sudo -u aiops AIOPS_HOME=/var/lib/aiops-hub \
  /opt/aiops-hub/venv/bin/python /opt/aiops-hub/run.py \
  --home /var/lib/aiops-hub init --password "$(sudo cat /etc/aiops-hub/password)"
```

### 1.2 Windows 客户端

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 1809+ / Windows 11 |
| 浏览器 | Edge / Chrome（访问 Web 控制台） |
| 远程通道 A | OpenSSH Client（Win10 1809+ 可选功能）或 Tailscale/ZeroTier |
| 远程通道 B | 直接 HTTPS 访问反向代理地址 |
| Agent（可选） | Python 3.10+，对目标客户端配置目录有写权限，可用 NSSM 或任务计划托管 |
| 本地客户端 | Trae / CodeBuddy / WorkBuddy / Qoder 等已安装并可登录 |

Windows 启用 OpenSSH Client：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

---

## 2. 连接与协同机制

### 2.1 两种方式（推荐 A）

**方式 A：SSH 隧道（最安全，推荐先用）**

服务器只监听 `127.0.0.1:8787`，Windows 建立本地端口转发：

```powershell
ssh -N -L 8787:127.0.0.1:8787 aiops@SERVER_IP
# 浏览器打开 http://127.0.0.1:8787
```

特点：管理 API 与 Web 面板都不暴露公网；只需开放 22；密钥登录后无需额外证书。
可在 Windows 用 `ssh -N -L ... -f` 或制作快捷方式后台运行。

**方式 B：HTTPS 反向代理（适合多人/长期访问）**

服务器仍监听 `127.0.0.1:8787`，由 Caddy 终止 TLS：

```caddyfile
# /etc/caddy/Caddyfile
hub.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787

    # 生产环境禁止访问演示模拟接口
    @mock path /mock/*
    respond @mock 404

    # 可选：IP 白名单（公司出口 IP）
    # @denied not remote_ip 1.2.3.4/32
    # respond @denied 403
}
```

```bash
sudo systemctl reload caddy
```

Windows 直接访问 `https://hub.example.com`，右上角填入 `server.admin_key`。

> 两种方式都使用应用内管理密钥鉴权（`X-Admin-Key`）；Agent 使用独立 Agent Token，不复用管理员密钥。

### 2.2 端口与网络配置

| 端口 | 绑定 | 用途 | 暴露范围 |
|---|---|---|---|
| 8787/TCP | `127.0.0.1` | AIOpsHub Web/API/网关 | 仅本机；经隧道或反代访问 |
| 22/TCP | `0.0.0.0` | SSH 管理/隧道 | 仅管理员 IP |
| 443/TCP | `0.0.0.0` | Caddy TLS | Windows 客户端/VPN |
| 出站 443 | — | 平台签到/积分接口、Webhook、包更新 | 服务器 |

防火墙示例：

```bash
sudo ufw default deny incoming
sudo ufw allow from YOUR_ADMIN_IP to any port 22 proto tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 2.3 协同流程

```text
1. Windows 浏览器 → SSH隧道/HTTPS → 服务器 Web/API
2. 用户在面板点击“签到/切换/积分” → 服务器 Hub 执行或下发 Agent 命令
3. 调度器 7×24 运行：定时签到、积分轮询、健康探测、自动切换
4. 执行结果写入 records.jsonl → 看板/报表/告警实时反映
5. 若需切 Windows 客户端：服务器下发 command → Windows Agent 执行本地事务切换 → 回传 ack + context
```

Agent 通道建议采用**出站长轮询**（Windows 主动连服务器，无需在 Windows 开入站端口）：

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/agent/register` | POST | `X-Admin-Key` | 上报机器标识/平台/目录，返回 `agent_id` + `agent_token`（仅一次） |
| `/agent/heartbeat` | POST | `X-Agent-Token` | 上报在线状态、活跃账号、上下文序号 |
| `/agent/commands/poll?agent_id=&since=` | GET | `X-Agent-Token` | 拉取待执行切换命令（带 `command_id` 与租约） |
| `/agent/commands/ack` | POST | `X-Agent-Token` | 回传执行结果、登录态快照、上下文 |
| `/agent/context` | GET/POST | `X-Agent-Token` | 读取/覆盖 `active[platform]`、事务阶段、最近登录态摘要 |
| `/agent/credentials?agent_id=&credential_id=` | GET | `X-Agent-Token` | 获取 Agent Token 封装的加密凭据 |
| `/agent/credentials/upload` | POST | `X-Agent-Token` | 回传轮换后的凭据，覆盖服务端 vault |
| `/api/agents` | GET | `X-Admin-Key` | 查看 Agent 列表与命令队列 |

服务端把 Agent 上下文存到 `AIOPS_HOME/contexts/<agent_id>.json`，注册信息/命令队列存 `AIOPS_HOME/agents.json`，并以 `command_id` 做幂等，避免重复切号。以上接口已在本项目 `src/aiopshub/agents.py` 与 `server.py` 中实现。

---

## 3. 号池管理功能

### 3.1 服务器号池与 Windows 端的对应

- 服务器 `accounts.json` 是**唯一权威账号池**，Windows 端通过 Web API 查看同一份数据。
- 添加账号两种方式：
  1. 服务端可直连平台接口时，直接在服务器采集登录态文件；
  2. 登录态只在 Windows 本机时，由 Agent 调用现有 `adapters.capture()` 采集，加密上传到服务器 `vault.json`，账号表只存 `credentialId`。
- 支持分组、状态（active/paused/invalid/banned）、健康度、积分、冷却、活跃指针。

### 3.2 自动切换账号

服务器调度器按 `switch.strategy` 选号：

- `round-robin`：轮询；
- `least-points`：优先低积分账号；
- `undated-first`：优先未签到账号。

执行分两类：

| 场景 | 执行者 | 流程 |
|---|---|---|
| 服务端网关/无界面调用 | 服务器 `Switcher` | 备份服务端登录态 → 写回目标凭据 → 更新 `active[platform]` → 清理事务日志 |
| Windows 桌面客户端 | Windows Agent | 服务器下发 `command_id + credential_id + platform` → Agent 复用 `Switcher` 备份/写回/校验/回滚 → ack |

两者都遵循同一套事务语义：`backup → restored → committed`，失败自动回滚，`switch.lock` 防并发。Windows 端点击“切换”按钮与自动切换走同一命令通道。

### 3.3 自动获取积分

服务器调度器执行：

1. 按任务范围选号；
2. 从 `vault.json` 取目标账号凭据，提取 token/device_id；
3. 调用 `adapters.checkin()` / `adapters.points()`；
4. 写入 `records.jsonl`（签到记录 + 积分快照）；
5. 更新账号 `points`、`last_checkin_date`、`fail_streak`、`health`；
6. 触发通知（连续失败两次、账号失效、积分下降）；
7. 若 token 轮换，Agent 回传新凭据并覆盖 vault。

幂等保护：同一 `account_id + 日期` 成功达到 `max_checkin_per_day` 后直接返回 `skipped`，重复触发不会重复加分。

---

## 4. 数据持久化与上下文保持

### 4.1 服务器端持久化

| 数据 | 文件 | 机制 |
|---|---|---|
| 配置 | `config.json` | 原子写（`tmp → fsync → .bak → rename`） |
| 账号池/分组/活跃指针 | `accounts.json(.bak)` | SHA-256 checksum，损坏回退 `.bak`，再失败隔离 `.corrupt-*` |
| 凭据 | `vault.json` | AES-256-GCM 加密，scrypt 派生密钥，文件 0600 |
| 任务定义 | `tasks.json` | 原子写 |
| 签到/积分/网关/事件 | `records.jsonl(.bak)` | 追加 + fsync，按日/行数压缩 |
| 切换事务 | `switch.journal.json` | 仅切换中存在；启动检测未提交事务并回滚 |
| 登录态备份 | `backups/` | 每次切换前备份，保留最近 5 份 |
| Agent 上下文 | `contexts/<id>.json` | 记录 last_seq、active、事务阶段、待确认命令 |

每日备份：

```bash
# /etc/cron.d/aiops-backup
0 2 * * * aiops tar czf /var/backups/aiops-$(date +\%F).tar.gz -C /var/lib/aiops-hub . && find /var/backups -name 'aiops-*.tar.gz' -mtime +30 -delete
```

备份文件包含加密 vault，但仍建议目标目录权限 0700，异地备份时再套一层 GPG/age 加密。

### 4.2 Windows Agent 本地上下文

Agent 在 `%APPDATA%\AIOpsAgent\` 保存：

- `context.json`：当前活跃账号、最近 `command_id`、事务阶段、本地登录态文件摘要；
- `journal.json`：与服务器一致的事务日志；
- `snapshots/`：登录态快照（保留最近 5 份）；
- `applied-commands.log`：已执行 `command_id`，用于幂等。

### 4.3 同步与恢复机制

1. **序号同步**：Agent 每次心跳带 `last_seq`，服务器回放之后的命令与上下文。
2. **幂等**：命令以 `command_id` 为键；Agent 已执行过则直接 ack，不重复切换。
3. **断点恢复**：Agent 启动时检查 `journal.json`；若阶段为 backup/restored，先恢复本地备份再上线。
4. **服务器重启**：systemd `Restart=always`；服务启动调用 `Switcher.recover()` 处理未完成事务。
5. **凭据轮换**：切换后 Agent 重新采集登录态并上传，服务器覆盖 `vault.json` 中对应凭据。
6. **冲突处理**：同一平台多个 Agent 时，服务端用 `switch.lock` + Agent 租约（lease）保证同一时刻只有一个执行者。

---

## 5. 配置项、安全与注意事项

### 5.1 关键配置参数

| 配置路径 | 建议值 | 说明 |
|---|---|---|
| `server.host` | `127.0.0.1` | 永不直接绑 `0.0.0.0` |
| `server.port` | `8787` | 隧道/反代上游端口 |
| `server.admin_key` | 随机 32 字节 | 面板与 API 鉴权，定期轮换 |
| `server.enable_mock` | `false`（生产） | 应用级禁用 `/mock/*`，默认 true 仅供演示 |
| `agent.enabled` | `true` | 允许切换命令派发到在线 Agent |
| `agent.heartbeat_timeout_seconds` | `90` | 超过该时间未心跳视为离线 |
| `agent.command_ttl_seconds` | `300` | 命令租约，超时未 ack 自动重投 |
| `AIOPS_HOME` | `/var/lib/aiops-hub` | 数据根目录，0700 |
| `AIOPS_PASSWORD_FILE` | `/etc/aiops-hub/password` | 无人值守解锁凭据库，0600 |
| `schedule.checkin_time` | `09:00` | 签到时间 |
| `schedule.jitter_minutes` | `30` | 随机抖动，降低风控 |
| `schedule.points_poll_interval_hours` | `6` | 积分轮询 |
| `switch.strategy` | `round-robin` | 选号策略 |
| `switch.auto_switch_after_checkin` | `false`（按需要开） | 签到后自动切下一个号 |
| `switch.backup_keep` | `5` | 登录态备份保留数 |
| `limits.min_request_interval_ms` | `5000` | 平台请求最小间隔 |
| `limits.max_checkin_per_day` | `1` | 单账号每日签到上限 |
| `notify.channels` | `["log","webhook"]` | 告警通道 |
| `notify.webhook_url` | 飞书/企业微信机器人 | 异常告警 |
| `adapters.<platform>.checkin_url` | 真实接口 | 生产必须替换掉演示 `/mock/*` |
| `gateway.upstream_url` | 真实上游或自建代理 | 网关调用目标 |
| `gateway.keys[].ip_whitelist` | Windows 出口 IP | 密钥来源限制 |
| `agent.heartbeat_interval` | `30` 秒 | Agent 心跳 |

### 5.2 systemd 服务

```ini
# /etc/systemd/system/aiops-hub.service
[Unit]
Description=AIOpsHub Unified Account Operations Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aiops
Group=aiops
WorkingDirectory=/opt/aiops-hub
Environment=AIOPS_HOME=/var/lib/aiops-hub
Environment=AIOPS_PASSWORD_FILE=/etc/aiops-hub/password
ExecStart=/opt/aiops-hub/venv/bin/python /opt/aiops-hub/run.py serve --host 127.0.0.1 --port 8787
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aiops-hub
sudo systemctl status aiops-hub
journalctl -u aiops-hub -f
```

### 5.3 安全注意事项

- **绝不把 8787 直接暴露公网**；仅 SSH 隧道或 TLS 反代。
- 生产环境通过反代屏蔽 `/mock/*`，避免演示接口干扰真实签到。
- 管理密钥、Agent Token、网关 Key 分开管理，定期轮换；不同 Windows 机器使用不同 Agent Token。
- 凭据库明文只在内存；`master.key`/`vault.json` 权限 0600；备份同样视为敏感数据。
- 开启平台侧风控节流：抖动、请求间隔、每日上限，不要关闭。
- 多账号自动化可能违反目标平台服务条款，请自行评估；不提供批量注册/验证码绕过。
- 服务器开启自动安全更新与 NTP；日志保留不少于 30 天。

### 5.4 稳定性注意事项与常见问题

| 问题 | 原因 | 规避/处理 |
|---|---|---|
| 面板 401 | `admin_key` 不一致 | 核对 `data/config.json` 与页面右上角密钥 |
| 签到一直 skipped | 达到每日上限 / 接口未配置 | 检查 `max_checkin_per_day` 与 `adapters.*.checkin_url` |
| 切换失败并回滚 | 客户端运行中或凭据损坏 | 关闭客户端后重试；查看 `records.jsonl` 中 switch failed 详情 |
| Agent 不在线 | 出站 443 被拦 / Token 过期 | 检查代理/防火墙，重新注册 Token |
| 上下文丢失 | Agent 未上报 ack | 依赖 `journal.json` + `command_id` 幂等，重连后回放 |
| 任务不触发 | 服务器时间偏差 / `last_due` 已标记 | 校准 NTP；强制运行 `python run.py task run --type checkin` |
| 端口冲突 | 8787 被占用 | 修改 `server.port` 并同步隧道/反代 |
| 主口令丢失 | 无法解密 vault | 无法恢复，只能重建凭据库并重新纳管账号 |
| token 存于系统密钥链 | 文件级采集不到 | 由 Agent 通过客户端导出/授权流程写入凭据库 |

---

## 6. 执行清单（按顺序）

1. 服务器安装依赖、创建 `aiops` 用户与目录、初始化凭据库。
2. 编辑 `/var/lib/aiops-hub/config.json`：设置 `admin_key`、真实适配器接口、网关 Key、通知 Webhook。
3. 配置 systemd 服务并启动，确认 `journalctl -u aiops-hub` 无异常。
4. 配置 Caddy TLS（或直接使用 SSH 隧道），屏蔽 `/mock/*`。
5. Windows 建立 SSH 隧道或 HTTPS 访问，打开控制台，确认 `doctor` 全部关键项通过。
6. 纳管账号：服务端直采或 Windows Agent 加密上传登录态。
7. 验证：手动点击一次签到、一次切换、一次网关调用；查看看板与 `records.jsonl`。
8. 启用调度器常驻；配置每日备份与告警。
9. 若需切换 Windows 桌面客户端，在 Windows 上执行：
   ```powershell
   python agent/agent.py register --server https://hub.example.com --admin-key <管理员密钥> --machine-id WIN-01 --platform trae --credential-dir "$env:APPDATA\Trae\User"
   python agent/agent.py run --interval 5
   ```
   再用 NSSM 把第二条命令注册为服务；在面板「远程 Agent」页确认在线，点击账号「切换」验证命令回执与上下文 last_seq 增长。
10. 试运行 3 天，检查幂等、回滚、备份恢复与通知是否正常。

## 7. 验收标准

- Windows 端可通过隧道/HTTPS 访问服务器控制台，`doctor` 关键项全绿。
- 号池账号、分组、状态、积分在服务器与 Windows 端显示一致。
- 自动签到每日仅成功一次，重复触发返回 skipped。
- 自动切换可在服务端与 Windows Agent 两条路径完成，失败可回滚。
- 服务器重启、Windows 重启后，活跃账号与上下文可恢复，无重复切换。
- 管理 API 不暴露公网；`/mock/*` 不可访问；所有敏感文件权限正确。
- 每日备份可还原，且还原后凭据库仍可解锁。

---

## 8. 与现有 GitHub 项目的关系

- `Jlemonz2020/mam`：提供“本地加密凭据 + 事务切换 + CLI/systemd timer”范式，本方案把它的服务端形态提升为长期运行控制面。
- `smart-open/TraeWorkAssistant` / `ithtelab/workbuddy-manager`：提供多平台适配器、网关与账号池的产品级参考。
- `jlcodes99/cockpit-tools`：提供多客户端切换与多实例隔离思路，可补充 Agent 的 Windows 侧能力。
- 本仓库 `aiops-hub`：已实现统一账号池、Vault、调度、网关、Web 控制台与 API，可直接作为服务器控制面部署。

## 9. 实现假设与补全说明

1. `/agent/register` 需要管理员密钥：文档要求 Agent Token 与管理密钥分离，但未说明注册鉴权；采用一次性管理员密钥注册可防止任意主机入池。
2. Token 存储：服务端仅保存 `SHA-256(agent_token)`，明文 Token 只在注册响应与 Windows 本地 `config.json` 中出现。
3. 凭据传输：不引入 PKI，使用高熵 Agent Token 派生 AES-GCM 密钥封装凭据，满足“独立 Token + 加密下发”要求；后续可平滑替换为公钥加密。
4. Agent 通信：采用出站长轮询，默认 5 秒；无需 Windows 入站端口。命令租约默认 300 秒，超时自动重投。
5. 演示接口：`server.enable_mock` 默认 `true` 保证本地演示可用；生产设为 `false` 后应用自身也返回 404，可与 Caddy 规则双保险。
6. 上下文恢复：Agent 端 `journal.json` + `snapshots/` + `applied-commands.log`，服务端 `contexts/<id>.json` + `agents.json` 提供双向恢复依据。

> 合规提示：多账号切换、自动签到与 API 代理可能违反目标平台服务条款，请自行评估风险；本方案不提供批量注册、验证码识别或身份伪造能力。
