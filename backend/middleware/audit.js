/**
 * 审计日志中间件
 * 
 * 自动记录敏感 API 操作到 audit_logs 表。
 * 支持手动记录和自动拦截两种模式。
 */

const { getRawDB } = require('../models/db');

// 需要自动审计的 API 路径模式
const AUDIT_PATTERNS = [
  { method: 'POST',   pattern: /^\/api\/pay\/create/,        action: 'payment.create',        severity: 'info' },
  { method: 'POST',   pattern: /^\/api\/pay\/refund/,        action: 'payment.refund',        severity: 'critical' },
  { method: 'POST',   pattern: /^\/api\/pay\/mock-success/,  action: 'payment.mock_success',  severity: 'warning' },
  { method: 'POST',   pattern: /^\/api\/orders/,              action: 'order.create',          severity: 'info' },
  { method: 'PUT',    pattern: /^\/api\/orders\//,            action: 'order.update',          severity: 'warning' },
  { method: 'POST',   pattern: /^\/api\/admin\/login/,        action: 'admin.login',           severity: 'info' },
  { method: 'POST',   pattern: /^\/api\/auth\/login/,         action: 'user.login',            severity: 'info' },
  { method: 'POST',   pattern: /^\/api\/onboarding/,          action: 'onboarding.submit',     severity: 'info' },
  { method: 'POST',   pattern: /^\/api\/contact/,             action: 'contact.submit',        severity: 'info' },
  { method: 'POST',   pattern: /^\/api\/admin\/products/,     action: 'product.create',        severity: 'warning' },
  { method: 'PUT',    pattern: /^\/api\/admin\/products\//,   action: 'product.update',        severity: 'warning' },
  { method: 'DELETE', pattern: /^\/api\/admin\/products\//,   action: 'product.delete',        severity: 'critical' },
  { method: 'POST',   pattern: /^\/api\/admin\/articles/,     action: 'article.create',        severity: 'warning' },
  { method: 'PUT',    pattern: /^\/api\/admin\/articles\//,   action: 'article.update',        severity: 'warning' },
  { method: 'DELETE', pattern: /^\/api\/admin\/articles\//,   action: 'article.delete',        severity: 'critical' },
  { method: 'POST',   pattern: /^\/api\/admin\/client-products/, action: 'client_product.create', severity: 'warning' },
  { method: 'PUT',    pattern: /^\/api\/admin\/client-products\//, action: 'client_product.update', severity: 'warning' },
  { method: 'DELETE', pattern: /^\/api\/admin\/client-products\//, action: 'client_product.delete', severity: 'critical' },
  { method: 'POST',   pattern: /^\/api\/admin\/orders\//,     action: 'admin.order_update',    severity: 'warning' },
  { method: 'POST',   pattern: /^\/api\/admin\/onboardings\//, action: 'onboarding.review',    severity: 'warning' },
  { method: 'POST',   pattern: /^\/api\/coupons\/redeem/,     action: 'coupon.redeem',         severity: 'info' },
  { method: 'POST',   pattern: /^\/api\/coupons/,             action: 'coupon.create',         severity: 'warning' },
  { method: 'POST',   pattern: /^\/api\/bookings/,            action: 'booking.create',        severity: 'info' },
  { method: 'POST',   pattern: /^\/api\/feedback/,            action: 'feedback.submit',       severity: 'info' },
];

// 需要从请求体中过滤掉的敏感字段
const SENSITIVE_FIELDS = ['password', 'token', 'secret', 'api_key', 'privateKey', 'certSerialNo', 'v3Key'];

/**
 * 清理请求体中的敏感信息
 */
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return '{}';
  const cleaned = {};
  for (const [key, value] of Object.entries(body)) {
    if (SENSITIVE_FIELDS.some(f => key.toLowerCase().includes(f.toLowerCase()))) {
      cleaned[key] = '***REDACTED***';
    } else {
      cleaned[key] = value;
    }
  }
  // 限制大小
  const str = JSON.stringify(cleaned);
  if (str.length > 2000) return str.slice(0, 2000) + '...[truncated]';
  return str;
}

/**
 * 提取资源 ID 从路径中
 */
function extractResourceId(path, pattern) {
  const match = path.match(pattern);
  if (match && match[1]) return match[1];
  return '';
}

/**
 * 判断请求是否需要审计
 */
function shouldAudit(method, path) {
  for (const rule of AUDIT_PATTERNS) {
    if (rule.method === method && rule.pattern.test(path)) {
      return rule;
    }
  }
  return null;
}

/**
 * 获取客户端 IP
 */
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.headers['x-real-ip'] 
    || req.socket?.remoteAddress 
    || '';
}

/**
 * 写入审计日志
 */
function writeAuditLog(entry) {
  try {
    const db = getRawDB();
    if (!db) return;
    
    db.prepare(`INSERT INTO audit_logs 
      (actor_type, actor_id, actor_name, action, resource_type, resource_id, 
       description, ip_address, user_agent, request_method, request_path, 
       request_body, response_status, severity, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.actor_type || 'system',
      entry.actor_id || '',
      entry.actor_name || '',
      entry.action || '',
      entry.resource_type || '',
      entry.resource_id || '',
      entry.description || '',
      entry.ip_address || '',
      entry.user_agent || '',
      entry.request_method || '',
      entry.request_path || '',
      entry.request_body || '',
      entry.response_status || 0,
      entry.severity || 'info',
      JSON.stringify(entry.metadata || {})
    );
  } catch (e) {
    console.error('审计日志写入失败:', e.message);
  }
}

/**
 * Express 中间件：自动审计敏感 API
 */
function auditMiddleware(req, res, next) {
  const rule = shouldAudit(req.method, req.path);
  if (!rule) return next();

  // 记录请求开始时间
  const startTime = Date.now();
  
  // 拦截响应完成事件
  const originalEnd = res.end;
  res.end = function(...args) {
    // 恢复原始 end
    res.end = originalEnd;
    
    // 构建审计日志条目
    const actorType = req.path.includes('/admin/') ? 'admin' : 
                      req.headers.authorization ? 'user' : 'api';
    
    const actorId = req.body?.username || 
                    req.headers['x-openid'] || 
                    getClientIP(req);
    
    let resourceType = '';
    let resourceId = '';
    
    if (req.path.includes('/orders')) { resourceType = 'order'; resourceId = req.params?.id || req.body?.order_no || ''; }
    else if (req.path.includes('/products')) { resourceType = 'product'; resourceId = req.params?.id || req.body?.id || ''; }
    else if (req.path.includes('/articles')) { resourceType = 'article'; resourceId = req.params?.id || req.body?.id || ''; }
    else if (req.path.includes('/client-products')) { resourceType = 'client_product'; resourceId = req.params?.id || req.body?.id || ''; }
    else if (req.path.includes('/onboarding')) { resourceType = 'onboarding'; resourceId = req.params?.id || ''; }
    else if (req.path.includes('/pay')) { resourceType = 'payment'; resourceId = req.body?.order_no || ''; }
    else if (req.path.includes('/coupons')) { resourceType = 'coupon'; resourceId = req.body?.code || ''; }
    else if (req.path.includes('/bookings')) { resourceType = 'booking'; resourceId = req.body?.booking_no || ''; }
    
    // 构建描述
    const desc = `${rule.action} - ${req.method} ${req.path}`;
    
    const entry = {
      actor_type: actorType,
      actor_id: actorId,
      actor_name: req.body?.username || '',
      action: rule.action,
      resource_type: resourceType,
      resource_id: resourceId,
      description: desc,
      ip_address: getClientIP(req),
      user_agent: (req.headers['user-agent'] || '').slice(0, 200),
      request_method: req.method,
      request_path: req.path,
      request_body: sanitizeBody(req.body),
      response_status: res.statusCode,
      severity: res.statusCode >= 400 ? 'warning' : rule.severity,
      metadata: {
        duration_ms: Date.now() - startTime,
        query: req.query ? JSON.stringify(req.query).slice(0, 500) : ''
      }
    };
    
    writeAuditLog(entry);
    
    // 调用原始 end
    res.end(...args);
  };
  
  next();
}

/**
 * 手动记录审计日志（供路由代码主动调用）
 */
function log(action, options = {}) {
  writeAuditLog({
    actor_type: options.actor_type || 'system',
    actor_id: options.actor_id || '',
    actor_name: options.actor_name || '',
    action,
    resource_type: options.resource_type || '',
    resource_id: options.resource_id || '',
    description: options.description || action,
    ip_address: options.ip_address || '',
    user_agent: options.user_agent || '',
    request_method: options.method || '',
    request_path: options.path || '',
    request_body: options.body || '',
    response_status: options.status || 0,
    severity: options.severity || 'info',
    metadata: options.metadata || {}
  });
}

module.exports = { auditMiddleware, log, writeAuditLog, getClientIP };
