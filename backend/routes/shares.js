/**
 * 数造工坊 - 分享裂变追踪路由
 */

const express = require('express');
const router = express.Router();
const share = require('../models/share');
const db = require('../models/db');
const pointsRoute = require('./points');

// ==================== 中间件：获取当前用户 openid ====================

function getOpenid(req) {
  // 实际项目中应从 session 或 token 中获取
  // 这里简单从 header 或 query 中获取（开发模式）
  return req.headers['x-openid'] || req.query.openid || req.body.openid || '';
}

// ==================== 记录分享事件 ====================

/**
 * POST /api/shares
 * Body: { page_path, page_title, page_type, target_id, target_title, share_scene }
 * 返回: { share_id, share_url }
 */
router.post('/', (req, res) => {
  try {
    const openid = getOpenid(req);
    const { page_path, page_title, page_type, target_id, target_title, share_scene } = req.body;
    
    if (!page_path) {
      return res.status(400).json({ error: '缺少 page_path' });
    }
    
    const shareRecord = share.createShare({
      sharer_openid: openid,
      sharer_name: req.body.sharer_name || '',
      page_path,
      page_title: page_title || '',
      page_type: page_type || '',
      target_id: target_id || 0,
      target_title: target_title || '',
      share_scene: share_scene || 0
    });
    
    // 生成分享链接（带 share_id 参数）
    const share_url = `${page_path}${page_path.includes('?') ? '&' : '?'}share_id=${shareRecord.share_id}`;
    
    // 积分奖励
    let pointsResult = null;
    if (openid) {
      const action = page_type === 'article' ? 'share_article' : 'share_product';
      pointsResult = pointsRoute.addPoints(openid, action, String(shareRecord.share_id), page_title || '');
    }
    
    res.json({
      success: true,
      share_id: shareRecord.share_id,
      share_url,
      points: pointsResult && pointsResult.success ? pointsResult.points : 0
    });
  } catch (err) {
    console.error('[分享] 记录分享失败:', err);
    res.status(500).json({ error: '记录分享失败' });
  }
});

// ==================== 记录分享链接点击 ====================

/**
 * POST /api/shares/click
 * Body: { share_id, scene, referrer }
 * 返回: { success }
 */
router.post('/click', (req, res) => {
  try {
    const { share_id, scene, referrer } = req.body;
    
    if (!share_id) {
      return res.status(400).json({ error: '缺少 share_id' });
    }
    
    const openid = getOpenid(req);
    
    // 获取点击者IP
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
    
    const click = share.createShareClick({
      share_id,
      clicker_openid: openid,
      clicker_ip: ip,
      user_agent: req.headers['user-agent'] || '',
      referrer: referrer || '',
      scene: scene || 0
    });
    
    res.json({ success: true, click_id: click.id });
  } catch (err) {
    console.error('[分享] 记录点击失败:', err);
    res.status(500).json({ error: '记录点击失败' });
  }
});

// ==================== 标记转化为已转化 ====================

/**
 * POST /api/shares/convert
 * Body: { share_id, conversion_type, conversion_id }
 * 返回: { success, reward }
 */
router.post('/convert', (req, res) => {
  try {
    const { share_id, conversion_type, conversion_id } = req.body;
    
    if (!share_id || !conversion_type) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    
    // 查找对应的点击记录（同一个 clicker_openid 的最近点击）
    const data = db.getDB();
    const openid = getOpenid(req);
    
    const click = data.share_clicks
      .filter(c => c.share_id === share_id && c.clicker_openid === openid)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    
    if (click) {
      share.markClickConverted(click.id, conversion_type, conversion_id);
    } else {
      // 直接增加分享的转化计数
      share.incrementShareConversion(share_id, conversion_type, conversion_id);
    }
    
    // 检查并颁发奖励
    const reward = share.checkAndIssueReward(openid, share_id, conversion_type);
    
    res.json({ success: true, reward });
  } catch (err) {
    console.error('[分享] 记录转化失败:', err);
    res.status(500).json({ error: '记录转化失败' });
  }
});

// ==================== 获取我的分享统计 ====================

/**
 * GET /api/shares/stats
 * Query: openid
 * 返回: { total_shares, total_clicks, total_conversions, total_reward, by_type }
 */
router.get('/stats', (req, res) => {
  try {
    const openid = req.query.openid || getOpenid(req);
    
    if (!openid) {
      return res.status(400).json({ error: '缺少 openid' });
    }
    
    const stats = share.getShareStats(openid);
    res.json(stats);
  } catch (err) {
    console.error('[分享] 获取统计失败:', err);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// ==================== 获取我的分享列表 ====================

/**
 * GET /api/shares/my
 * Query: openid, page, limit
 * 返回: { list, total, page, limit }
 */
router.get('/my', (req, res) => {
  try {
    const openid = req.query.openid || getOpenid(req);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    if (!openid) {
      return res.status(400).json({ error: '缺少 openid' });
    }
    
    const result = share.getSharesByOpenid(openid, page, limit);
    res.json(result);
  } catch (err) {
    console.error('[分享] 获取分享列表失败:', err);
    res.status(500).json({ error: '获取分享列表失败' });
  }
});

// ==================== 获取我的奖励列表 ====================

/**
 * GET /api/shares/rewards
 * Query: openid, page, limit
 * 返回: { list, total, page, limit }
 */
router.get('/rewards', (req, res) => {
  try {
    const openid = req.query.openid || getOpenid(req);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    if (!openid) {
      return res.status(400).json({ error: '缺少 openid' });
    }
    
    const result = share.getUserRewards(openid, page, limit);
    res.json(result);
  } catch (err) {
    console.error('[分享] 获取奖励列表失败:', err);
    res.status(500).json({ error: '获取奖励列表失败' });
  }
});

// ==================== 获取分享详情（通过 share_id） ====================

/**
 * GET /api/shares/:share_id
 * 返回: { share }
 */
router.get('/:share_id', (req, res) => {
  try {
    const { share_id } = req.params;
    const shareRecord = share.getShareByShareId(share_id);
    
    if (!shareRecord) {
      return res.status(404).json({ error: '分享记录不存在' });
    }
    
    res.json({ share: shareRecord });
  } catch (err) {
    console.error('[分享] 获取分享详情失败:', err);
    res.status(500).json({ error: '获取分享详情失败' });
  }
});

module.exports = router;
