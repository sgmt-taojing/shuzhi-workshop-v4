const express = require('express');
const router = express.Router();
const dbModule = require('../models/db');
const db = dbModule.getDB();
const pointsRoute = require('./points');

/**
 * 用户反馈系统
 * 
 * API 列表：
 *   POST   /api/feedback          — 提交反馈
 *   GET    /api/feedback          — 获取反馈列表（admin）
 *   GET    /api/feedback/:id      — 获取反馈详情（admin）
 *   PUT    /api/feedback/:id      — 更新反馈状态/回复（admin）
 *   DELETE /api/feedback/:id      — 删除反馈（admin）
 *   GET    /api/feedback/stats    — 反馈统计（admin）
 */

// ==================== 中间件：管理员鉴权 ====================

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: '未授权' });
  const token = auth.slice(7);
  try {
    const rawDb = dbModule.getRawDB();
    if (!rawDb) return res.status(401).json({ error: '数据库未初始化' });
    const session = rawDb.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
    if (!session) return res.status(401).json({ error: '登录已过期' });
    req.adminUser = { id: session.admin_id, username: session.username };
    next();
  } catch(e) {
    return res.status(401).json({ error: '认证失败' });
  }
}

// ==================== 反馈分类 ====================

const FEEDBACK_CATEGORIES = [
  { key: 'bug', label: '功能异常', icon: '🐛', color: '#ef4444' },
  { key: 'suggestion', label: '功能建议', icon: '💡', color: '#f59e0b' },
  { key: 'experience', label: '使用体验', icon: '💬', color: '#3b82f6' },
  { key: 'complaint', label: '投诉反馈', icon: '⚠️', color: '#dc2626' },
  { key: 'other', label: '其他', icon: '📝', color: '#6b7280' }
];

const STATUS_MAP = {
  'pending': { label: '待处理', color: '#f59e0b', icon: '⏳' },
  'processing': { label: '处理中', color: '#3b82f6', icon: '🔧' },
  'resolved': { label: '已解决', color: '#22c55e', icon: '✅' },
  'closed': { label: '已关闭', color: '#6b7280', icon: '🔒' }
};

// ==================== 路由 ====================

/**
 * GET /api/feedback/categories
 * 获取反馈分类列表（公开）
 */
router.get('/categories', (req, res) => {
  res.json({
    categories: FEEDBACK_CATEGORIES,
    statuses: Object.entries(STATUS_MAP).map(([key, val]) => ({ key, ...val }))
  });
});

/**
 * POST /api/feedback
 * 提交用户反馈
 */
router.post('/', (req, res) => {
  try {
    const {
      category,
      content,
      contact = '',
      openid = '',
      user_id = null,
      rating = 0,
      images = [],
      page = ''
    } = req.body;

    // 参数校验
    if (!content || !content.trim()) {
      return res.status(400).json({ error: '反馈内容不能为空' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ error: '反馈内容不能超过2000字' });
    }

    const validCategory = FEEDBACK_CATEGORIES.find(c => c.key === category);
    if (!validCategory) {
      return res.status(400).json({ error: '无效的反馈分类' });
    }

    // 生成反馈ID
    const feedbackId = (db.feedbacks && db.feedbacks.length > 0)
      ? Math.max(...db.feedbacks.map(f => f.id || 0)) + 1
      : 1;

    const feedback = {
      id: feedbackId,
      category,
      category_label: validCategory.label,
      content: content.trim(),
      contact: contact.trim(),
      openid: openid.trim(),
      user_id: user_id,
      rating: Math.min(5, Math.max(0, parseInt(rating) || 0)),
      images: Array.isArray(images) ? images.slice(0, 9) : [],
      page: page.trim(),
      status: 'pending',
      reply: '',
      replied_at: null,
      replied_by: '',
      created_at: new Date().toISOString()
    };

    if (!db.feedbacks) db.feedbacks = [];
    db.feedbacks.push(feedback);
    db.syncRow('feedbacks', feedback);

    console.log(`[Feedback] 新反馈 #${feedbackId}: ${validCategory.label} - ${content.substring(0, 50)}...`);

    // 积分奖励
    let pointsResult = null;
    if (openid.trim()) {
      pointsResult = pointsRoute.addPoints(openid.trim(), 'submit_feedback', String(feedbackId), '提交反馈: ' + validCategory.label);
    }

    res.json({
      success: true,
      message: '反馈已提交，我们会尽快处理',
      feedback_id: feedbackId,
      points: pointsResult && pointsResult.success ? pointsResult.points : 0
    });
  } catch (err) {
    console.error('[Feedback] 提交失败:', err);
    res.status(500).json({ error: '提交反馈失败: ' + err.message });
  }
});

/**
 * GET /api/feedback
 * 获取反馈列表（管理员）
 * 
 * Query: page, limit, category, status, keyword
 */
router.get('/', adminAuth, (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      category = '',
      status = '',
      keyword = ''
    } = req.query;

    let list = db.feedbacks || [];

    // 筛选
    if (category) list = list.filter(f => f.category === category);
    if (status) list = list.filter(f => f.status === status);
    if (keyword) {
      const kw = keyword.toLowerCase();
      list = list.filter(f =>
        (f.content || '').toLowerCase().includes(kw) ||
        (f.contact || '').toLowerCase().includes(kw)
      );
    }

    // 按时间倒序
    list = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 分页
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const total = list.length;
    const totalPages = Math.ceil(total / limitNum);
    const data = list.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    // 附加分类和状态信息
    const enriched = data.map(f => {
      const cat = FEEDBACK_CATEGORIES.find(c => c.key === f.category) || {};
      const st = STATUS_MAP[f.status] || {};
      return {
        ...f,
        category_info: cat,
        status_info: st
      };
    });

    res.json({
      total,
      page: pageNum,
      limit: limitNum,
      pages: totalPages,
      data: enriched
    });
  } catch (err) {
    console.error('[Feedback] 获取列表失败:', err);
    res.status(500).json({ error: '获取反馈列表失败' });
  }
});

/**
 * GET /api/feedback/stats
 * 反馈统计（管理员）
 */
router.get('/stats', adminAuth, (req, res) => {
  try {
    const list = db.feedbacks || [];

    // 按状态统计
    const byStatus = {};
    Object.keys(STATUS_MAP).forEach(s => {
      byStatus[s] = list.filter(f => f.status === s).length;
    });

    // 按分类统计
    const byCategory = {};
    FEEDBACK_CATEGORIES.forEach(c => {
      byCategory[c.key] = list.filter(f => f.category === c.key).length;
    });

    // 平均评分
    const ratedList = list.filter(f => f.rating > 0);
    const avgRating = ratedList.length > 0
      ? (ratedList.reduce((sum, f) => sum + f.rating, 0) / ratedList.length).toFixed(1)
      : '0.0';

    // 最近7天反馈数
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentCount = list.filter(f => new Date(f.created_at) >= sevenDaysAgo).length;

    res.json({
      total: list.length,
      pending: byStatus.pending,
      processing: byStatus.processing,
      resolved: byStatus.resolved,
      closed: byStatus.closed,
      recent_7days: recentCount,
      avg_rating: avgRating,
      by_status: byStatus,
      by_category: byCategory
    });
  } catch (err) {
    console.error('[Feedback] 统计失败:', err);
    res.status(500).json({ error: '获取反馈统计失败' });
  }
});

/**
 * GET /api/feedback/:id
 * 获取反馈详情（管理员）
 */
router.get('/:id', adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const feedback = (db.feedbacks || []).find(f => f.id === id);

    if (!feedback) {
      return res.status(404).json({ error: '反馈不存在' });
    }

    const cat = FEEDBACK_CATEGORIES.find(c => c.key === feedback.category) || {};
    const st = STATUS_MAP[feedback.status] || {};

    res.json({
      ...feedback,
      category_info: cat,
      status_info: st
    });
  } catch (err) {
    console.error('[Feedback] 获取详情失败:', err);
    res.status(500).json({ error: '获取反馈详情失败' });
  }
});

/**
 * PUT /api/feedback/:id
 * 更新反馈状态/回复（管理员）
 * 
 * Body: { status?, reply? }
 */
router.put('/:id', adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, reply } = req.body;

    const feedback = (db.feedbacks || []).find(f => f.id === id);
    if (!feedback) {
      return res.status(404).json({ error: '反馈不存在' });
    }

    let changed = false;

    if (status && STATUS_MAP[status]) {
      feedback.status = status;
      changed = true;
    }

    if (reply !== undefined) {
      feedback.reply = reply.trim();
      feedback.replied_at = new Date().toISOString();
      feedback.replied_by = req.headers['x-admin-user'] || 'admin';
      changed = true;
    }

    if (changed) {
      feedback.updated_at = new Date().toISOString();
      db.syncRow('feedbacks', feedback);
      console.log(`[Feedback] 更新反馈 #${id}: status=${feedback.status}`);

      // 如果是回复，发送订阅消息通知用户
      if (reply !== undefined && feedback.openid) {
        try {
          const subscribeMsg = require('./subscribe-msg');
          subscribeMsg.notifyUser(
            feedback.openid,
            'feedback_reply',
            {
              thing1: { value: (feedback.content || '').substring(0, 20) },
              thing2: { value: feedback.reply.substring(0, 20) },
              time1: { value: new Date().toLocaleString('zh-CN') }
            },
            `/package-user/pages/feedback/feedback`,
            'feedback',
            id
          );
        } catch (e) {
          console.warn('[Feedback] 发送订阅消息失败:', e.message);
        }
      }
    }

    res.json({
      success: true,
      feedback
    });
  } catch (err) {
    console.error('[Feedback] 更新失败:', err);
    res.status(500).json({ error: '更新反馈失败' });
  }
});

/**
 * DELETE /api/feedback/:id
 * 删除反馈（管理员）
 */
router.delete('/:id', adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = (db.feedbacks || []).findIndex(f => f.id === id);

    if (idx === -1) {
      return res.status(404).json({ error: '反馈不存在' });
    }

    const deleted = db.feedbacks.splice(idx, 1)[0];
    db.syncRow('feedbacks', deleted); // syncRow will detect deletion

    console.log(`[Feedback] 删除反馈 #${id}`);
    res.json({ success: true, message: '反馈已删除' });
  } catch (err) {
    console.error('[Feedback] 删除失败:', err);
    res.status(500).json({ error: '删除反馈失败' });
  }
});

/**
 * GET /api/feedback/mine/:openid
 * 获取用户的反馈历史
 */
router.get('/mine/:openid', (req, res) => {
  try {
    const { openid } = req.params;
    if (!openid) {
      return res.status(400).json({ error: '缺少openid' });
    }

    const list = (db.feedbacks || [])
      .filter(f => f.openid === openid)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const enriched = list.map(f => {
      const cat = FEEDBACK_CATEGORIES.find(c => c.key === f.category) || {};
      const st = STATUS_MAP[f.status] || {};
      return {
        ...f,
        category_info: cat,
        status_info: st
      };
    });

    res.json({
      total: enriched.length,
      data: enriched
    });
  } catch (err) {
    console.error('[Feedback] 获取用户反馈失败:', err);
    res.status(500).json({ error: '获取反馈历史失败' });
  }
});

module.exports = router;
