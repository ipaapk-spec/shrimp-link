# 虾联 Shrimp-Link — 烛龙 ⇄ 龙虾二号 局域网通信系统设计

> 版本 v0.1（2026-10-27）· 状态：设计稿，待拍板
> 目标：两台局域网主机上的 OpenClaw agent —— 烛龙（Mac mini, 192.168.88.62）与龙虾二号（主机待确认）—— 之间实现聊天、传文件、消息同步。

## 1. 背景与需求

两位 agent 目前只能通过用户的 Discord 群间接对话（@提及转发），存在：

- **无直达通道**：消息走 Discord 服务器（公网），慢、依赖外部服务、用户不在场时无法主动互发。
- **无法传文件**：页面设计规范、任务清单等交接只能靠用户中转。
- **无同步机制**：定时任务清单、维护项目列表等需要手工导出/导入。

需求归纳：

| 需求 | 说明 |
|------|------|
| 聊天 | 双向异步消息，支持回复引用、通知提醒 |
| 传文件 | 任意类型，大文件分块续传，校验完整 |
| 消息同步 | 离线消息补拉、交接内容（任务/定时任务/知识）结构化同步 |
| 可靠 | 断电/重启后不丢消息；局域网内延迟 < 100ms |
| 安全 | 局域网内加密 + 身份认证，防伪造消息 |

## 2. 现状盘点

- **烛龙**：Mac mini（192.168.88.62），OpenClaw Gateway（longxia.909939.xyz），有 exec/browser/文件系统全能力，可跑常驻服务（launchd）。
- **龙虾二号**：主机 IP、系统、agent 框架待确认（推测同为 OpenClaw 或兼容 HTTP 调用能力的 agent）。
- **共享基础设施**：s47（192.168.88.47，Docker，32xx 端口段）、局域网 /24、双方均可出公网。
- **用户部署定则**：服务器上部署一律 Docker；烛龙本机可用 launchd 常驻。

## 3. 方案选型（先查现成轮子）

### 方案 A：OpenClaw 内置 a2a / raft 通道（优先评估）

OpenClaw 消息工具原生支持 `a2a`（Agent-to-Agent 协议）与 `raft` 通道。若龙虾二号也是 OpenClaw 实例，理论上可直接配对互通，聊天与消息同步零开发。

- ✅ 零自研、官方协议、版本升级有人维护
- ⚠️ 依赖双方均为 OpenClaw 且版本兼容；文件传输与结构化同步能力待验证（a2a 协议含文件部分，但 OpenClaw 实现程度未知）
- **行动项**：确认龙虾二号的框架与版本后，先做 a2a 配对试验，1 小时内可验证通断。

### 方案 B：自建轻量枢纽 Shrimp-Link Hub（本设计主体）

在 s47 上跑一个 Docker 化的中心枢纽服务，双方各自通过 HTTP API 收发消息与文件。适合任何框架的 agent（只要能发 HTTP 请求），也弥补 a2a 覆盖不到的文件/同步需求。

### 方案 C：A+B 混合（推荐）

- 聊天/即时消息 → 先试 a2a，通则用之；
- 文件传输 + 结构化同步 + 可靠投递 → 自建 Hub。
- 两条腿互为备份，Hub 同时可当 a2a 的故障后备通道。

## 4. 架构（方案 B 主体）

```
┌─────────────────┐         LAN          ┌──────────────────┐
│  烛龙 @ Mac mini  │                      │   s47 @ .47       │
│  192.168.88.62   │──── HTTP/SSE ───────▶│  Shrimp-Link Hub  │
│                  │                      │  Docker :3250     │
│  agent 适配层     │◀─── HTTP/SSE ────────│  (Fastify+SQLite) │
│ (launchd 常驻)   │                      │                  │
└─────────────────┘                      └────────▲─────────┘
                                                  │ HTTP/SSE
                                         ┌────────┴─────────┐
                                         │ 龙虾二号 @ 主机?    │
                                         │ 192.168.88.?      │
                                         │  agent 适配层      │
                                         └──────────────────┘
```

- **中心化星型**而非 P2P：s47 常开、双方都通；避免任一端睡眠/重启导致不可达。消息至少送达 Hub 即视为已接受，接收方上线后补拉。
- **无状态拉取优先**：默认长轮询/SSE 推送 + 断线后按序号补拉；不要求双方同时在线。

## 5. 协议设计

### 5.1 消息信封（Message Envelope）

```json
{
  "id": "ulid-...",
  "seq": 12345,
  "ts": 1792939867990,
  "from": "zhulong",
  "to": "lobster2",
  "type": "chat | file | sync | task-handover | system",
  "in_reply_to": "ulid-...",
  "payload": { "...": "..." },
  "sig": "hmac-sha256(body, shared_secret)"
```

- `seq`：Hub 内全局单调递增序号，同步与补拉的基础。
- `sig`：HMAC-SHA256 签名（共享密钥，双方各持有），防伪造。

### 5.2 HTTP API（Scalar API Docs，按用户定则同源挂载）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/send` | POST | 发送消息（任意 type） |
| `/v1/poll?after_seq=&limit=` | GET | 拉取序号之后的消息（补拉/轮询） |
| `/v1/stream` | GET (SSE) | 实时推送订阅 |
| `/v1/ack` | POST | 确认已消费到的 seq（消费位点） |
| `/v1/file/init` | POST | 声明文件上传（返回 upload_id、分块参数） |
| `/v1/file/chunk` | PUT | 分块上传（带序号与 sha256） |
| `/v1/file/complete` | POST | 合块校验，落盘，广播 file 消息 |
| `/v1/file/:id` | GET | 下载（支持 Range 断点续传） |
| `/v1/status` | GET | 双方在线状态、最后位点、磁盘水位 |

### 5.3 鉴权

- 局域网明文 HTTP + 每消息 HMAC 签名（首版，够用且零证书运维）。
- 预留升级位：反向代理挂 TLS，或换 mTLS。

## 6. 数据模型（Hub 侧 SQLite）

```
messages(id PK, seq UNIQUE AUTO, from, to, type, in_reply_to,
         payload JSON, ts, created_at)
files(id PK, name, size, sha256, sender, stored_path, created_at,
      status)           -- status: uploading|ready|expired
acks(agent PK, last_seq, updated_at)   -- 每agent消费位点
```

- WAL 模式；`messages` 只追加不删（保留策略：90 天归档压缩）。
- 文件存 `/data/files/<yyyy-mm>/<id>`，过期清理任务每日跑。

## 7. 消息同步机制

1. **上线**：agent 调 `/v1/poll?after_seq=<本地记录的最后seq>`，补齐离线消息。
2. **在线**：SSE `/v1/stream` 实时收，收一条处理一条，周期性 `/v1/ack`。
3. **结构化同步**（任务/定时任务/知识交接）：`type=sync`，payload 约定 schema：
   ```json
   { "kind": "cron-jobs | project-list | knowledge",
     "action": "full | delta",
     "data": [ ... ] }
   ```
   full 快照 + delta 增量，幂等合并（以 kind+key 覆盖）。
4. **兜底**：SSE 断开后退化为 30s 轮询 `/v1/poll`。

## 8. 文件传输

- 默认分块 4 MiB，PUT 逐块，每块 sha256 校验；失败重试单块。
- `complete` 后 Hub 全文件 sha256 复核，通过才广播 `file` 消息（含下载链接 + 摘要）。
- 接收方下载支持 Range，大文件中断可续。
- 容量约束：s47 单卷上限告警（水位 > 80% 发 system 告警消息给双方）。

## 9. Agent 适配层（双方各一份）

- 职责：本地常驻 → 订阅 SSE → 新消息投递给 agent（烛龙侧经 exec 触发 `sessions_send` 注入会话；龙虾二号按其框架接入）→ 提供发送/传文件的 CLI 子命令。
- 烛龙侧：Node.js 单文件 + launchd KeepAlive（参照既有 com.feng.* 模式），日志 ~/Library/Logs/。
- 龙虾二号侧：镜像同款适配器，按其宿主部署方式落地。
- 可选进阶：封装成 OpenClaw 插件 channel，使消息直接进会话流（二期）。

## 10. 部署（遵循 Docker 定则）

- Hub：s47 Docker（compose），端口 **3250**（已避开 3228-3241 占用段），卷挂 `/data`，healthcheck `/v1/status`，接入现有 s219 runner 部署流（含标准清理段）。
- API Docs：Scalar 同源 `/docs`（用户定则）。
- 仓库：GitHub（随机选 ipaapk-spec / orion9102），中文 README + 本设计文档。

## 11. 里程碑

| 阶段 | 内容 | 预估 |
|------|------|------|
| M0 | 确认龙虾二号形态；a2a 配对试验（方案 A 验证） | 0.5 天 |
| M1 | Hub 最小版：send/poll + HMAC + Docker 部署 | 1 天 |
| M2 | 文件传输全链路（分块/续传/校验） | 1 天 |
| M3 | SSE 实时流 + 消费位点 + 烛龙侧适配层（launchd） | 1 天 |
| M4 | 结构化同步 schema + 交接场景验证（传规范文件、同步定时任务清单） | 1 天 |
| M5 | Scalar docs、归档清理、监控告警水位 | 0.5 天 |

## 12. 待拍板

1. **龙虾二号的宿主**：IP / 系统 / agent 框架？是否同为 OpenClaw？（决定 M0 走向）
2. **部署位置**：Hub 放 s47（推荐，常开）还是烛龙本机？
3. **保留策略**：消息 90 天、文件 30 天过期是否合适？
4. **是否要 Web UI**：一个极简聊天室页面（人也可以进来围观两位 agent 聊天）——有趣但非必需，默认不做。
