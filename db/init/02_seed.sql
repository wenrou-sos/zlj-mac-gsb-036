-- =====================================================================
-- 演示数据（仅开发环境）
-- =====================================================================

-- 寮房
INSERT INTO rooms (id, room_no, capacity, note) VALUES
    ('11111111-1111-1111-1111-111111111101', '东单1号', 2, '云水寮'),
    ('11111111-1111-1111-1111-111111111102', '东单2号', 2, '云水寮'),
    ('11111111-1111-1111-1111-111111111103', '西单1号', 2, '云水寮'),
    ('11111111-1111-1111-1111-111111111104', '静修楼101', 1, '方丈寮'),
    ('11111111-1111-1111-1111-111111111105', '静修楼201', 1, '寮元安排'),
    ('11111111-1111-1111-1111-111111111106', '静修楼202', 1, '寮元安排'),
    ('11111111-1111-1111-1111-111111111107', '静修楼203', 1, '寮元安排'),
    ('11111111-1111-1111-1111-111111111108', '静修楼204', 1, '空闲');

-- 床位（每房按 capacity 生成 1..n）
INSERT INTO beds (room_id, bed_no)
SELECT r.id, g.bed_no
FROM rooms r
CROSS JOIN LATERAL generate_series(1, r.capacity) AS g(bed_no);

-- 常住僧人
INSERT INTO monks (id, dharma_name, home_monastery, ordination_no, generation, tonsure_master,
                   ordination_date, ordination_place, current_post, status, note)
VALUES
    ('22222222-2222-2222-2222-222222222201', '智明', '泉州承天寺', 'JD20120086', '智',
     '上圆下拙', '2012-10-15', '江西云居山真如寺', '方丈', 'permanent', NULL),
    ('22222222-2222-2222-2222-222222222202', '慧海', '苏州灵岩山寺', 'JD20150142', '慧',
     '上明下学', '2015-04-08', '江苏宝华山隆昌寺', '知客', 'permanent', '客堂日常接待'),
    ('22222222-2222-2222-2222-222222222203', '妙音', '天台国清寺', 'JD20170233', '妙',
     '上可下明', '2017-11-03', '浙江天台山国清寺', '维那', 'permanent', '领众唱念'),
    ('22222222-2222-2222-2222-222222222204', '庆云', '广东南华寺', 'JD20160077', '庆',
     '上传下正', '2016-09-20', '广东南华寺', '典座', 'permanent', '五观堂'),
    ('22222222-2222-2222-2222-222222222205', '常济', '镇江金山寺', 'JD20180319', '常',
     '上慈下舟', '2018-05-22', '江苏句容宝华山', '僧值', 'permanent', '考勤登记');

-- 挂单僧人（在寺）
INSERT INTO monks (id, dharma_name, home_monastery, ordination_no, status, note)
VALUES
    ('22222222-2222-2222-2222-222222222211', '法远', '河南嵩山少林寺', 'JD20210455', 'guadan', NULL),
    ('22222222-2222-2222-2222-222222222212', '善持', '四川峨眉山报国寺', 'JD20200661', 'guadan', NULL),
    ('22222222-2222-2222-2222-222222222213', '行简', '湖南南岳祝圣寺', 'JD20190208', 'inspection', '发心常住，考察中'),
    ('22222222-2222-2222-2222-222222222214', '定空', '福建广化寺', 'JD20220770', 'inspection', NULL),
    -- 有缺勤情况的挂单僧人（用于自动提醒演示）
    ('22222222-2222-2222-2222-222222222215', '演戒', '山西五台山塔院寺', 'JD20210899', 'guadan', '近日常往医院照看同参');

-- 安排床位
DO $$
DECLARE
    bed_gu1 UUID; bed_gu2 UUID; bed_gu3 UUID; bed_gu4 UUID; bed_gu5 UUID;
    bed_p1 UUID; bed_p2 UUID; bed_p3 UUID; bed_p4 UUID; bed_p5 UUID;
BEGIN
    SELECT b.id INTO bed_gu1 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='东单1号' AND b.bed_no='1';
    SELECT b.id INTO bed_gu2 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='东单2号' AND b.bed_no='1';
    SELECT b.id INTO bed_gu3 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='东单1号' AND b.bed_no='2';
    SELECT b.id INTO bed_gu4 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='西单1号' AND b.bed_no='1';
    SELECT b.id INTO bed_gu5 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='东单2号' AND b.bed_no='2';
    SELECT b.id INTO bed_p1 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='静修楼101' AND b.bed_no='1';
    SELECT b.id INTO bed_p2 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='静修楼201' AND b.bed_no='1';
    SELECT b.id INTO bed_p3 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='静修楼202' AND b.bed_no='1';
    SELECT b.id INTO bed_p4 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='静修楼203' AND b.bed_no='1';
    SELECT b.id INTO bed_p5 FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no='西单1号' AND b.bed_no='2';

    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222211' WHERE id=bed_gu1;
    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222212' WHERE id=bed_gu2;
    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222213' WHERE id=bed_gu3;
    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222214' WHERE id=bed_gu4;
    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222215' WHERE id=bed_gu5;

    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222201' WHERE id=bed_p1;
    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222202' WHERE id=bed_p2;
    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222203' WHERE id=bed_p3;
    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222204' WHERE id=bed_p4;
    UPDATE beds SET monk_id='22222222-2222-2222-2222-222222222205' WHERE id=bed_p5;
END $$;

-- 挂单记录
INSERT INTO guadan (monk_id, arrive_date, expected_days, bed_id, status, note)
SELECT '22222222-2222-2222-2222-222222222211', CURRENT_DATE - 4,  15, b.id, 'active', NULL
FROM beds b WHERE b.monk_id='22222222-2222-2222-2222-222222222211';
INSERT INTO guadan (monk_id, arrive_date, expected_days, bed_id, status)
SELECT '22222222-2222-2222-2222-222222222212', CURRENT_DATE - 9, 30, b.id, 'active'
FROM beds b WHERE b.monk_id='22222222-2222-2222-2222-222222222212';
INSERT INTO guadan (monk_id, arrive_date, expected_days, bed_id, status, note)
SELECT '22222222-2222-2222-2222-222222222215', CURRENT_DATE - 12, 20, b.id, 'active', '住满预计日期后续单'
FROM beds b WHERE b.monk_id='22222222-2222-2222-2222-222222222215';

-- 考察期僧人：挂单记录仍 active（住众身份延续）
INSERT INTO guadan (id, monk_id, arrive_date, expected_days, bed_id, status)
SELECT '33333333-3333-3333-3333-333333333301', '22222222-2222-2222-2222-222222222213',
       CURRENT_DATE - 70, 120, b.id, 'active'
FROM beds b WHERE b.monk_id='22222222-2222-2222-2222-222222222213';
INSERT INTO guadan (id, monk_id, arrive_date, expected_days, bed_id, status)
SELECT '33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222214',
       CURRENT_DATE - 88, 120, b.id, 'active'
FROM beds b WHERE b.monk_id='22222222-2222-2222-2222-222222222214';

INSERT INTO inspections (id, monk_id, guadan_id, start_date, expected_end, result, note, stage_summary)
VALUES
    ('44444444-4444-4444-4444-444444444401',
     '22222222-2222-2222-2222-222222222213',
     '33333333-3333-3333-3333-333333333301',
     CURRENT_DATE - 70, (CURRENT_DATE - 70 + INTERVAL '3 months')::date, 'pending',
     '随众用功，行持稳重', NULL),
    ('44444444-4444-4444-4444-444444444402',
     '22222222-2222-2222-2222-222222222214',
     '33333333-3333-3333-3333-333333333302',
     CURRENT_DATE - 88, (CURRENT_DATE - 88 + INTERVAL '3 months')::date, 'pending',
     NULL,
     '三月以来戒行清净、随众用功，执事评议均分达标，无缺勤待办，同意提交羯磨转常住。');

-- ---------------------------------------------------------------------
-- 月度评议会次（行简：前两月已汇总，第三月收评分中，维那缺席待补评；
--                定空：三月评议均已汇总，均分达标，可发起羯磨）
-- ---------------------------------------------------------------------
INSERT INTO review_rounds
    (id, inspection_id, seq_no, period_start, period_end, meeting_date, status,
     average_score, conclusion, summary_note, summarized_by, summarized_at)
VALUES
    ('55555555-5555-5555-5555-550000000101', '44444444-4444-4444-4444-444444444401', 1,
     CURRENT_DATE - 70, (CURRENT_DATE - 70 + INTERVAL '1 month')::date - 1,
     (CURRENT_DATE - 70 + INTERVAL '1 month')::date, 'summarized',
     78.25, 'qualified', '初来规矩生疏，道心尚好，宜多提点丛林规矩。', '知客',
     (CURRENT_DATE - 70 + INTERVAL '1 month')::date + INTERVAL '1 day'),
    ('55555555-5555-5555-5555-550000000102', '44444444-4444-4444-4444-444444444401', 2,
     (CURRENT_DATE - 70 + INTERVAL '1 month')::date,
     (CURRENT_DATE - 70 + INTERVAL '2 months')::date - 1,
     (CURRENT_DATE - 70 + INTERVAL '2 months')::date, 'summarized',
     80.25, 'qualified', '行持渐稳；典座当月外出参学，归寺后已补评。', '知客',
     (CURRENT_DATE - 70 + INTERVAL '2 months')::date + INTERVAL '1 day'),
    ('55555555-5555-5555-5555-550000000103', '44444444-4444-4444-4444-444444444401', 3,
     (CURRENT_DATE - 70 + INTERVAL '2 months')::date,
     (CURRENT_DATE - 70 + INTERVAL '3 months')::date - 1,
     CURRENT_DATE, 'collecting', NULL, NULL, NULL, NULL, NULL),
    ('55555555-5555-5555-5555-550000000201', '44444444-4444-4444-4444-444444444402', 1,
     CURRENT_DATE - 88, (CURRENT_DATE - 88 + INTERVAL '1 month')::date - 1,
     (CURRENT_DATE - 88 + INTERVAL '1 month')::date, 'summarized',
     82.75, 'qualified', '威仪规矩尚可，功课熟悉尚需时日。', '知客',
     (CURRENT_DATE - 88 + INTERVAL '1 month')::date + INTERVAL '1 day'),
    ('55555555-5555-5555-5555-550000000202', '44444444-4444-4444-4444-444444444402', 2,
     (CURRENT_DATE - 88 + INTERVAL '1 month')::date,
     (CURRENT_DATE - 88 + INTERVAL '2 months')::date - 1,
     (CURRENT_DATE - 88 + INTERVAL '2 months')::date, 'summarized',
     85.00, 'qualified', '领众配合得力，出坡作务勤恳。', '知客',
     (CURRENT_DATE - 88 + INTERVAL '2 months')::date + INTERVAL '1 day'),
    ('55555555-5555-5555-5555-550000000203', '44444444-4444-4444-4444-444444444402', 3,
     (CURRENT_DATE - 88 + INTERVAL '2 months')::date,
     (CURRENT_DATE - 88 + INTERVAL '3 months')::date - 1,
     CURRENT_DATE, 'summarized',
     88.00, 'excellent', '戒行清净，堪许常住；请提交羯磨。', '知客', now());

-- 每月评议名册：知客、维那、典座、僧值四位执事独立评分
INSERT INTO review_reviewers (round_id, reviewer_id, reviewer_name, reviewer_role, seat_no)
SELECT r.id, m.id, m.dharma_name, m.current_post,
       array_position(ARRAY['22222222-2222-2222-2222-222222222202',
                            '22222222-2222-2222-2222-222222222203',
                            '22222222-2222-2222-2222-222222222204',
                            '22222222-2222-2222-2222-222222222205']::uuid[], m.id)
FROM review_rounds r
JOIN monks m ON m.id IN (
    '22222222-2222-2222-2222-222222222202',
    '22222222-2222-2222-2222-222222222203',
    '22222222-2222-2222-2222-222222222204',
    '22222222-2222-2222-2222-222222222205');

-- 行简 · 第一月（四位执事均按期评分）
INSERT INTO review_scores (round_id, reviewer_id, score, comment, submitted_at)
VALUES
    ('55555555-5555-5555-5555-550000000101', '22222222-2222-2222-2222-222222222202', 78.00, '规矩生疏，客堂已多予引导。', CURRENT_DATE - 39),
    ('55555555-5555-5555-5555-550000000101', '22222222-2222-2222-2222-222222222203', 80.00, '唱念尚在学习，态度端正。', CURRENT_DATE - 39),
    ('55555555-5555-5555-5555-550000000101', '22222222-2222-2222-2222-222222222204', 76.00, '大寮发心踏实。', CURRENT_DATE - 39),
    ('55555555-5555-5555-5555-550000000101', '22222222-2222-2222-2222-222222222205', 79.00, '早晚课全勤，无缺勤。', CURRENT_DATE - 39);

-- 行简 · 第二月（典座庆云评议会当日外出，归寺后缺席补评；知客评分经一次修订）
INSERT INTO review_scores (id, round_id, reviewer_id, score, comment, submission_type, absent_reason, submitted_at)
VALUES
    ('66666666-6666-6666-6666-660000000101', '55555555-5555-5555-5555-550000000102',
     '22222222-2222-2222-2222-222222222202', 80.00, '随众安稳，月末复核后予以加分。', 'normal', NULL, CURRENT_DATE - 9),
    ('66666666-6666-6666-6666-660000000102', '55555555-5555-5555-5555-550000000102',
     '22222222-2222-2222-2222-222222222203', 84.00, '梵腔日渐纯熟，可助悦众。', 'normal', NULL, CURRENT_DATE - 9),
    ('66666666-6666-6666-6666-660000000103', '55555555-5555-5555-5555-550000000102',
     '22222222-2222-2222-2222-222222222204', 75.00, '大寮轮值认真，所陈与所见相符。', 'makeup',
     '评议会当日随外单参学，五日后归寺补评', CURRENT_DATE - 4),
    ('66666666-6666-6666-6666-660000000104', '55555555-5555-5555-5555-550000000102',
     '22222222-2222-2222-2222-222222222205', 82.00, '本月考勤齐备。', 'normal', NULL, CURRENT_DATE - 9);

-- 知客评分修订留痕（78 → 80）
INSERT INTO score_revisions (score_id, round_id, reviewer_id, reviewer_name,
                              old_score, new_score, old_comment, new_comment,
                              reason, revised_by, revised_at)
VALUES
    ('66666666-6666-6666-6666-660000000101', '55555555-5555-5555-5555-550000000102',
     '22222222-2222-2222-2222-222222222202', '慧海',
     78.00, 80.00, '随众尚可。', '随众安稳，月末复核后予以加分。',
     '月末复核行持，初评偏保守，依规修订并留痕', '知客 慧海', CURRENT_DATE - 3);

-- 行简 · 第三月（收评分中：维那妙音因病缺席，尚未补评）
INSERT INTO review_scores (round_id, reviewer_id, score, comment, submitted_at)
VALUES
    ('55555555-5555-5555-5555-550000000103', '22222222-2222-2222-2222-222222222202', 85.00, '客堂接待发心，愈见稳练。', CURRENT_DATE),
    ('55555555-5555-5555-5555-550000000103', '22222222-2222-2222-2222-222222222204', 82.00, '大寮公务未曾推托。', CURRENT_DATE),
    ('55555555-5555-5555-5555-550000000103', '22222222-2222-2222-2222-222222222205', 84.00, '考勤依旧齐整。', CURRENT_DATE);

-- 定空 · 第一月
INSERT INTO review_scores (round_id, reviewer_id, score, comment, submitted_at)
VALUES
    ('55555555-5555-5555-5555-550000000201', '22222222-2222-2222-2222-222222222202', 82.00, '威仪有度，应答合宜。', CURRENT_DATE - 57),
    ('55555555-5555-5555-5555-550000000201', '22222222-2222-2222-2222-222222222203', 85.00, '课诵字句清楚。', CURRENT_DATE - 57),
    ('55555555-5555-5555-5555-550000000201', '22222222-2222-2222-2222-222222222204', 80.00, '随众出坡不落后。', CURRENT_DATE - 57),
    ('55555555-5555-5555-5555-550000000201', '22222222-2222-2222-2222-222222222205', 84.00, '无缺勤记录。', CURRENT_DATE - 57);

-- 定空 · 第二月
INSERT INTO review_scores (round_id, reviewer_id, score, comment, submitted_at)
VALUES
    ('55555555-5555-5555-5555-550000000202', '22222222-2222-2222-2222-222222222202', 85.00, '客堂应酬知进退。', CURRENT_DATE - 27),
    ('55555555-5555-5555-5555-550000000202', '22222222-2222-2222-2222-222222222203', 87.00, '梵呗清亮，可辅维那。', CURRENT_DATE - 27),
    ('55555555-5555-5555-5555-550000000202', '22222222-2222-2222-2222-222222222204', 82.00, '惜福劳作，不厌粗重。', CURRENT_DATE - 27),
    ('55555555-5555-5555-5555-550000000202', '22222222-2222-2222-2222-222222222205', 86.00, '全勤，请假亦依规告假。', CURRENT_DATE - 27);

-- 定空 · 第三月（当月汇总，均分 88，优秀）
INSERT INTO review_scores (round_id, reviewer_id, score, comment, submitted_at)
VALUES
    ('55555555-5555-5555-5555-550000000203', '22222222-2222-2222-2222-222222222202', 88.00, '三月考察，行持一贯。', CURRENT_DATE),
    ('55555555-5555-5555-5555-550000000203', '22222222-2222-2222-2222-222222222203', 90.00, '唱念法器俱可胜任。', CURRENT_DATE),
    ('55555555-5555-5555-5555-550000000203', '22222222-2222-2222-2222-222222222204', 85.00, '大寮公务精勤。', CURRENT_DATE),
    ('55555555-5555-5555-5555-550000000203', '22222222-2222-2222-2222-222222222205', 89.00, '考勤清白。', CURRENT_DATE);

-- 已完成的历史挂单（舍单）
INSERT INTO monks (id, dharma_name, home_monastery, ordination_no, status)
VALUES ('22222222-2222-2222-2222-222222222221', '净一', '庐山东林寺', 'JD20190510', 'left');
INSERT INTO guadan (monk_id, arrive_date, expected_days, status, leave_date, note)
VALUES ('22222222-2222-2222-2222-222222222221',
        CURRENT_DATE - 100, 7, 'closed', CURRENT_DATE - 94, '朝山完毕，继续参学');

-- ---------------------------------------------------------------------
-- 考勤：近 7 天，常住与挂单众默认随众；演戒近三日早晚课缺勤共 4 次
-- ---------------------------------------------------------------------
INSERT INTO attendance (monk_id, attend_date, session, status)
SELECT m.id, d.d::date, s.sess::session_type, 'present'::attendance_status
FROM monks m
CROSS JOIN generate_series(CURRENT_DATE - 6, CURRENT_DATE - 3, INTERVAL '1 day') AS d(d)
CROSS JOIN (VALUES ('morning'), ('evening')) AS s(sess)
WHERE m.status IN ('permanent','guadan','inspection');

INSERT INTO attendance (monk_id, attend_date, session, status)
SELECT m.id, d.d::date, s.sess::session_type,
       (CASE WHEN m.id = '22222222-2222-2222-2222-222222222215'
                 AND d.d::date >= CURRENT_DATE - 2 THEN 'absent'
            WHEN m.id = '22222222-2222-2222-2222-222222222212'
                 AND d.d::date = CURRENT_DATE - 1 AND s.sess = 'evening' THEN 'leave'
            ELSE 'present' END)::attendance_status
FROM monks m
CROSS JOIN generate_series(CURRENT_DATE - 2, CURRENT_DATE, INTERVAL '1 day') AS d(d)
CROSS JOIN (VALUES ('morning'), ('evening')) AS s(sess)
WHERE m.status IN ('permanent','guadan','inspection')
  AND NOT (m.id = '22222222-2222-2222-2222-222222222215' AND d.d::date = CURRENT_DATE);

-- 演戒近 30 日缺勤满 3 次，absence_alerts 由触发器自动生成
-- （见 01_schema.sql 中 trg_attendance_absence）
