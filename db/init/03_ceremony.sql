-- =====================================================================
-- 大型法会临时僧众管理
-- 幂等迁移：全新库执行无副作用；旧库执行则增量建表
-- =====================================================================

-- btree_gist：让排他约束可以同时使用等值与区间列
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 临时来寺参加法会的僧人：独立于原有身份体系（不进考勤告警/考察统计）
ALTER TYPE monk_status ADD VALUE IF NOT EXISTS 'ceremony';

CREATE TYPE ceremony_status AS ENUM ('preparing', 'active', 'closed');
-- preparing 筹备中 / active 法会进行中 / closed 已圆满（归档）

CREATE TYPE ceremony_participant_status AS ENUM
    ('registered', 'waitlisted', 'proposed', 'checked_in', 'late', 'no_show', 'early_left', 'left', 'cancelled');
-- registered 已登记(接待名额内、未分床或分床待确认)
-- waitlisted 候补
-- proposed 床位递补已占床，待知客确认
-- checked_in 已签到 / late 迟到 / no_show 未到
-- early_left 提前离寺 / left 圆满离寺 / cancelled 已取消

CREATE TYPE ceremony_bed_status AS ENUM ('active', 'released');
-- active 当前占用（含 proposed 抢占）/ released 已释放（历史留痕，不可改）

CREATE TYPE ceremony_bed_assignment_type AS ENUM ('auto', 'manual', 'promoted');
-- auto 分组自动分配 / manual 调床 / promoted 候补递补

-- ---------------------------------------------------------------------
-- 法会
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ceremonies (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(128) NOT NULL,                    -- 法会名称
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    daily_capacity  INTEGER NOT NULL CHECK (daily_capacity > 0),  -- 每日接待上限（按人天口径）
    note            TEXT,
    status          ceremony_status NOT NULL DEFAULT 'preparing',
    closed_at       TIMESTAMPTZ,
    final_stats     JSONB,                                    -- 圆满时冻结：实到率/床位峰值/每日入住趋势
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_ceremonies_status ON ceremonies(status);

-- ---------------------------------------------------------------------
-- 法会临时人员
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ceremony_participants (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ceremony_id         UUID NOT NULL REFERENCES ceremonies(id) ON DELETE CASCADE,
    monk_id             UUID REFERENCES monks(id) ON DELETE SET NULL, -- 自动建档的临时僧人
    dharma_name         VARCHAR(64) NOT NULL,
    home_monastery      VARCHAR(128),
    ordination_no       VARCHAR(64),
    group_key           VARCHAR(128) NOT NULL DEFAULT '',     -- 到离寺时间+特殊需求分组键
    arrive_date         DATE NOT NULL,
    leave_date          DATE NOT NULL,                        -- 预计离寺
    actual_leave_date   DATE,                                 -- 实际离寺
    special_need        VARCHAR(256),                         -- 特殊需求（病僧/行动不便/忌口…）
    status              ceremony_participant_status NOT NULL DEFAULT 'registered',
    checkin_at          TIMESTAMPTZ,                          -- 签到时间
    checkin_type        ceremony_participant_status,          -- late/checked_in
    note                TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (leave_date >= arrive_date),
    CONSTRAINT ceremony_part_ordination_chk CHECK (ordination_no IS NULL OR ordination_no <> '')
);
CREATE INDEX IF NOT EXISTS idx_cpart_ceremony ON ceremony_participants(ceremony_id);
CREATE INDEX IF NOT EXISTS idx_cpart_status ON ceremony_participants(status);
CREATE INDEX IF NOT EXISTS idx_cpart_monk ON ceremony_participants(monk_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpart_ceremony_ordination
    ON ceremony_participants(ceremony_id, ordination_no)
    WHERE ordination_no IS NOT NULL AND status <> 'cancelled';
-- 同一僧人（有 monk_id）在同一法会只保留一条有效记录
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpart_ceremony_monk
    ON ceremony_participants(ceremony_id, monk_id)
    WHERE monk_id IS NOT NULL AND status <> 'cancelled';

-- ---------------------------------------------------------------------
-- 临时床位分配（区间占用；历史释放记录只增不改）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ceremony_bed_assignments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ceremony_id     UUID NOT NULL REFERENCES ceremonies(id) ON DELETE CASCADE,
    participant_id  UUID NOT NULL REFERENCES ceremony_participants(id) ON DELETE CASCADE,
    bed_id          UUID NOT NULL REFERENCES beds(id) ON DELETE RESTRICT,
    stay_range      DATERANGE NOT NULL,                      -- [到寺, 离寺) 半开区间
    assignment_type ceremony_bed_assignment_type NOT NULL DEFAULT 'auto',
    status          ceremony_bed_status NOT NULL DEFAULT 'active',
    assigned_by     VARCHAR(64) NOT NULL DEFAULT '知客',
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at     TIMESTAMPTZ,
    released_reason VARCHAR(64),                             -- early_leave / transfer / cancel / close
    note            TEXT,
    CONSTRAINT cba_range_chk CHECK (not isempty(stay_range))
);
CREATE INDEX IF NOT EXISTS idx_cba_bed ON ceremony_bed_assignments(bed_id);
CREATE INDEX IF NOT EXISTS idx_cba_participant ON ceremony_bed_assignments(participant_id);
-- 同一床位的有效占用区间不得重叠：数据库级保证并发抢占安全
ALTER TABLE ceremony_bed_assignments
    DROP CONSTRAINT IF EXISTS cba_bed_overlap;
ALTER TABLE ceremony_bed_assignments
    ADD CONSTRAINT cba_bed_overlap
    EXCLUDE USING gist (
        bed_id WITH =,
        stay_range WITH &&
    ) WHERE (status = 'active');

-- ---------------------------------------------------------------------
-- 法会操作流水：导入/分床/调床/递补/签到/离寺/圆满 全部留痕
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ceremony_event_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ceremony_id     UUID NOT NULL REFERENCES ceremonies(id) ON DELETE CASCADE,
    participant_id  UUID REFERENCES ceremony_participants(id) ON DELETE SET NULL,
    batch_no        INTEGER,                                 -- 导入批次（同一次导入共享）
    action          VARCHAR(32) NOT NULL,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    operator        VARCHAR(64) NOT NULL DEFAULT '知客',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_celog_ceremony ON ceremony_event_log(ceremony_id);
CREATE INDEX IF NOT EXISTS idx_celog_batch ON ceremony_event_log(batch_no);
CREATE INDEX IF NOT EXISTS idx_celog_participant ON ceremony_event_log(participant_id);

-- updated_at
DROP TRIGGER IF EXISTS trg_ceremonies_updated ON ceremonies;
CREATE TRIGGER trg_ceremonies_updated BEFORE UPDATE ON ceremonies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_cpart_updated ON ceremony_participants;
CREATE TRIGGER trg_cpart_updated BEFORE UPDATE ON ceremony_participants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 演示数据（幂等：仅全新环境/表为空时插入）
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_cid UUID := 'aaaaaaaa-0000-4000-8000-000000000001';
    v_ra UUID;
    v_rb UUID;
    v_beds UUID[];
    v_p1 UUID := 'aaaaaaaa-1000-4000-8000-000000000001';
    v_p2 UUID := 'aaaaaaaa-1000-4000-8000-000000000002';
    v_p3 UUID := 'aaaaaaaa-1000-4000-8000-000000000003';
    v_p4 UUID := 'aaaaaaaa-1000-4000-8000-000000000004';
    v_p5 UUID := 'aaaaaaaa-1000-4000-8000-000000000005';
    v_p6 UUID := 'aaaaaaaa-1000-4000-8000-000000000006';
    v_p7 UUID := 'aaaaaaaa-1000-4000-8000-000000000007';
    v_p8 UUID := 'aaaaaaaa-1000-4000-8000-000000000008';
    v_m1 UUID := 'aaaaaaaa-2000-4000-8000-000000000001';
    v_m2 UUID := 'aaaaaaaa-2000-4000-8000-000000000002';
    v_m3 UUID := 'aaaaaaaa-2000-4000-8000-000000000003';
    v_m4 UUID := 'aaaaaaaa-2000-4000-8000-000000000004';
    v_m5 UUID := 'aaaaaaaa-2000-4000-8000-000000000005';
    v_m6 UUID := 'aaaaaaaa-2000-4000-8000-000000000006';
    v_m7 UUID := 'aaaaaaaa-2000-4000-8000-000000000007';
    v_m8 UUID := 'aaaaaaaa-2000-4000-8000-000000000008';
    i INT;
BEGIN
    IF EXISTS (SELECT 1 FROM ceremonies) THEN
        RETURN;
    END IF;

    -- 两间法会临时寮房（各 4 床）
    INSERT INTO rooms (id, room_no, capacity, note)
    VALUES ('aaaaaaaa-3000-4000-8000-000000000001', '法会寮东', 4, '大型法会临时僧众寮房')
    RETURNING id INTO v_ra;
    INSERT INTO rooms (id, room_no, capacity, note)
    VALUES ('aaaaaaaa-3000-4000-8000-000000000002', '法会寮西', 4, '大型法会临时僧众寮房')
    RETURNING id INTO v_rb;

    FOR i IN 1..4 LOOP
        INSERT INTO beds (room_id, bed_no) VALUES (v_ra, i::text);
        INSERT INTO beds (room_id, bed_no) VALUES (v_rb, i::text);
    END LOOP;

    INSERT INTO ceremonies (id, name, start_date, end_date, daily_capacity, note, status)
    VALUES (v_cid, '二〇二六年秋季精进佛七', '2026-10-01', '2026-10-07', 6,
            '十方丛林联合精进，客堂统筹接待与床位', 'preparing');

    -- 临时僧人档（ceremony 身份，不进常规考勤）
    INSERT INTO monks (id, dharma_name, home_monastery, ordination_no, status) VALUES
        (v_m1, '寂光', '江西云居山真如寺', 'FH20260101', 'ceremony'),
        (v_m2, '朗照', '苏州灵岩山寺',     'FH20260102', 'ceremony'),
        (v_m3, '克勤', '湖南夹山灵泉禅院', 'FH20260103', 'ceremony'),
        (v_m4, '慧圆', '福建莆田广化寺',   'FH20260104', 'ceremony'),
        (v_m5, '佛源', '广东云门大觉禅寺', 'FH20260105', 'ceremony'),
        (v_m6, '净天', '西安卧龙寺',       'FH20260106', 'ceremony'),
        (v_m7, '安忍', '宁波天童寺',       'FH20260107', 'ceremony'),
        (v_m8, '道安', '成都昭觉寺',       'FH20260108', 'ceremony');

    -- 6 人在名额内，第 7、8 人进入候补
    INSERT INTO ceremony_participants
        (id, ceremony_id, monk_id, dharma_name, home_monastery, ordination_no,
         group_key, arrive_date, leave_date, special_need, status) VALUES
        (v_p1, v_cid, v_m1, '寂光', '江西云居山真如寺', 'FH20260101',
         '2026-10-01~2026-10-07|腿脚不便，安排下层', '2026-10-01', '2026-10-07',
         '腿脚不便，安排下层', 'registered'),
        (v_p2, v_cid, v_m2, '朗照', '苏州灵岩山寺', 'FH20260102',
         '2026-10-01~2026-10-07|', '2026-10-01', '2026-10-07', NULL, 'registered'),
        (v_p3, v_cid, v_m3, '克勤', '湖南夹山灵泉禅院', 'FH20260103',
         '2026-10-01~2026-10-07|', '2026-10-01', '2026-10-07', NULL, 'registered'),
        (v_p4, v_cid, v_m4, '慧圆', '福建莆田广化寺', 'FH20260104',
         '2026-10-02~2026-10-07|过午不食', '2026-10-02', '2026-10-07',
         '过午不食，需斋堂照应', 'registered'),
        (v_p5, v_cid, v_m5, '佛源', '广东云门大觉禅寺', 'FH20260105',
         '2026-10-02~2026-10-07|过午不食', '2026-10-02', '2026-10-07',
         '过午不食，需斋堂照应', 'registered'),
        (v_p6, v_cid, v_m6, '净天', '西安卧龙寺', 'FH20260106',
         '2026-10-01~2026-10-07|', '2026-10-01', '2026-10-07', NULL, 'registered'),
        (v_p7, v_cid, v_m7, '安忍', '宁波天童寺', 'FH20260107',
         '2026-10-01~2026-10-07|', '2026-10-01', '2026-10-07', NULL, 'waitlisted'),
        (v_p8, v_cid, v_m8, '道安', '成都昭觉寺', 'FH20260108',
         '2026-10-01~2026-10-07|', '2026-10-01', '2026-10-07', NULL, 'waitlisted');

    -- 前 5 人已按组安排床位
    SELECT array_agg(b.id ORDER BY b.bed_no) INTO v_beds FROM beds b
      JOIN rooms r ON r.id=b.room_id WHERE r.id IN (v_ra, v_rb);
    INSERT INTO ceremony_bed_assignments
        (ceremony_id, participant_id, bed_id, stay_range, assignment_type, assigned_by)
    VALUES
        (v_cid, v_p1, v_beds[1], daterange('2026-10-01','2026-10-08'), 'auto', '寮元'),
        (v_cid, v_p2, v_beds[2], daterange('2026-10-01','2026-10-08'), 'auto', '寮元'),
        (v_cid, v_p3, v_beds[3], daterange('2026-10-01','2026-10-08'), 'auto', '寮元'),
        (v_cid, v_p4, v_beds[5], daterange('2026-10-02','2026-10-08'), 'auto', '寮元'),
        (v_cid, v_p5, v_beds[6], daterange('2026-10-02','2026-10-08'), 'auto', '寮元');

    INSERT INTO ceremony_event_log (ceremony_id, participant_id, action, detail) VALUES
        (v_cid, NULL,  'import_batch',
         '{"batch_no":1,"total":8,"imported":6,"waitlisted":2,"errors":0}'::jsonb),
        (v_cid, v_p1, 'auto_assign', '{"bed":"法会寮东 · 1床","group":"特殊需求聚住"}'::jsonb),
        (v_cid, v_p7, 'import', '{"result":"waitlisted","over_day":"2026-10-01"}'::jsonb),
        (v_cid, v_p8, 'import', '{"result":"waitlisted","over_day":"2026-10-01"}'::jsonb);
END $$;

