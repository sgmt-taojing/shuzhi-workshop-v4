const express = require('express');
const router = express.Router();
const dbModule = require('../models/db');
// 使用 getDB() 返回的 Proxy 来访问数据库表
const db = dbModule.getDB();

/**
 * GET /api/analytics/overview
 * 获取数据概览（首页统计卡片）
 */
router.get('/overview', (req, res) => {
  try {
    const products = db.products || [];
    const articles = db.articles || [];
    const orders = db.orders || [];
    const contacts = db.contacts || [];
    const onboardings = db.onboardings || [];
    const csConversations = db.cs_conversations || [];
    const clientProducts = db.client_products || [];
    const clients = db.clients || [];

    // 产品统计
    const publishedProducts = products.filter(p => p.status === 'published' || p.published !== false);

    // 文章统计
    const publishedArticles = articles.filter(a => a.status === 'published' || a.published !== false);

    // 订单统计
    const pendingOrders = orders.filter(o => o.status === 'pending').length;
    const paidOrders = orders.filter(o => o.status === 'paid' || o.status === 'shipped').length;
    const completedOrders = orders.filter(o => o.status === 'completed').length;
    const totalRevenue = orders
      .filter(o => o.status !== 'pending' && o.status !== 'cancelled')
      .reduce((sum, o) => sum + (o.total_price || o.price || 0), 0);

    // 线索统计
    const pendingContacts = contacts.filter(c => c.status === 'pending').length;
    const processedContacts = contacts.filter(c => c.status !== 'pending').length;

    // 入驻统计
    const pendingOnboardings = onboardings.filter(o => o.status === 'pending').length;
    const approvedOnboardings = onboardings.filter(o => o.status === 'approved').length;

    // 客服统计
    const openConversations = csConversations.filter(c => c.status === 'open').length;
    const unreadMessages = (db.cs_messages || []).filter(m => m.direction === 'in' && !m.is_read).length;

    res.json({
      products: {
        total: publishedProducts.length,
        byCategory: groupByCategory(publishedProducts)
      },
      articles: publishedArticles.length,
      clientProducts: clientProducts.filter(cp => cp.status === 'published').length,
      clients: clients.length,
      orders: {
        total: orders.length,
        pending: pendingOrders,
        paid: paidOrders,
        completed: completedOrders,
        totalRevenue
      },
      contacts: {
        total: contacts.length,
        pending: pendingContacts,
        processed: processedContacts
      },
      onboardings: {
        total: onboardings.length,
        pending: pendingOnboardings,
        approved: approvedOnboardings
      },
      customerService: {
        conversations: csConversations.length,
        open: openConversations,
        unread: unreadMessages
      }
    });
  } catch (err) {
    console.error('获取统计概览失败:', err);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

/**
 * GET /api/analytics/orders/trend
 * 订单趋势（按天统计，最近30天）
 */
router.get('/orders/trend', (req, res) => {
  try {
    const orders = db.orders || [];
    const days = parseInt(req.query.days) || 30;
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // 按天分组
    const trendMap = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      trendMap[key] = { date: key, count: 0, revenue: 0 };
    }

    orders.forEach(order => {
      const date = (order.created_at || '').slice(0, 10);
      if (trendMap[date]) {
        trendMap[date].count++;
        if (order.status !== 'pending' && order.status !== 'cancelled') {
          trendMap[date].revenue += order.total_price || order.price || 0;
        }
      }
    });

    const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));
    res.json(trend);
  } catch (err) {
    console.error('获取订单趋势失败:', err);
    res.status(500).json({ error: '获取订单趋势失败' });
  }
});

/**
 * GET /api/analytics/products/hot
 * 产品热度排行（按订单数/收藏数/浏览数）
 */
router.get('/products/hot', (req, res) => {
  try {
    const orders = db.orders || [];
    const products = db.products || [];
    const limit = parseInt(req.query.limit) || 10;

    // 统计每个产品的订单数
    const productOrderCount = {};
    orders.forEach(order => {
      const pid = order.product_id;
      if (pid) {
        productOrderCount[pid] = (productOrderCount[pid] || 0) + 1;
      }
    });

    // 组装热度数据
    const hotProducts = products
      .filter(p => p.status === 'published' || p.published !== false)
      .map(p => ({
        id: p.id,
        title: p.title,
        icon: p.icon || '📦',
        category: p.category || '',
        price: p.price || 0,
        orderCount: productOrderCount[p.id] || 0,
        revenue: orders
          .filter(o => o.product_id === p.id && o.status !== 'pending' && o.status !== 'cancelled')
          .reduce((sum, o) => sum + (o.total_price || o.price || 0), 0)
      }))
      .sort((a, b) => b.orderCount - a.orderCount)
      .slice(0, limit);

    res.json(hotProducts);
  } catch (err) {
    console.error('获取产品热度失败:', err);
    res.status(500).json({ error: '获取产品热度失败' });
  }
});

/**
 * GET /api/analytics/contacts/source
 * 线索来源分析（按行业/渠道）
 */
router.get('/contacts/source', (req, res) => {
  try {
    const contacts = db.contacts || [];

    // 按行业分组
    const byIndustry = {};
    contacts.forEach(c => {
      const industry = c.industry || '未知';
      byIndustry[industry] = (byIndustry[industry] || 0) + 1;
    });

    // 按状态分组
    const byStatus = {
      pending: contacts.filter(c => c.status === 'pending').length,
      processing: contacts.filter(c => c.status === 'processing').length,
      converted: contacts.filter(c => c.status === 'converted').length,
      closed: contacts.filter(c => c.status === 'closed').length
    };

    // 按日期（最近7天）
    const now = new Date();
    const recent7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const count = contacts.filter(c => (c.created_at || '').slice(0, 10) === key).length;
      recent7Days.push({ date: key, count });
    }

    res.json({
      byIndustry: Object.entries(byIndustry)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      byStatus,
      recent7Days
    });
  } catch (err) {
    console.error('获取线索分析失败:', err);
    res.status(500).json({ error: '获取线索分析失败' });
  }
});

/**
 * GET /api/analytics/client-products/performance
 * 甲方产品表现（销量、转化率）
 */
router.get('/client-products/performance', (req, res) => {
  try {
    const clientProducts = db.client_products || [];
    const orders = db.orders || [];
    const clients = db.clients || [];

    const performance = clientProducts
      .filter(cp => cp.status === 'published')
      .map(cp => {
        const cpOrders = orders.filter(o => o.client_product_id === cp.id);
        const client = clients.find(c => c.id === cp.client_id);
        return {
          id: cp.id,
          title: cp.title,
          clientName: client ? client.name : cp.client_name || '未知',
          type: cp.type || 'product',
          price: cp.price || 0,
          orderCount: cpOrders.length,
          revenue: cpOrders
            .filter(o => o.status !== 'pending' && o.status !== 'cancelled')
            .reduce((sum, o) => sum + (o.total_price || o.price || 0), 0)
        };
      })
      .sort((a, b) => b.orderCount - a.orderCount)
      .slice(0, 20);

    res.json(performance);
  } catch (err) {
    console.error('获取甲方产品表现失败:', err);
    res.status(500).json({ error: '获取甲方产品表现失败' });
  }
});

/**
 * GET /api/analytics/realtime
 * 实时数据（今日数据）
 */
router.get('/realtime', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const orders = db.orders || [];
    const contacts = db.contacts || [];
    const csMessages = db.cs_messages || [];

    const todayOrders = orders.filter(o => (o.created_at || '').slice(0, 10) === today);
    const todayContacts = contacts.filter(c => (c.created_at || '').slice(0, 10) === today);
    const todayMessages = csMessages.filter(m => (m.created_at || '').slice(0, 10) === today);

    res.json({
      date: today,
      orders: {
        total: todayOrders.length,
        pending: todayOrders.filter(o => o.status === 'pending').length,
        revenue: todayOrders
          .filter(o => o.status !== 'pending' && o.status !== 'cancelled')
          .reduce((sum, o) => sum + (o.total_price || o.price || 0), 0)
      },
      contacts: {
        total: todayContacts.length,
        pending: todayContacts.filter(c => c.status === 'pending').length
      },
      messages: {
        total: todayMessages.length,
        inbound: todayMessages.filter(m => m.direction === 'in').length
      }
    });
  } catch (err) {
    console.error('获取实时数据失败:', err);
    res.status(500).json({ error: '获取实时数据失败' });
  }
});

// 辅助函数：按分类分组
function groupByCategory(products) {
  const groups = {};
  products.forEach(p => {
    const cat = p.category || '其他';
    groups[cat] = (groups[cat] || 0) + 1;
  });
  return Object.entries(groups)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

module.exports = router;
