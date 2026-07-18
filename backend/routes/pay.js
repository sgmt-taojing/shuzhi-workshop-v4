const { getDB, nextId, save, syncRow } = require('../models/db');
const { createNotification } = require('./notifications');
const { config: payConfig, isPayConfigured } = require('../config/wechat-pay');
const pointsRoute = require('./points');
const { log: auditLog } = require('../middleware/audit');
const router = require('express').Router();

let WxPay = null;
let wxpayInstance = null;

/**
 * 懒加载微信支付 SDK 实例
 */
function getWxPayInstance() {
  if (wxpayInstance) return wxpayInstance;
  try {
    WxPay = require('wechatpay-node-v3');
    wxpayInstance = new WxPay({
      appid: payConfig.appid,
      mchid: payConfig.mchid,
      publicKey: Buffer.from(''), // V3 解密暂不需要平台证书，回调解密用 apiKey
      privateKey: payConfig.privateKey,
    });
    return wxpayInstance;
  } catch (err) {
    console.error('❌ 微信支付SDK初始化失败:', err.message);
    return null;
  }
}

/**
 * POST /api/pay/create - 创建微信支付订单
 * 
 * 请求体:
 *   product_type: 'client_product' | 'product'
 *   product_id: 产品ID
 *   product_title: 产品名称
 *   amount: 金额（元）
 *   buyer_name: 买家姓名
 *   buyer_phone: 买家电话
 *   buyer_openid: 买家openid（必须，小程序支付需要）
 *   user_id: 用户ID（可选，关联用户账户）
 *   quantity: 数量（默认1）
 *   remark: 备注
 */
router.post('/create', async (req, res) => {
  const { 
    product_type, product_id, product_title, amount, 
    buyer_name, buyer_phone, buyer_openid, user_id,
    quantity, remark, coupon_code
  } = req.body;

  if (!product_id || !product_title || !buyer_phone) {
    return res.status(400).json({ error: '缺少必填项（product_id, product_title, buyer_phone）' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: '金额必须大于0' });
  }

  // ===== 优惠券折扣计算 =====
  let originalAmount = Number(amount);
  let discountAmount = 0;
  let couponInfo = null;

  if (coupon_code) {
    const db2 = getDB();
    if (!db2.coupons) db2.coupons = [];
    const coupon = db2.coupons.find(c => c.code.toUpperCase() === coupon_code.toUpperCase());
    if (!coupon) {
      return res.status(400).json({ error: '优惠码不存在' });
    }
    if (coupon.status !== 'active') {
      return res.status(400).json({ error: '优惠券已失效' });
    }
    const now = new Date().toISOString();
    if (coupon.start_time && coupon.start_time > now) {
      return res.status(400).json({ error: '优惠券尚未生效' });
    }
    if (coupon.end_time && coupon.end_time < now) {
      return res.status(400).json({ error: '优惠券已过期' });
    }
    if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
      return res.status(400).json({ error: '优惠券已被领完' });
    }
    if (coupon.min_amount && originalAmount < coupon.min_amount) {
      return res.status(400).json({ error: `订单金额需满${coupon.min_amount}元才能使用此优惠券` });
    }

    // 计算折扣
    if (coupon.type === 'fixed') {
      discountAmount = coupon.value;
    } else if (coupon.type === 'percent') {
      discountAmount = Math.floor(originalAmount * coupon.value / 100);
      if (coupon.max_discount) discountAmount = Math.min(discountAmount, coupon.max_discount);
    }
    // 确保折扣不超过原价
    discountAmount = Math.min(discountAmount, originalAmount);
    couponInfo = { id: coupon.id, code: coupon.code, title: coupon.title, type: coupon.type, value: coupon.value, discountAmount };
  }

  const finalAmount = originalAmount - discountAmount;
  if (finalAmount <= 0 && originalAmount > 0) {
    // 全额减免 → 订单金额为0，直接标记为已支付（免单）
  }

  const db = getDB();
  const orderNo = 'DT' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();

  // 创建订单记录
  const order = {
    id: nextId('orders'),
    order_no: orderNo,
    product_type: product_type || 'client_product',
    product_id: Number(product_id),
    product_title,
    amount: finalAmount,
    original_amount: originalAmount,
    discount_amount: discountAmount,
    coupon_code: coupon_code || '',
    coupon_info: couponInfo ? JSON.stringify(couponInfo) : '',
    quantity: Number(quantity) || 1,
    buyer_name: buyer_name || '',
    buyer_phone,
    buyer_openid: buyer_openid || '',
    user_id: user_id ? Number(user_id) : null, // 新增：关联用户ID
    remark: remark || '',
    status: 'pending',
    payment_method: '',
    transaction_id: '', // 微信支付流水号
    paid_at: null,
    shipped_at: null,
    completed_at: null,
    cancelled_at: null,
    cancel_reason: '',
    tracking_number: '',
    tracking_company: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.orders) db.orders = [];
  db.orders.unshift(order);
  // save() not needed - unshift auto-writes

  // 免单场景（全额优惠券）→ 直接标记为已支付
  if (finalAmount <= 0 && originalAmount > 0) {
    order.status = 'paid';
    order.payment_method = 'coupon_free';
    order.paid_at = new Date().toISOString();
    order.updated_at = new Date().toISOString();
    syncRow('orders', order);

    createNotification({
      type: 'order',
      title: '免单成功',
      content: `订单 ${orderNo} 已通过优惠券全额减免，无需支付。我们会尽快为您安排服务。`,
      target_phones: [buyer_phone],
      link_type: 'order',
      link_id: String(order.id),
      icon: '🎫'
    });

    return res.json({
      order_no: orderNo,
      order_id: order.id,
      mode: 'free',
      original_amount: originalAmount,
      discount_amount: discountAmount,
      final_amount: 0,
      coupon_info: couponInfo,
      _note: '优惠券全额减免，订单已自动标记为已支付'
    });
  }

  // 检查微信支付是否配置
  if (!isPayConfigured() || !buyer_openid) {
    // 未配置或无openid → 返回模拟支付参数（开发模式）
    console.log('⚠️ 微信支付未配置或缺少openid，返回模拟支付参数');
    return res.json({
      order_no: orderNo,
      order_id: order.id,
      mode: 'mock',
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: Math.random().toString(36).slice(2),
      package: 'prepay_id=wx' + Date.now(),
      signType: 'RSA',
      paySign: 'mock_sign_' + Date.now(),
      _note: '当前为模拟支付模式。配置 WX_PAY_* 环境变量并传入 buyer_openid 后可启用真实微信支付。'
    });
  }

  // ===== 真实微信支付 V3 流程 =====
  try {
    const wxpay = getWxPayInstance();
    if (!wxpay) {
      throw new Error('微信支付SDK初始化失败');
    }

    // 金额转分
    const totalCents = Math.round(Number(amount) * 100);

    // 调用微信支付统一下单接口 (JSAPI)
    const result = await wxpay.transactions_jsapi({
      description: product_title,
      out_trade_no: orderNo,
      notify_url: payConfig.notifyUrl,
      amount: {
        total: totalCents,
        currency: 'CNY'
      },
      payer: {
        openid: buyer_openid
      }
    });

    if (result.prepay_id) {
      // 签名生成小程序支付参数
      const payParams = wxpay.getPaySignByJSAPI({
        prepay_id: result.prepay_id,
        appid: payConfig.appid,
        timeStamp: String(Math.floor(Date.now() / 1000)),
        nonceStr: Math.random().toString(36).slice(2),
      });

      res.json({
        order_no: orderNo,
        order_id: order.id,
        mode: 'live',
        timeStamp: payParams.timeStamp,
        nonceStr: payParams.nonceStr,
        package: payParams.package,
        signType: 'RSA',
        paySign: payParams.paySign,
      });
    } else {
      console.error('❌ 微信下单失败:', JSON.stringify(result));
      res.status(500).json({ error: '微信下单失败', detail: result });
    }
  } catch (err) {
    console.error('❌ 微信支付创建异常:', err.message);
    // 降级返回模拟参数，保证流程可继续
    res.json({
      order_no: orderNo,
      order_id: order.id,
      mode: 'mock_fallback',
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: Math.random().toString(36).slice(2),
      package: 'prepay_id=wx_fallback_' + Date.now(),
      signType: 'RSA',
      paySign: 'mock_sign_' + Date.now(),
      _note: '微信支付异常降级为模拟模式: ' + err.message
    });
  }
});

/**
 * POST /api/pay/notify - 微信支付回调通知
 * 
 * 微信服务器在支付成功后调用此接口
 * 需公网可达，建议通过 nginx 转发
 */
router.post('/notify', async (req, res) => {
  try {
    const wxpay = getWxPayInstance();
    if (!wxpay || !isPayConfigured()) {
      console.log('收到支付回调（模拟模式）:', JSON.stringify(req.body));
      return res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
    }

    // V3 回调解密
    const { resource } = req.body || {};
    if (!resource) {
      console.error('❌ 支付回调缺少resource字段');
      return res.status(400).send('<xml><return_code><![CDATA[FAIL]]></return_code></xml>');
    }

    let decrypted;
    try {
      decrypted = wxpay.decipher_gcm(resource.ciphertext, resource.associated_data, resource.nonce, payConfig.apiKeyV3);
    } catch (decryptErr) {
      console.error('❌ 支付回调解密失败:', decryptErr.message);
      return res.status(400).send('<xml><return_code><![CDATA[FAIL]]></return_code></xml>');
    }

    const paymentResult = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
    console.log('✅ 收到微信支付回调:', paymentResult.out_trade_no, paymentResult.trade_state);

    // 更新订单状态
    if (paymentResult.trade_state === 'SUCCESS') {
      const db = getDB();
      const order = (db.orders || []).find(o => o.order_no === paymentResult.out_trade_no);
      if (order && order.status === 'pending') {
        order.status = 'paid';
        order.payment_method = 'wechat';
        order.transaction_id = paymentResult.transaction_id || '';
        order.paid_at = paymentResult.success_time || new Date().toISOString();
        order.updated_at = new Date().toISOString();
        syncRow('orders', order);
        console.log('✅ 订单已更新为已支付:', order.order_no);

        // 积分奖励
        if (order.buyer_openid) {
          pointsRoute.addPoints(order.buyer_openid, 'place_order', order.order_no, '下单: ' + (order.product_title || order.order_no));
        }

        // 自动初始化服务交付里程碑
        try {
          const { initMilestonesForOrder } = require('./service-tracker');
          await initMilestonesForOrder(order.id);
        } catch (e) {
          console.warn('[Pay] 里程碑自动初始化失败:', e.message);
        }
      }
    }

    // 返回成功响应给微信
    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('❌ 支付回调处理异常:', err.message);
    res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
});

/**
 * POST /api/pay/mock-success - 模拟支付成功（开发调试用）
 * 将指定订单标记为已支付
 */
router.post('/mock-success', async (req, res) => {
  const { order_no } = req.body;
  if (!order_no) return res.status(400).json({ error: '缺少order_no' });

  const db = getDB();
  const order = (db.orders || []).find(o => o.order_no === order_no);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status !== 'pending') return res.status(400).json({ error: '订单状态不是待支付' });

  order.status = 'paid';
  order.payment_method = 'mock';
  order.transaction_id = 'MOCK_' + Date.now();
  order.paid_at = new Date().toISOString();
  order.updated_at = new Date().toISOString();
  syncRow('orders', order);

  // 支付成功通知
  createNotification({
    type: 'order',
    title: '支付成功',
    content: `订单 ${order_no} 已支付成功，金额 ¥${Number(order.amount).toFixed(2)}，我们会尽快为您安排服务。`,
    target_phones: [order.buyer_phone],
    link_type: 'order',
    link_id: String(order.id),
    icon: '💰'
  });

  // 自动初始化服务交付里程碑
  try {
    const { initMilestonesForOrder } = require('./service-tracker');
    await initMilestonesForOrder(order.id);
  } catch (e) {
    console.warn('[Pay] 里程碑自动初始化失败:', e.message);
  }

  // 积分奖励
  if (order.buyer_openid) {
    pointsRoute.addPoints(order.buyer_openid, 'place_order', order_no, '下单: ' + (order.product_title || order_no));

    // 发送订阅消息：订单支付成功通知
    try {
      const subscribeMsg = require('./subscribe-msg');
      subscribeMsg.notifyUser(
        order.buyer_openid,
        'order_status',
        {
          character_string1: { value: order_no },
          phrase1: { value: '已支付' },
          amount2: { value: `¥${Number(order.amount).toFixed(2)}` },
          time2: { value: new Date().toLocaleString('zh-CN') }
        },
        `/package-user/pages/orders/orders`,
        'order',
        order.id
      );
    } catch (e) {
      console.warn('[Pay] 发送订阅消息失败:', e.message);
    }
  }

  res.json({ message: '模拟支付成功', order_no, status: 'paid' });
});

/**
 * POST /api/pay/refund - 申请退款
 * 
 * 请求体:
 *   order_no: 订单号
 *   refund_reason: 退款原因
 *   refund_amount: 退款金额（元，不传则全额退款）
 */
router.post('/refund', async (req, res) => {
  const { order_no, refund_reason, refund_amount } = req.body;
  if (!order_no) return res.status(400).json({ error: '缺少order_no' });

  const db = getDB();
  const order = (db.orders || []).find(o => o.order_no === order_no);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (order.status !== 'paid' && order.status !== 'shipped') {
    return res.status(400).json({ error: '订单状态不支持退款' });
  }

  const refundAmount = refund_amount ? Math.round(Number(refund_amount) * 100) : Math.round(order.amount * 100);
  const refundNo = 'RF' + Date.now();

  // 更新订单状态
  order.status = 'refunding';
  order.cancel_reason = refund_reason || '用户申请退款';
  order.updated_at = new Date().toISOString();
  syncRow('orders', order);

  // 记录审计日志
  auditLog('payment.refund', {
    actor_type: 'user',
    actor_id: buyer_phone || order.buyer_phone || '',
    description: `退款申请: 订单 ${order_no}, 金额 ¥${refundAmount / 100}, 原因: ${refund_reason || '未指定'}`,
    resource_type: 'order',
    resource_id: order_no,
    severity: 'critical',
    metadata: { order_no, refund_amount: refundAmount / 100, refund_reason }
  });

  // 检查微信支付是否配置
  if (!isPayConfigured() || order.payment_method === 'mock') {
    // 模拟退款
    order.status = 'refunded';
    order.cancelled_at = new Date().toISOString();
    order.updated_at = new Date().toISOString();
    syncRow('orders', order);
    return res.json({ message: '模拟退款成功（开发模式）', order_no, refund_no: refundNo, refund_amount: refundAmount / 100 });
  }

  // 真实微信退款
  try {
    const wxpay = getWxPayInstance();
    const result = await wxpay.refund({
      out_trade_no: order_no,
      out_refund_no: refundNo,
      amount: {
        refund: refundAmount,
        total: Math.round(order.amount * 100),
        currency: 'CNY'
      },
      reason: refund_reason || '用户申请退款',
      notify_url: payConfig.notifyUrl.replace('/notify', '/refund-notify')
    });

    res.json({ message: '退款申请已提交', refund_no: refundNo, wx_result: result });
  } catch (err) {
    console.error('❌ 退款申请失败:', err.message);
    // 回滚状态
    order.status = 'paid';
    order.updated_at = new Date().toISOString();
    syncRow('orders', order);
    res.status(500).json({ error: '退款申请失败', detail: err.message });
  }
});

/**
 * GET /api/pay/query/:order_no - 查询支付状态
 */
router.get('/query/:order_no', async (req, res) => {
  const { order_no } = req.params;
  const db = getDB();
  const order = (db.orders || []).find(o => o.order_no === order_no);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  // 如果本地已是终态，直接返回
  if (['paid', 'completed', 'cancelled', 'refunded'].includes(order.status)) {
    return res.json({ order_no, status: order.status, paid_at: order.paid_at, transaction_id: order.transaction_id });
  }

  // 未配置微信支付 → 返回本地状态
  if (!isPayConfigured()) {
    return res.json({ order_no, status: order.status, _note: '本地数据（未接入微信支付查询）' });
  }

  // 向微信查询
  try {
    const wxpay = getWxPayInstance();
    const result = await wxpay.query({ out_trade_no: order_no });
    const tradeState = result.trade_state;

    if (tradeState === 'SUCCESS' && order.status === 'pending') {
      order.status = 'paid';
      order.transaction_id = result.transaction_id || '';
      order.paid_at = result.success_time || new Date().toISOString();
      order.updated_at = new Date().toISOString();
      syncRow('orders', order);
    } else if (tradeState === 'CLOSED' && order.status === 'pending') {
      order.status = 'cancelled';
      order.cancel_reason = '支付超时关闭';
      order.cancelled_at = new Date().toISOString();
      order.updated_at = new Date().toISOString();
      syncRow('orders', order);
    }

    res.json({ order_no, status: order.status, wx_trade_state: tradeState, paid_at: order.paid_at });
  } catch (err) {
    res.json({ order_no, status: order.status, _note: '微信查询失败: ' + err.message });
  }
});

module.exports = router;
