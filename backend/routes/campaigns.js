const express = require('express');
const router = express.Router();
const { getDB, nextId, save, syncRow } = require('../models/db');

/**
 * 营销活动管理系统
 * 支持限时折扣、满减优惠、赠品活动、闪购、套餐捆绑
 * 
 * 活动类型：
 * - discount: 折扣活动（百分比/固定金额减免）
 * - gift: 赠品活动（满额赠送）
 * - flash: 闪购活动（限时特价）
 * - bundle: 套餐捆绑（多产品组合优惠）
 */

// ===== 工具函数 =====

function generateCampaignNo() {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `CP${ymd}${rand}`;
}

function isCampaignActive(campaign) {
  if (campaign.status !== 'active') return false;
  const now = new Date().toISOString();
  if (campaign.start_time && now < campaign.start_time) return false;
  if (campaign.end_time && now > campaign.end_time) return false;
  if (campaign.usage_limit > 0 && campaign.used_count >= campaign.usage_limit) return false;
  return true;
}

function isProductApplicable(campaign, productId, productCategory) {
  if (campaign.applicable_scope === 'all') return true;
  if (campaign.applicable_scope === 'products') {
    return (campaign.applicable_products || []).includes(Number(productId));
  }
  if (campaign.applicable_scope === 'categories') {
    return (campaign.applicable_categories || []).includes(productCategory);
  }
  return false;
}

function calculateDiscount(campaign, originalAmount) {
  if (campaign.type === 'gift') return { discount: 0, detail: `赠送：${campaign.gift_product_title || '精美赠品'}` };
  
  let discount = 0;
  let detail = '';
  
  if (campaign.min_amount > 0 && originalAmount < campaign.min_amount) {
    return { discount: 0, detail: `需满${campaign.min_amount}元参与` };
  }
  
  if (campaign.discount_type === 'percent') {
    discount = Math.round(originalAmount * campaign.discount_value / 100 * 100) / 100;
    if (campaign.max_discount > 0 && discount > campaign.max_discount) {
      discount = campaign.max_discount;
    }
    detail = `${campaign.discount_value}% off，减${discount}元`;
  } else if (campaign.discount_type === 'fixed') {
    discount = campaign.discount_value;
    detail = `立减${discount}元`;
  }
  
  return { discount, detail };
}

function getTypeLabel(type) {
  const map = { discount: '折扣活动', gift: '赠品活动', flash: '闪购活动', bundle: '套餐捆绑' };
  return map[type] || type;
}

function getStatusLabel(status) {
  const map = { draft: '草稿', active: '进行中', paused: '已暂停', ended: '已结束', expired: '已过期' };
  return map[status] || status;
}

// ===== 用户端 API =====

/**
 * GET /api/campaigns/active
 * 获取当前进行中的活动列表
 */
router.get('/active', (req, res) => {
  try {
    const { product_id, category } = req.query;
    let campaigns = (db_get().campaigns || []).filter(c => isCampaignActive(c));
    
    if (product_id) {
      campaigns = campaigns.filter(c => isProductApplicable(c, product_id, category));
    }
    
    campaigns.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    
    const result = campaigns.map(c => ({
      id: c.id,
      campaign_no: c.campaign_no,
      name: c.name,
      description: c.description,
      type: c.type,
      discount_type: c.discount_type,
      discount_value: c.discount_value,
      min_amount: c.min_amount,
      max_discount: c.max_discount,
      gift_product_title: c.gift_product_title,
      start_time: c.start_time,
      end_time: c.end_time,
      banner_image: c.banner_image,
      rules: c.rules || [],
      applicable_scope: c.applicable_scope,
      type_label: getTypeLabel(c.type),
      status_label: getStatusLabel(c.status),
      remaining: c.usage_limit > 0 ? Math.max(0, c.usage_limit - c.used_count) : -1,
      end_time_ts: c.end_time ? new Date(c.end_time).getTime() : 0
    }));
    
    res.json({ code: 0, data: result });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * GET /api/campaigns/:id
 * 获取活动详情
 */
router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const campaign = (db_get().campaigns || []).find(c => c.id === id);
    if (!campaign) return res.status(404).json({ code: 1, message: '活动不存在' });
    
    res.json({ code: 0, data: { ...campaign, type_label: getTypeLabel(campaign.type), status_label: getStatusLabel(campaign.status) } });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * POST /api/campaigns/calculate
 * 计算活动优惠（下单时调用）
 */
router.post('/calculate', (req, res) => {
  try {
    const { product_id, product_category, amount, openid } = req.body;
    const campaigns = (db_get().campaigns || []).filter(c => 
      isCampaignActive(c) && isProductApplicable(c, product_id, product_category)
    );
    
    if (campaigns.length === 0) {
      return res.json({ code: 0, data: { has_campaign: false, discount: 0, final_amount: amount, campaign: null } });
    }
    
    campaigns.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const campaign = campaigns[0];
    
    // 检查用户参与次数
    if (openid && campaign.per_user_limit > 0) {
      const userRecords = (db_get().campaign_records || []).filter(
        r => r.campaign_id === campaign.id && r.user_openid === openid
      );
      if (userRecords.length >= campaign.per_user_limit) {
        return res.json({ 
          code: 0, 
          data: { has_campaign: false, discount: 0, final_amount: amount, campaign: null, reason: '已达参与上限' }
        });
      }
    }
    
    const { discount, detail } = calculateDiscount(campaign, amount);
    const finalAmount = Math.max(0, amount - discount);
    
    res.json({
      code: 0,
      data: {
        has_campaign: true,
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        campaign_type: campaign.type,
        discount,
        final_amount: finalAmount,
        benefit_type: campaign.type === 'gift' ? 'gift' : 'discount',
        benefit_detail: detail,
        gift_product_title: campaign.gift_product_title || ''
      }
    });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * GET /api/campaigns/records/list
 * 用户参与活动记录
 */
router.get('/records/list', (req, res) => {
  try {
    const { openid, phone, page = 1, pageSize = 20 } = req.query;
    let records = [...(db_get().campaign_records || [])];
    
    if (openid) records = records.filter(r => r.user_openid === openid);
    if (phone) records = records.filter(r => r.user_phone === phone);
    
    records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    
    const start = (page - 1) * pageSize;
    const list = records.slice(start, start + Number(pageSize));
    
    res.json({ code: 0, data: { list, total: records.length, page: Number(page) } });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

// ===== 管理端 API =====

/**
 * GET /api/campaigns/admin/list
 */
router.get('/admin/list', (req, res) => {
  try {
    const { status, type, keyword, page = 1, pageSize = 20 } = req.query;
    let campaigns = [...(db_get().campaigns || [])];
    
    if (status) campaigns = campaigns.filter(c => c.status === status);
    if (type) campaigns = campaigns.filter(c => c.type === type);
    if (keyword) {
      const kw = keyword.toLowerCase();
      campaigns = campaigns.filter(c => 
        c.name.toLowerCase().includes(kw) || 
        c.campaign_no.toLowerCase().includes(kw) ||
        (c.description || '').toLowerCase().includes(kw)
      );
    }
    
    campaigns.sort((a, b) => (b.id || 0) - (a.id || 0));
    
    const allCampaigns = db_get().campaigns || [];
    const stats = {
      total: allCampaigns.length,
      active: allCampaigns.filter(c => isCampaignActive(c)).length,
      draft: allCampaigns.filter(c => c.status === 'draft').length,
      ended: allCampaigns.filter(c => c.status === 'ended' || c.status === 'expired').length,
      total_used: allCampaigns.reduce((s, c) => s + (c.used_count || 0), 0),
      total_discount: (db_get().campaign_records || []).reduce((s, r) => s + (r.discount_amount || 0), 0)
    };
    
    const start = (page - 1) * pageSize;
    const list = campaigns.slice(start, start + Number(pageSize)).map(c => ({
      ...c,
      type_label: getTypeLabel(c.type),
      status_label: getStatusLabel(c.status),
      is_active: isCampaignActive(c)
    }));
    
    res.json({ code: 0, data: { list, total: campaigns.length, page: Number(page), stats } });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * POST /api/campaigns/admin/create
 */
router.post('/admin/create', (req, res) => {
  try {
    const {
      name, description, type, discount_type, discount_value,
      min_amount, max_discount, gift_product_id, gift_product_title,
      start_time, end_time, banner_image, rules,
      applicable_scope, applicable_products, applicable_categories,
      usage_limit, per_user_limit, priority, created_by
    } = req.body;
    
    if (!name || !start_time || !end_time) {
      return res.status(400).json({ code: 1, message: '活动名称、开始时间、结束时间为必填' });
    }
    
    const campaign_no = generateCampaignNo();
    const now = new Date().toISOString();
    
    const campaign = {
      id: nextId('campaigns'),
      campaign_no,
      name,
      description: description || '',
      type: type || 'discount',
      discount_type: discount_type || 'percent',
      discount_value: discount_value || 0,
      min_amount: min_amount || 0,
      max_discount: max_discount || 0,
      gift_product_id: gift_product_id || 0,
      gift_product_title: gift_product_title || '',
      start_time,
      end_time,
      status: 'draft',
      banner_image: banner_image || '',
      rules: rules || [],
      applicable_scope: applicable_scope || 'all',
      applicable_products: applicable_products || [],
      applicable_categories: applicable_categories || [],
      usage_limit: usage_limit || 0,
      used_count: 0,
      per_user_limit: per_user_limit || 1,
      priority: priority || 0,
      created_by: created_by || 'admin',
      created_at: now,
      updated_at: now
    };
    
    if (!db_get().campaigns) db_get().campaigns = [];
    db_get().campaigns.push(campaign);
    syncRow('campaigns', campaign);
    
    res.json({ code: 0, data: { id: campaign.id, campaign_no }, message: '活动创建成功' });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * PUT /api/campaigns/admin/:id
 */
router.put('/admin/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const campaign = (db_get().campaigns || []).find(c => c.id === id);
    if (!campaign) return res.status(404).json({ code: 1, message: '活动不存在' });
    
    const allowedFields = [
      'name', 'description', 'type', 'discount_type', 'discount_value',
      'min_amount', 'max_discount', 'gift_product_id', 'gift_product_title',
      'start_time', 'end_time', 'status', 'banner_image', 'rules',
      'applicable_scope', 'applicable_products', 'applicable_categories',
      'usage_limit', 'per_user_limit', 'priority'
    ];
    
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) campaign[f] = req.body[f];
    }
    campaign.updated_at = new Date().toISOString();
    
    syncRow('campaigns', campaign);
    
    res.json({ code: 0, message: '更新成功' });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * DELETE /api/campaigns/admin/:id
 */
router.delete('/admin/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = db_get();
    const campaign = (d.campaigns || []).find(c => c.id === id);
    if (!campaign) return res.status(404).json({ code: 1, message: '活动不存在' });
    
    if (campaign.status === 'active') {
      return res.status(400).json({ code: 1, message: '进行中的活动不可删除，请先暂停或结束' });
    }
    
    const idx = d.campaigns.findIndex(c => c.id === id);
    if (idx >= 0) {
      d.campaigns.splice(idx, 1);
      const { deleteRows } = require('../models/db');
      deleteRows('campaigns', { id });
    }
    
    // 删除关联记录
    const records = (d.campaign_records || []).filter(r => r.campaign_id === id);
    records.forEach(r => {
      const ridx = d.campaign_records.findIndex(rr => rr.id === r.id);
      if (ridx >= 0) d.campaign_records.splice(ridx, 1);
    });
    
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * POST /api/campaigns/admin/:id/status
 */
router.post('/admin/:id/status', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;
    const campaign = (db_get().campaigns || []).find(c => c.id === id);
    if (!campaign) return res.status(404).json({ code: 1, message: '活动不存在' });
    
    const validStatus = ['draft', 'active', 'paused', 'ended', 'expired'];
    if (!validStatus.includes(status)) {
      return res.status(400).json({ code: 1, message: '无效状态' });
    }
    
    campaign.status = status;
    campaign.updated_at = new Date().toISOString();
    syncRow('campaigns', campaign);
    
    res.json({ code: 0, message: '状态更新成功' });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * GET /api/campaigns/admin/:id/records
 */
router.get('/admin/:id/records', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { page = 1, pageSize = 20 } = req.query;
    
    let records = (db_get().campaign_records || []).filter(r => r.campaign_id === id);
    records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    
    const start = (page - 1) * pageSize;
    const list = records.slice(start, start + Number(pageSize));
    
    const totalDiscount = records.reduce((s, r) => s + (r.discount_amount || 0), 0);
    const totalOrders = records.filter(r => r.order_id).length;
    
    res.json({ 
      code: 0, 
      data: { 
        list, 
        total: records.length, 
        page: Number(page),
        stats: { total_records: records.length, total_discount: totalDiscount, total_orders: totalOrders }
      }
    });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * GET /api/campaigns/admin/stats
 */
router.get('/admin/stats', (req, res) => {
  try {
    const d = db_get();
    const campaigns = d.campaigns || [];
    const records = d.campaign_records || [];
    
    const byType = {};
    campaigns.forEach(c => { byType[c.type] = (byType[c.type] || 0) + 1; });
    
    const byStatus = {};
    campaigns.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
    
    const now = new Date();
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 86400000);
      const dateStr = date.toISOString().slice(0, 10);
      const dayRecords = records.filter(r => (r.created_at || '').startsWith(dateStr));
      trend.push({
        date: dateStr,
        count: dayRecords.length,
        discount: dayRecords.reduce((s, r) => s + (r.discount_amount || 0), 0)
      });
    }
    
    const ranking = campaigns.map(c => {
      const cRecords = records.filter(r => r.campaign_id === c.id);
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        type_label: getTypeLabel(c.type),
        used_count: c.used_count,
        records: cRecords.length,
        total_discount: cRecords.reduce((s, r) => s + (r.discount_amount || 0), 0),
        status: c.status
      };
    }).sort((a, b) => b.records - a.records).slice(0, 10);
    
    res.json({
      code: 0,
      data: {
        overview: {
          total_campaigns: campaigns.length,
          active_campaigns: campaigns.filter(c => isCampaignActive(c)).length,
          total_records: records.length,
          total_discount: records.reduce((s, r) => s + (r.discount_amount || 0), 0),
          avg_discount: records.length > 0 ? records.reduce((s, r) => s + (r.discount_amount || 0), 0) / records.length : 0
        },
        by_type: byType,
        by_status: byStatus,
        trend_7d: trend,
        ranking
      }
    });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

/**
 * POST /api/campaigns/admin/record
 * 手动记录活动参与（订单创建时内部调用）
 */
router.post('/admin/record', (req, res) => {
  try {
    const {
      campaign_id, user_openid, user_phone, order_id, order_no,
      original_amount, discount_amount, final_amount, benefit_type, benefit_detail
    } = req.body;
    
    const d = db_get();
    const campaign = (d.campaigns || []).find(c => c.id === campaign_id);
    if (!campaign) return res.status(404).json({ code: 1, message: '活动不存在' });
    
    const record = {
      id: nextId('campaign_records'),
      campaign_id,
      campaign_name: campaign.name,
      user_openid: user_openid || '',
      user_phone: user_phone || '',
      order_id: order_id || 0,
      order_no: order_no || '',
      original_amount: original_amount || 0,
      discount_amount: discount_amount || 0,
      final_amount: final_amount || 0,
      benefit_type: benefit_type || 'discount',
      benefit_detail: benefit_detail || '',
      created_at: new Date().toISOString()
    };
    
    if (!d.campaign_records) d.campaign_records = [];
    d.campaign_records.push(record);
    syncRow('campaign_records', record);
    
    // 更新活动参与次数
    campaign.used_count = (campaign.used_count || 0) + 1;
    campaign.updated_at = new Date().toISOString();
    syncRow('campaigns', campaign);
    
    res.json({ code: 0, message: '记录成功' });
  } catch (e) {
    res.status(500).json({ code: 1, message: e.message });
  }
});

// 兼容：用闭包获取 db 实例
function db_get() {
  return getDB();
}

module.exports = router;
