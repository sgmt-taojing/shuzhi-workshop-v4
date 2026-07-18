/**
 * 预约演示系统 API
 * 
 * 功能：
 * - 用户提交预约演示请求（选择日期、时间段、演示方式）
 * - 管理员查看/确认/取消/重新安排预约
 * - 时间段管理（自动生成+手动配置）
 * - 预约提醒（模板消息/订阅消息）
 * - 数据统计
 */

const { getDB, nextId, save, syncRow, getRawDB } = require('../models/db');
const { sendTemplateMessage } = require('./template-msg');
const router = require('express').Router();

// ─────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────

function genBookingNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `BK${ymd}${rand}`;
}

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 默认时间段
const DEFAULT_TIME_SLOTS = [
  '09:00', '09:30', '10:00', '10:30',
  '11:00', '11:30', '14:00', '14:30',
  '15:00', '15:30', '16:00', '16:30',
  '17:00', '17:30'
];

// 周末判断
function isWeekend(date) {
  const day = new Date(date).getDay();
  return day === 0 || day === 6;
}

// ─────────────────────────────────────────
// 1. GET /api/bookings/slots
//    获取可用时间段（未来14天）
//    query: ?days=14
// ─────────────────────────────────────────
router.get('/slots', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;
    const rawDB = getRawDB();
    const today = new Date();
    const result = [];

    for (let i = 1; i <= days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dateStr = formatDate(date);
      const weekend = isWeekend(date);

      // 查询该日期已配置的时间段
      const existingSlots = rawDB.prepare(
        'SELECT * FROM booking_slots WHERE slot_date = ? ORDER BY slot_time'
      ).all(dateStr);

      let slots;
      if (existingSlots.length > 0) {
        // 使用已配置的时间段
        slots = existingSlots.map(s => ({
          time: s.slot_time,
          max: s.max_bookings,
          current: s.current_bookings,
          available: s.enabled && (s.current_bookings < s.max_bookings),
          enabled: !!s.enabled
        }));
      } else {
        // 自动生成默认时间段（周末减半）
        const timeList = weekend ? DEFAULT_TIME_SLOTS.filter((_, idx) => idx % 2 === 0) : DEFAULT_TIME_SLOTS;
        slots = timeList.map(t => ({
          time: t,
          max: 3,
          current: 0,
          available: true,
          enabled: true
        }));
      }

      result.push({
        date: dateStr,
        weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(dateStr).getDay()],
        weekend,
        slots
      });
    }

    res.json(result);
  } catch (err) {
    console.error('获取时间段失败:', err);
    res.status(500).json({ error: '获取时间段失败' });
  }
});

// ─────────────────────────────────────────
// 2. POST /api/bookings
//    提交预约演示
//    body: { product_id, product_title, product_type, name, phone, company, position, industry, email, demo_date, demo_time, demo_format, message, openid }
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      product_id, product_title, product_type,
      name, phone, company, position, industry, email,
      demo_date, demo_time, demo_format, message, openid
    } = req.body;

    // 基础校验
    if (!name || !name.trim()) {
      return res.status(400).json({ error: '请填写姓名' });
    }
    if (name.trim().length > 20) {
      return res.status(400).json({ error: '姓名不能超过20个字符' });
    }
    if (!phone || !/^1[3-9]\d{9}$/.test(phone.trim())) {
      return res.status(400).json({ error: '请输入正确的手机号' });
    }
    if (!demo_date || !demo_time) {
      return res.status(400).json({ error: '请选择预约日期和时间段' });
    }

    // 检查日期不能是过去
    const today = formatDate(new Date());
    if (demo_date < today) {
      return res.status(400).json({ error: '预约日期不能早于今天' });
    }

    // XSS 防护
    const xssPattern = /<script|javascript:|on\w+=/i;
    if (xssPattern.test(name + (company || '') + (message || ''))) {
      return res.status(400).json({ error: '提交内容包含不安全字符' });
    }

    const rawDB = getRawDB();

    // 检查时间段是否已被约满
    let slot = rawDB.prepare(
      'SELECT * FROM booking_slots WHERE slot_date = ? AND slot_time = ?'
    ).get(demo_date, demo_time);

    if (slot && slot.current_bookings >= slot.max_bookings) {
      return res.status(400).json({ error: '该时间段已约满，请选择其他时间段' });
    }

    // 检查同一手机号当天是否已预约
    const existingBooking = rawDB.prepare(
      "SELECT id FROM bookings WHERE phone = ? AND demo_date = ? AND status IN ('pending', 'confirmed')"
    ).get(phone.trim(), demo_date);
    if (existingBooking) {
      return res.status(400).json({ error: '您当天已有预约，请更换日期或取消原有预约' });
    }

    // 创建预约
    const bookingId = nextId('bookings');
    const bookingNo = genBookingNo();
    const now = new Date().toISOString();

    rawDB.prepare(`
      INSERT INTO bookings (id, booking_no, product_id, product_title, product_type, name, phone, company, position, industry, email, demo_date, demo_time, demo_format, message, status, openid, created_at, updated_at)
      VALUES (@id, @booking_no, @product_id, @product_title, @product_type, @name, @phone, @company, @position, @industry, @email, @demo_date, @demo_time, @demo_format, @message, 'pending', @openid, @created_at, @updated_at)
    `).run({
      id: bookingId,
      booking_no: bookingNo,
      product_id: product_id || 0,
      product_title: product_title || '',
      product_type: product_type || 'product',
      name: name.trim(),
      phone: phone.trim(),
      company: (company || '').trim(),
      position: (position || '').trim(),
      industry: (industry || '').trim(),
      email: (email || '').trim(),
      demo_date,
      demo_time,
      demo_format: demo_format || 'online',
      message: (message || '').trim(),
      openid: openid || '',
      created_at: now,
      updated_at: now
    });

    // 更新时间段预约数
    if (slot) {
      rawDB.prepare(
        'UPDATE booking_slots SET current_bookings = current_bookings + 1 WHERE slot_date = ? AND slot_time = ?'
      ).run(demo_date, demo_time);
    } else {
      // 自动创建 slot 记录
      rawDB.prepare(
        'INSERT OR IGNORE INTO booking_slots (slot_date, slot_time, max_bookings, current_bookings, enabled) VALUES (?, ?, 3, 1, 1)'
      ).run(demo_date, demo_time);
    }

    // 异步通知管理员
    try {
      const adminNotifyData = {
        first: { value: '📅 有新的预约演示请求', color: '#2563EB' },
        keyword1: { value: name.trim(), color: '#333' },
        keyword2: { value: phone.trim(), color: '#333' },
        keyword3: { value: `${demo_date} ${demo_time}`, color: '#E53E30' },
        keyword4: { value: product_title || '通用咨询', color: '#333' },
        remark: { value: `企业：${company || '未填写'}\n行业：${industry || '未填写'}\n演示方式：${demo_format === 'online' ? '线上会议' : '线下拜访'}\n留言：${message || '无'}`, color: '#666' }
      };
      // 尝试发送模板消息（不阻塞）
      sendTemplateMessage('admin', 'booking_notify', adminNotifyData).catch(() => {});
    } catch (e) {
      console.warn('通知管理员失败:', e.message);
    }

    res.json({
      success: true,
      booking_no: bookingNo,
      booking_id: bookingId,
      message: '预约成功！我们的顾问将在1个工作日内与您联系确认。'
    });
  } catch (err) {
    console.error('创建预约失败:', err);
    res.status(500).json({ error: '创建预约失败: ' + err.message });
  }
});

// ─────────────────────────────────────────
// 3. GET /api/bookings
//    查询预约列表（管理端/用户端）
//    query: ?status=pending&page=1&limit=20&phone=xxx&date=2026-06-22
// ─────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const rawDB = getRawDB();
    const { status, phone, date, openid } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let where = [];
    let params = {};

    if (status && status !== 'all') {
      where.push('status = @status');
      params.status = status;
    }
    if (phone) {
      where.push('phone = @phone');
      params.phone = phone;
    }
    if (date) {
      where.push('demo_date = @date');
      params.date = date;
    }
    if (openid) {
      where.push('openid = @openid');
      params.openid = openid;
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const total = rawDB.prepare(`SELECT COUNT(*) as c FROM bookings ${whereClause}`).get(params).c;
    const rows = rawDB.prepare(
      `SELECT * FROM bookings ${whereClause} ORDER BY demo_date DESC, demo_time DESC LIMIT ${limit} OFFSET ${offset}`
    ).all(params);

    res.json({
      list: rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('查询预约列表失败:', err);
    res.status(500).json({ error: '查询失败' });
  }
});

// ─────────────────────────────────────────
// 4. GET /api/bookings/:id
//    预约详情
// ─────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const rawDB = getRawDB();
    const booking = rawDB.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }
    res.json(booking);
  } catch (err) {
    console.error('查询预约详情失败:', err);
    res.status(500).json({ error: '查询失败' });
  }
});

// ─────────────────────────────────────────
// 5. PUT /api/bookings/:id/status
//    更新预约状态
//    body: { status, assigned_to, meeting_link, meeting_location, remark }
// ─────────────────────────────────────────
router.put('/:id/status', (req, res) => {
  try {
    const rawDB = getRawDB();
    const bookingId = Number(req.params.id);
    const { status, assigned_to, meeting_link, meeting_location, remark } = req.body;

    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled', 'rescheduled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: '无效的预约状态' });
    }

    const booking = rawDB.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }

    const updates = { status, updated_at: new Date().toISOString() };
    if (assigned_to !== undefined) updates.assigned_to = assigned_to;
    if (meeting_link !== undefined) updates.meeting_link = meeting_link;
    if (meeting_location !== undefined) updates.meeting_location = meeting_location;
    if (remark !== undefined) updates.remark = remark;

    const setClauses = Object.keys(updates).map(k => `${k} = @${k}`);
    updates.id = bookingId;
    rawDB.prepare(`UPDATE bookings SET ${setClauses.join(', ')} WHERE id = @id`).run(updates);

    // 如果取消预约，释放时间段名额
    if (status === 'cancelled' && booking.status !== 'cancelled') {
      rawDB.prepare(
        'UPDATE booking_slots SET current_bookings = MAX(0, current_bookings - 1) WHERE slot_date = ? AND slot_time = ?'
      ).run(booking.demo_date, booking.demo_time);
    }

    res.json({ success: true, message: '状态更新成功' });
  } catch (err) {
    console.error('更新预约状态失败:', err);
    res.status(500).json({ error: '更新失败' });
  }
});

// ─────────────────────────────────────────
// 6. PUT /api/bookings/:id/reschedule
//    重新安排预约时间
//    body: { demo_date, demo_time }
// ─────────────────────────────────────────
router.put('/:id/reschedule', (req, res) => {
  try {
    const rawDB = getRawDB();
    const bookingId = Number(req.params.id);
    const { demo_date, demo_time } = req.body;

    if (!demo_date || !demo_time) {
      return res.status(400).json({ error: '请提供新的日期和时间段' });
    }

    const booking = rawDB.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }

    // 释放旧时间段
    rawDB.prepare(
      'UPDATE booking_slots SET current_bookings = MAX(0, current_bookings - 1) WHERE slot_date = ? AND slot_time = ?'
    ).run(booking.demo_date, booking.demo_time);

    // 检查新时间段
    let newSlot = rawDB.prepare(
      'SELECT * FROM booking_slots WHERE slot_date = ? AND slot_time = ?'
    ).get(demo_date, demo_time);

    if (newSlot && newSlot.current_bookings >= newSlot.max_bookings) {
      // 恢复旧时间段
      rawDB.prepare(
        'UPDATE booking_slots SET current_bookings = current_bookings + 1 WHERE slot_date = ? AND slot_time = ?'
      ).run(booking.demo_date, booking.demo_time);
      return res.status(400).json({ error: '新时间段已约满' });
    }

    // 更新预约
    rawDB.prepare(
      'UPDATE bookings SET demo_date = ?, demo_time = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(demo_date, demo_time, 'rescheduled', new Date().toISOString(), bookingId);

    // 占用新时间段
    if (newSlot) {
      rawDB.prepare(
        'UPDATE booking_slots SET current_bookings = current_bookings + 1 WHERE slot_date = ? AND slot_time = ?'
      ).run(demo_date, demo_time);
    } else {
      rawDB.prepare(
        'INSERT OR IGNORE INTO booking_slots (slot_date, slot_time, max_bookings, current_bookings, enabled) VALUES (?, ?, 3, 1, 1)'
      ).run(demo_date, demo_time);
    }

    res.json({ success: true, message: '预约时间已更新' });
  } catch (err) {
    console.error('重新安排预约失败:', err);
    res.status(500).json({ error: '操作失败' });
  }
});

// ─────────────────────────────────────────
// 7. DELETE /api/bookings/:id
//    删除预约（仅 cancelled 状态可删除）
// ─────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const rawDB = getRawDB();
    const booking = rawDB.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }
    if (booking.status !== 'cancelled') {
      return res.status(400).json({ error: '只能删除已取消的预约' });
    }
    rawDB.prepare('DELETE FROM bookings WHERE id = ?').run(Number(req.params.id));
    res.json({ success: true, message: '预约已删除' });
  } catch (err) {
    console.error('删除预约失败:', err);
    res.status(500).json({ error: '删除失败' });
  }
});

// ─────────────────────────────────────────
// 8. GET /api/bookings/stats/overview
//    预约统计概览
// ─────────────────────────────────────────
router.get('/stats/overview', (req, res) => {
  try {
    const rawDB = getRawDB();
    const today = formatDate(new Date());

    const stats = {
      total: rawDB.prepare('SELECT COUNT(*) as c FROM bookings').get().c,
      pending: rawDB.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get().c,
      confirmed: rawDB.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'confirmed'").get().c,
      completed: rawDB.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'completed'").get().c,
      cancelled: rawDB.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'cancelled'").get().c,
      today: rawDB.prepare('SELECT COUNT(*) as c FROM bookings WHERE demo_date = ?').get(today).c,
      thisWeek: rawDB.prepare(
        "SELECT COUNT(*) as c FROM bookings WHERE demo_date >= ? AND demo_date <= ?"
      ).get(today, formatDate(new Date(Date.now() + 7 * 86400000))).c,
      byFormat: {
        online: rawDB.prepare("SELECT COUNT(*) as c FROM bookings WHERE demo_format = 'online'").get().c,
        offline: rawDB.prepare("SELECT COUNT(*) as c FROM bookings WHERE demo_format = 'offline'").get().c
      }
    };

    // 转化率
    stats.completionRate = stats.total > 0
      ? ((stats.completed / stats.total) * 100).toFixed(1) + '%'
      : '0%';
    stats.cancelRate = stats.total > 0
      ? ((stats.cancelled / stats.total) * 100).toFixed(1) + '%'
      : '0%';

    // 近7天趋势
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = formatDate(new Date(Date.now() - i * 86400000));
      const count = rawDB.prepare('SELECT COUNT(*) as c FROM bookings WHERE demo_date = ?').get(d).c;
      trend.push({ date: d, count });
    }
    stats.trend = trend;

    // 热门产品
    const hotProducts = rawDB.prepare(`
      SELECT product_title, COUNT(*) as count 
      FROM bookings 
      WHERE product_title != '' 
      GROUP BY product_title 
      ORDER BY count DESC 
      LIMIT 5
    `).all();
    stats.hotProducts = hotProducts;

    res.json(stats);
  } catch (err) {
    console.error('预约统计失败:', err);
    res.status(500).json({ error: '统计失败' });
  }
});

// ─────────────────────────────────────────
// 9. PUT /api/bookings/slots/config
//    配置时间段（管理员）
//    body: { slot_date, slot_time, max_bookings, enabled }
// ─────────────────────────────────────────
router.put('/slots/config', (req, res) => {
  try {
    const rawDB = getRawDB();
    const { slot_date, slot_time, max_bookings, enabled } = req.body;

    if (!slot_date || !slot_time) {
      return res.status(400).json({ error: '请提供日期和时间段' });
    }

    rawDB.prepare(`
      INSERT INTO booking_slots (slot_date, slot_time, max_bookings, current_bookings, enabled)
      VALUES (?, ?, ?, 
        COALESCE((SELECT current_bookings FROM booking_slots WHERE slot_date = ? AND slot_time = ?), 0),
        ?)
      ON CONFLICT(slot_date, slot_time) DO UPDATE SET
        max_bookings = excluded.max_bookings,
        enabled = excluded.enabled
    `).run(slot_date, slot_time, max_bookings || 3, slot_date, slot_time, enabled !== undefined ? (enabled ? 1 : 0) : 1);

    res.json({ success: true, message: '时间段配置已更新' });
  } catch (err) {
    console.error('配置时间段失败:', err);
    res.status(500).json({ error: '配置失败' });
  }
});

module.exports = router;
