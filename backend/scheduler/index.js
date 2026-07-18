/**
 * 数造工坊 · 集中式定时任务调度器
 *
 * 功能：
 * 1. 统一管理所有后台定时任务（注册、启停、监控）
 * 2. 内置任务：超时订单自动取消、优惠券到期提醒、CRM滞留线索提醒、低库存预警、数据备份
 * 3. 管理后台 API：查看任务列表、手动触发、启停任务
 * 4. 任务执行日志记录
 * 5. 无额外依赖，基于 setInterval 实现
 *
 * 使用方式：
 *   const scheduler = require('./scheduler');
 *   scheduler.start(); // 启动调度器（在 server.js 中调用）
 */

const path = require('path');
const fs = require('fs');

// ==================== 任务执行日志 ====================

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'scheduler.log');
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB

// 确保日志目录存在
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }

// 内存中的执行日志（最近 500 条）
const executionLogs = [];
const MAX_MEM_LOGS = 500;

function logExecution(taskName, status, message, duration) {
  const entry = {
    id: executionLogs.length + 1,
    task_name: taskName,
    status: status, // success / error / skipped
    message: message || '',
    duration_ms: duration || 0,
    executed_at: new Date().toISOString()
  };
  executionLogs.unshift(entry);
  if (executionLogs.length > MAX_MEM_LOGS) {
    executionLogs.length = MAX_MEM_LOGS;
  }

  // 写入文件日志
  const logLine = `[${entry.executed_at}] [${taskName}] [${status}] ${entry.message} (${entry.duration_ms}ms)\n`;
  try {
    // 日志文件轮转
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.old');
      }
    }
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (e) {
    console.error('[Scheduler] 写入日志失败:', e.message);
  }

  // 控制台输出
  if (status === 'error') {
    console.error(logLine.trim());
  } else if (status === 'skipped') {
    // 静默跳过
  } else {
    console.log(logLine.trim());
  }
}

// ==================== 任务注册表 ====================

const tasks = {};
let mainTimer = null;
let isRunning = false;

/**
 * 注册定时任务
 * @param {Object} config 任务配置
 * @param {string} config.name 任务名称（唯一标识）
 * @param {string} config.description 任务描述
 * @param {string} config.schedule 执行频率描述（人类可读）
 * @param {Function} config.check 触发条件检查函数，返回 true 则执行
 * @param {Function} config.execute 执行函数（async）
 * @param {boolean} config.enabled 是否启用
 * @param {number} config.checkIntervalSeconds 检查间隔（秒），默认 60
 */
function registerTask(config) {
  tasks[config.name] = {
    name: config.name,
    description: config.description || '',
    schedule: config.schedule || '',
    check: config.check || (() => false),
    execute: config.execute || (async () => {}),
    enabled: config.enabled !== false,
    checkIntervalSeconds: config.checkIntervalSeconds || 60,
    lastRun: null,
    lastStatus: 'idle', // idle / success / error / skipped
    lastDuration: 0,
    runCount: 0,
    errorCount: 0,
    successCount: 0,
    skipCount: 0,
    nextCheck: Date.now() + (config.checkIntervalSeconds || 60) * 1000
  };
}

// ==================== 内置任务 ====================

/**
 * 任务1：超时订单自动取消
 * 检查间隔：每 5 分钟
 * 触发条件：始终执行
 * 逻辑：找到 status=pending 且创建超过 30 分钟的订单，自动取消
 */
registerTask({
  name: 'auto_cancel_timeout_orders',
  description: '自动取消超时未支付的订单（30分钟）',
  schedule: '每5分钟检查',
  checkIntervalSeconds: 300,
  enabled: true,
  check: () => true,
  execute: async () => {
    const { getRawDB } = require('../models/db');
    const d = getRawDB();
    if (!d) return { cancelled: 0, reason: '数据库未就绪' };

    const timeoutMinutes = 30;
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

    // 查找超时订单
    const timeoutOrders = d.prepare(`
      SELECT id, order_no, product_title, buyer_name, buyer_phone, created_at
      FROM orders
      WHERE status = 'pending' AND created_at < ?
    `).all(cutoff);

    if (timeoutOrders.length === 0) {
      return { cancelled: 0, reason: '无超时订单' };
    }

    // 批量取消
    const updateStmt = d.prepare(`
      UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `);

    let cancelled = 0;
    const cancelIds = [];
    const cancelLogs = [];

    for (const order of timeoutOrders) {
      const result = updateStmt.run(order.id);
      if (result.changes > 0) {
        cancelled++;
        cancelIds.push(order.id);
        cancelLogs.push(`${order.order_no}(${order.product_title})`);

        // 创建通知
        try {
          const { createNotification } = require('../routes/notifications');
          createNotification({
            type: 'order',
            title: '订单已自动取消',
            content: `订单 ${order.order_no}（${order.product_title}）因超时未支付已自动取消。`,
            target_phones: order.buyer_phone ? [order.buyer_phone] : []
          });
        } catch (e) {
          // 通知失败不影响取消操作
        }
      }
    }

    // 记录审计日志
    if (cancelled > 0) {
      try {
        const { log: auditLog } = require('../middleware/audit');
        auditLog('order.auto_cancel', {
          actorType: 'system',
          actorId: 'scheduler',
          actorName: '定时调度器',
          description: `自动取消 ${cancelled} 个超时订单: ${cancelLogs.join(', ')}`,
          resourceType: 'order',
          resourceId: cancelIds.join(','),
          severity: 'warning',
          metadata: { cancelled, orderIds: cancelIds }
        });
      } catch (e) { /* ignore */ }
    }

    return { cancelled, orderIds: cancelIds, details: cancelLogs };
  }
});

/**
 * 任务2：优惠券到期提醒
 * 检查间隔：每 1 小时
 * 触发条件：始终执行
 * 逻辑：找到 3 天内到期且未提醒的用户优惠券，推送通知
 */
registerTask({
  name: 'coupon_expiry_reminder',
  description: '优惠券到期提醒（提前3天）',
  schedule: '每小时检查',
  checkIntervalSeconds: 3600,
  enabled: true,
  check: () => true,
  execute: async () => {
    const { getRawDB } = require('../models/db');
    const d = getRawDB();
    if (!d) return { reminded: 0, reason: '数据库未就绪' };

    // 检查 user_coupons 表是否存在
    const tableExists = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_coupons'").get();
    if (!tableExists) return { reminded: 0, reason: 'user_coupons 表不存在' };

    const remindDays = 3;
    const cutoff = new Date(Date.now() + remindDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 查找即将到期且未提醒的优惠券
    const expiring = d.prepare(`
      SELECT uc.id, uc.coupon_id, uc.user_phone, uc.status,
             c.title, c.discount_type, c.discount_value, c.min_amount, c.expire_date
      FROM user_coupons uc
      LEFT JOIN coupons c ON uc.coupon_id = c.id
      WHERE uc.status = 'unused'
        AND c.expire_date <= ?
        AND c.expire_date >= date('now')
        AND (uc.remind_sent IS NULL OR uc.remind_sent = 0)
    `).all(cutoff);

    if (expiring.length === 0) {
      return { reminded: 0, reason: '无即将到期的优惠券' };
    }

    const { createNotification } = require('../routes/notifications');
    let reminded = 0;
    const updateStmt = d.prepare('UPDATE user_coupons SET remind_sent = 1 WHERE id = ?');

    for (const uc of expiring) {
      try {
        const discountText = uc.discount_type === 'percent'
          ? `${uc.discount_value}折`
          : `¥${uc.discount_value}`;

        createNotification({
          type: 'activity',
          title: '优惠券即将到期提醒',
          content: `您的优惠券「${uc.title}」(${discountText}) 将于 ${uc.expire_date} 到期，请尽快使用！`,
          target_phones: uc.user_phone ? [uc.user_phone] : []
        });

        updateStmt.run(uc.id);
        reminded++;
      } catch (e) {
        // 单条失败不影响其他
      }
    }

    return { reminded, total: expiring.length };
  }
});

/**
 * 任务3：CRM 滞留线索提醒
 * 检查间隔：每 6 小时
 * 触发条件：始终执行
 * 逻辑：找到在某一阶段停留超过 7 天的线索，创建提醒通知
 */
registerTask({
  name: 'crm_stale_lead_reminder',
  description: 'CRM滞留线索提醒（停留超7天）',
  schedule: '每6小时检查',
  checkIntervalSeconds: 21600,
  enabled: true,
  check: () => true,
  execute: async () => {
    const { getRawDB } = require('../models/db');
    const d = getRawDB();
    if (!d) return { reminded: 0, reason: '数据库未就绪' };

    // 检查 contacts 表是否有 CRM 字段
    const tableExists = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'").get();
    if (!tableExists) return { reminded: 0, reason: 'contacts 表不存在' };

    try {
      const staleDays = 7;
      const cutoff = new Date(Date.now() - staleDays * 86400000).toISOString();

      // 查找滞留线索（非终态，且更新时间超过阈值）
      const staleLeads = d.prepare(`
        SELECT id, name, phone, company, lead_stage, assigned_to, updated_at
        FROM contacts
        WHERE lead_stage NOT IN ('won', 'lost')
          AND lead_stage IS NOT NULL
          AND updated_at < ?
          AND (stale_remind_sent IS NULL OR stale_remind_sent = 0)
      `).all(cutoff);

      if (staleLeads.length === 0) {
        return { reminded: 0, reason: '无滞留线索' };
      }

      const { createNotification } = require('../routes/notifications');
      let reminded = 0;
      const updateStmt = d.prepare('UPDATE contacts SET stale_remind_sent = 1 WHERE id = ?');

      const stageNames = {
        new: '新线索', contacted: '已联系', qualified: '已合格',
        proposal: '方案报价', negotiation: '谈判中'
      };

      for (const lead of staleLeads) {
        try {
          createNotification({
            type: 'system',
            title: 'CRM滞留线索提醒',
            content: `线索「${lead.name}」(${lead.company || '无公司'}) 在「${stageNames[lead.lead_stage] || lead.lead_stage}」阶段已停留超过 ${staleDays} 天，请及时跟进。`,
            target_phones: []
          });

          updateStmt.run(lead.id);
          reminded++;
        } catch (e) {
          // 单条失败不影响其他
        }
      }

      return { reminded, total: staleLeads.length };
    } catch (e) {
      // 可能 stale_remind_sent 列不存在
      return { reminded: 0, reason: '字段缺失: ' + e.message };
    }
  }
});

/**
 * 任务4：数据自动备份
 * 检查间隔：每 24 小时
 * 触发条件：每天凌晨 2:00 执行
 * 逻辑：备份 SQLite 数据库文件
 */
registerTask({
  name: 'auto_data_backup',
  description: '数据库自动备份（每日凌晨2点）',
  schedule: '每天 02:00',
  checkIntervalSeconds: 3600, // 每小时检查一次
  enabled: true,
  check: () => {
    const now = new Date();
    return now.getHours() === 2 && now.getMinutes() < 5;
  },
  execute: async () => {
    const { getRawDB } = require('../models/db');
    if (!getRawDB) return { backed: false, reason: '数据库未就绪' };

    const backupDir = path.join(__dirname, '..', 'data', 'backups');
    try { fs.mkdirSync(backupDir, { recursive: true }); } catch (e) { /* ignore */ }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const backupFile = path.join(backupDir, `dt-mall-${timestamp}.db`);

    const dbPath = path.join(__dirname, '..', 'data', 'dt-mall.db');
    if (!fs.existsSync(dbPath)) {
      return { backed: false, reason: '数据库文件不存在' };
    }

    // 使用 SQLite 的 backup API
    try {
      const d = getRawDB();
      await d.backup(backupFile);
    } catch (e) {
      // fallback: 直接复制文件
      fs.copyFileSync(dbPath, backupFile);
    }

    // 清理旧备份（保留最近 7 天）
    const cutoff = Date.now() - 7 * 86400000;
    const backups = fs.readdirSync(backupDir)
      .map(f => ({ name: f, path: path.join(backupDir, f), mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    let cleaned = 0;
    for (const b of backups) {
      if (b.mtime < cutoff) {
        fs.unlinkSync(b.path);
        cleaned++;
      }
    }

    // 记录审计
    try {
      const { log: auditLog } = require('../middleware/audit');
      auditLog('system.backup', {
        actorType: 'system',
        actorId: 'scheduler',
        actorName: '定时调度器',
        description: `自动数据备份完成: ${path.basename(backupFile)}`,
        resourceType: 'system',
        resourceId: 'database',
        severity: 'info',
        metadata: { backupFile: path.basename(backupFile), cleaned: cleaned }
      });
    } catch (e) { /* ignore */ }

    return { backed: true, file: path.basename(backupFile), cleaned: cleaned };
  }
});

/**
 * 任务5：预约提醒
 * 检查间隔：每 30 分钟
 * 触发条件：始终执行
 * 逻辑：找到 24 小时内的预约，给用户发送提醒通知
 */
registerTask({
  name: 'booking_reminder',
  description: '预约演示提醒（提前24小时）',
  schedule: '每30分钟检查',
  checkIntervalSeconds: 1800,
  enabled: true,
  check: () => true,
  execute: async () => {
    const { getRawDB } = require('../models/db');
    const d = getRawDB();
    if (!d) return { reminded: 0, reason: '数据库未就绪' };

    const tableExists = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bookings'").get();
    if (!tableExists) return { reminded: 0, reason: 'bookings 表不存在' };

    // 查找 24 小时内的待提醒预约
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const today = now.toISOString();

    try {
      const upcoming = d.prepare(`
        SELECT id, name, phone, product_title, demo_date, demo_time, status, remind_sent
        FROM bookings
        WHERE status = 'confirmed'
          AND demo_date || ' ' || COALESCE(demo_time, '00:00') >= ?
          AND demo_date || ' ' || COALESCE(demo_time, '00:00') <= ?
          AND (remind_sent IS NULL OR remind_sent = 0)
      `).all(today, tomorrow);

      if (upcoming.length === 0) {
        return { reminded: 0, reason: '无待提醒预约' };
      }

      const { createNotification } = require('../routes/notifications');
      let reminded = 0;
      const updateStmt = d.prepare('UPDATE bookings SET remind_sent = 1 WHERE id = ?');

      for (const b of upcoming) {
        try {
          createNotification({
            type: 'system',
            title: '预约演示提醒',
            content: `您预约的「${b.product_title}」演示将于 ${b.demo_date} ${b.demo_time || ''} 进行，请准时参加。如需修改请提前联系客服。`,
            target_phones: b.phone ? [b.phone] : []
          });

          updateStmt.run(b.id);
          reminded++;
        } catch (e) {
          // 单条失败不影响其他
        }
      }

      return { reminded, total: upcoming.length };
    } catch (e) {
      return { reminded: 0, reason: '字段缺失: ' + e.message };
    }
  }
});

/**
 * 任务6：系统健康检查
 * 检查间隔：每 5 分钟
 * 触发条件：始终执行
 * 逻辑：检查数据库连接、磁盘空间、关键表数据量
 */
registerTask({
  name: 'system_health_check',
  description: '系统健康检查（数据库/磁盘/数据量）',
  schedule: '每5分钟检查',
  checkIntervalSeconds: 300,
  enabled: true,
  check: () => true,
  execute: async () => {
    const { getRawDB } = require('../models/db');
    const d = getRawDB();
    if (!d) return { healthy: false, reason: '数据库未就绪' };

    const checks = {};

    // 1. 数据库连接
    try {
      d.prepare('SELECT 1').get();
      checks.database = 'ok';
    } catch (e) {
      checks.database = 'error: ' + e.message;
      return { healthy: false, checks };
    }

    // 2. 关键表数据量
    const tables = ['products', 'articles', 'client_products', 'orders', 'contacts'];
    checks.tableCounts = {};
    for (const t of tables) {
      try {
        const count = d.prepare(`SELECT COUNT(*) as c FROM ${t}`).get();
        checks.tableCounts[t] = count.c;
      } catch (e) {
        checks.tableCounts[t] = -1;
      }
    }

    // 3. 磁盘空间（检查数据目录大小）
    try {
      const dataDir = path.join(__dirname, '..', 'data');
      if (fs.existsSync(dataDir)) {
        const stats = fs.statSync(path.join(dataDir, 'dt-mall.db'));
        checks.dbFileSize = (stats.size / 1024 / 1024).toFixed(2) + 'MB';
      }
    } catch (e) {
      checks.dbFileSize = 'unknown';
    }

    // 4. 检查待处理订单数
    try {
      const pendingOrders = d.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get();
      checks.pendingOrders = pendingOrders.c;
      if (pendingOrders.c > 100) {
        checks.warnings = checks.warnings || [];
        checks.warnings.push(`待处理订单数较高: ${pendingOrders.c}`);
      }
    } catch (e) { /* ignore */ }

    checks.healthy = true;
    return checks;
  }
});

// ==================== 调度器核心 ====================

/**
 * 执行单个任务
 */
async function runTask(taskName) {
  const task = tasks[taskName];
  if (!task) return { error: '任务不存在' };

  const startTime = Date.now();
  try {
    // 检查触发条件
    let shouldRun = true;
    try {
      shouldRun = task.check();
    } catch (e) {
      shouldRun = true; // check 出错也执行
    }

    if (!shouldRun) {
      task.lastStatus = 'skipped';
      task.skipCount++;
      logExecution(taskName, 'skipped', '条件不满足，跳过执行', 0);
      return { skipped: true };
    }

    // 执行任务
    const result = await task.execute();
    const duration = Date.now() - startTime;

    task.lastRun = new Date().toISOString();
    task.lastStatus = 'success';
    task.lastDuration = duration;
    task.runCount++;
    task.successCount++;

    const msg = typeof result === 'object'
      ? JSON.stringify(result)
      : String(result);
    logExecution(taskName, 'success', msg, duration);

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    task.lastRun = new Date().toISOString();
    task.lastStatus = 'error';
    task.lastDuration = duration;
    task.runCount++;
    task.errorCount++;

    logExecution(taskName, 'error', error.message, duration);
    return { error: error.message };
  }
}

/**
 * 启动调度器
 */
function start() {
  if (isRunning) return;
  isRunning = true;

  // 主循环：每 30 秒检查一次是否有任务需要执行
  mainTimer = setInterval(async () => {
    const now = Date.now();
    for (const [name, task] of Object.entries(tasks)) {
      if (!task.enabled) continue;
      if (now >= task.nextCheck) {
        task.nextCheck = now + task.checkIntervalSeconds * 1000;
        // 异步执行，不阻塞主循环
        runTask(name).catch(() => {});
      }
    }
  }, 30 * 1000);

  console.log('[Scheduler] 定时任务调度器已启动，注册任务:', Object.keys(tasks).join(', '));
}

/**
 * 停止调度器
 */
function stop() {
  if (mainTimer) {
    clearInterval(mainTimer);
    mainTimer = null;
  }
  isRunning = false;
  console.log('[Scheduler] 定时任务调度器已停止');
}

/**
 * 获取所有任务状态
 */
function getTaskStatus() {
  return Object.values(tasks).map(t => ({
    name: t.name,
    description: t.description,
    schedule: t.schedule,
    enabled: t.enabled,
    lastRun: t.lastRun,
    lastStatus: t.lastStatus,
    lastDuration: t.lastDuration,
    runCount: t.runCount,
    successCount: t.successCount,
    errorCount: t.errorCount,
    skipCount: t.skipCount,
    nextCheck: new Date(t.nextCheck).toISOString()
  }));
}

/**
 * 获取执行日志
 */
function getLogs(limit) {
  return executionLogs.slice(0, limit || 100);
}

/**
 * 启用/禁用任务
 */
function toggleTask(name, enabled) {
  const task = tasks[name];
  if (!task) return false;
  task.enabled = enabled;
  if (enabled) {
    task.nextCheck = Date.now();
  }
  logExecution(name, 'success', `任务${enabled ? '已启用' : '已禁用'}`, 0);
  return true;
}

/**
 * 手动触发任务
 */
async function triggerTask(name) {
  if (!tasks[name]) return { error: '任务不存在' };
  return await runTask(name);
}

module.exports = {
  start,
  stop,
  registerTask,
  runTask,
  getTaskStatus,
  getLogs,
  toggleTask,
  triggerTask,
  executionLogs
};
