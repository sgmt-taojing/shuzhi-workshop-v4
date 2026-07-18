const express = require('express');
const router = express.Router();
const dbModule = require('../models/db');
const db = dbModule.getDB();

/**
 * 营销 Banner 管理系统
 * 
 * 功能：
 * - 首页轮播 Banner 展示（自动过滤有效期内、active 状态的）
 * - 管理后台 CRUD 管理
 * - 点击/曝光统计
 * - 定时上下架（基于 start_date / end_date）
 * - 目标受众筛选
 */

// ===== 工具函数 =====

function isBannerActive(banner, now = new Date()) {
  if (banner.status !== 'active') return false;
  const today = now.toISOString().slice(0, 10);
  if (banner.start_date && banner.start_date > today) return false;
  if (banner.end_date && banner.end_date < today) return false;
  return true;
}

function normalizeBanner(b) {
  if (!b) return null;
  return {
    ...b,
    link_params: typeof b.link_params === 'string' ? safeJsonParse(b.link_params) : (b.link_params || {}),
    active: isBannerActive(b)
  };
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ===== 客户端 API =====

/**
 * GET /api/banners/active
 * 获取当前有效的轮播 Banner 列表（小程序首页调用）
 */
router.get('/active', (req, res) => {
  try {
    const all = db.banners || [];
    const active = all
      .filter(b => isBannerActive(b))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      .map(b => normalizeBanner(b));

    // 增加曝光计数
    active.forEach(b => {
      try {
        const stmt = db._rawDb?.prepare('UPDATE banners SET impression_count = impression_count + 1 WHERE id = ?');
        if (stmt) stmt.run(b.id);
      } catch (e) { /* ignore */ }
    });

    res.json(active);
  } catch (err) {
    console.error('[banners] active error:', err);
    res.status(500).json({ error: '获取Banner失败' });
  }
});

/**
 * POST /api/banners/:id/click
 * 记录 Banner 点击
 */
router.post('/:id/click', (req, res) => {
  try {
    const id = Number(req.params.id);
    const banner = (db.banners || []).find(b => b.id === id);
    if (!banner) return res.status(404).json({ error: 'Banner不存在' });

    try {
      const stmt = db._rawDb?.prepare('UPDATE banners SET click_count = click_count + 1 WHERE id = ?');
      if (stmt) stmt.run(id);
    } catch (e) { /* ignore */ }

    res.json({ success: true, link_type: banner.link_type, link_url: banner.link_url, link_params: normalizeBanner(banner).link_params });
  } catch (err) {
    console.error('[banners] click error:', err);
    res.status(500).json({ error: '记录点击失败' });
  }
});

// ===== 管理端 API =====

/**
 * GET /api/banners
 * 获取所有 Banner（管理端）
 * Query: status, page, pageSize
 */
router.get('/', (req, res) => {
  try {
    const { status, page = 1, pageSize = 50 } = req.query;
    let list = db.banners || [];
    
    if (status && status !== 'all') {
      list = list.filter(b => b.status === status);
    }

    // 按sort_order排序，再按创建时间倒序
    list = list.sort((a, b) => {
      if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0);
      return (b.id || 0) - (a.id || 0);
    });

    const total = list.length;
    const start = (Number(page) - 1) * Number(pageSize);
    const items = list.slice(start, start + Number(pageSize)).map(b => normalizeBanner(b));

    // 统计概览
    const allBanners = db.banners || [];
    const stats = {
      total: allBanners.length,
      active: allBanners.filter(b => isBannerActive(b)).length,
      scheduled: allBanners.filter(b => b.status === 'active' && b.start_date && b.start_date > new Date().toISOString().slice(0, 10)).length,
      expired: allBanners.filter(b => b.status === 'active' && b.end_date && b.end_date < new Date().toISOString().slice(0, 10)).length,
      inactive: allBanners.filter(b => b.status === 'inactive').length,
      totalClicks: allBanners.reduce((s, b) => s + (b.click_count || 0), 0),
      totalImpressions: allBanners.reduce((s, b) => s + (b.impression_count || 0), 0)
    };

    res.json({ items, total, stats });
  } catch (err) {
    console.error('[banners] list error:', err);
    res.status(500).json({ error: '获取Banner列表失败' });
  }
});

/**
 * GET /api/banners/:id
 * 获取单个 Banner 详情
 */
router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const banner = (db.banners || []).find(b => b.id === id);
    if (!banner) return res.status(404).json({ error: 'Banner不存在' });
    res.json(normalizeBanner(banner));
  } catch (err) {
    res.status(500).json({ error: '获取Banner详情失败' });
  }
});

/**
 * POST /api/banners
 * 创建 Banner
 */
router.post('/', (req, res) => {
  try {
    const {
      title, subtitle, image_url, link_type, link_url, link_params,
      bg_color, text_color, sort_order, status, start_date, end_date, target_audience
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Banner标题不能为空' });
    }

    const banners = db.banners || [];
    const newId = banners.length > 0 ? Math.max(...banners.map(b => b.id || 0)) + 1 : 1;

    const newBanner = {
      id: newId,
      title: title.trim(),
      subtitle: subtitle || '',
      image_url: image_url || '',
      link_type: link_type || 'page',
      link_url: link_url || '',
      link_params: link_params || {},
      bg_color: bg_color || '#2563eb',
      text_color: text_color || '#ffffff',
      sort_order: sort_order || 0,
      status: status || 'active',
      start_date: start_date || '',
      end_date: end_date || '',
      click_count: 0,
      impression_count: 0,
      target_audience: target_audience || 'all',
      created_by: req.body.created_by || 'admin',
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
    };

    banners.push(newBanner);
    db.banners = banners;
    dbModule.save();

    res.json({ success: true, banner: normalizeBanner(newBanner) });
  } catch (err) {
    console.error('[banners] create error:', err);
    res.status(500).json({ error: '创建Banner失败' });
  }
});

/**
 * PUT /api/banners/:id
 * 更新 Banner
 */
router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const banners = db.banners || [];
    const idx = banners.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Banner不存在' });

    const allowed = ['title', 'subtitle', 'image_url', 'link_type', 'link_url', 'link_params',
      'bg_color', 'text_color', 'sort_order', 'status', 'start_date', 'end_date', 'target_audience'];

    const banner = banners[idx];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        banner[key] = req.body[key];
      }
    }
    banner.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    banners[idx] = banner;
    db.banners = banners;
    dbModule.save();

    res.json({ success: true, banner: normalizeBanner(banner) });
  } catch (err) {
    console.error('[banners] update error:', err);
    res.status(500).json({ error: '更新Banner失败' });
  }
});

/**
 * DELETE /api/banners/:id
 * 删除 Banner
 */
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    let banners = db.banners || [];
    const idx = banners.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Banner不存在' });

    banners.splice(idx, 1);
    db.banners = banners;
    dbModule.save();

    res.json({ success: true });
  } catch (err) {
    console.error('[banners] delete error:', err);
    res.status(500).json({ error: '删除Banner失败' });
  }
});

/**
 * PUT /api/banners/:id/sort
 * 批量调整排序
 */
router.put('/:id/sort', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { sort_order } = req.body;
    const banners = db.banners || [];
    const idx = banners.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Banner不存在' });

    banners[idx].sort_order = sort_order;
    banners[idx].updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.banners = banners;
    dbModule.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '调整排序失败' });
  }
});

/**
 * POST /api/banners/seed
 * 初始化默认 Banner 数据（仅首次调用有效）
 */
router.post('/seed', (req, res) => {
  try {
    const existing = db.banners || [];
    if (existing.length > 0) {
      return res.json({ success: true, message: 'Banner数据已存在，跳过初始化', count: existing.length });
    }

    const defaultBanners = [
      {
        id: 1,
        title: '数字化转型免费诊断',
        subtitle: '限时免费 · 专家1对1诊断 · 定制方案',
        image_url: '',
        link_type: 'page',
        link_url: '/package-detail/pages/onboarding/onboarding',
        link_params: {},
        bg_color: '#2563eb',
        text_color: '#ffffff',
        sort_order: 1,
        status: 'active',
        start_date: '',
        end_date: '',
        click_count: 0,
        impression_count: 0,
        target_audience: 'all',
        created_by: 'system',
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
      },
      {
        id: 2,
        title: '企业数字化成熟度评估',
        subtitle: '5维度20题 · 3分钟出报告 · 限时免费',
        image_url: '',
        link_type: 'page',
        link_url: '/package-detail/pages/assessment/assessment',
        link_params: {},
        bg_color: '#7c3aed',
        text_color: '#ffffff',
        sort_order: 2,
        status: 'active',
        start_date: '',
        end_date: '',
        click_count: 0,
        impression_count: 0,
        target_audience: 'all',
        created_by: 'system',
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
      },
      {
        id: 3,
        title: '方案报价计算器',
        subtitle: '选模块 · 估预算 · 透明定价不求人',
        image_url: '',
        link_type: 'page',
        link_url: '/package-detail/pages/quote-calculator/quote-calculator',
        link_params: {},
        bg_color: '#059669',
        text_color: '#ffffff',
        sort_order: 3,
        status: 'active',
        start_date: '',
        end_date: '',
        click_count: 0,
        impression_count: 0,
        target_audience: 'all',
        created_by: 'system',
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
      }
    ];

    db.banners = defaultBanners;
    dbModule.save();

    res.json({ success: true, message: '已初始化3条默认Banner', count: defaultBanners.length });
  } catch (err) {
    console.error('[banners] seed error:', err);
    res.status(500).json({ error: '初始化Banner失败' });
  }
});

module.exports = router;
