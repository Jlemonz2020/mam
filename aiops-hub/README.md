# AIOpsHub · 统一 AI 账号与额度运营中枢

把 MAM、TraeWorkAssistant、workbuddy-manager、cockpit-tools、ai-token-checkin-workers、AntigravityManager 的能力“缝合”为**一个可运行项目**：统一账号池、加密凭据库、事务化登录态切换、统一调度、签到/积分/额度追踪、网关与密钥、统一 Web 控制台与 CLI。

- 运行条件：Python 3.10+（已验证 3.12），依赖 `cryptography`。
- 默认本地运行，不访问真实 AI 平台；演示接口全部内置在 `/mock/*`。
- 数据默认写入项目下 `data/`，可用 `AIOPS_HOME` 或 `--home` 覆盖。

## 1. 目录结构

```text
aiops-hub/
├── run.py                       # CLI 入口
├── requirements.txt             # 唯一外部依赖
├── config/
│   ├── default_config.json      # 调度/节流/网关/通知默认配置
│   └── adapters.json            # 多平台适配器定义（可覆盖）
├── src/aiopshub/
│   ├── util.py                  # 原子写、校验和、跨平台文件锁
│   ├── storage.py               # 带 checksum/.bak 回退的状态存储 + JSONL 流水
│   ├── models.py                # 统一账号与任务模型
│   ├── config.py                # 配置加载与合并
│   ├── vault.py                 # AES-256-GCM 凭据库 + scrypt 主口令
│   ├── accounts.py              # 账号池、分组、健康度、选号策略
│   ├── adapters.py              # 统一适配器：采集/写回/签到/积分
│   ├── switcher.py              # 事务日志、备份、切换、崩溃恢复、回滚
│   ├── scheduler.py             # 统一调度中枢（每日/间隔/抖动/幂等）
│   ├── notify.py                # 统一通知中心（日志/Webhook）
│   ├── observer.py              # 看板、报表、用量、健康视图
│   ├── service.py               # Hub 门面：模块协同编排
│   ├── server.py                # 本地 HTTP 服务、管理 API、网关、Mock
│   └── cli.py                   # 命令行接口
├── web/                         # 统一 Web 控制台（原生 HTML/CSS/JS）
├── tests/test_core.py           # 单元测试
├── scripts/demo.py              # 一键端到端演示
└── data/ / demo-data/           # 运行时数据（gitignore）
```

## 2. 安装与快速开始

```powershell
cd aiops-hub
python -m pip install -r requirements.txt

# 初始化主口令（至少 6 位）
python run.py --home ./data init --password demo-pass-123

# 添加账号（自动采集当前适配器目录的登录态文件）
python run.py --home ./data add --name "Trae 工作号" --platform trae --groups 工作
python run.py --home ./data add --name "CodeBuddy 测试号" --platform codebuddy --groups 测试
python run.py --home ./data list

# 启动统一控制台 + 调度器（终端 A）
python run.py --home ./data serve

# 终端 B 中执行签到/切换/积分/报表
python run.py --home ./data checkin --all
python run.py --home ./data switch 2
python run.py --home ./data points 1
python run.py --home ./data report --month 2026-11
python run.py --home ./data doctor
```

打开 <http://127.0.0.1:8787>，管理密钥默认为 `change-me-local-admin-key`（可在 `data/config.json` 修改）。

> 签名接口默认指向本地 Mock；因此 `serve` 需先启动，签到/积分才能自动完成。未启动 Mock 时适配器返回 `skipped/error`，不会访问外网。

## 3. 一键验证

```powershell
# 端到端演示：初始化 → 建目录 → 加账号 → 签到 → 切换 → 网关调用 → 看板 → HTTP 校验
python scripts/demo.py

# 单元测试：加密、存储回退、账号池、幂等签到、切换回滚、网关鉴权、调度判定
python -m unittest discover -s tests -v
```

已验证：15 项单元测试全部通过；`demo.py` 完成“初始化 → 纳管 → 签到 → 切换 → 网关 → 看板 → HTTP 校验”全链路；`remote_demo.py` 完成“服务器 CLI → HTTP 派发 → Windows Agent CLI → 命令回执/上下文校验”跨进程链路，均退出码 0。

演示脚本会在 `demo-data/` 生成数据，并启动临时服务（端口来自配置，默认 8787），结束后自动关闭。

## 4. 主要功能模块与协同

| 模块 | 文件 | 职责 |
|---|---|---|
| 账号与身份中心 | `accounts.py` | 唯一账号主数据：分组、状态、健康度、选号策略、活跃指针 |
| 凭据与设备身份 | `vault.py` | AES-256-GCM 加密凭据，scrypt 派生主密钥，机器绑定托管，令牌轮换写回 |
| 切换运行时 | `switcher.py` | 备份 → 写回 → 校验 → 提交 → 清理；失败/崩溃按事务日志回滚 |
| 统一调度 | `scheduler.py` | 签到、保活、唤醒、积分巡检、健康探测；抖动、节流、每日上限、幂等 |
| 适配器层 | `adapters.py` | Trae/CodeBuddy/WorkBuddy/Qoder 登录态采集与自动签到/积分接口 |
| 可观测中心 | `observer.py` | 总览看板、签到报表、网关用量、账号健康、事件流水 |
| 网关与密钥 | `service.py` + `server.py` | Key 鉴权、白名单、选号路由、流式上游、用量审计 |
| 通知中心 | `notify.py` | 所有事件统一落流水，可选 Webhook |
| 交互入口 | `cli.py` + `web/` | CLI 与 Web 控制台共用同一 Hub 门面，状态与术语一致 |

协同链路：

```text
账号接入 → 账号池 → 凭据库 → 调度中心 → 切换运行时 → 客户端/网关
        → 签到/积分/用量采集 → 可观测中心 → 告警与健康度反馈 → 选号策略
```

## 5. 关键处理逻辑

- **可靠写入**：`*.tmp → fsync → .bak → rename`，外层带 SHA-256 checksum；校验失败自动回退 `.bak`，损坏文件隔离为 `.corrupt-*`。
- **事务切换**：`switch.journal.json` 记录 `backup → restored → committed`；失败删除半成品并移回备份；启动时若发现未提交事务自动恢复。
- **幂等签到**：按“账号 + 日期 + 成功次数”判断是否超过 `limits.max_checkin_per_day`；重复触发返回 `skipped`，不重复加分。
- **节流**：全局 `min_request_interval_ms`、每日上限、失败退避、签到随机抖动，降低风控风险。
- **凭据安全**：主口令由 `AIOPS_PASSWORD` / `AIOPS_PASSWORD_FILE` / 机器绑定 `master.key` 提供；明文不写日志与报表。
- **模块隔离**：所有模块通过 `Hub` 门面协作，禁止互相读写内部文件；新增平台只需在 `config/adapters.json` 增加定义。

## 6. 扩展方式

1. **新增平台**：在 `config/adapters.json` 增加平台定义（目录、token 文件、签到/积分接口），账号池、调度、看板、网关自动纳入。
2. **新增任务类型**：在 `models.TASK_TYPES` 注册，并在 `Scheduler._run_task` 增加分支。
3. **新增通知渠道**：在 `NotifyCenter.emit` 中扩展 channel。
4. **替换 Mock 为真实接口**：修改 `config/adapters.json` 与 `gateway.upstream_url`，并配置鉴权头。

## 7. 约束与边界

- 本地优先，Web 面板默认只监听 `127.0.0.1`；远程访问需自行加 TLS 与鉴权。
- 不提供批量注册、验证码破解、身份伪造等能力；多账号自动化可能违反目标平台条款，请自行评估。
- 本项目是“融合目标态”的可运行参考实现：桌面壳（Electron/Tauri）、OS 密钥链、真实平台协议可在此契约上继续扩展。

## 8. 运行时数据

```text
data/
├── config.json            # 合并后的配置
├── accounts.json(.bak)    # 账号池状态（checksum）
├── vault.json             # 加密凭据库
├── master.key             # 机器绑定的主口令托管
├── tasks.json             # 统一任务定义
├── records.jsonl(.bak)    # 签到/快照/任务/网关/事件流水
├── switch.journal.json    # 切换事务日志（仅切换中存在）
├── instance.lock / switch.lock
├── backups/               # 登录态备份（保留最近 N 份）
├── contexts/              # 各 Agent 上下文（last_seq / active / phase）
├── agents.json            # Agent 注册信息与命令队列
└── fake-clients/          # 演示用客户端登录态目录
```

## 9. 远程接入能力（按《服务器部署与Windows远程接入方案》实现）

### 9.1 新增文件与接口

- 服务端注册中心：`src/aiopshub/agents.py`（注册、Token 哈希认证、心跳、命令队列、租约、上下文）。
- Windows Agent：`agent/agent.py`（出站轮询、本地事务切换、凭据轮换、断点恢复、幂等）。
- Web 控制台新增「远程 Agent」页：查看在线状态、上下文序号与命令队列。
- 新增配置：
  - `server.enable_mock`：生产设 `false`，应用级禁用 `/mock/*`；
  - `agent.enabled`、`agent.heartbeat_timeout_seconds`、`agent.command_ttl_seconds`。

服务端接口（与部署文档一致）：

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/agent/register` | POST | `X-Admin-Key` | 注册机器，返回 `agent_id` + `agent_token` |
| `/agent/heartbeat` | POST | `X-Agent-Token` | 心跳与上下文上报 |
| `/agent/commands/poll?agent_id=&since=` | GET | `X-Agent-Token` | 拉取待执行切换命令 |
| `/agent/commands/ack` | POST | `X-Agent-Token` | 回传执行结果与上下文 |
| `/agent/context` | GET/POST | `X-Agent-Token` | 读取/覆盖上下文 |
| `/agent/credentials?agent_id=&credential_id=` | GET | `X-Agent-Token` | 获取 Agent Token 封装的凭据 |
| `/agent/credentials/upload` | POST | `X-Agent-Token` | 回传轮换后的凭据 |
| `/api/agents` | GET | `X-Admin-Key` | Agent 与命令队列总览 |

### 9.2 Windows Agent 使用

```powershell
# 注册（管理员密钥仅注册时使用）
python agent/agent.py register `
  --server http://127.0.0.1:8787 `
  --admin-key change-me-local-admin-key `
  --machine-id WIN-PC-01 --platform trae `
  --credential-dir "$env:APPDATA\Trae\User"

# 前台运行（单次/常驻）
python agent/agent.py run --once
python agent/agent.py run --interval 5

# 查看本地状态
python agent/agent.py status
```

注册信息保存在 `%APPDATA%\AIOpsAgent\config.json`，上下文/事务日志/快照/幂等记录也在该目录。Agent 只发起出站 HTTPS/HTTP 请求，无需在 Windows 开放入站端口。

### 9.3 协同行为

- 面板点击「切换」默认 `prefer_agent=true`：若目标平台有在线 Agent，则下发命令，否则服务端本地执行。
- 调度器签到后的自动切换同样优先派发在线 Agent。
- 命令以 `command_id` 幂等；租约超时自动重新投递；Agent 端 `applied-commands.log` 防止重复执行。
- 凭据通过 AES-GCM（密钥为 `SHA-256(agent_token)`）封装下发，Agent 仅能解包自己被授权的凭据。
- 切换后 Agent 重新采集登录态并上传，服务器覆盖 vault 中对应凭据，实现 token 轮换闭环。

### 9.4 远程链路验证

```powershell
python scripts/remote_demo.py
```

该脚本启动真实服务器进程、用 Agent CLI 注册、经 HTTP 下发切换命令、Agent 执行本地事务切换，并断言命令状态为 `done`、上下文 `last_seq` 与 `active[platform]` 正确。

### 9.5 合理假设（文档未明确处）

1. `/agent/register` 需要管理员密钥，避免任意主机注册；Token 仅在注册响应中返回一次。
2. 服务端只保存 Token 的 SHA-256 哈希，Agent 本地保存明文 Token（文件权限建议 0600）。
3. 凭据传输不引入 PKI，使用高熵 Agent Token 派生 AES-GCM 密钥，满足文档“独立 Token、加密下发”的要求。
4. Agent 采用出站长轮询；若后续部署在内网，只需允许访问服务器 443/隧道端口。
5. `server.enable_mock` 默认 `true` 以保持演示可用；生产按文档设为 `false`，并可叠加 Caddy 屏蔽 `/mock/*`。
