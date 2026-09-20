# 机坪夜间集中拖行 · 拖行许可引擎

面向夜间集中拖机场景的 Node.js 许可引擎。管制席面对的牵引车、机务人员、封闭滑行通道、
交叉口占用被统一建模为**时空资源**：引擎在有向路段网络上为每份拖行申请寻找可执行路线、
预留沿途资源，并在同一临界区内完成审批，从机制上杜绝“两席各自看到空闲而同时放行”。

- 纯 Node.js（≥20），零第三方依赖；事件溯源 JSONL 落盘，重启即恢复
- `npm test` 运行 22 项单元/集成测试；`npm run demo` 跑通完整夜间场景；`npm start` 起 HTTP 服务

## 1. 道路资料模型（`fixtures/airport.json`）

- **节点 nodes**：`stand`（机位）、`bay`（等待坪/安全停靠点，可声明 `capacity`）、`junction`（交叉口）。
  只有机位/等待坪允许停车让行；交叉口内禁止等待。
- **有向路段 edges**：`from`/`to`/`seconds`（标准通过秒数），可被申请的 `segmentSeconds` 按机型/实测覆盖；
  `aircraftTypes` 为机型白名单（缺省不限），`widthClass: narrow` 标注窄口。
- **交叉区 zones / 边的 `conflictZone`**：多条边可共享同一交叉区（如 J4 三路汇入）。
  交叉区按**占用区间 + 安全间隔**预留：另一许可的占用与本区间任一端间隔不足
  `separationSeconds` 即冲突；同一许可连续共享同一交叉区的相邻边自动合并为一个区间。
- 路段占用区间互斥，**首尾相接允许交接**（前者退出时刻 = 后者进入时刻不冲突）。

## 2. 拖行申请样例（`fixtures/requests.json`）

每份申请包含：航空器（机型/注册号）、牵引组（机务人员资质及有效期、牵引车状态有效期、
必需岗位）、起终点、期望窗口（`desiredStart`/`latestStart`）、各段预计耗时
`segmentSeconds`、交叉区安全间隔、激活超时。样例含四条：

| 申请 | 机型 | 场景 |
|---|---|---|
| tow-88 | A320 | S12→H21，主通道过 J4 |
| tow-91 | A320 | N8→H21，与 tow-88 在 J4 构成窄口相遇，被自动错峰 |
| tow-93 | B777 | S11→H22，机型不可走窄口，自动绕行 W1/J5 |
| tow-94 | A320 | 资质与车辆状态在出发前失效：可批准但激活必被拒 |

## 3. 规划与预留规则

1. 枚举起终点间所有有向路径，按机型白名单静态过滤并记录拒绝边（用于“为何无路”解释）。
2. 路径以可等待点切成**刚性区块**：交叉口/窄口一旦进入必须连续驶出，让行等待只能发生在
   区块入口的机位/等待坪（等待本身占容量）。
3. 逐区块做时空槽位调度：路段互斥、交叉区安全间隔、封闭区间相交、终点机位容量，
   冲突时整体顺延到资源释放点；超过 `latestStart` 判该路径不可行并保留 blocker。
4. 审批通过即在资源日历上**预留**沿途全部区间；方案按到达时刻排序，可指定 `planIndex`。

## 4. 许可生命周期

`registered → approved → active → completed | cancelled | expired`

- **激活复验**：批准只给资质预警；激活时硬性复验人员资质与车辆状态此刻仍有效，
  失效返回 `412 eligibility_failed` 且释放拒绝原因，许可保留待人工处理。
- **超时自动释放**：批准后激活倒计时锚定计划出发时刻 + `activationTimeoutSeconds`，
  后台扫描将未激活许可置 expired 并释放全部预留；也可显式 `POST /expire` 驱动。
- **幂等**：取消、完成、过期释放、重复激活、重复登记均幂等；审批支持 `idempotencyKey`，
  同一申请已有有效许可时再批返回已有许可。
- 所有状态变化先进入引擎内互斥临界区，再追加事件日志——审批的“查空闲+预留”不可分割。

## 5. 封闭、改道与审计

- `POST /edges/:id/close` 立即返回影响：未执行许可（含改期/改道可行性）与在途许可
  （安全停靠点、ETA、改道候选；若已在封闭点之前的不可停车路段则标 `critical`，
  指令现场引导驶离，禁止交叉口停车）。
- 未执行许可 `reroute`、在途许可在安全点报到后 `divert`（尾段改道），都**必须填写原因**；
  原计划进入 amendment 链永久保留，不存在无记录改写。
- `GET /permits/:id/replay` 回放时间线：计划途经、计划等待、实际位置上报、
  人工放行（`manual` + `notes`，签字留痕）、改道理由、终态事件。

## 6. 重启一致性

所有命令都是不可变事件（JSONL，每条含 `seq/type/time/actor`）。启动时全量重放重建
资源日历（路段/交叉区/机位占用、封闭状态）与在途位置；崩溃残留的半行在加载时丢弃并计数
（`snapshot.droppedTail`）。生产部署应把 `LOG_PATH` 指向持久卷。

## 7. HTTP 接口

| 方法 路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /airport` | 道路资料（节点/边/交叉区/机型限制） |
| `POST /requests` | 登记申请（幂等） |
| `GET /requests/:id` | 申请状态 |
| `POST /requests/:id/explain` | 仅规划：可行方案 + 逐路径不可行解释 |
| `POST /requests/:id/approve` | 审批预留；body 可带 `planIndex`、`manual:{reason}`（人工放行）、`idempotencyKey` |
| `POST /permits/:id/activate` | 激活（资质/车辆状态此刻复验） |
| `POST /permits/:id/progress` | 在途位置 `{kind:"node",nodeId,state}` 或 `{kind:"edge",edgeId}` |
| `POST /permits/:id/complete` · `/cancel` | 完成 / 取消（幂等） |
| `POST /permits/:id/reroute` · `/divert` | 未执行改期改道 / 在途安全点尾段改道（必须 `reason`） |
| `POST /permits/:id/notes` | 人工放行理由等管制记录 |
| `GET /permits/:id/replay` | 完整时间线回放 |
| `POST /edges/:id/close` · `/reopen` | 封闭（可带 `until`）/解封，返回影响清单 |
| `GET /closures/impact?edgeId=` | 封闭影响预览（不产生事件） |
| `GET /snapshot` | 全部许可 + 资源日历 + 封闭 + 重放事件数 |

席位身份取 `X-Controller-Id` 头或 body 中 `actor`（头必须是 ASCII）。

### 快速试跑

```bash
npm start                       # 默认 :3000，事件日志 data/events.jsonl
curl localhost:3000/airport | head
# 审批无解时（如窗口过紧）返回 409 no_route，details.explanation 给出
# 每条候选路径的 blocker（占用许可、封闭区间、机型拒绝边、超窗时刻）
npm run demo                    # 纯内存全流程演示
```

## 8. 代码结构

```
src/model/
  airport.js     有向路网/机型白名单/交叉区声明/路径枚举
  calendar.js    资源日历：路段区间、交叉区区间+间隔、机位容量、封闭
  planner.js     刚性区块时空调度 + 逐路径可行性解释
  eligibility.js 人员资质/车辆状态有效期校验
  eventlog.js    JSONL 事件日志（追加、加载、半行处理）
  engine.js      许可状态机、串行临界区、幂等、封闭影响、改道、回放
src/api.js       REST 路由
src/server.js    启动：资料加载 + 日志重放 + HTTP
fixtures/        airport.json 道路资料；requests.json 申请样例；context.json 旧领域样例
test/            22 项测试（规划/并发/资质/幂等/封闭/改道/重放/HTTP 端到端）
```
