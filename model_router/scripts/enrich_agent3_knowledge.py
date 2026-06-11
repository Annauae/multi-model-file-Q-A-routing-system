"""Remove filler from agent_3/knowledge.md and append unique technical reference content (5000+ lines)."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "files" / "agent_3" / "knowledge.md"
MARKER = "## 结语"

TOC_NEW = """20. [经典算法题型思路](#20-经典算法题型思路)
21. [HTTP 与 API 实战词条](#21-http-与-api-实战词条)
22. [CSS 与布局百科](#22-css-与布局百科)
23. [数据库 SQL 菜谱](#23-数据库-sql-菜谱)
24. [技术术语词典](#24-技术术语词典)
25. [Linux 与 Shell 实战](#25-linux-与-shell-实战)
26. [面试系统设计精要](#26-面试系统设计精要)
"""

FILLER_RES = [
    re.compile(r"^- MQ 实践条目 \d+:"),
    re.compile(r"^- SRE 检查项 \d+:"),
    re.compile(r"^- LLM 场景 \d+\.\d+"),
    re.compile(r"^- 模式实践 \d+:"),
    re.compile(r"^- 场景题练习 \d+:"),
]
OPT_HEADER = re.compile(r"^#### 17\.5\.\d+ 优化项:")

OPT_REPLACEMENT = """### 17.5 优化检查清单

| 优化项 | 说明 | 验证方式 |
|--------|------|----------|
| 减少 HTTP 请求 | 合并资源、HTTP/2 多路复用 | Lighthouse Network |
| 启用压缩 | gzip/brotli 压缩文本资源 | 对比 Content-Length |
| 数据库索引 | WHERE/ORDER BY/JOIN 列建索引 | EXPLAIN ANALYZE |
| 避免 N+1 | JOIN 或 DataLoader 批量加载 | ORM 查询日志 |
| 序列化优化 | Protobuf/MessagePack 替代 JSON | 压测吞吐 |
| 限流降级 | 令牌桶保护下游 | 错误率与延迟曲线 |

优化流程: 先测量基线 (p95) -> 单变量改动 -> 回归测试 -> 记录收益。"""

LLM_SCENARIOS = """### 16.6 LLM 场景落地指南

#### 16.6.1 客服问答 (RAG)

- **目标**: 基于企业知识库准确回答，拒答超出范围问题
- **检索**: 混合检索 (BM25 + 向量)，top-k=5，重排序 cross-encoder
- **Prompt**: 强制引用 `[doc_id]`，无依据时回复「暂无相关信息」
- **评估**: Faithfulness > 0.9，人工抽检每周 50 条
- **降级**: 检索分数低于阈值时转人工

#### 16.6.2 代码助手

- **上下文**: 当前文件 + 相关符号定义 + 最近编辑 diff
- **约束**: 只输出 patch 或完整函数，说明依赖变更
- **安全**: 禁止生成硬编码密钥；扫描建议中的危险 API
- **评估**: 单元测试通过率、编译成功率

#### 16.6.3 文档摘要

- **输入**: 长文分块后 map-reduce 摘要，保留章节结构
- **输出**: 固定格式「背景 / 要点 / 行动项」
- **长度**: 按受众控制 (高管 150 字 vs 技术 500 字)

#### 16.6.4 结构化抽取

- **输出**: JSON Schema 约束，配合 function calling 或 constrained decoding
- **校验**: Pydantic / Zod 二次校验，失败则重试一次
- **场景**: 发票字段、简历解析、日志实体抽取

#### 16.6.5 多轮对话

- **记忆**: 滑动窗口 + 会话摘要压缩历史
- **状态**: 显式 slot（订单号、城市）写入 session store
- **澄清**: 歧义时主动追问，避免猜测

#### 16.6.6 Agent 工作流

- **规划**: ReAct / Plan-and-Execute，每步可观测
- **工具**: 最小权限 API key，超时与重试上限
- **终止**: 最大步数、总 token 预算、人工审批节点
"""

ALGO_PROBLEMS = [
    ("两数之和", "哈希表存 complement", "O(n)", "数组 哈希"),
    ("三数之和", "排序 + 双指针", "O(n²)", "排序 双指针"),
    ("盛最多水的容器", "双指针向内移动较短边", "O(n)", "双指针"),
    ("最长无重复子串", "滑动窗口 + 字符最后位置", "O(n)", "滑动窗口"),
    ("最小覆盖子串", "滑动窗口 + 需求计数", "O(n)", "滑动窗口"),
    ("合并区间", "按起点排序后合并", "O(n log n)", "排序"),
    ("旋转图像", "先转置再翻转每行", "O(n²)", "矩阵"),
    ("螺旋矩阵", "按层模拟四条边", "O(mn)", "模拟"),
    ("搜索旋转排序数组", "二分判断有序半区", "O(log n)", "二分"),
    ("寻找峰值", "二分比较 mid 与 mid+1", "O(log n)", "二分"),
    ("x 的平方根", "二分或牛顿法", "O(log n)", "二分"),
    ("搜索二维矩阵", "从右上或左下走", "O(m+n)", "矩阵"),
    ("接雨水", "双指针或单调栈", "O(n)", "双指针 栈"),
    ("每日温度", "单调递减栈", "O(n)", "单调栈"),
    ("柱状图最大矩形", "单调栈", "O(n)", "单调栈"),
    ("最大矩形", "逐行转化为柱状图问题", "O(mn)", "栈 DP"),
    ("岛屿数量", "DFS/BFS 标记", "O(mn)", "图 DFS"),
    ("腐烂的橘子", "多源 BFS", "O(mn)", "BFS"),
    ("课程表", "拓扑排序检测环", "O(V+E)", "拓扑"),
    ("冗余连接", "并查集", "O(n α(n))", "并查集"),
    ("省份数量", "并查集或 DFS", "O(n²)", "并查集"),
    ("网络延迟时间", "Dijkstra 最短路", "O(E log V)", "最短路"),
    ("最小生成树", "Kruskal + 并查集 / Prim", "O(E log E)", "MST"),
    ("单词接龙", "BFS 层序", "O(N·L²)", "BFS"),
    ("打开转盘锁", "BFS 状态空间", "O(10^4)", "BFS"),
    ("全排列", "回溯 + used 数组", "O(n·n!)", "回溯"),
    ("子集", "回溯或位掩码", "O(2^n)", "回溯"),
    ("组合总和", "回溯可重复选", "O(2^n)", "回溯"),
    ("N 皇后", "回溯 + 列/对角线集合", "O(n!)", "回溯"),
    ("括号生成", "回溯左开右闭", "O(4^n/√n)", "回溯"),
    ("单词搜索", "回溯 + 网格标记", "O(mn·4^L)", "回溯"),
    ("打家劫舍", "DP: dp[i]=max(dp[i-1], dp[i-2]+nums[i])", "O(n)", "DP"),
    ("零钱兑换", "完全背包 DP", "O(n·amount)", "DP 背包"),
    ("最长递增子序列", "DP O(n²) 或 贪心+二分 O(n log n)", "O(n log n)", "DP"),
    ("编辑距离", "二维 DP", "O(mn)", "DP"),
    ("最大子数组和", "Kadane", "O(n)", "DP"),
    ("不同路径", "组合数学或 DP", "O(mn)", "DP"),
    ("最小路径和", "网格 DP", "O(mn)", "DP"),
    ("买卖股票最佳时机", "一次遍历维护最低价", "O(n)", "贪心"),
    ("跳跃游戏", "贪心维护最远可达", "O(n)", "贪心"),
    ("合并K个升序链表", "最小堆", "O(N log k)", "堆"),
    ("数据流的中位数", "大顶堆+小顶堆", "O(log n)", "堆"),
    ("前 K 个高频元素", "桶排序或堆", "O(n)", "堆 桶"),
    ("LRU 缓存", "哈希 + 双向链表", "O(1)", "设计"),
    ("LFU 缓存", "频率桶 + 双向链表", "O(1)", "设计"),
    ("Trie 实现", "前缀树节点 children", "O(L)", "Trie"),
    ("添加与搜索单词", "Trie + 通配 DFS", "O(26^L)", "Trie"),
    ("实现 strStr", "KMP 前缀函数", "O(m+n)", "字符串 KMP"),
    ("最长回文子串", "中心扩展或 Manacher", "O(n²)", "字符串"),
    ("有效括号", "栈匹配", "O(n)", "栈"),
    ("逆波兰表达式", "栈求值", "O(n)", "栈"),
    ("基本计算器", "栈处理括号与符号", "O(n)", "栈"),
    ("柱状图面积", "见单调栈", "O(n)", "栈"),
    ("二叉树层序遍历", "队列 BFS", "O(n)", "树 BFS"),
    ("二叉树最大深度", "递归或 BFS", "O(n)", "树"),
    ("翻转二叉树", "递归交换左右", "O(n)", "树"),
    ("验证 BST", "中序或递归范围", "O(n)", "树"),
    ("最近公共祖先", "递归分治", "O(n)", "树"),
    ("二叉树右视图", "BFS 每层最后一个", "O(n)", "树"),
    ("路径总和 III", "前缀和 + 哈希", "O(n)", "树"),
    ("序列化二叉树", "前序 + null 标记", "O(n)", "树"),
    ("合并二叉树", "同步递归", "O(n)", "树"),
    ("对称二叉树", "递归比较镜像", "O(n)", "树"),
    ("直径二叉树", "递归返回深度", "O(n)", "树"),
    ("克隆图", "DFS/BFS + 哈希映射", "O(V+E)", "图"),
    ("太平洋大西洋水流", "反向 DFS 从海洋", "O(mn)", "图"),
    ("除法求值", "带权并查集或图", "O(q·α(n))", "图"),
    ("会议室 II", "排序起点终点扫线", "O(n log n)", "贪心 堆"),
    ("插入区间", "扫描合并", "O(n)", "区间"),
    ("缺失的第一个正数", "原地哈希索引", "O(n)", "数组 技巧"),
    ("寻找重复数", "快慢指针或二分", "O(n)", "数组"),
    ("颜色分类", "荷兰国旗三指针", "O(n)", "双指针"),
    ("移动零", "双指针写非零", "O(n)", "双指针"),
    ("最长连续序列", "哈希集只从序列起点扩展", "O(n)", "哈希"),
    ("字母异位词分组", "排序键或计数键", "O(nk)", "哈希"),
    ("Top K 频繁", "见堆", "O(n)", "堆"),
    ("乘积最大子数组", "维护 max/min DP", "O(n)", "DP"),
    ("分割等和子集", "0-1 背包", "O(n·sum)", "DP"),
    ("目标和", "DFS 或 DP", "O(2^n)", "回溯 DP"),
    ("完全平方数", "BFS 层数或 DP", "O(n·√n)", "BFS DP"),
    ("单词拆分", "DP 可达性", "O(n²)", "DP"),
    ("最长有效括号", "栈或 DP", "O(n)", "栈 DP"),
    ("正则匹配", "二维 DP", "O(mn)", "DP"),
    ("通配符匹配", "二维 DP", "O(mn)", "DP"),
    ("地下城游戏", "逆推 DP", "O(mn)", "DP"),
    ("最大正方形", "DP 边长", "O(mn)", "DP"),
    ("分割数组", "区间 DP 最小代价", "O(n³)", "DP"),
]

HTTP_TIPS = [
    ("Cache-Control: no-store", "敏感数据绝不缓存", "银行余额 API"),
    ("Cache-Control: max-age=3600", "静态资源强缓存", "带 hash 的 JS/CSS"),
    ("ETag + If-None-Match", "协商缓存省带宽", "API 列表未变更返回 304"),
    ("Vary: Accept-Encoding", "按编码分别缓存", "CDN 同时存 gzip/br"),
    ("Content-Encoding: br", "Brotli 比 gzip 更小", "文本响应优先 br"),
    ("Transfer-Encoding: chunked", "流式响应无需 Content-Length", "SSE、大文件"),
    ("Connection: keep-alive", "复用 TCP 连接", "HTTP/1.1 默认"),
    ("HTTP/2 Server Push", "主动推送关键资源", "现已较少用，preload 更常见"),
    ("Alt-Svc", "声明 HTTP/3 可用", "h3=\":443\""),
    ("Strict-Transport-Security", "强制 HTTPS", "max-age=31536000; includeSubDomains"),
    ("X-Content-Type-Options: nosniff", "禁止 MIME 嗅探", "防上传 HTML 当图片执行"),
    ("X-Frame-Options: DENY", "禁止被 iframe 嵌入", "防点击劫持"),
    ("Content-Security-Policy", "限制脚本/样式来源", "default-src 'self'"),
    ("Referrer-Policy", "控制 Referer 泄露", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "禁用相机/麦克风等", "geolocation=()"),
    ("Access-Control-Allow-Origin", "CORS 允许源", "生产勿用 * 带凭证"),
    ("Access-Control-Allow-Credentials", "跨域带 Cookie", "需具体 Origin"),
    ("Access-Control-Max-Age", "预检缓存", "86400 减少 OPTIONS"),
    ("Access-Control-Expose-Headers", "前端可读响应头", "X-Request-Id"),
    ("Idempotency-Key", "幂等 POST", "支付、下单防重复"),
    ("X-Request-Id", "全链路追踪", "网关生成透传"),
    ("Retry-After", "429/503 告知重试时间", "秒数或 HTTP-date"),
    ("Link rel=preload", "提前加载资源", "<style.css>; rel=preload; as=style"),
    ("Accept: application/json", "内容协商", "API 默认 JSON"),
    ("Accept-Language", "国际化", "zh-CN,en;q=0.9"),
    ("Range: bytes=0-", "断点续传", "返回 206 Partial Content"),
    ("If-Range", "与 ETag 配合续传", "文件未变则 206"),
    ("Digest: sha-256=...", "响应体完整性", "较少见"),
    ("Signature (HTTP Signatures)", "请求签名", "Webhook 验证"),
    ("429 Too Many Requests", "限流标准码", "配合 Retry-After"),
    ("451 Unavailable For Legal Reasons", "法律屏蔽", "地区合规"),
    ("308 Permanent Redirect", "保持方法的永久重定向", "POST 仍 POST"),
    ("307 Temporary Redirect", "临时且保持方法", "维护页跳转"),
    ("204 No Content", "成功无 body", "DELETE 成功"),
    ("201 Created", "创建成功", "Location 头指向新资源"),
    ("409 Conflict", "版本冲突", "乐观锁失败"),
    ("422 Unprocessable Entity", "语义错误", "校验失败详情"),
    ("412 Precondition Failed", "If-Match 不满足", "并发更新"),
    ("428 Precondition Required", "要求 If-Match", "防丢失更新"),
    ("Problem Details RFC7807", "标准错误 JSON", "type/title/detail/instance"),
    ("cursor 分页", "稳定翻页", "?cursor=eyJpZCI6MTIzfQ"),
    ("offset 分页", "简单但深页慢", "?page=2&size=20"),
    ("keyset 分页", "WHERE id > last_id", "大表推荐"),
    ("API 版本", "URL /v1 或 Header", "勿破坏旧客户端"),
    ("HATEOAS", "响应含 _links", "自描述导航"),
    ("OpenAPI 3.1", "机器可读契约", "生成 SDK/文档"),
    ("JSON:API", "规范嵌套与关系", "included/data/links"),
    ("GraphQL", "客户端选字段", "注意 N+1 用 DataLoader"),
    ("gRPC", "二进制高性能", "内部微服务"),
    ("WebSocket", "全双工长连接", "聊天、行情"),
    ("SSE", "服务端单向推送", "text/event-stream"),
    ("Webhook", "事件回调", "签名校验 + 幂等"),
    ("Long Polling", "兼容老环境", "Comet 模式"),
    ("mTLS", "双向 TLS", "服务间零信任"),
    ("JWT access 短期", "15min 常见", "配合 refresh token"),
    ("Refresh Token 轮换", "每次刷新发新 refresh", "检测盗用"),
    ("OAuth state 参数", "防 CSRF", "随机串校验"),
    ("PKCE", "公共客户端必用", "S256 code_challenge"),
    ("API Key 放 Header", "勿放 URL", "X-API-Key"),
    ("Rate Limit 响应头", "X-RateLimit-Remaining", "客户端退避"),
    ("压缩仅文本", "图片视频已压缩", "勿 double compress"),
    ("JSON 字段命名", "snake_case vs camelCase", "团队统一"),
    ("时间 ISO8601 UTC", "2024-06-08T12:00:00Z", "带时区或 Z"),
    ("金额用整数分", "避免浮点", "amount_cents: 1999"),
    ("布尔 null 三态", "未设置 vs false", "Optional 字段"),
    ("枚举开放扩展", "未知值当 unknown", "向前兼容"),
    ("批量 API", "POST /batch", "部分成功 207 Multi-Status"),
    ("健康检查 /health", "liveness", "K8s probe"),
    ("就绪检查 /ready", "依赖就绪才接流量", "DB 连接 OK"),
    ("优雅关闭", "SIGTERM 停接新请求", "drain 30s"),
    ("请求超时", "客户端与服务端都设", "避免级联挂起"),
    ("熔断器", "错误率超阈开路", "半开探测"),
    ("舱壁隔离", "线程池分池", "支付与查询分离"),
    ("超时传递", "context deadline", "全链统一 budget"),
]

CSS_TOPICS = [
    ("display: grid", "二维布局", "grid-template-columns: repeat(3, 1fr)"),
    ("display: flex", "一维弹性", "justify-content / align-items"),
    ("flex: 1", "flex-grow:1 shrink:1 basis:0%", "占满剩余空间"),
    ("gap", "flex/grid 子项间距", "替代 margin 技巧"),
    ("minmax()", "网格列宽范围", "minmax(200px, 1fr)"),
    ("auto-fit vs auto-fill", "空轨道是否折叠", "响应卡片"),
    ("subgrid", "子网格对齐父轨道", "卡片内对齐"),
    ("container queries", "@container 按父宽", "组件级响应式"),
    (":is() :where()", "选择器分组", ":where() 零特异性"),
    (":has()", "父选择器", "含 img 的 card 样式"),
    ("aspect-ratio", "固定宽高比", "16/9 视频容器"),
    ("object-fit: cover", "图片裁剪填充", "头像圆形"),
    ("position: sticky", "滚动粘滞", "表头固定"),
    ("inset", "top/right/bottom/left 简写", "定位"),
    ("z-index 层叠上下文", "仅同级比较", "transform 创建新上下文"),
    ("overflow: hidden", "BFC 与裁剪", "清除浮动"),
    ("contain", "布局/绘制隔离", "优化渲染"),
    ("content-visibility", "跳过屏外渲染", "长列表"),
    ("will-change", "提示合成层", "勿滥用"),
    ("transform + opacity", "GPU 动画", "避免 layout 属性动画"),
    ("@keyframes", "关键帧动画", "animation-fill-mode"),
    ("transition", "状态过渡", "prefer-reduced-motion"),
    ("clamp()", "流体排版", "clamp(1rem, 2vw, 1.5rem)"),
    ("rem vs em", "rem 相对根字号", "em 相对父元素"),
    ("line-height", "无单位倍数最佳", "1.5"),
    ("vertical-align", "行内对齐", "middle 仅近似"),
    ("box-sizing: border-box", "width 含 padding", "全局 reset"),
    ("margin 折叠", "相邻块垂直合并", "BFC 或 padding 阻断"),
    ("伪元素 ::before", "装饰内容", "content 必填"),
    ("attr() in CSS", "读 HTML 属性", "data-label"),
    ("CSS 变量", "--color: #333", "var(--color, fallback)"),
    ("@layer", "级联层优先级", "base, components, utilities"),
    ("@scope", "限定样式范围", "避免泄漏"),
    (":focus-visible", "键盘焦点环", "鼠标点击无环"),
    (":focus-within", "子元素聚焦", "表单高亮"),
    ("outline-offset", "焦点环外扩", "a11y"),
    ("color-scheme", "暗色表单控件", "dark light"),
    ("prefers-color-scheme", "系统主题", "媒体查询"),
    ("prefers-reduced-motion", "减少动画", "无障碍"),
    ("scroll-snap", "滚动吸附", "轮播/分页"),
    ("overscroll-behavior", "阻止链式滚动", "模态内滚动"),
    ("touch-action", "触摸手势", "pan-y 竖滚"),
    ("user-select", "禁止选中", "按钮 none"),
    ("pointer-events: none", "穿透点击", "遮罩层"),
    ("backdrop-filter", "毛玻璃", "blur(10px)"),
    ("filter", "滤镜", "grayscale brightness"),
    ("mix-blend-mode", "混合模式", "multiply"),
    ("isolation: isolate", "独立混合组", ""),
    ("clip-path", "裁剪形状", "circle polygon"),
    ("mask", "蒙版", "渐变淡出"),
    ("writing-mode", "竖排文字", "vertical-rl"),
    ("logical properties", "margin-inline-start", "国际化布局"),
    ("grid-area", "命名区域", "header main footer"),
    ("place-items", "align + justify", "居中"),
    ("min-height: 100dvh", "动态视口", "移动端地址栏"),
    ("env(safe-area-inset-*)", "刘海屏安全区", "padding"),
    ("@font-face", "自定义字体", "font-display: swap"),
    ("font-variant-numeric", "等宽数字", "tabular-nums"),
    ("text-overflow: ellipsis", "单行省略", "需 nowrap + overflow"),
    ("line-clamp", "多行省略", "-webkit-line-clamp: 3"),
    ("word-break: break-all", "长 URL 断行", "vs overflow-wrap"),
    ("hyphens", "自动连字符", "lang 属性"),
    ("columns", "多栏排版", "报纸布局"),
    ("break-inside: avoid", "打印不分页", "卡片"),
    ("@media print", "打印样式", "隐藏 nav"),
]

SQL_RECIPES = [
    ("活跃用户（7日）", "SELECT user_id FROM events WHERE ts > now()-interval '7 days' GROUP BY 1", "索引 ts"),
    ("留存率 D1", "cohort 首次登录日与次日回访", "窗口函数"),
    ("漏斗转化", "多步事件顺序计数", "FILTER WHERE"),
    ("去重计数", "COUNT(DISTINCT user_id)", "HyperLogLog 近似"),
    ("Top N 每组", "ROW_NUMBER() PARTITION BY", "rank=1"),
    ("累计求和", "SUM() OVER (ORDER BY)", "运行总额"),
    ("同比环比", "LAG 偏移对比", "增长率"),
    ("移动平均", "AVG() OVER (ROWS 6 PRECEDING)", "7日均线"),
    ("会话划分", "gap > 30min 新 session", "条件累加 session_id"),
    ("JSON 字段查询", "data->>'key' = 'x'", "GIN 索引"),
    ("数组包含", "tags @> ARRAY['go']", "GIN"),
    ("全文搜索", "to_tsvector @@ plainto_tsquery", "tsvector 索引"),
    ("地理距离", "PostGIS ST_DWithin", "空间索引"),
    ("悲观锁", "SELECT FOR UPDATE", "事务内"),
    ("乐观锁", "UPDATE ... WHERE version=$v", "version 列"),
    ("UPSERT", "ON CONFLICT DO UPDATE", "幂等写入"),
    ("软删除", "deleted_at IS NULL", "部分索引"),
    ("分区表", "PARTITION BY RANGE (created_at)", "按月"),
    ("物化视图", "REFRESH MATERIALIZED VIEW", "报表加速"),
    ("CTE 递归", "WITH RECURSIVE 树", "组织层级"),
    ("透视", "crosstab 或 FILTER", "行转列"),
    ("反规范化冗余", "计数器列 + 触发器", "读多写少"),
    ("慢查询", "pg_stat_statements", "排序 total_time"),
    ("连接池", "PgBouncer transaction mode", "避免连接风暴"),
    ("读写分离", "路由到 replica", "延迟复制注意"),
    ("分库分表", "shard key 一致性", "跨分片聚合难"),
    ("NULL 比较", "IS NULL 非 =NULL", "三值逻辑"),
    ("EXISTS vs IN", "大表 EXISTS 常更优", "半连接"),
    ("JOIN 顺序", "小表驱动", "优化器 hint"),
    ("覆盖索引", "INCLUDE 列", "Index Only Scan"),
    ("部分索引", "WHERE status='active'", "减小索引"),
    ("表达式索引", "(lower(email))", "大小写不敏感"),
    ("BRIN", "时序大表", "块级 minmax"),
    ("VACUUM", "回收死元组", "autovacuum 调优"),
    ("ANALYZE", "更新统计信息", "计划器准确"),
    ("死锁", "按固定顺序加锁", "重试"),
    ("长事务", "阻塞 VACUUM", "尽快提交"),
    ("两阶段提交", "分布式事务", "XA 少用"),
    ("逻辑复制", "pub/sub 表级", "升级迁移"),
    ("备份 PITR", "WAL 归档", "时间点恢复"),
    ("连接数监控", "max_connections", "reserved 给 superuser"),
]

TERMS = [
    ("ACID", "原子性、一致性、隔离性、持久性"),
    ("BASE", "基本可用、软状态、最终一致"),
    ("CAP", "一致性、可用性、分区容忍三者最多其二"),
    ("CQRS", "命令查询职责分离"),
    ("DDD", "领域驱动设计"),
    ("BFF", "Backend For Frontend 聚合层"),
    ("API Gateway", "统一入口路由鉴权限流"),
    ("Service Mesh", "边车代理服务间通信"),
    ("Sidecar", "与主容器伴生的辅助进程"),
    ("Circuit Breaker", "熔断器防雪崩"),
    ("Bulkhead", "舱壁隔离资源"),
    ("Backpressure", "背压控制生产速度"),
    ("Idempotency", "重复执行结果相同"),
    ("Event Sourcing", "以事件序列作为真相源"),
    ("Saga", "长事务拆为本地事务+补偿"),
    ("Two-Phase Commit", "两阶段提交分布式原子"),
    ("Raft", "易理解的分布式共识"),
    ("Paxos", "经典共识算法"),
    ("Quorum", "读写法定人数"),
    ("Leader Election", "选主避免脑裂"),
    ("Split Brain", "网络分区导致双主"),
    ("TTL", "生存时间过期删除"),
    ("LRU", "最近最少使用淘汰"),
    ("LFU", "最不经常使用淘汰"),
    ("Write-Through", "写缓存同时写 DB"),
    ("Write-Back", "写缓存异步刷盘"),
    ("Cache Aside", "应用管缓存读写"),
    ("Read-Through", "缓存代理读 DB"),
    ("Thundering Herd", "缓存失效并发打穿 DB"),
    ("Cache Stampede", "同义于惊群需互斥重建"),
    ("Bloom Filter", "概率型存在判断"),
    ("Consistent Hashing", "扩缩节点少迁移"),
    ("Virtual Node", "虚拟节点均衡环"),
    ("Sharding", "水平分片"),
    ("Replication", "副本复制"),
    ("Fan-out", "一对多扇出"),
    ("Fan-in", "多对一汇聚"),
    ("Pub/Sub", "发布订阅解耦"),
    ("Dead Letter Queue", "失败消息隔离队列"),
    ("Poison Message", "导致反复失败的消息"),
    ("Backfill", "回填历史数据"),
    ("Cold Start", "无预热首次延迟高"),
    ("Warm Pool", "预留实例减冷启动"),
    ("Horizontal Scaling", "加机器扩容量"),
    ("Vertical Scaling", "升配单机"),
    ("Autoscaling", "按指标自动扩缩"),
    ("Blue-Green", "蓝绿零停机切换"),
    ("Canary", "金丝雀渐进发布"),
    ("Rolling Update", "滚动替换实例"),
    ("Feature Flag", "开关控制功能灰度"),
    ("Dark Launch", "暗发布测负载"),
    ("Chaos Engineering", "故障注入验证韧性"),
    ("SLA", "服务等级协议"),
    ("SLO", "内部目标指标"),
    ("SLI", "可测量服务水平指标"),
    ("Error Budget", "允许不可用比例"),
    ("MTTR", "平均修复时间"),
    ("MTBF", "平均故障间隔"),
    ("On-call", "值班响应告警"),
    ("Runbook", "故障处理手册"),
    ("Postmortem", "无责复盘"),
    ("Blameless", "不追责文化"),
    ("Toil", "重复手工运维劳动"),
    ("Immutable Infrastructure", "不可变基础设施"),
    ("GitOps", "Git 为配置真相源"),
    ("IaC", "基础设施即代码"),
    ("CNCF", "云原生计算基金会"),
    ("OCI", "开放容器倡议镜像标准"),
    ("CRI", "容器运行时接口"),
    ("CNI", "容器网络接口"),
    ("CSI", "容器存储接口"),
    ("Ingress", "K8s HTTP 入口"),
    ("Pod", "K8s 最小调度单元"),
    ("Deployment", "无状态应用控制器"),
    ("StatefulSet", "有状态有序部署"),
    ("DaemonSet", "每节点一个 Pod"),
    ("ConfigMap", "非敏感配置"),
    ("Secret", "敏感配置 Base64"),
    ("HPA", "水平 Pod 自动伸缩"),
    ("VPA", "垂直 Pod 资源建议"),
    ("RBAC", "基于角色的访问控制"),
    ("ABAC", "基于属性的访问控制"),
    ("OAuth", "授权框架"),
    ("OIDC", "身份层 OpenID Connect"),
    ("SAML", "企业 SSO XML 协议"),
    ("mTLS", "双向 TLS 认证"),
    ("Zero Trust", "永不信任始终验证"),
    ("WAF", "Web 应用防火墙"),
    ("DDoS", "分布式拒绝服务"),
    ("SQL Injection", "SQL 注入"),
    ("XSS", "跨站脚本"),
    ("CSRF", "跨站请求伪造"),
    ("SSRF", "服务端请求伪造"),
    ("RCE", "远程代码执行"),
    ("PII", "个人可识别信息"),
    ("GDPR", "欧盟数据保护条例"),
    ("SOC2", "安全合规审计框架"),
    ("Pen Test", "渗透测试"),
    ("SAST", "静态应用安全测试"),
    ("DAST", "动态应用安全测试"),
    ("Dependency Scan", "依赖漏洞扫描"),
    ("SBOM", "软件物料清单"),
    ("Supply Chain Attack", "供应链攻击"),
    ("Semantic Versioning", "主.次.补丁版本语义"),
    ("LTS", "长期支持版本"),
    ("Breaking Change", "不兼容变更"),
    ("Deprecation", "弃用过渡期"),
    ("RFC", "请求评论标准文档"),
    ("W3C", "Web 标准组织"),
    ("WHATWG", "HTML  living standard"),
    ("TC39", "JavaScript 标准委员会"),
    ("ECMAScript", "JS 语言规范"),
    ("WebAssembly", "浏览器字节码"),
    ("SSR", "服务端渲染"),
    ("SSG", "构建时静态生成"),
    ("ISR", "增量静态再生"),
    ("CSR", "客户端渲染"),
    ("Hydration", "客户端接管 SSR HTML"),
    ("RSC", "React Server Components"),
    ("Edge Runtime", "边缘轻量 JS 运行时"),
    ("CDN", "内容分发网络"),
    ("Anycast", "路由到最近节点"),
    ("DNS", "域名解析系统"),
    ("TTL DNS", "DNS 缓存时间"),
    ("CNAME", "别名记录"),
    ("A/AAAA", "IPv4/IPv6 记录"),
    ("TXT", "文本记录 SPF/DKIM"),
    ("Load Balancer", "负载均衡器"),
    ("Round Robin", "轮询调度"),
    ("Least Connections", "最少连接"),
    ("IP Hash", "源 IP 粘性"),
    ("Health Check", "探活摘除故障节点"),
    ("Sticky Session", "会话粘滞"),
    ("WebSocket", "全双工协议"),
    ("SSE", "Server-Sent Events"),
    ("gRPC", "HTTP/2 二进制 RPC"),
    ("Protobuf", "二进制序列化"),
    ("Thrift", "跨语言 RPC 框架"),
    ("GraphQL", "查询语言 API"),
    ("REST", "表述性状态转移风格"),
    ("HATEOAS", "超媒体驱动 API"),
    ("OpenAPI", "REST API 描述规范"),
    ("JSON Schema", "JSON 结构校验"),
    ("JWT", "JSON Web Token"),
    ("JWK", "JSON Web Key"),
    ("HMAC", "密钥哈希消息认证"),
    ("RSA", "非对称加密算法"),
    ("AES-GCM", "对称认证加密"),
    ("bcrypt", "密码哈希"),
    ("Argon2", "现代密码哈希"),
    ("Salt", "防彩虹表随机盐"),
    ("Pepper", "服务端全局秘密"),
    ("MFA", "多因素认证"),
    ("TOTP", "基于时间的一次密码"),
    ("WebAuthn", "FIDO2 无密码"),
    ("Passkey", "平台同步密钥"),
    ("RAG", "检索增强生成"),
    ("Embedding", "向量嵌入表示"),
    ("Fine-tuning", "微调模型权重"),
    ("LoRA", "低秩适配微调"),
    ("Prompt Injection", "提示注入攻击"),
    ("Hallucination", "模型幻觉编造"),
    ("Temperature", "采样随机性参数"),
    ("Top-p", "核采样截断"),
    ("Context Window", "模型上下文长度"),
    ("Token", "模型词元单位"),
    ("KV Cache", "注意力键值缓存加速"),
    ("Quantization", "模型量化减体积"),
    ("Distillation", "大模型蒸馏小模型"),
    ("Batch Inference", "批量推理提吞吐"),
    ("Streaming", "流式输出 token"),
    ("Agent", "可调用工具的多步 LLM"),
    ("Tool Calling", "函数调用扩展能力"),
    ("MCP", "Model Context Protocol"),
    ("Vector DB", "向量数据库"),
    ("HNSW", "近似最近邻索引"),
    ("Cosine Similarity", "余弦相似度"),
    ("Reranker", "检索结果重排序模型"),
    ("Chunking", "文档分块策略"),
    ("Grounding", "回答锚定检索证据"),
]

SHELL_TIPS = [
    ("grep -r pattern .", "递归搜索", "加 --include='*.py'"),
    ("rg pattern", "ripgrep 更快", "默认尊重 gitignore"),
    ("find . -name '*.log'", "按名查找", "-mtime -7 七天內"),
    ("xargs -0", "配合 find -print0", "防空格文件名"),
    ("parallel", "GNU parallel 并行", "比 xargs -P 强"),
    ("tail -f", "跟踪日志", "F 重开文件"),
    ("journalctl -u svc", "systemd 日志", "-f 跟随"),
    ("strace -p PID", "跟踪系统调用", "调试卡住"),
    ("lsof -i :8080", "谁占用端口", ""),
    ("ss -tlnp", "监听套接字", "替代 netstat"),
    ("tcpdump -i any port 443", "抓包", "写 pcap 用 wireshark"),
    ("curl -v", "看请求响应头", "-o /dev/null 只要头"),
    ("httpie", "友好 HTTP CLI", "http POST url key=val"),
    ("jq", "JSON 处理", "cat a.json | jq '.items[]'"),
    ("yq", "YAML 处理", "K8s 清单编辑"),
    ("awk '{sum+=$1} END{print sum}'", "列求和", ""),
    ("sed 's/old/new/g'", "替换", "-i 原地编辑"),
    ("sort -u", "排序去重", "-n 数字 -k2 第二列"),
    ("uniq -c", "相邻去重计数", "先 sort"),
    ("wc -l", "行数", "管道统计"),
    ("du -sh *", "目录大小", "sort -h"),
    ("df -h", "磁盘空间", ""),
    ("free -h", "内存", "available 列"),
    ("top / htop", "进程", "M 按内存 P CPU"),
    ("ps aux | grep", "查进程", "勿杀随机 PID"),
    ("kill -15", "SIGTERM 优雅", "先 TERM 再 -9"),
    ("nohup cmd &", "断开终端继续", "日志重定向"),
    ("tmux new -s dev", "会话保持", "attach 恢复"),
    ("ssh -L 5432:localhost:5432", "本地端口转发", "连远程 DB"),
    ("scp -r", "复制目录", "rsync 更可续传"),
    ("rsync -avz --progress", "同步", "--delete 镜像"),
    ("tar czf a.tgz dir", "打包压缩", "xzf 解压"),
    ("chmod +x", "可执行", "755 脚本"),
    ("chown user:group", "改属主", ""),
    ("umask 022", "默认权限掩码", ""),
    ("crontab -e", "定时任务", "分 时 日 月 周"),
    ("systemctl status", "服务状态", "restart reload"),
    ("docker logs -f", "容器日志", "--tail 100"),
    ("kubectl logs -f pod", "K8s 日志", "-c 容器名"),
    ("env | sort", "环境变量", "export VAR=val"),
    ("set -euo pipefail", "bash 严格模式", "脚本开头"),
    ("trap cleanup EXIT", "退出清理", ""),
    ("mktemp -d", "临时目录", "用完 rm -rf"),
    ("flock", "文件锁防并发", "cron 防重叠"),
    ("timeout 30 cmd", "超时终止", ""),
    ("watch -n 1 cmd", "周期执行", "监控"),
    ("diff -u a b", "统一 diff", "patch 应用"),
    ("git diff --stat", "变更统计", ""),
    ("history | grep", "历史命令", "!123 重跑"),
]

SYSTEM_DESIGN = [
    ("短链接", "62 进制 id", "Redis 计数或雪花", "读多写少 CDN 缓存", "自定义域名"),
    ("微博时间线", "推 vs 拉", "大 V 拉、普通推", "fan-out 写扩散", "混合 timeline"),
    ("聊天", "WebSocket 网关", "消息序 id", "已读回执", "离线推送"),
    ("秒杀", "库存预扣 Redis", "队列削峰", "验证码防刷", "CDN 静态页"),
    ("分布式 ID", "雪花 timestamp+worker+seq", "时钟回拨处理", "号段模式 DB", "UUID 无序"),
    ("搜索引擎", "倒排索引", "分词器", "PageRank 可选", "ES 集群"),
    ("视频点播", "HLS/DASH 分片", "CDN 边缘", "转码多码率", "DRM"),
    ("协同文档", "OT 或 CRDT", "WebSocket 同步", "版本向量", "Google Docs 类"),
    ("限流器", "令牌桶 Redis+Lua", "滑动窗口", "分布式计数", "网关层"),
    ("任务调度", "优先级队列", "worker 池", "重试 DLQ", "Cron 解析"),
    ("网盘", "对象存储 S3", "元数据 DB", "分块上传", "去重 hash"),
    ("支付", "幂等键", "对账", "TCC 或 Saga", "PCI 隔离"),
    ("推荐 Feed", "召回+排序", "特征存储", "AB 实验", "实时 vs 离线"),
    ("地图 LBS", "GeoHash", "四叉树", "路径规划", "瓦片 CDN"),
    ("日志系统", "采集 agent", "Kafka 缓冲", "ES 检索", "冷热分层"),
    ("监控告警", "时序 DB", "聚合规则", "告警抑制", "On-call"),
    ("配置中心", "推拉结合", "版本命名空间", "灰度发布", "etcd/consul"),
    ("API 网关", "路由鉴权", "限流熔断", "协议转换", "插件链"),
    ("多租户 SaaS", "行级 tenant_id", "schema 隔离", "配额计费", "数据隔离"),
    ("全球多活", "单元化", "数据复制延迟", "冲突解决", "DNS 就近"),
]


def section_20() -> str:
    lines = ["## 20. 经典算法题型思路", "", "每题含：思路、复杂度、标签。", ""]
    for i, (title, idea, complexity, tags) in enumerate(ALGO_PROBLEMS, 1):
        lines.extend(
            [
                f"### 20.{i} {title}",
                "",
                f"- **思路**: {idea}",
                f"- **复杂度**: {complexity}",
                f"- **标签**: {tags}",
                "",
            ]
        )
    return "\n".join(lines)


def section_21() -> str:
    lines = ["## 21. HTTP 与 API 实战词条", ""]
    for i, (item, explain, example) in enumerate(HTTP_TIPS, 1):
        lines.extend(
            [
                f"### 21.{i} {item}",
                "",
                f"- **说明**: {explain}",
                f"- **示例**: {example}",
                "",
            ]
        )
    return "\n".join(lines)


def section_22() -> str:
    lines = ["## 22. CSS 与布局百科", ""]
    for i, (prop, explain, example) in enumerate(CSS_TOPICS, 1):
        block = [f"### 22.{i} {prop}", "", f"- **要点**: {explain}"]
        if example:
            block.append(f"- **示例**: `{example}`")
        block.append("")
        lines.extend(block)
    return "\n".join(lines)


def section_23() -> str:
    lines = ["## 23. 数据库 SQL 菜谱", ""]
    for i, (name, sql, note) in enumerate(SQL_RECIPES, 1):
        lines.extend(
            [
                f"### 23.{i} {name}",
                "",
                f"```sql",
                sql,
                "```",
                f"- **备注**: {note}",
                "",
            ]
        )
    return "\n".join(lines)


def section_24() -> str:
    lines = ["## 24. 技术术语词典", "", "| 术语 | 解释 |", "|------|------|"]
    for term, definition in TERMS:
        lines.append(f"| {term} | {definition} |")
    lines.append("")
    return "\n".join(lines)


def section_25() -> str:
    lines = ["## 25. Linux 与 Shell 实战", ""]
    for i, (cmd, explain, extra) in enumerate(SHELL_TIPS, 1):
        extra_line = f"- **补充**: {extra}" if extra else ""
        block = [
            f"### 25.{i} `{cmd}`",
            "",
            f"- **说明**: {explain}",
        ]
        if extra_line:
            block.append(extra_line)
        block.append("")
        lines.extend(block)
    return "\n".join(lines)


def section_26() -> str:
    lines = ["## 26. 面试系统设计精要", ""]
    for i, (title, *points) in enumerate(SYSTEM_DESIGN, 1):
        lines.extend([f"### 26.{i} {title}", ""])
        for p in points:
            lines.append(f"- {p}")
        lines.append("")
    return "\n".join(lines)


def clean_lines(lines: list[str]) -> list[str]:
    out: list[str] = []
    inserted_175 = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if OPT_HEADER.match(line):
            if not inserted_175:
                out.append(OPT_REPLACEMENT)
                inserted_175 = True
            i += 1
            while i < len(lines) and not re.match(r"^#{2,3} ", lines[i]):
                i += 1
            continue
        if any(p.match(line) for p in FILLER_RES):
            i += 1
            continue
        out.append(line)
        i += 1
    return out


def inject_llm_scenarios(text: str) -> str:
    if "### 16.6 LLM 场景落地指南" in text:
        return text
    anchor = "### 16.5 生产注意事项"
    if anchor not in text:
        return text
    head, rest = text.split(anchor, 1)
    for stop in ("\n---\n\n## 17.", "\n## 17.", "\n---"):
        idx = rest.find(stop)
        if idx != -1:
            body = rest[:idx].rstrip()
            tail = rest[idx:]
            return head + anchor + body + "\n\n" + LLM_SCENARIOS + tail
    return text


def main() -> None:
    text = TARGET.read_text(encoding="utf-8")
    lines = clean_lines(text.splitlines())
    text = "\n".join(lines)
    text = inject_llm_scenarios(text)

    if "20. [经典算法题型思路]" not in text:
        text = text.replace(
            "19. [扩展附录与场景题库](#19-扩展附录与场景题库)",
            "19. [扩展附录与场景题库](#19-扩展附录与场景题库)\n" + TOC_NEW.rstrip(),
        )

    if "## 20. 经典算法题型思路" not in text:
        supplement = "\n---\n\n".join(
            [
                section_20(),
                section_21(),
                section_22(),
                section_23(),
                section_24(),
                section_25(),
                section_26(),
            ]
        )
        head, tail = text.split(MARKER, 1)
        text = head.rstrip() + "\n\n---\n\n" + supplement + "\n\n---\n\n" + MARKER + tail

    text = text.rstrip() + "\n"
    TARGET.write_text(text, encoding="utf-8", newline="\n")
    line_count = text.count("\n") + (0 if text.endswith("\n") else 1)
    print(f"Wrote {TARGET}")
    print(f"Total lines: {line_count}")


if __name__ == "__main__":
    main()
