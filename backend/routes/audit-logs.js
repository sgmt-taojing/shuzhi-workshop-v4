/**
 * 审计日志 API 路由
 * 
 * 提供审计日志的查询、筛选、统计和导出功能。
 */

const express = require('express');
const router = express.Router();
const { getRawDB } = require('../models/db');
const { log } = require('../middleware/audit');

// 管理员鉴权
function authCheck(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "未授权" });
  const token = auth.slice(7);
  try {
    const { getRawDB } = require("../models/db");
    const db = getRawDB();
    if (!db) return res.status(401).json({ error: "数据库未初始化" });
    const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
    if (!session) return res.status(401).json({ error: "登录已过期，请重新登录" });
    req.adminUser = { id: session.admin_id, username: session.username, role_id: session.role_id, role_name: session.role_name };
    next();
  } catch(e) {
    return res.status(401).json({ error: "认证失败" });
  }
}

/**
 * GET /api/audit-logs
 * 查询审计日志（分页 + 多维筛选）
 */
router.get('/', authCheck, (req, res) => {
  const db = getRawDB();
  if (!db) return res.json({ data: [], total: 0, page: 1, limit: 20 });
  
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  
  // 构建查询条件
  const where = [];
  const params = {};
  
  if (req.query.actor_type) {
    where.push('actor_type = @actor_type');
    params.actor_type = req.query.actor_type;
  }
  if (req.query.action) {
    where.push('action LIKE @action');
    params.action = `%${req.query.action}%`;
  }
  if (req.query.resource_type) {
    where.push('resource_type = @resource_type');
    params.resource_type = req.query.resource_type;
  }
  if (req.query.severity) {
    where.push('severity = @severity');
    params.severity = req.query.severity;
  }
  if (req.query.start_date) {
    where.push('created_at >= @start_date');
    params.start_date = req.query.start_date;
  }
  if (req.query.end_date) {
    where.push('created_at <= @end_date');
    params.end_date = req.query.end_date + ' 23:59:59';
  }
  if (req.query.keyword) {
    where.push('(description LIKE @keyword OR actor_name LIKE @keyword OR actor_id LIKE @keyword OR resource_id LIKE @keyword)');
    params.keyword = `%${req.query.keyword}%`;
  }
  
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  
  // 查询总数
  const countSql = `SELECT COUNT(*) as total FROM audit_logs ${whereClause}`;
  const countResult = db.prepare(countSql).get(params);
  
  // 查询分页数据
  const dataSql = `SELECT * FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  const rows = db.prepare(dataSql).all(params);
  
  // 解析 JSON 字段
  const processedRows = rows.map(row => ({
    ...row,
    metadata: safeJsonParse(row.metadata, {}),
    request_body: row.request_body ? (safeJsonParse(row.request_body, row.request_body)) : ''
  }));
  
  res.json({
    data: processedRows,
    total: countResult.total,
    page,
    limit,
    total_pages: Math.ceil(countResult.total / limit)
  });
});

/**
 * GET /api/audit-logs/stats
 * 审计日志统计概览
 */
router.get('/stats', authCheck, (req, res) => {
  const db = getRawDB();
  if (!db) return res.json({ total: 0, bySeverity: {}, byAction: {}, byActor: {} });
  
  const days = parseInt(req.query.days) || 7;
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  
  // 总数
  const total = db.prepare('SELECT COUNT(*) as c FROM audit_logs WHERE created_at >= ?').get(startDate);
  
  // 按严重程度
  const bySeverity = db.prepare(`
    SELECT severity, COUNT(*) as count 
    FROM audit_logs WHERE created_at >= ? 
    GROUP BY severity ORDER BY count DESC
  `).all(startDate);
  
  // 按操作类型（Top 15）
  const byAction = db.prepare(`
    SELECT action, COUNT(*) as count 
    FROM audit_logs WHERE created_at >= ? 
    GROUP BY action ORDER BY count DESC LIMIT 15
  `).all(startDate);
  
  // 按操作者类型
  const byActorType = db.prepare(`
    SELECT actor_type, COUNT(*) as count 
    FROM audit_logs WHERE created_at >= ? 
    GROUP BY actor_type ORDER BY count DESC
  `).all(startDate);
  
  // 按资源类型
  const byResource = db.prepare(`
    SELECT resource_type, COUNT(*) as count 
    FROM audit_logs WHERE created_at >= ? 
    GROUP BY resource_type ORDER BY count DESC
  `).all(startDate);
  
  // 错误操作（4xx/5xx）
  const errors = db.prepare(`
    SELECT COUNT(*) as count 
    FROM audit_logs WHERE created_at >= ? AND response_status >= 400
  `).get(startDate);
  
  // 高危操作
  const critical = db.prepare(`
    SELECT COUNT(*) as count 
    FROM audit_logs WHERE created_at >= ? AND severity = 'critical'
  `).get(startDate);
  
  // 每日趋势
  const dailyTrend = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as count,
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warning,
      SUM(CASE WHEN response_status >= 400 THEN 1 ELSE 0 END) as errors
    FROM audit_logs WHERE created_at >= ?
    GROUP BY DATE(created_at) ORDER BY date DESC
  `).all(startDate);
  
  res.json({
    total: total.c,
    errors: errors.count,
    critical: critical.count,
    bySeverity: bySeverity,
    byAction: byAction,
    byActorType: byActorType,
    byResource: byResource,
    dailyTrend: dailyTrend,
    days: days
  });
});

/**
 * GET /api/audit-logs/export
 * 导出审计日志为 CSV
 */
router.get('/export', authCheck, (req, res) => {
  const db = getRawDB();
  if (!db) return res.status(500).json({ error: '数据库不可用' });
  
  const where = [];
  const params = {};
  
  if (req.query.actor_type) { where.push('actor_type = @actor_type'); params.actor_type = req.query.actor_type; }
  if (req.query.severity) { where.push('severity = @severity'); params.severity = req.query.severity; }
  if (req.query.start_date) { where.push('created_at >= @start_date'); params.start_date = req.query.start_date; }
  if (req.query.end_date) { where.push('created_at <= @end_date'); params.end_date = req.query.end_date + ' 23:59:59'; }
  if (req.query.action) { where.push('action LIKE @action'); params.action = `%${req.query.action}%`; }
  
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT 5000`).all(params);
  
  // CSV headers
  const headers = ['ID', '时间', '操作者类型', '操作者ID', '操作者名称', '操作', '资源类型', '资源ID', '描述', 'IP', '方法', '路径', '响应状态', '严重程度'];
  let csv = '\uFEFF' + headers.join(',') + '\n'; // BOM for Excel
  
  for (const row of rows) {
    const line = [
      row.id,
      row.created_at,
      row.actor_type,
      `"${(row.actor_id || '').replace(/"/g, '""')}"`,
      `"${(row.actor_name || '').replace(/"/g, '""')}"`,
      `"${(row.action || '').replace(/"/g, '""')}"`,
      row.resource_type,
      `"${(row.resource_id || '').replace(/"/g, '""')}"`,
      `"${(row.description || '').replace(/"/g, '""')}"`,
      row.ip_address,
      row.request_method,
      row.request_path,
      row.response_status,
      row.severity
    ].join(',');
    csv += line + '\n';
  }
  
  const filename = `audit_logs_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

/**
 * DELETE /api/audit-logs/before
 * 清理指定日期之前的日志（数据维护）
 */
router.delete('/before', authCheck, (req, res) => {
  const db = getRawDB();
  if (!db) return res.status(500).json({ error: '数据库不可用' });
  
  const beforeDate = req.query.date;
  if (!beforeDate) return res.status(400).json({ error: '请指定截止日期' });
  
  const result = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(beforeDate);
  
  // 记录这次清理操作本身
  log('audit.cleanup', {
    actor_type: 'admin',
    actor_id: 'admin',
    description: `清理 ${beforeDate} 之前的审计日志，共删除 ${result.changes} 条`,
    severity: 'warning',
    resource_type: 'audit_logs',
    metadata: { deleted_count: result.changes, before_date: beforeDate }
  });
  
  res.json({ deleted: result.changes });
});

/**
 * GET /api/audit-logs/timeline/:resourceType/:resourceId
 * 获取某个资源的完整操作时间线
 */
router.get('/timeline/:resourceType/:resourceId', authCheck, (req, res) => {
  const db = getRawDB();
  if (!db) return res.json({ data: [] });
  
  const { resourceType, resourceId } = req.params;
  
  const rows = db.prepare(`
    SELECT * FROM audit_logs 
    WHERE resource_type = ? AND resource_id = ?
    ORDER BY created_at ASC
  `).all(resourceType, resourceId);
  
  const processedRows = rows.map(row => ({
    ...row,
    metadata: safeJsonParse(row.metadata, {}),
    request_body: row.request_body ? safeJsonParse(row.request_body, row.request_body) : ''
  }));
  
  res.json({ data: processedRows, count: rows.length });
});

// 辅助函数
function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
