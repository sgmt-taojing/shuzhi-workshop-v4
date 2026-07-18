/**
 * 定时任务调度器管理 API
 *
 * 接口：
 *   GET    /api/scheduler/tasks        - 获取所有任务状态
 *   GET    /api/scheduler/logs         - 获取执行日志
 *   POST   /api/scheduler/trigger/:name - 手动触发任务
 *   POST   /api/scheduler/toggle/:name - 启用/禁用任务
 *   GET    /api/scheduler/status       - 调度器总体状态
 */

const express = require('express');
const router = express.Router();
const scheduler = require('../scheduler');

// 鉴权
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

// 调度器总体状态
router.get('/status', authCheck, (req, res) => {
  const tasks = scheduler.getTaskStatus();
  const logs = scheduler.getLogs(10);
  res.json({
    running: true,
    totalTasks: tasks.length,
    enabledTasks: tasks.filter(t => t.enabled).length,
    totalRuns: tasks.reduce((sum, t) => sum + t.runCount, 0),
    totalErrors: tasks.reduce((sum, t) => sum + t.errorCount, 0),
    recentLogs: logs,
    uptime: process.uptime()
  });
});

// 获取所有任务状态
router.get('/tasks', authCheck, (req, res) => {
  res.json(scheduler.getTaskStatus());
});

// 获取执行日志
router.get('/logs', authCheck, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(scheduler.getLogs(limit));
});

// 手动触发任务
router.post('/trigger/:name', authCheck, async (req, res) => {
  const { name } = req.params;
  const result = await scheduler.triggerTask(name);
  res.json({ task: name, result, triggered_at: new Date().toISOString() });
});

// 启用/禁用任务
router.post('/toggle/:name', authCheck, (req, res) => {
  const { name } = req.params;
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '参数 enabled 必须为布尔值' });
  }
  const ok = scheduler.toggleTask(name, enabled);
  if (!ok) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json({ task: name, enabled, message: `任务已${enabled ? '启用' : '禁用'}` });
});

module.exports = router;
