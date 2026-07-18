const express = require('express');
const router = express.Router();
const dbModule = require('../models/db');
const db = dbModule.getDB();

/**
 * GET /api/export/stats
 * 获取导出数据统计摘要
 */
router.get('/stats', (req, res) => {
  try {
    const orders = db.orders || [];
    const contacts = db.contacts || [];
    const products = db.products || [];
    const clientProducts = db.client_products || [];
    const clients = db.clients || [];
    
    // 本月数据
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const thisMonthOrders = orders.filter(o => new Date(o.created_at) >= thisMonthStart);
    const thisMonthContacts = contacts.filter(c => new Date(c.created_at) >= thisMonthStart);
    
    res.json({
      overview: {
        totalOrders: orders.length,
        totalRevenue: orders.filter(o => ['paid', 'shipped', 'completed'].includes(o.status)).reduce((sum, o) => sum + Number(o.amount || 0), 0),
        totalContacts: contacts.length,
        totalProducts: products.length,
        totalClientProducts: clientProducts.length,
        totalClients: clients.length
      },
      thisMonth: {
        orders: thisMonthOrders.length,
        revenue: thisMonthOrders.filter(o => ['paid', 'shipped', 'completed'].includes(o.status)).reduce((sum, o) => sum + Number(o.amount || 0), 0),
        contacts: thisMonthContacts.length,
        newClients: clients.filter(c => new Date(c.created_at) >= thisMonthStart).length
      },
      orderStatus: {
        pending: orders.filter(o => o.status === 'pending').length,
        paid: orders.filter(o => o.status === 'paid').length,
        shipped: orders.filter(o => o.status === 'shipped').length,
        completed: orders.filter(o => o.status === 'completed').length,
        cancelled: orders.filter(o => o.status === 'cancelled').length
      },
      contactStatus: {
        pending: contacts.filter(c => c.status === 'pending').length,
        processing: contacts.filter(c => c.status === 'processing').length,
        converted: contacts.filter(c => c.status === 'converted').length,
        closed: contacts.filter(c => c.status === 'closed').length
      },
      topProducts: products.slice(0, 5).map(p => ({
        id: p.id,
        title: p.title,
        orders: orders.filter(o => o.product_id === p.id && o.product_type === 'product').length,
        revenue: orders.filter(o => o.product_id === p.id && o.product_type === 'product' && ['paid', 'shipped', 'completed'].includes(o.status)).reduce((sum, o) => sum + Number(o.amount || 0), 0)
      })).sort((a, b) => b.revenue - a.revenue)
    });
  } catch (e) {
    console.error('获取统计摘要失败:', e);
    res.status(500).json({ error: '获取失败', message: e.message });
  }
});

/**
 * 将数组转换为CSV格式
 */
function arrayToCSV(data, headers) {
  // 添加BOM头，确保Excel正确识别UTF-8编码
  let csv = '\uFEFF';
  
  // 添加表头
  csv += headers.map(h => `"${h}"`).join(',') + '\n';
  
  // 添加数据行
  data.forEach(row => {
    const values = headers.map(header => {
      let value = row[header] || '';
      // 处理包含逗号、引号、换行的字段
      if (typeof value === 'string') {
        value = value.replace(/"/g, '""'); // 转义引号
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          value = `"${value}"`;
        }
      }
      return value;
    });
    csv += values.join(',') + '\n';
  });
  
  return csv;
}

/**
 * POST /api/export/orders
 * 导出订单数据（支持高级筛选）
 */
router.post('/orders', (req, res) => {
  try {
    const { filters = {}, includeStats = true } = req.body;
    let orders = db.orders || [];
    
    // 状态筛选
    if (filters.status && filters.status !== 'all') {
      orders = orders.filter(o => o.status === filters.status);
    }
    
    // 日期范围
    if (filters.dateFrom) {
      const fromDate = new Date(filters.dateFrom + 'T00:00:00');
      orders = orders.filter(o => new Date(o.created_at) >= fromDate);
    }
    if (filters.dateTo) {
      const toDate = new Date(filters.dateTo + 'T23:59:59');
      orders = orders.filter(o => new Date(o.created_at) <= toDate);
    }
    
    // 金额范围
    if (filters.minAmount) {
      orders = orders.filter(o => Number(o.amount) >= Number(filters.minAmount));
    }
    if (filters.maxAmount) {
      orders = orders.filter(o => Number(o.amount) <= Number(filters.maxAmount));
    }
    
    // 关键词搜索
    if (filters.search) {
      const kw = filters.search.toLowerCase();
      orders = orders.filter(o =>
        (o.order_no && o.order_no.toLowerCase().includes(kw)) ||
        (o.product_title && o.product_title.toLowerCase().includes(kw)) ||
        (o.buyer_name && o.buyer_name.toLowerCase().includes(kw)) ||
        (o.buyer_phone && o.buyer_phone.includes(kw))
      );
    }
    
    // 产品类型筛选
    if (filters.productType) {
      orders = orders.filter(o => o.product_type === filters.productType);
    }
    
    // 准备CSV数据
    const headers = ['订单号', '产品名称', '产品类型', '买家姓名', '买家电话', '原价', '优惠金额', '实付金额', '优惠券', '数量', '状态', '支付方式', '支付时间', '发货时间', '物流公司', '物流单号', '完成时间', '备注', '创建时间'];
    const data = orders.map(o => ({
      '订单号': o.order_no || o.id,
      '产品名称': o.product_title || '',
      '产品类型': o.product_type === 'client_product' ? '甲方产品' : '数字化方案',
      '买家姓名': o.buyer_name || '',
      '买家电话': o.buyer_phone || '',
      '原价': o.original_amount || o.amount || 0,
      '优惠金额': o.discount_amount || 0,
      '实付金额': o.amount || 0,
      '优惠券': o.coupon_code || '',
      '数量': o.quantity || 1,
      '状态': getOrderStatusText(o.status),
      '支付方式': o.payment_method || '',
      '支付时间': o.paid_at || '',
      '发货时间': o.shipped_at || '',
      '物流公司': o.tracking_company || '',
      '物流单号': o.tracking_number || '',
      '完成时间': o.completed_at || '',
      '备注': o.remark || '',
      '创建时间': o.created_at || ''
    }));
    
    const csv = arrayToCSV(data, headers);
    
    // 添加统计摘要（可选）
    if (includeStats) {
      const stats = {
        totalOrders: orders.length,
        totalAmount: orders.reduce((sum, o) => sum + Number(o.amount || 0), 0),
        totalOriginal: orders.reduce((sum, o) => sum + Number(o.original_amount || o.amount || 0), 0),
        totalDiscount: orders.reduce((sum, o) => sum + Number(o.discount_amount || 0), 0),
        byStatus: {
          pending: orders.filter(o => o.status === 'pending').length,
          paid: orders.filter(o => o.status === 'paid').length,
          shipped: orders.filter(o => o.status === 'shipped').length,
          completed: orders.filter(o => o.status === 'completed').length,
          cancelled: orders.filter(o => o.status === 'cancelled').length
        },
        avgAmount: orders.length > 0 ? Math.round(orders.reduce((sum, o) => sum + Number(o.amount || 0), 0) / orders.length) : 0
      };
      
      res.setHeader('X-Export-Stats', JSON.stringify(stats));
    }
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=orders_${formatDate()}.csv`);
    res.send(csv);
  } catch (e) {
    console.error('导出订单失败:', e);
    res.status(500).json({ error: '导出失败', message: e.message });
  }
});

/**
 * POST /api/export/contacts
 * 导出线索数据
 */
router.post('/contacts', (req, res) => {
  try {
    const { filters = {} } = req.body;
    let contacts = db.contacts || [];
    
    // 应用过滤条件
    if (filters.status && filters.status !== 'all') {
      contacts = contacts.filter(c => c.status === filters.status);
    }
    if (filters.source && filters.source !== 'all') {
      contacts = contacts.filter(c => c.source === filters.source);
    }
    
    // 准备CSV数据
    const headers = ['ID', '姓名', '手机号', '公司', '行业', '需求描述', '来源', '状态', '备注', '创建时间'];
    const data = contacts.map(c => ({
      'ID': c.id,
      '姓名': c.name || '',
      '手机号': c.phone || '',
      '公司': c.company || '',
      '行业': c.industry || '',
      '需求描述': c.requirements || c.message || '',
      '来源': c.source || '',
      '状态': getContactStatusText(c.status),
      '备注': c.notes || '',
      '创建时间': c.created_at || ''
    }));
    
    const csv = arrayToCSV(data, headers);
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=contacts_${formatDate()}.csv`);
    res.send(csv);
  } catch (e) {
    console.error('导出线索失败:', e);
    res.status(500).json({ error: '导出失败', message: e.message });
  }
});

/**
 * POST /api/export/clients
 * 导出客户数据
 */
router.post('/clients', (req, res) => {
  try {
    let clients = db.clients || [];
    
    // 准备CSV数据
    const headers = ['ID', '公司名称', '联系人', '职位', '手机号', '邮箱', '行业', '状态', '产品数', '入驻时间'];
    const data = clients.map(c => {
      const clientProducts = (db.client_products || []).filter(cp => cp.client_id === c.id);
      return {
        'ID': c.id,
        '公司名称': c.company_name || c.companyName || '',
        '联系人': c.contact_name || c.contactName || '',
        '职位': c.contact_title || c.contactTitle || '',
        '手机号': c.phone || '',
        '邮箱': c.email || '',
        '行业': c.industry || '',
        '状态': c.status || 'active',
        '产品数': clientProducts.length,
        '入驻时间': c.created_at || ''
      };
    });
    
    const csv = arrayToCSV(data, headers);
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=clients_${formatDate()}.csv`);
    res.send(csv);
  } catch (e) {
    console.error('导出客户失败:', e);
    res.status(500).json({ error: '导出失败', message: e.message });
  }
});

/**
 * POST /api/export/products
 * 导出产品数据
 */
router.post('/products', (req, res) => {
  try {
    let products = db.products || [];
    
    // 准备CSV数据
    const headers = ['ID', '产品名称', '分类', '价格', '状态', '订单数', '创建时间'];
    const data = products.map(p => {
      const orders = (db.orders || []).filter(o => 
        o.product_id === p.id && o.product_type === 'product'
      );
      return {
        'ID': p.id,
        '产品名称': p.title || p.name || '',
        '分类': p.category || '',
        '价格': p.price || 0,
        '状态': p.status === 'published' ? '已发布' : '草稿',
        '订单数': orders.length,
        '创建时间': p.created_at || ''
      };
    });
    
    const csv = arrayToCSV(data, headers);
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=products_${formatDate()}.csv`);
    res.send(csv);
  } catch (e) {
    console.error('导出产品失败:', e);
    res.status(500).json({ error: '导出失败', message: e.message });
  }
});

// ============ 辅助函数 ============

function getOrderStatusText(status) {
  const map = {
    'pending': '待支付',
    'paid': '已支付',
    'shipped': '已发货',
    'completed': '已完成',
    'cancelled': '已取消',
    'refunded': '已退款'
  };
  return map[status] || status;
}

function getContactStatusText(status) {
  const map = {
    'pending': '待处理',
    'processing': '跟进中',
    'converted': '已转化',
    'closed': '已关闭'
  };
  return map[status] || status;
}

function formatDate() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = router;
