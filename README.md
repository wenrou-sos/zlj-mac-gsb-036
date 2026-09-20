# 寺院僧众挂单与常住管理平台

云游僧人到寺挂单登记、寮房床位安排、考察期管理、羯磨转常住、常住档案、早晚课考勤与缺勤自动提醒。

- **前端**：Vue 3 + TypeScript + Vite + Naive UI
- **后端**：Fastify + TypeScript + node-postgres
- **数据库**：PostgreSQL 16（枚举类型、事务、触发器）

## 功能

| 模块 | 说明 |
| --- | --- |
| 客堂总览 | 在寺人数、床位使用率、今日早晚课随众、即将到期挂单、考察期进度 |
| 挂单登记 | 法名、出家寺庙、戒牒编号、到寺日期、预计住几天；可同时安排床位；续单、舍单 |
| 寮房床位 | 房间号/床位号、入住状态可视化；新建房间自动生成床位；床位冲突事务校验 |
| 考察与常住 | 发心常住转入 **3–6 个月**考察期，规定月度评议次数与羯磨达标分；按月召集多位执事**独立评分**，支持**缺席补评**、**评语修订留痕**与**阶段汇总**；四项条件具足方可行**羯磨转常住**，并保留完整**决策快照** |
| 常住档案 | 法名、字辈、剃度师、受戒时间与戒场、担任职务（知客/维那/典座等） |
| 早晚课考勤 | 早课/晚课按日整堂登记（随众/缺勤/请假），支持按僧人区间查询 |
| 缺勤提醒 | **近 30 日缺勤累计满 3 次，数据库触发器自动生成客堂待办**，知客知悉后归档 |
| 大型法会临时僧众 | 创办法会（日期、每日接待上限）；表格批量导入逐行反馈**重复/撞期/容量**错误；按到离寺时间与特殊需求**分组分床**，区间排他约束防并发抢占；满员自动**候补队列**，床位释放即递补并待知客确认；批量**签到/迟到/未到/提前离寺**；圆满批量释放床位并冻结**实到率、床位峰值、每日入住趋势**；临时人员**不进入**常规考勤告警与考察统计，全部操作留痕 |

## 目录结构

```
.
├── db/init/            # PostgreSQL 建表(01)、演示数据(02)、法会模块迁移与演示(03)
├── server/             # Fastify + TS API
│   ├── src/routes/     # monks / guadan / rooms / inspections / reviews / attendance
│   │                   #   / alerts / dashboard / ceremonies
│   └── test/           # 法会模块关键流程测试（node:test）
├── web/                # Vue3 + TS + Naive UI
│   └── src/pages/      # 常规页面 + ceremony/ 法会客堂（名单/床位/候补/签到/统计/流水）
└── docker-compose.yml  # 一键启动 PostgreSQL
```

## 快速开始

### 方式一：Docker（推荐）

```bash
# 1. 启动数据库（首次自动建表并写入演示数据）
docker compose up -d db

# 2. 启动 API
cd server && npm install && npm run dev      # http://localhost:3000

# 3. 启动前端
cd web && npm install && npm run dev         # http://localhost:5173
```

浏览器打开 http://localhost:5173 。Vite 已把 `/api` 代理到 3000 端口。

### 方式二：无 Docker 环境

`.devtools/` 内提供了用户态免安装 PostgreSQL（基于 embedded-postgres），无需 root：

```bash
cd .devtools && npm install
node pg.mjs            # 启动并在首次运行时建库建表+种子数据
```

之后同样启动 `server` 与 `web` 即可。后端测试：

```bash
cd server && npm test          # 法会模块关键流程（需 PostgreSQL 已启动）
```

> 重新演示初始数据：停掉数据库后删除 `.devtools/pgdata`，再 `node pg.mjs`；
> Docker 方式则 `docker compose down -v` 后重新 `up`。

## 账号 / 环境

开发环境无登录鉴权，数据库连接见 `server/.env`：

```
PGHOST=localhost  PGPORT=5432  PGDATABASE=sangha  PGUSER=postgres  PGPASSWORD=postgres
```

## 演示数据

- 5 位常住（方丈、知客、维那、典座、僧值）
- 3 位挂单、2 位考察期僧人
  - **行简**：前两月已阶段汇总（典座曾缺席补评、知客评分有一次修订留痕），第三月收评分中、维那缺席待补评 —— 尚不满足羯磨条件
  - **定空**：三月月度评议均已汇总，均分达标、无缺勤待办 —— 可直接体验羯磨转常住与决策快照
- 云水寮/静修楼共 11 个床位
- 近 7 天早晚课考勤；僧人 **演戒** 近 30 日缺勤 4 次，已自动生成一条客堂缺勤提醒
- **二〇二六年秋季精进佛七**（筹备中，10/01–10/07，每日 6 人）：法会寮东/西 8 张临时床位，已导入 8 人——6 人在名额内（5 人已分床，含按特殊需求分组聚住），2 人候补；可体验导入逐行反馈、自动分床、签到、释放床位自动递补与圆满统计

### 羯磨转常住的四项条件

必须同时满足，缺一即被后端事务拒绝（前端弹窗亦实时显示核对清单）：

1. 月度阶段汇总次数达到**规定评议次数**；
2. **无缺席待补评**（评议名册中每位执事均有票，缺席者已走补评）；
3. **无未处理缺勤提醒**（`absence_alerts` 无 open 待办）；
4. 历次月度评议**均分达到达标分**（默认 75）。

提交后在同一事务内冻结逐月评分、补评与修订留痕、资格核对结果，写入只增不改的 `karma_decision_snapshots`。

## 主要接口

| Method | Path | 说明 |
| --- | --- | --- |
| GET/POST | `/api/guadan` | 挂单列表/登记 |
| PUT | `/api/guadan/:id/bed` | 安排调换床位 |
| PUT | `/api/guadan/:id/extend` | 续单 |
| POST | `/api/guadan/:id/checkout` | 舍单离寺（释放床位） |
| GET/POST | `/api/rooms` | 寮房与床位 |
| GET/POST | `/api/inspections` | 考察期列表/转入考察（含规定评议次数、达标分） |
| PUT | `/api/inspections/:id` | 调整规定评议次数/达标分（仅考察中） |
| GET | `/api/inspections/:id/eligibility` | 羯磨四项资格核对 |
| POST | `/api/inspections/:id/pass` | 羯磨通过转常住（事务内核验资格并落决策快照） |
| POST | `/api/inspections/:id/fail` | 考察不通过 |
| GET | `/api/inspections/:id/snapshots` · `/api/inspections/snapshots/:id` | 羯磨决策快照列表/详情（只增不可变） |
| GET | `/api/reviews/reviewers` | 可参与评议的核心执事 |
| GET/POST | `/api/reviews/inspections/:id/rounds` | 月度评议会次列表（名册/评分/修订）/召集 |
| PUT | `/api/reviews/rounds/:id` | 调整会次区间/日期 |
| POST | `/api/reviews/rounds/:id/scores` | 执事独立评分（同人再投即修订留痕；缺席补评） |
| PUT | `/api/reviews/scores/:id/revisions` | 评语/评分修订（须填缘由，只增留痕） |
| POST | `/api/reviews/rounds/:id/summarize` · `/reopen` | 月度阶段汇总锁定 / 撤销汇总 |
| GET | `/api/reviews/inspections/:id/summary` | 阶段汇总总览（逐月均分、历次总均分） |
| GET/PUT | `/api/monks[/:id]` | 僧人档案 |
| GET/POST | `/api/attendance` | 某日某课名册/单条登记 |
| POST | `/api/attendance/bulk` | 整堂批量登记 |
| GET | `/api/attendance/summary` | 区间缺勤统计 |
| GET/POST | `/api/alerts` | 缺勤提醒 / 知悉 |
| GET | `/api/dashboard` | 客堂总览 |
| GET/POST | `/api/ceremonies` | 法会列表 / 创办（日期、每日接待上限） |
| GET/PUT | `/api/ceremonies/:id` | 法会详情 / 修改设置（仅筹备中） |
| POST | `/api/ceremonies/:id/start` · `/close` | 法会开始 / 圆满（批量释放床位、冻结统计） |
| POST | `/api/ceremonies/:id/import` | 表格批量导入，逐行返回 ok / waitlisted / duplicate / conflict / invalid |
| GET | `/api/ceremonies/:id/participants` | 法会人员名单（按状态/法名过滤） |
| POST | `/api/ceremonies/:id/auto-assign` | 按到离寺时间+特殊需求分组自动分床 |
| GET | `/api/ceremonies/:id/available-beds` | 指定到离寺区间内的空闲床位 |
| PUT | `/api/ceremonies/:id/participants/:pid/bed` | 调床（区间排他校验，原床释放触发递补） |
| POST | `/api/ceremonies/:id/promote` | 手动尝试候补递补 |
| POST | `/api/ceremonies/:id/participants/:pid/confirm` · `/reject` | 知客确认 / 拒绝递补 |
| POST | `/api/ceremonies/:id/participants/:pid/cancel` | 取消登记/候补并递补 |
| POST | `/api/ceremonies/:id/checkins/bulk` | 批量签到 / 迟到 / 未到（释放床位并递补） |
| POST | `/api/ceremonies/:id/participants/:pid/early-leave` | 提前离寺（释放名额与床位、自动递补） |
| GET | `/api/ceremonies/:id/stats` | 实到率 / 床位峰值 / 每日入住趋势（圆满后返回冻结值） |
| GET | `/api/ceremonies/:id/logs` | 导入/分床/调床/递补/签到等完整流水 |
