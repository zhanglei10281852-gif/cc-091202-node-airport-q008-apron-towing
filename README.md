# 机坪夜间拖行许可引擎

面向机坪管制席“夜间集中拖机”场景的 Node.js 拖行许可（tow permit）引擎。它把白板上无法提前发现的
**窄口相会**问题建模为带时间维度的资源预留问题：有向路段、物理通道、交叉区都是需要在时间轴上独占或
保持安全间隔的资源；引擎在审批时即找出可执行路线并预留沿途时空资源。

- 纯 Node.js，无第三方依赖（`node:http` + `node:test`），Node ≥ 20。
- 所有状态变更事件溯源落盘（JSONL），日历/封闭/在途位置全部由事件流派生，重启重放一致。
- 单写者串行锁：两席并发审批不可能“各自看到空闲而同时放行”。

## 领域模型

资料位于 `fixtures/airport-network.json`：

| 概念 | 表示 | 约束 |
| --- | --- | --- |
| 有向路段 edge | `{id, from, to, seconds, aircraftTypes?, zone?, channel?, maxWingspan?}` | 同一时间窗独占；仅允许列出的机型；翼展不得超过 `maxWingspan` |
| 物理通道 channel | 共线/反向 edge 共享同一 `channel`（如 `J2->J4` 与 `J4->J2` 共用 `TW-A`） | 时间窗互斥，防止窄口内会车 |
| 交叉区 zone | 进入某边即进入其 `zone` | 任意两次进入时刻之差 ≥ 安全间隔（取双方要求的最大值，默认 60s） |
| 安全停靠点 | `holdingPoints[].safeHold`，起节点始终可停 | **只允许在起节点/安全停靠点等待让行**；进入路段后必须连续通过 |
| 交接节点 | `handoffNodes` 或无出边终点 | 只允许在这些节点“首尾相接”换组 |

申请（见 `fixtures/requests.json`）包含：航空器（含机型/翼展等级）、牵引组（人员 id 列表）、
牵引车、起终点、期望窗口、交叉区安全间隔、各段预计耗时 `legSeconds`、激活宽限。

人员资质与车辆台账见 `fixtures/credentials.json`：角色（驾驶员/机务）、翼展签注、证件有效期、
排班、车辆检定与适航状态。

## 许可生命周期与关键规则

```
REQUEST_SUBMITTED ─approve→ ISSUED ─activate→ ACTIVE ─position/handoff/reroute→ COMPLETED
                              │  │             │
                              │  └─credentials  └─cancel（须在安全停靠点）
                              ├─ 超过 activateBy 未激活 → EXPIRED（自动释放预留，幂等）
                              └─cancel → CANCELLED
```

- **审批即排程**：枚举结构可行路径并做前向时空推演；冲突时把等待“回溯”到之前最近的安全停靠点
  错峰发车；窗口内无法避让则拒绝，返回按约束聚合的“无路可走”解释（哪条边、与哪个许可、波及多少路径）。
- **激活时才校验资质/车辆**：证件过期、非当班、翼展签注不符、车辆故障/检定过期均拒绝激活
  （`credentials_invalid_at_departure`），许可保留待管制处理；超过 `activateGraceSeconds` 未激活自动释放。
- **封闭路段**：`POST /admin/closures` 立即返回受影响的未执行许可；对在途许可给出
  安全停靠点与改道候选；若飞机已进入该边则提示“继续驶离”，不得就地改道。
- **改道必须留痕**：只能在安全停靠点执行；原路线、被替换航段、理由、指令人全部进入修订链
  （`PERMIT_REROUTED`），不存在“无记录改写原路线”。
- **人工放行**：窗口不足但管制员现场裁决时，必须逐条签收冲突键并写明理由，全部计入许可审计。
- **幂等**：写接口可带 `commandId`（或 `X-Command-Id` 头）；取消/完成/过期/重复激活重复调用安全。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/requests` | 提交申请，返回只读预规划 |
| GET | `/requests/:id/explain` | 解释为何有路/无路（约束聚合 + 每条路径推演） |
| POST | `/requests/:id/approve` | 审批发放许可，body 可带 `manual:{reason,acknowledge[]}` 人工放行 |
| POST | `/permits/:id/activate` | 出发时激活并校验资质车辆 |
| POST | `/permits/:id/position` | 回报实际位置（node 或 edgeId + phase，必须在执行路线上） |
| POST | `/permits/:id/handoff` | 交接点换组（fromTeam/toTeam/reason） |
| POST | `/permits/:id/reroute` | 安全停靠点改道（reason/node），原路线留痕 |
| POST | `/permits/:id/cancel` | 取消（在途须带安全点 node） |
| POST | `/permits/:id/complete` | 完成（回报位置须已在终点） |
| GET | `/permits/:id` | 时间线回放：计划/实际路线、等待、位置、交接、修订、人工放行 |
| GET | `/permits` | 许可列表 |
| GET | `/calendar?from&to` | 资源日历（edge/channel/zone 占用） |
| GET | `/network` | 路网、机型限制与当前封闭 |
| POST/DELETE | `/admin/closures` | 封闭/解封路段（封闭返回影响面） |
| POST | `/admin/sweep-expired` | 手动触发过期扫描（服务也每 15 秒自动扫描） |

错误响应统一为 `{error, details}`，典型状态码：422 无路可走/不可改道，412 资质失效/未在安全点，
409 状态冲突，404 资源不存在。

### 快速上手

```bash
npm test          # 25 项 node:test 用例
npm run demo      # 夜间拖机全流程脚本演示（并发审批/改道/交接/过期/重启）
npm start         # HTTP 服务 :3000，事件日志默认 data/events.jsonl
EVENT_LOG=/var/lib/towing/events.jsonl PORT=8080 npm start
docker compose up --build
```

`npm run demo` 的 15 个章节逐项演示了需求中的每条能力，其中第 11 节在日历非空、封闭仍在、
有许可在途的时刻重建引擎实例并逐字节比对日历与时间线。

## 事件与重启

事件按序追加到 JSONL：`REQUEST_SUBMITTED`、`PERMIT_ISSUED/ACTIVATED/CANCELLED/COMPLETED/EXPIRED`、
`POSITION_REPORTED`、`PERMIT_HANDED_OFF`、`PERMIT_REROUTED`、`MANUAL_RELEASE`、
`EDGE_CLOSED/EDGE_REOPENED`。重启时 `engine.load()` 重放事件流，重建：

- 资源日历（许可终态时其预留被释放）；
- 路段封闭状态；
- 每个许可的状态、修订后的执行路线、位置回报序列、交接记录、人工放行记录。

生产部署应把 `EVENT_LOG` 放在持久化卷（compose 已挂 `/app/data`）。

## 代码结构

```
src/domain/time.js        时间/可推进时钟
src/domain/network.js     有向图、机型与翼展限制、封闭、停靠/交接节点
src/domain/scheduler.js   时空资源日历（edge/channel 独占，zone 安全间隔）
src/domain/planner.js     路径枚举 + 前向时空推演 + 安全停靠点回溯等待 + 无路解释
src/domain/credentials.js 人员资质/车辆状态台账（出发时刻校验）
src/domain/engine.js      许可状态机、并发串行锁、幂等、封闭影响、改道、回放
src/domain/store.js       JSONL 事件存储 / 内存存储
src/api.js                HTTP 适配层
src/index.js              装配（加载 fixtures）
scripts/demo.mjs          端到端演示
```

模型为示意路网，接入生产时需替换为真实机场资料、把人员台账对接资质系统，并按现场运行手册调整
安全间隔、翼展等级与停靠点容量。
