# 数智工坊 V4.0 项目计划

> 文（文化宣传）· 影（短视频）· 商（甄选商城）城立品牌，撮合产业链，严选源头好货，赋能万家，让天下没有难做的生意

## 一、当前状态盘点

### 已完成
| 模块 | 状态 | 说明 |
|------|------|------|
| V4.0 在线版 | ✅ | 54KB，4 Tab，需配合 assets/ 目录 |
| V4.0 离线版 | ✅ | 664KB，4张图 base64 内联，双击即开 |
| 桌面同步 | ✅ | 在线版+离线版+4张图已拷到 ~/Desktop/AutoClaw/ |
| JS 修复 | ✅ | IIFE + addEventListener，零 event.target 残留 |
| 马季品牌色 | ✅ | --oil-gold/amber/deep/cream 贯穿 45 处 |
| 响应式 | ✅ | 3个 @media 查询，viewport meta 已设 |
| 图片路径修复 | ✅ | 桌面 assets/ 4张图就位 |

### 待完成
| 任务 | 优先级 | 说明 |
|------|--------|------|
| GitHub 仓库创建 | P0 | 需用户提供 Personal Access Token |
| 外网部署 | P0 | GitHub Pages 或 Vercel |
| 移动端测试 | P0 | 真机/模拟器验证 |
| 代码优化 | P1 | 语义化HTML、A11y、SEO meta |
| 短视频占位替换 | P1 | 当前为播放按钮占位 |
| 离线版图片压缩 | P2 | 当前 664KB，可优化到 ~400KB |

## 二、五阶段排期

### 阶段1：设计完善（1天）
- [ ] 补充 SEO meta（description/keywords/OG标签）
- [ ] 补充 ARIA 属性（aria-label/aria-selected）
- [ ] 语义化 HTML5 标签审查（article/nav/main/aside）
- [ ] 短视频区域增加占位说明文字
- [ ] 源头甄选 Tab 增加品类扩展路线图视觉
- [ ] 撮合 Tab 增加数据看板视觉

### 阶段2：开发优化（1-2天）
- [ ] CSS 精简（去除冗余规则，合并重复样式）
- [ ] 离线版图片压缩（WebP格式，目标<450KB）
- [ ] 增加打印样式优化
- [ ] 增加键盘导航支持（Tab/Enter/方向键切换Tab）
- [ ] 增加加载动画（CSS-only spinner）
- [ ] 移动端深度适配（触摸优化、字体缩放、横屏适配）

### 阶段3：测试验证（1天）
- [ ] 桌面 Chrome/Safari/Firefox 三浏览器测试
- [ ] 移动端 iOS Safari / Android Chrome 测试
- [ ] Tab 切换功能测试（点击/键盘）
- [ ] 图片加载测试（在线版+离线版）
- [ ] 响应式断点测试（375px/768px/1024px/1440px）
- [ ] 离线版双击打开测试
- [ ] 控制台零报错验证

### 阶段4：发布部署（半天）
- [ ] 创建 GitHub 仓库（需用户配合授权）
- [ ] 推送代码到 GitHub
- [ ] 启用 GitHub Pages（免费外网访问）
- [ ] 生成外网访问 URL
- [ ] 生成二维码（方便移动端扫码访问）
- [ ] 更新 CHANGELOG.md

### 阶段5：移动端测试（半天）
- [ ] 手机扫码访问 GitHub Pages URL
- [ ] 验证 4 个 Tab 触摸切换
- [ ] 验证图片加载速度
- [ ] 验证文字可读性
- [ ] 验证横屏体验
- [ ] 收集体验反馈

## 三、GitHub 部署方案

### 前置条件（需用户操作）
1. 登录 GitHub 账号
2. 创建 Personal Access Token（Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token）
3. 勾选 `repo` 权限
4. 复制 token 提供给 AutoClaw

### 部署步骤
```bash
# 1. 配置 git
git config --global user.name "用户名"
git config --global user.email "邮箱"

# 2. 创建仓库
gh repo create shuzhi-workshop-v4 --public --source=. --push

# 3. 启用 GitHub Pages
gh api repos/用户名/shuzhi-workshop-v4/pages -X POST -f source[branch]=main -f source[path]=/

# 4. 获取外网 URL
# https://用户名.github.io/shuzhi-workshop-v4/
```

### 访问方式
- **外网URL**: `https://用户名.github.io/shuzhi-workshop-v4/`
- **二维码**: 生成后放在桌面 AutoClaw/ 目录
- **移动端**: 手机扫码直接访问

## 四、技术规格

| 项目 | 值 |
|------|-----|
| 在线版大小 | 54KB |
| 离线版大小 | 664KB |
| Tab数 | 4（企业宣传/源头甄选/产业链撮合/产品推广）|
| 图片数 | 4张（base64内联） |
| CSS变量 | 4组品牌色 + 10组功能色 |
| 响应式断点 | 768px / 700px |
| JS依赖 | 零（纯原生 IIFE） |
| 外部依赖 | 零（无CDN/字体/框架） |

## 五、风险与对策

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| GitHub Token 权限不足 | 中 | 阻断 | 用户确认勾选 repo 权限 |
| GitHub Pages 生效延迟 | 低 | 10分钟内 | 等待 + 重试 |
| 移动端图片加载慢 | 中 | 体验 | 离线版base64避免额外请求 |
| Tab切换在旧浏览器不工作 | 低 | 功能降级 | addEventListener 兼容性好 |
| 中文字体在部分设备显示异常 | 低 | 观感 | 使用系统字体栈 -apple-system |
