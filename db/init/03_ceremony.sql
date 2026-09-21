-- =====================================================================
-- 大型法会临时僧众管理 —— 数据库结构（01_schema.sql 的扩展）
-- 临时人员独立建表（ceremony_participants），不进入 monks 主表，
-- 因而天然与早晚课考勤、缺勤提醒触发器、考察期统计隔离。
-- =====================================================================

-- 区间排他约束所需（daterange / gist）
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------
-- 枚举
-- ---------------------------------------------------------------------
CREATE TYPE ceremony_status AS ENUM ('preparing', 'ongoing', 'closed');
-- preparing 备会 / ongoing 进行中 / closed 已圆满

CREATE TYPE participant_status AS ENUM (
    'registered',    -- 已登记（占接待名额，待分床）
    'waitlisted',    -- 候补队列
    'bed_offered',   -- 床位递补已分配，等待知客确认
    'confirmed',     -- 床位已确认
    'checked_in',    -- 已签到在寺
    'early_left',    -- 提前离寺
    'checked_out',   -- 正常离寺
    'no_show',       -- 未到
    'cancelled'      -- 已取消
);

CREATE TYPE stay_status AS ENUM ('held', 'confirmed', 'released');
-- held 递补预留待确认 / confirmed 已确认占用 / released 已释放（保留历史）

CREATE TYPE checkin_kind AS ENUM ('on_time', 'late');
-- on_time 如期签到 / late 迟到

CREATE TYPE ceremony_event_type AS ENUM (
    'create', 'import', 'allocate', 'bed_change',
    'waitlist_promote', 'offer_confirm', 'offer_reject',
    'checkin', 'no_show', 'early_leave', 'checkout',
    'release', 'release_all', 'cancel', 'close'
);

-- ---------------------------------------------------------------------
-- 法会
-- ---------------------------------------------------------------------
CREATE TABLE dharma_ceremonies (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(128) NOT NULL,                     -- 法会名称
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    capacity    INTEGER NOT NULL CHECK (capacity > 0),     -- 接待上限（同日在寺临时人数）
    status      ceremony_status NOT NULL DEFAULT 'preparing',
    note        TEXT,
    closed_at   TIMESTAMPTZ,
    created_by  VARCHAR(64) NOT NULL DEFAULT '知客',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date >= start_date)
);

-- ---------------------------------------------------------------------
-- 法会临时人员（不写入 monks，不参与原有考勤/考察/告警）
-- ---------------------------------------------------------------------
CREATE TABLE ceremony_participants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ceremony_id     UUID NOT NULL REFERENCES dharma_ceremonies(id) ON DELETE CASCADE,
    dharma_name     VARCHAR(64) NOT NULL,                  -- 法名（快照）
    home_monastery  VARCHAR(128),                          -- 出家寺庙（快照）
    ordination_no   VARCHAR(64),                           -- 戒牒编号（快照）
    contact         VARCHAR(64),                           -- 联系方式
    special_need    VARCHAR(128) NOT NULL DEFAULT '',      -- 特殊需求（病弱/饮食/医药/下铺…）
    group_code      VARCHAR(16),                           -- 按到离寺时间+特殊需求所分组（G01…）
    arrive_date     DATE NOT NULL,                         -- 预计到寺
    leave_date      DATE NOT NULL,                         -- 预计离寺
    status          participant_status NOT NULL DEFAULT 'registered',
    waitlist_seq    BIGINT,                                -- 候补序号（FIFO）
    created_by      VARCHAR(64) NOT NULL DEFAULT '知客',
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (leave_date >= arrive_date),
    CHECK (ordination_no IS NULL OR ordination_no <> '')
);
CREATE INDEX idx_cp_ceremony ON ceremony_participants(ceremony_id);
CREATE INDEX idx_cp_status ON ceremony_participants(ceremony_id, status);
-- 戒牒编号在同一法会内（未取消者）唯一：重复导入的数据库兜底
CREATE UNIQUE INDEX uq_cp_ordination
    ON ceremony_participants(ceremony_id, ordination_no)
    WHERE ordination_no IS NOT NULL AND status <> 'cancelled';

-- ---------------------------------------------------------------------
-- 临时床位占用（区间）。与常住床位共用 beds：
--   * beds.monk_id 非空 = 现有常住/挂单入住，临时分配事务内拒绝；
--   * 本表 held/confirmed 区间互不重叠（排他约束防并发抢占）；
--   * released 行保留，用于床位峰值等历史统计。
-- ---------------------------------------------------------------------
CREATE TABLE ceremony_bed_stays (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ceremony_id     UUID NOT NULL REFERENCES dharma_ceremonies(id) ON DELETE CASCADE,
    participant_id  UUID NOT NULL REFERENCES ceremony_participants(id) ON DELETE CASCADE,
    bed_id          UUID NOT NULL REFERENCES beds(id) ON DELETE RESTRICT,
    stay_start      DATE NOT NULL,                         -- 占用起（递补时为递补当日）
    stay_end        DATE NOT NULL,                         -- 计划占用止
    actual_end      DATE,                                  -- 提前释放/离寺实际末日
    status          stay_status NOT NULL DEFAULT 'held',
    allocated_by    VARCHAR(64) NOT NULL DEFAULT '知客',
    released_at     TIMESTAMPTZ,
    release_reason  VARCHAR(32),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (stay_end >= stay_start),
    CHECK (actual_end IS NULL
           OR (actual_end >= stay_start - 1 AND actual_end <= stay_end))
);
CREATE INDEX idx_cbs_bed ON ceremony_bed_stays(bed_id);
CREATE INDEX idx_cbs_participant ON ceremony_bed_stays(participant_id);
-- 同一床位 held/confirmed 占用区间不得重叠（日期重叠/并发抢占的最终防线）
ALTER TABLE ceremony_bed_stays
    ADD CONSTRAINT cbs_bed_no_overlap
    EXCLUDE USING gist (bed_id WITH =, daterange(stay_start, stay_end, '[]') WITH &&)
    WHERE (status <> 'released');

-- ---------------------------------------------------------------------
-- 法会签到/离寺（一人一条）
-- ---------------------------------------------------------------------
CREATE TABLE ceremony_checkins (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ceremony_id     UUID NOT NULL REFERENCES dharma_ceremonies(id) ON DELETE CASCADE,
    participant_id  UUID NOT NULL REFERENCES ceremony_participants(id) ON DELETE CASCADE,
    checkin_date    DATE,                                  -- 实际签到日（NULL=未到）
    checkin_kind    checkin_kind,                          -- 如期 / 迟到（晚于 arrive_date）
    checkout_date   DATE,                                  -- 实际离寺日
    checkout_early  BOOLEAN NOT NULL DEFAULT false,        -- 是否提前离寺
    recorded_by     VARCHAR(64) NOT NULL DEFAULT '知客',
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (participant_id)
);
CREATE INDEX idx_ci_ceremony ON ceremony_checkins(ceremony_id);

-- ---------------------------------------------------------------------
-- 法会操作留痕：导入、自动分床、调床、候补递补、确认、签到、未到、离寺…
-- ---------------------------------------------------------------------
CREATE TABLE ceremony_event_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ceremony_id     UUID NOT NULL REFERENCES dharma_ceremonies(id) ON DELETE CASCADE,
    participant_id  UUID REFERENCES ceremony_participants(id) ON DELETE SET NULL,
    event_type      ceremony_event_type NOT NULL,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    operator        VARCHAR(64) NOT NULL DEFAULT '知客',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cel_ceremony ON ceremony_event_log(ceremony_id, created_at);
CREATE INDEX idx_cel_type ON ceremony_event_log(ceremony_id, event_type);

-- ---------------------------------------------------------------------
-- 表格导入批次（逐行结果完整保留）
-- ---------------------------------------------------------------------
CREATE TABLE ceremony_import_batches (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ceremony_id     UUID NOT NULL REFERENCES dharma_ceremonies(id) ON DELETE CASCADE,
    file_name       VARCHAR(256),
    total_rows      INTEGER NOT NULL DEFAULT 0,
    accepted_count  INTEGER NOT NULL DEFAULT 0,             -- 已登记
    waitlisted_count INTEGER NOT NULL DEFAULT 0,            -- 满员自动入候补
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    conflict_count  INTEGER NOT NULL DEFAULT 0,
    capacity_count  INTEGER NOT NULL DEFAULT 0,
    invalid_count   INTEGER NOT NULL DEFAULT 0,
    row_results     JSONB NOT NULL DEFAULT '[]'::jsonb,     -- 逐行反馈
    imported_by     VARCHAR(64) NOT NULL DEFAULT '知客',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cib_ceremony ON ceremony_import_batches(ceremony_id, created_at);

-- ---------------------------------------------------------------------
-- updated_at 维护
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_ceremony_updated BEFORE UPDATE ON dharma_ceremonies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_cp_updated BEFORE UPDATE ON ceremony_participants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_cbs_updated BEFORE UPDATE ON ceremony_bed_stays
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_ci_updated BEFORE UPDATE ON ceremony_checkins
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 接待上限约束：任意一天（当天及未来，过去日期名额已自然释放），占名额状态
--   （registered / bed_offered / confirmed / checked_in）
-- 的临时人数不得超过法会 capacity。
-- 触发器内先对法会行加 FOR UPDATE 锁，串行化同一法会的名额竞争。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_ceremony_capacity() RETURNS TRIGGER AS $$
DECLARE
    v_cap INTEGER;
    v_n   INTEGER;
    v_d   DATE;
    v_from DATE;
BEGIN
    IF NEW.status IN ('registered', 'bed_offered', 'confirmed', 'checked_in') THEN
        PERFORM 1 FROM dharma_ceremonies WHERE id = NEW.ceremony_id FOR UPDATE;

        SELECT capacity INTO v_cap FROM dharma_ceremonies WHERE id = NEW.ceremony_id;

        v_from := GREATEST(CURRENT_DATE, NEW.arrive_date);
        FOR v_d IN SELECT d::date FROM generate_series(v_from, NEW.leave_date, INTERVAL '1 day') d
        LOOP
            SELECT count(*) INTO v_n
            FROM ceremony_participants p
            WHERE p.ceremony_id = NEW.ceremony_id
              AND p.status IN ('registered', 'bed_offered', 'confirmed', 'checked_in')
              AND v_d BETWEEN p.arrive_date AND p.leave_date
              AND p.id IS DISTINCT FROM NEW.id;

            IF v_n + 1 > v_cap THEN
                RAISE EXCEPTION '法会接待上限 % 人：% 已满（在寺人数 %）',
                    v_cap, v_d, v_n + 1
                    USING ERRCODE = 'check_violation',
                          CONSTRAINT = 'ceremony_capacity';
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cp_capacity
    BEFORE INSERT OR UPDATE OF status, arrive_date, leave_date, ceremony_id
    ON ceremony_participants
    FOR EACH ROW EXECUTE FUNCTION check_ceremony_capacity();

-- =====================================================================
-- 演示数据：秋季水陆法会（法会接待楼两层共 8 个临时床位，接待上限 6）
-- =====================================================================
INSERT INTO rooms (id, room_no, capacity, note) VALUES
    ('aaaaaaaa-1111-1111-1111-111111111101', '法会接待楼1号', 4, '水陆法会临时接待'),
    ('aaaaaaaa-1111-1111-1111-111111111102', '法会接待楼2号', 4, '水陆法会临时接待');

INSERT INTO beds (room_id, bed_no)
SELECT r.id, g.bed_no
FROM rooms r
CROSS JOIN LATERAL generate_series(1, r.capacity) AS g(bed_no)
WHERE r.id IN ('aaaaaaaa-1111-1111-1111-111111111101',
               'aaaaaaaa-1111-1111-1111-111111111102');

INSERT INTO dharma_ceremonies
    (id, name, start_date, end_date, capacity, status, note, created_by)
VALUES
    ('bbbbbbbb-2222-2222-2222-222222222201',
     '2026 秋季水陆法会', CURRENT_DATE - 1, CURRENT_DATE + 6, 6, 'ongoing',
     '外寮诸山长老暨戒期僧众接待；病弱法师安排下铺', '知客 慧海');

-- 6 位已分床（G01 同期到离 4 人、G02 病弱需照应 2 人），2 位候补
INSERT INTO ceremony_participants
    (id, ceremony_id, dharma_name, home_monastery, ordination_no, contact, special_need,
     group_code, arrive_date, leave_date, status, created_by)
VALUES
    ('cccccccc-3333-3333-3333-333333333301', 'bbbbbbbb-2222-2222-2222-222222222201',
     '德林', '宁波天童寺', 'JD20180701', '13800000001', '', 'G01',
     CURRENT_DATE - 1, CURRENT_DATE + 6, 'checked_in', '知客 慧海'),
    ('cccccccc-3333-3333-3333-333333333302', 'bbbbbbbb-2222-2222-2222-222222222201',
     '养玄', '扬州高旻寺', 'JD20190702', '13800000002', '', 'G01',
     CURRENT_DATE - 1, CURRENT_DATE + 6, 'checked_in', '知客 慧海'),
    ('cccccccc-3333-3333-3333-333333333303', 'bbbbbbbb-2222-2222-2222-222222222201',
     '崇戒', '常州天宁寺', 'JD20170703', '13800000003', '', 'G01',
     CURRENT_DATE - 1, CURRENT_DATE + 6, 'confirmed', '知客 慧海'),
    ('cccccccc-3333-3333-3333-333333333304', 'bbbbbbbb-2222-2222-2222-222222222201',
     '明启', '杭州灵隐寺', 'JD20200704', '13800000004', '', 'G01',
     CURRENT_DATE - 1, CURRENT_DATE + 6, 'confirmed', '知客 慧海'),
    ('cccccccc-3333-3333-3333-333333333305', 'bbbbbbbb-2222-2222-2222-222222222201',
     '净如', '江西庐山东林寺', 'JD20160705', '13800000005', '病弱，需下铺', 'G02',
     CURRENT_DATE, CURRENT_DATE + 6, 'confirmed', '知客 慧海'),
    ('cccccccc-3333-3333-3333-333333333306', 'bbbbbbbb-2222-2222-2222-222222222201',
     '慧开', '北京法源寺', 'JD20180706', '13800000006', '素食禁忌，斋堂照应', 'G02',
     CURRENT_DATE, CURRENT_DATE + 6, 'confirmed', '知客 慧海'),
    ('cccccccc-3333-3333-3333-333333333307', 'bbbbbbbb-2222-2222-2222-222222222201',
     '道源', '苏州西园寺', 'JD20210707', '13800000007', '', 'G03',
     CURRENT_DATE, CURRENT_DATE + 6, 'waitlisted', '知客 慧海'),
    ('cccccccc-3333-3333-3333-333333333308', 'bbbbbbbb-2222-2222-2222-222222222201',
     '广学', '厦门南普陀寺', 'JD20220708', '13800000008', '病弱，需下铺', 'G04',
     CURRENT_DATE, CURRENT_DATE + 6, 'waitlisted', '知客 慧海');

UPDATE ceremony_participants SET waitlist_seq = 1
WHERE id = 'cccccccc-3333-3333-3333-333333333307';
UPDATE ceremony_participants SET waitlist_seq = 2
WHERE id = 'cccccccc-3333-3333-3333-333333333308';

-- 床位占用（6 人；G01 住接待楼 1 号，病弱两位安排在 2 号房 1/2 床）
INSERT INTO ceremony_bed_stays
    (ceremony_id, participant_id, bed_id, stay_start, stay_end, status, allocated_by)
SELECT 'bbbbbbbb-2222-2222-2222-222222222201', mp.pid, b.id,
       p.arrive_date, p.leave_date, 'confirmed', '知客 慧海'
FROM (VALUES
    ('cccccccc-3333-3333-3333-333333333301'::uuid, 'aaaaaaaa-1111-1111-1111-111111111101'::uuid, '1'),
    ('cccccccc-3333-3333-3333-333333333302', 'aaaaaaaa-1111-1111-1111-111111111101', '2'),
    ('cccccccc-3333-3333-3333-333333333303', 'aaaaaaaa-1111-1111-1111-111111111101', '3'),
    ('cccccccc-3333-3333-3333-333333333304', 'aaaaaaaa-1111-1111-1111-111111111101', '4'),
    ('cccccccc-3333-3333-3333-333333333305', 'aaaaaaaa-1111-1111-1111-111111111102', '1'),
    ('cccccccc-3333-3333-3333-333333333306', 'aaaaaaaa-1111-1111-1111-111111111102', '2')
) AS mp(pid, room, bed_no)
JOIN beds b ON b.bed_no = mp.bed_no AND b.room_id = mp.room
JOIN ceremony_participants p ON p.id = mp.pid;

-- 签到：德林如期，养玄迟到一日
INSERT INTO ceremony_checkins (ceremony_id, participant_id, checkin_date, checkin_kind, recorded_by)
VALUES
    ('bbbbbbbb-2222-2222-2222-222222222201', 'cccccccc-3333-3333-3333-333333333301',
     CURRENT_DATE - 1, 'on_time', '知客 慧海'),
    ('bbbbbbbb-2222-2222-2222-222222222201', 'cccccccc-3333-3333-3333-333333333302',
     CURRENT_DATE, 'late', '知客 慧海');

INSERT INTO ceremony_event_log (ceremony_id, participant_id, event_type, detail, operator)
VALUES
    ('bbbbbbbb-2222-2222-2222-222222222201', NULL, 'create',
     jsonb_build_object('name', '2026 秋季水陆法会', 'capacity', 6), '知客 慧海'),
    ('bbbbbbbb-2222-2222-2222-222222222201', 'cccccccc-3333-3333-3333-333333333301',
     'checkin', jsonb_build_object('kind', 'on_time'), '知客 慧海'),
    ('bbbbbbbb-2222-2222-2222-222222222201', 'cccccccc-3333-3333-3333-333333333302',
     'checkin', jsonb_build_object('kind', 'late'), '知客 慧海');
