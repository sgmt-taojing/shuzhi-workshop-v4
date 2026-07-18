/**
 * 文件上传路由
 * 
 * 支持 multipart/form-data 文件上传（图片等）
 * 图片存储到 backend/uploads/ 目录下，通过静态文件服务访问
 * 
 * 使用场景：
 * - 评价图片上传（reviews）
 * - 甲方产品图片上传（client-products）
 * - 头像上传（avatars）
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();

// 上传根目录
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// 各类型图片子目录
const SUB_DIRS = {
  reviews: 'reviews',
  'client-products': 'client-products',
  avatars: 'avatars',
  articles: 'articles',
  products: 'products',
  general: 'general'
};

// 允许的文件类型
const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
};

// 最大文件大小（5MB）
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// 确保子目录存在
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 生成唯一文件名
function generateFilename(ext) {
  const hash = crypto.randomBytes(8).toString('hex');
  const ts = Date.now();
  return `${ts}_${hash}${ext}`;
}

/**
 * POST /api/upload
 * 上传文件
 * 
 * body: multipart/form-data
 *   - file: 文件（必填）
 *   - type: 类型（可选，默认 general）
 *     reviews | client-products | avatars | articles | products | general
 * 
 * 返回:
 *   { url: "/uploads/reviews/xxx.jpg", path: "uploads/reviews/xxx.jpg", name: "原始文件名" }
 */
router.post('/', async (req, res) => {
  // 根据 Content-Type 选择上传方式
  const contentType = (req.headers['content-type'] || '').toLowerCase();

  if (contentType.includes('application/json') || contentType.includes('text/plain')) {
    // JSON/纯文本 → base64 data URI 方式
    return handleBase64Upload(req, res);
  }

  // multipart/form-data → formidable 处理
  if (contentType.includes('multipart/form-data') || !req.is('json')) {
    return handleFormDataUpload(req, res);
  }

  // 兜底
  return handleBase64Upload(req, res);
});

/**
 * 处理 multipart/form-data 文件上传
 */
function handleFormDataUpload(req, res) {
  let formidable;
  try {
    formidable = require('formidable');
  } catch (e) {
    return res.status(500).json({ error: '服务器未配置文件上传模块' });
  }

  const form = formidable({
    multiples: false,
    maxFileSize: MAX_FILE_SIZE,
    keepExtensions: true,
    filter: ({ mimetype }) => {
      return !!ALLOWED_MIME[mimetype];
    }
  });

  form.parse(req, (err, fields, files) => {
    if (err) {
      console.error('文件上传解析失败:', err.message);
      return res.status(400).json({ error: '文件上传解析失败: ' + err.message });
    }

    const file = files.file || files.filepond || files.image;
    if (!file) {
      return res.status(400).json({ error: '未找到上传文件，请使用 file 字段上传' });
    }

    const uploadType = (fields.type || 'general').replace(/[^a-z0-9-]/g, '');
    const subDir = SUB_DIRS[uploadType] || SUB_DIRS.general;
    const targetDir = path.join(UPLOAD_DIR, subDir);
    ensureDir(targetDir);

    const ext = path.extname(file.originalFilename) || ALLOWED_MIME[file.mimetype] || '.jpg';
    const newFilename = generateFilename(ext);
    const targetPath = path.join(targetDir, newFilename);

    try {
      fs.copyFileSync(file.filepath, targetPath);
      try { fs.unlinkSync(file.filepath); } catch (_) {}
    } catch (e) {
      try {
        const data = fs.readFileSync(file.filepath);
        fs.writeFileSync(targetPath, data);
        try { fs.unlinkSync(file.filepath); } catch (_) {}
      } catch (e2) {
        return res.status(500).json({ error: '文件保存失败' });
      }
    }

    const relativePath = `/uploads/${subDir}/${newFilename}`;
    console.log(`📁 文件上传成功(表单): ${relativePath} (${uploadType})`);

    res.json({
      url: relativePath,
      path: `uploads/${subDir}/${newFilename}`,
      name: file.originalFilename || newFilename,
      size: file.size || 0,
      type: uploadType
    });
  });
}

/**
 * Base64 data URI 方式上传（fallback）
 * body: { file: "data:image/png;base64,...", type: "reviews", filename: "xxx.png" }
 */
async function handleBase64Upload(req, res) {
  const { file, type, filename } = req.body || {};

  if (!file) {
    return res.status(400).json({ error: '未找到文件数据' });
  }

  // 解析 data URI
  let matches = file.match(/^data:(image\/(\w+));base64,(.+)$/);
  if (!matches) {
    return res.status(400).json({ error: '不支持的文件格式，请上传图片' });
  }

  const mimeType = matches[1];
  const extName = matches[2];
  const base64Data = matches[3];

  const ext = '.' + extName;
  if (!Object.values(ALLOWED_MIME).includes(ext) && ext !== '.jpg' && ext !== '.png' && ext !== '.gif' && ext !== '.webp') {
    return res.status(400).json({ error: '不支持的图片格式' });
  }

  // 检查大小
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_FILE_SIZE) {
    return res.status(400).json({ error: '文件大小超过限制（最大5MB）' });
  }

  // 确定存储位置
  const uploadType = type || 'general';
  const subDir = SUB_DIRS[uploadType] || SUB_DIRS.general;
  const targetDir = path.join(UPLOAD_DIR, subDir);
  ensureDir(targetDir);

  const newFilename = generateFilename(ext);
  const targetPath = path.join(targetDir, newFilename);

  fs.writeFileSync(targetPath, buffer);

  const relativePath = `/uploads/${subDir}/${newFilename}`;
  console.log(`📁 文件上传成功(base64): ${relativePath} (${uploadType})`);

  res.json({
    url: relativePath,
    path: `uploads/${subDir}/${newFilename}`,
    name: filename || newFilename,
    size: buffer.length,
    type: uploadType
  });
}

module.exports = router;
