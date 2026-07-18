const { getDB } = require('../models/db');
const router = require('express').Router();

// 公开：获取痛点列表
router.get('/pain-points', (req, res) => {
  const db = getDB();
  const rows = (db.pain_points || []).filter(r => r.published).sort((a, b) => {
    const order = { inventory: 1, process: 2, data: 3, reconciliation: 4, approval: 5, collaboration: 6 };
    return (order[a.id] || 99) - (order[b.id] || 99);
  });
  res.json(rows);
});

// 公开：获取行业列表
router.get('/industries', (req, res) => {
  const db = getDB();
  const rows = (db.industries || []).filter(r => r.published);
  res.json(rows);
});

module.exports = router;
