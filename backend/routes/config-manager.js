const { getDB, syncRow, nextId, deleteRows } = require('../models/db');
const router = require('express').Router();

// GET / — 获取所有配置（公开，供前端使用）
router.get('/', (req, res) => {
  const db = getDB();
  const rows = db.system_config || [];
  const config = {};
  rows.forEach(r => { config[r.config_key] = r.config_value; });
  // 按分组整理
  const groups = {};
  rows.forEach(r => {
    if (!groups[r.config_group]) groups[r.config_group] = [];
    groups[r.config_group].push(r);
  });
  res.json({ config, groups, count: rows.length });
});

// GET /list — 管理员配置列表
router.get('/list', (req, res) => {
  const db = getDB();
  let rows = (db.system_config || []).slice().sort((a,b) => (a.config_group||'').localeCompare(b.config_group||''));
  const group = req.query.group;
  if (group) rows = rows.filter(r => r.config_group === group);
  res.json({ list: rows, total: rows.length });
});

// POST / — 添加/更新配置
router.post('/', (req, res) => {
  const { config_key, config_value, config_type, config_group, description } = req.body;
  if (!config_key) return res.status(400).json({ error: '缺少配置键' });
  const db = getDB();
  const exist = (db.system_config || []).find(r => r.config_key === config_key);
  if (exist) {
    exist.config_value = config_value !== undefined ? config_value : exist.config_value;
    if (config_type) exist.config_type = config_type;
    if (config_group) exist.config_group = config_group;
    if (description) exist.description = description;
    exist.updated_at = new Date().toISOString();
    syncRow('system_config', exist);
    return res.json(exist);
  }
  const id = nextId('system_config');
  const cfg = {
    id, config_key, config_value: config_value||'',
    config_type: config_type||'text', config_group: config_group||'general',
    description: description||'', updated_at: new Date().toISOString()
  };
  db.system_config.push(cfg);
  res.status(201).json(cfg);
});

// PUT /batch — 批量更新配置
router.put('/batch', (req, res) => {
  const configs = req.body.configs;
  if (!configs || !Array.isArray(configs)) return res.status(400).json({ error: '缺少configs数组' });
  const db = getDB();
  const now = new Date().toISOString();
  let updated = 0;
  configs.forEach(({ config_key, config_value }) => {
    const exist = (db.system_config || []).find(r => r.config_key === config_key);
    if (exist) {
      exist.config_value = config_value !== undefined ? String(config_value) : exist.config_value;
      exist.updated_at = now;
      syncRow('system_config', exist);
      updated++;
    }
  });
  res.json({ updated, message: `已更新 ${updated} 条配置` });
});

module.exports = router;
