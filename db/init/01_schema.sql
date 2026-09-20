-- =====================================================================
-- 寺院僧人挂单与常住管理平台 —— 数据库结构
-- PostgreSQL 16
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- 枚举
-- ---------------------------------------------------------------------
CREATE TYPE monk_status AS ENUM ('guadan', 'inspection', 'permanent', 'left');
-- guadan 挂单 / inspection 考察期 / permanent 常住 / left 已离寺

CREATE TYPE guadan_status AS ENUM ('active', 'closed');

CREATE TYPE inspection_result AS ENUM ('pending', 'passed', 'failed');

CREATE TYPE session_type AS ENUM ('morning', 'evening');
-- morning 早课 / evening 晚课

CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'leave');
-- present 随众 / absent 缺勤 / leave 请假

CREATE TYPE alert_status AS ENUM ('open', 'acknowledged');

-- 月度评议会次状态：collecting 收评分中 / summarized 已作阶段汇总
CREATE TYPE review_round_status AS ENUM ('collecting', 'summarized');

-- 评分提交方式：normal 按期评议 / makeup 缺席补评
CREATE TYPE review_submission_type AS ENUM ('normal', 'makeup');

-- 月度/阶段评议结论
CREATE TYPE review_conclusion AS ENUM ('excellent', 'qualified', 'unqualified');
-- excellent 优秀 / qualified 合格 / unqualified 不合格

-- ---------------------------------------------------------------------
-- 僧人总表（挂单/考察/常住共用身份记录）
-- ---------------------------------------------------------------------
CREATE TABLE monks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    dharma_name     VARCHAR(64) NOT NULL,                 -- 法名
    home_monastery  VARCHAR(128),                         -- 出家寺庙
    ordination_no   VARCHAR(64),                          -- 戒牒编号
    generation      VARCHAR(64),                          -- 字辈
    tonsure_master  VARCHAR(64),                          -- 剃度师
    ordination_date DATE,                                 -- 受戒时间
    ordination_place VARCHAR(128),                        -- 戒场
    current_post    VARCHAR(64),                          -- 担任职务（知客/维那/典座等）
    note            TEXT,                                 -- 备注
    status          monk_status NOT NULL DEFAULT 'guadan',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 同一僧人可能多次来寺挂单，戒牒编号不做唯一约束
    CONSTRAINT ordination_no_chk CHECK (ordination_no IS NULL OR ordination_no <> '')
);

-- ---------------------------------------------------------------------
-- 寮房（房间）
-- ---------------------------------------------------------------------
CREATE TABLE rooms (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_no     VARCHAR(32) NOT NULL UNIQUE,              -- 房间号
    capacity    INTEGER NOT NULL CHECK (capacity > 0),    -- 床位数
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 床位
-- ---------------------------------------------------------------------
CREATE TABLE beds (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id     UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    bed_no      VARCHAR(32) NOT NULL,                      -- 床位号
    monk_id     UUID REFERENCES monks(id) ON DELETE SET NULL, -- 当前住众
    UNIQUE (room_id, bed_no)
);

-- ---------------------------------------------------------------------
-- 挂单记录（每次入寺一条；舍单/转常住后 closed）
-- ---------------------------------------------------------------------
CREATE TABLE guadan (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    monk_id         UUID NOT NULL REFERENCES monks(id) ON DELETE CASCADE,
    arrive_date     DATE NOT NULL,                         -- 到寺日期
    expected_days   INTEGER NOT NULL CHECK (expected_days > 0), -- 预计住几天
    bed_id          UUID REFERENCES beds(id) ON DELETE SET NULL,-- 安排床位
    status          guadan_status NOT NULL DEFAULT 'active',
    leave_date      DATE,                                  -- 实际舍单日期
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_guadan_status ON guadan(status);
CREATE INDEX idx_guadan_monk ON guadan(monk_id);

-- ---------------------------------------------------------------------
-- 考察期（3-6 个月），通过后行羯磨转常住；
-- 考察期内按月召集执事评议（见 review_rounds / review_scores）
-- ---------------------------------------------------------------------
CREATE TABLE inspections (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    monk_id         UUID NOT NULL REFERENCES monks(id) ON DELETE CASCADE,
    guadan_id       UUID NOT NULL REFERENCES guadan(id) ON DELETE CASCADE,
    start_date      DATE NOT NULL,
    expected_end    DATE NOT NULL,                         -- 预计考察期满
    result          inspection_result NOT NULL DEFAULT 'pending',
    required_reviews INTEGER NOT NULL DEFAULT 3
                      CHECK (required_reviews BETWEEN 1 AND 12), -- 规定评议次数（月）
    pass_score      NUMERIC(5,2) NOT NULL DEFAULT 75.00
                      CHECK (pass_score BETWEEN 0 AND 100),     -- 羯磨达标平均分
    stage_summary   TEXT,                                  -- 阶段总评（末次月度汇总时形成）
    karma_date      DATE,                                  -- 羯磨仪式日期（通过时）
    decided_at      TIMESTAMPTZ,                           -- 结论时间
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 每位僧人同一时间只允许一条进行中的考察
CREATE UNIQUE INDEX one_pending_inspection_per_monk
    ON inspections(monk_id) WHERE result = 'pending';

-- ---------------------------------------------------------------------
-- 月度评议会次：一条考察按自然月起讫逐次召集
-- ---------------------------------------------------------------------
CREATE TABLE review_rounds (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inspection_id   UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
    seq_no          INTEGER NOT NULL,                      -- 第几次月度评议（从 1 起）
    period_start    DATE NOT NULL,                         -- 本月评议区间起
    period_end      DATE NOT NULL,                         -- 本月评议区间止
    meeting_date    DATE NOT NULL,                         -- 评议会日期
    status          review_round_status NOT NULL DEFAULT 'collecting',
    average_score   NUMERIC(5,2),                          -- 阶段汇总时锁定的当月均分
    conclusion      review_conclusion,                     -- 当月评议结论
    summary_note    TEXT,                                  -- 月度阶段小结
    note            TEXT,                                  -- 召集备注（区间说明等）
    summarized_by   VARCHAR(64),                           -- 汇总人（知客/僧值）
    summarized_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (inspection_id, seq_no),
    CHECK (period_end >= period_start)
);
CREATE INDEX idx_rounds_inspection ON review_rounds(inspection_id);

-- ---------------------------------------------------------------------
-- 评议名册（每月应参与评分的执事，请假缺席者以"缺席补评"补交）
-- ---------------------------------------------------------------------
CREATE TABLE review_reviewers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_id        UUID NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
    reviewer_id     UUID NOT NULL REFERENCES monks(id) ON DELETE RESTRICT,
    reviewer_name   VARCHAR(64) NOT NULL,                  -- 法名快照
    reviewer_role   VARCHAR(64),                           -- 职务快照（知客/维那/典座…）
    seat_no         INTEGER NOT NULL,                      -- 席次（排序用）
    UNIQUE (round_id, reviewer_id)
);

-- ---------------------------------------------------------------------
-- 执事独立评分：每位执事每月度一票；评语可修订，修订留痕见 score_revisions
-- ---------------------------------------------------------------------
CREATE TABLE review_scores (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_id        UUID NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
    reviewer_id     UUID NOT NULL REFERENCES monks(id) ON DELETE RESTRICT,
    score           NUMERIC(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
    comment         TEXT,
    submission_type review_submission_type NOT NULL DEFAULT 'normal',
    absent_reason   TEXT,                                  -- 缺席事由（补评时）
    submitted_by    VARCHAR(64) NOT NULL DEFAULT '知客',   -- 登记人
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),    -- 首次提交时间
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (round_id, reviewer_id)
);
CREATE INDEX idx_scores_round ON review_scores(round_id);

-- ---------------------------------------------------------------------
-- 评语/评分修订留痕：只增不改，保留每次修订前后内容
-- ---------------------------------------------------------------------
CREATE TABLE score_revisions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    score_id        UUID NOT NULL REFERENCES review_scores(id) ON DELETE CASCADE,
    round_id        UUID NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
    reviewer_id     UUID NOT NULL REFERENCES monks(id) ON DELETE RESTRICT,
    reviewer_name   VARCHAR(64) NOT NULL,
    old_score       NUMERIC(5,2),                          -- NULL 表示首次提交
    new_score       NUMERIC(5,2) NOT NULL,
    old_comment     TEXT,
    new_comment     TEXT,
    reason          TEXT NOT NULL,                         -- 修订/补评缘由
    revised_by      VARCHAR(64) NOT NULL DEFAULT '知客',
    revised_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_revisions_score ON score_revisions(score_id);

-- ---------------------------------------------------------------------
-- 羯磨决策快照：发起羯磨转常住时落库，此后评议数据任何变动
-- 都不影响快照内容（只插入，不更新/删除）
-- ---------------------------------------------------------------------
CREATE TABLE karma_decision_snapshots (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inspection_id       UUID NOT NULL REFERENCES inspections(id) ON DELETE RESTRICT,
    monk_id             UUID NOT NULL REFERENCES monks(id) ON DELETE RESTRICT,
    monk_name           VARCHAR(64) NOT NULL,
    karma_date          DATE NOT NULL,
    current_post        VARCHAR(64),
    required_reviews    INTEGER NOT NULL,
    completed_reviews   INTEGER NOT NULL,
    overall_avg_score   NUMERIC(5,2) NOT NULL,
    pass_score          NUMERIC(5,2) NOT NULL,
    open_alert_count    INTEGER NOT NULL,
    makeup_pending      INTEGER NOT NULL,
    stage_summary       TEXT,
    rounds              JSONB NOT NULL,                    -- 各月会次：评分、修订、结论
    eligibility         JSONB NOT NULL,                    -- 发起时四项门槛核对结果
    decided_by          VARCHAR(64) NOT NULL DEFAULT '羯磨法会',
    note                TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_snapshots_inspection ON karma_decision_snapshots(inspection_id);

-- ---------------------------------------------------------------------
-- 早晚课考勤（按人 / 日期 / 课次唯一）
-- ---------------------------------------------------------------------
CREATE TABLE attendance (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    monk_id     UUID NOT NULL REFERENCES monks(id) ON DELETE CASCADE,
    attend_date DATE NOT NULL,
    session     session_type NOT NULL,
    status      attendance_status NOT NULL DEFAULT 'present',
    recorded_by VARCHAR(64),                               -- 登记人（知客/僧值）
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (monk_id, attend_date, session)
);
CREATE INDEX idx_attendance_date ON attendance(attend_date);

-- ---------------------------------------------------------------------
-- 缺勤满三次自动提醒（客堂待办）
-- ---------------------------------------------------------------------
CREATE TABLE absence_alerts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    monk_id         UUID NOT NULL REFERENCES monks(id) ON DELETE CASCADE,
    window_days     INTEGER NOT NULL DEFAULT 30,           -- 统计窗口
    absence_count   INTEGER NOT NULL,                      -- 触发时缺勤次数
    last_absence    DATE NOT NULL,                         -- 最近一次缺勤日期
    status          alert_status NOT NULL DEFAULT 'open',
    acknowledged_by VARCHAR(64),
    acknowledged_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_status ON absence_alerts(status);

-- ---------------------------------------------------------------------
-- updated_at 自动维护
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_monks_updated   BEFORE UPDATE ON monks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_guadan_updated  BEFORE UPDATE ON guadan
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_attendance_updated BEFORE UPDATE ON attendance
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_scores_updated BEFORE UPDATE ON review_scores
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 缺勤累计满三次自动提醒：近 30 个自然日内缺勤 >= 3 次，
-- 自动在 absence_alerts 生成/更新一条客堂待办
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_absence_threshold() RETURNS TRIGGER AS $$
DECLARE
    v_count INTEGER;
    v_open  INTEGER;
BEGIN
    IF NEW.status = 'absent' THEN
        SELECT count(*) INTO v_count
        FROM attendance
        WHERE monk_id = NEW.monk_id
          AND status = 'absent'
          AND attend_date BETWEEN (NEW.attend_date - 29) AND NEW.attend_date;

        IF v_count >= 3 THEN
            SELECT count(*) INTO v_open
            FROM absence_alerts
            WHERE monk_id = NEW.monk_id AND status = 'open';

            IF v_open = 0 THEN
                INSERT INTO absence_alerts (monk_id, window_days, absence_count, last_absence)
                VALUES (NEW.monk_id, 30, v_count, NEW.attend_date);
            ELSE
                -- 已有待处理提醒则刷新计数与最近缺勤日期
                UPDATE absence_alerts
                   SET absence_count = v_count,
                       last_absence  = NEW.attend_date
                 WHERE monk_id = NEW.monk_id AND status = 'open';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_attendance_absence
    AFTER INSERT OR UPDATE OF status ON attendance
    FOR EACH ROW EXECUTE FUNCTION check_absence_threshold();
