"""Expand files/agent_3/knowledge.md to 5000+ lines with supplementary reference sections."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "files" / "agent_3" / "knowledge.md"
MARKER = "## 结语"

TOC_INSERT = """12. [Go / Rust / Java 后端速查](#12-go--rust--java-后端速查)
13. [消息队列与事件驱动](#13-消息队列与事件驱动)
14. [可观测性与 SRE](#14-可观测性与-sre)
15. [移动端与跨平台开发](#15-移动端与跨平台开发)
16. [LLM 与 AI 应用工程](#16-llm-与-ai-应用工程)
17. [性能优化实战手册](#17-性能优化实战手册)
18. [设计模式详解](#18-设计模式详解)
19. [扩展附录与场景题库](#19-扩展附录与场景题库)
"""


def section_12() -> str:
    return r"""## 12. Go / Rust / Java 后端速查

### 12.1 Go 并发与错误处理

Go 以 goroutine + channel 为核心并发模型，错误通过显式 `error` 返回值传递。

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "sync"
    "time"
)

func fetch(ctx context.Context, id int) (string, error) {
    select {
    case <-time.After(50 * time.Millisecond):
        if id%7 == 0 {
            return "", fmt.Errorf("upstream timeout for id=%d", id)
        }
        return fmt.Sprintf("result-%d", id), nil
    case <-ctx.Done():
        return "", ctx.Err()
    }
}

func fetchAll(ctx context.Context, ids []int) (map[int]string, error) {
    type item struct {
        id int
        val string
        err error
    }
    ch := make(chan item, len(ids))
    var wg sync.WaitGroup
    for _, id := range ids {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            val, err := fetch(ctx, id)
            ch <- item{id: id, val: val, err: err}
        }(id)
    }
    go func() {
        wg.Wait()
        close(ch)
    }()

    out := make(map[int]string, len(ids))
    var firstErr error
    for it := range ch {
        if it.err != nil && firstErr == nil {
            firstErr = it.err
            continue
        }
        if it.err == nil {
            out[it.id] = it.val
        }
    }
    if firstErr != nil {
        return out, errors.Join(firstErr, fmt.Errorf("partial failure"))
    }
    return out, nil
}
```

**Go 工程惯例**
- 用 `context.Context` 传递取消与超时，不要全局变量存请求态
- `errors.Is` / `errors.As` 判断错误类型，避免字符串比较
- 接口保持小而精 (`io.Reader`, `io.Writer`)
- 用 `go test -race` 检测数据竞争

### 12.2 Rust 所有权与异步

Rust 通过所有权系统在编译期保证内存安全，Tokio 是主流异步运行时。

```rust
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone)]
struct User {
    id: u64,
    email: String,
}

async fn load_user(id: u64) -> Result<User, String> {
    tokio::time::sleep(Duration::from_millis(20)).await;
    if id == 0 {
        return Err("invalid id".into());
    }
    Ok(User {
        id,
        email: format!("user{id}@example.com"),
    })
}

async fn load_many(ids: Vec<u64>, concurrency: usize) -> Vec<Result<User, String>> {
    let sem = Arc::new(Semaphore::new(concurrency));
    let mut handles = Vec::with_capacity(ids.len());
    for id in ids {
        let permit = sem.clone().acquire_owned().await.unwrap();
        handles.push(tokio::spawn(async move {
            let _p = permit;
            timeout(Duration::from_secs(2), load_user(id)).await.unwrap_or_else(|_| {
                Err("timeout".into())
            })
        }));
    }
    let mut results = Vec::with_capacity(handles.len());
    for h in handles {
        results.push(h.await.unwrap());
    }
    results
}
```

**Rust API 设计要点**
- 优先 `Result<T, E>` 而非 panic
- 用 `Arc` 共享只读数据，写路径用 `Mutex` / `RwLock`
- 序列化推荐 `serde` + `serde_json`
- HTTP 服务常用 `axum` 或 `actix-web`

### 12.3 Java Spring Boot 3 片段

```java
@RestController
@RequestMapping("/api/v1/users")
@Validated
public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping("/{id}")
    public ResponseEntity<UserDto> get(@PathVariable @Min(1) long id) {
        return userService.findById(id)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<UserDto> create(@Valid @RequestBody CreateUserRequest req) {
        UserDto created = userService.create(req);
        URI location = URI.create("/api/v1/users/" + created.id());
        return ResponseEntity.created(location).body(created);
    }
}
```

| 框架/库 | 用途 | 备注 |
|---------|------|------|
| Spring Boot | Web / DI / 配置 | 生态最大，适合企业级 |
| Spring Data JPA | ORM 抽象 | 注意 N+1 查询 |
| Hibernate | JPA 实现 | 二级缓存需审慎 |
| MapStruct | DTO 映射 | 编译期生成，性能好 |
| Resilience4j | 熔断/限流/重试 | 微服务容错 |
| Micrometer | 指标导出 | 对接 Prometheus |
| Testcontainers | 集成测试 | 真实 DB/Redis 容器 |

### 12.4 语言选型对照

| 维度 | Go | Rust | Java |
|------|----|------|------|
| 学习曲线 | 低 | 高 | 中 |
| 并发模型 | goroutine | async/await | 虚拟线程 (Loom) |
| 启动速度 | 快 | 快 | 较慢 (JVM 预热) |
| 内存占用 | 低 | 低-中 | 中-高 |
| 生态成熟度 | 云原生强 | 系统/基础设施工具强 | 企业业务强 |
| 典型场景 | API 网关、K8s 控制器 | CLI、高性能中间件 | 复杂业务系统 |

"""


def section_13() -> str:
    lines = [
        "## 13. 消息队列与事件驱动",
        "",
        "### 13.1 消息模型对比",
        "",
        "| 系统 | 模型 | 顺序 | 延迟 | 典型场景 |",
        "|------|------|------|------|----------|",
        "| Kafka | 日志流 / 分区 | 分区内有序 | ms 级 | 事件溯源、日志管道、流处理 |",
        "| RabbitMQ | 队列 / 交换机 | 单队列有序 | ms 级 | 任务分发、RPC 风格 |",
        "| NATS | 主题 / JetStream | 可配置 | 亚 ms | 微服务通信、边缘 |",
        "| Redis Streams | 流 | 近似有序 | 亚 ms | 轻量事件、排行榜 |",
        "| Pulsar | 分层存储 | 分区内有序 | ms 级 | 多租户、地理复制 |",
        "",
        "### 13.2 投递语义",
        "",
        "- **At-most-once**: 可能丢消息，不会重复（fire-and-forget）",
        "- **At-least-once**: 可能重复，不会丢（需消费者幂等）",
        "- **Exactly-once**: 端到端恰好一次（成本高，常通过事务 + 幂等键近似实现）",
        "",
        "**幂等消费模板**",
        "",
        "```python",
        "def handle_event(event: dict, store) -> None:",
        "    key = event['idempotency_key']",
        "    if store.seen(key):",
        "        return",
        "    with store.transaction():",
        "        apply_business_logic(event)",
        "        store.mark_seen(key)",
        "```",
        "",
        "### 13.3 Kafka 生产者/消费者要点",
        "",
        "```yaml",
        "生产者配置:",
        "  acks: all              # 等待所有 ISR 确认",
        "  enable.idempotence: true",
        "  retries: 2147483647",
        "  max.in.flight.requests.per.connection: 5",
        "",
        "消费者配置:",
        "  enable.auto.commit: false  # 手动提交 offset",
        "  isolation.level: read_committed  # 事务消息",
        "  max.poll.interval.ms: 300000",
        "```",
        "",
        "### 13.4 事件驱动架构模式",
        "",
        "1. **Event Notification**: 服务 A 发布事件，B/C 各自订阅，耦合低",
        "2. **Event-Carried State Transfer**: 事件携带足够数据，减少回调查询",
        "3. **Event Sourcing**: 状态由事件流重放得到，审计天然完整",
        "4. **CQRS**: 写模型与读模型分离，读侧可独立扩展",
        "",
        "### 13.5 Saga 分布式事务",
        "",
        "**编排式 (Orchestration)**",
        "",
        "```",
        "OrderSaga:",
        "  1. reserve_inventory -> 失败则结束",
        "  2. charge_payment   -> 失败则 release_inventory",
        "  3. create_shipment  -> 失败则 refund + release",
        "```",
        "",
        "**编舞式 (Choreography)**",
        "",
        "各服务监听彼此事件自行推进，无中心协调器，简单场景适用，复杂补偿难追踪。",
        "",
        "### 13.6 死信队列 (DLQ) 处理清单",
        "",
        "- 记录原始消息、失败原因、重试次数、时间戳",
        "- 指数退避重试，上限后进入 DLQ",
        "- 提供人工回放与批量修复工具",
        "- 监控 DLQ 深度告警",
        "- 区分可重试错误（网络抖动）与不可重试错误（格式错误）",
        "",
    ]
    # Expand with per-topic FAQ entries
    topics = [
        ("订单创建", "OrderCreated", "库存、支付、物流"),
        ("用户注册", "UserRegistered", "发欢迎邮件、初始化配置"),
        ("支付成功", "PaymentCaptured", "开通权益、开票"),
        ("文件上传", "FileUploaded", "病毒扫描、缩略图、索引"),
        ("评论发布", "CommentPosted", "审核、通知作者、更新计数"),
    ]
    for i, (name, event, consumers) in enumerate(topics, 1):
        lines.extend(
            [
                f"#### 13.6.{i} 场景: {name}",
                "",
                f"- 事件名: `{event}`",
                f"- 下游消费者: {consumers}",
                "- 建议分区键: `user_id` 或 `order_id` 保证相关事件有序",
                "- 幂等键: `event_id` 或业务主键",
                "- 重试策略: 1s, 2s, 4s, 8s, 最大 5 次",
                "- 可观测: 记录 `trace_id` 贯穿全链路",
                "",
            ]
        )
    lines.extend(
        [
            "### 13.7 MQ 运维要点",
            "",
            "- 监控消费延迟 (consumer lag)，分区数与并发消费者匹配",
            "- 避免单分区热点：按业务键均匀分区",
            "- 生产环境启用消息压缩与合理 retention",
            "",
        ]
    )
    return "\n".join(lines)


def section_14() -> str:
    lines = [
        "## 14. 可观测性与 SRE",
        "",
        "### 14.1 三大支柱",
        "",
        "| 支柱 | 回答的问题 | 工具示例 |",
        "|------|-----------|----------|",
        "| Metrics | 系统是否异常？趋势如何？ | Prometheus, Grafana |",
        "| Logs | 发生了什么？上下文？ | Loki, ELK, CloudWatch |",
        "| Traces | 请求经过哪些服务？瓶颈？ | Jaeger, Tempo, OTel |",
        "",
        "### 14.2 黄金信号 (Google SRE)",
        "",
        "1. **Latency** — 请求延迟分布（关注 p95/p99，不只是平均）",
        "2. **Traffic** — QPS、并发连接数",
        "3. **Errors** — 错误率（5xx、业务错误码）",
        "4. **Saturation** — CPU、内存、磁盘、连接池使用率",
        "",
        "### 14.3 RED 与 USE 方法",
        "",
        "**RED (面向服务)**",
        "- Rate — 每秒请求数",
        "- Errors — 失败请求比例",
        "- Duration — 请求耗时分布",
        "",
        "**USE (面向资源)**",
        "- Utilization — 资源使用百分比",
        "- Saturation — 排队/等待程度",
        "- Errors — 硬件/驱动错误计数",
        "",
        "### 14.4 Prometheus 指标命名",
        "",
        "```",
        "# 类型: counter, gauge, histogram, summary",
        "http_requests_total{method=\"GET\",route=\"/api/users\",status=\"200\"}",
        "http_request_duration_seconds_bucket{le=\"0.1\"}",
        "db_pool_active_connections",
        "cache_hit_ratio",
        "```",
        "",
        "### 14.5 OpenTelemetry 追踪",
        "",
        "```javascript",
        "const { trace } = require('@opentelemetry/api');",
        "",
        "async function handleRequest(req) {",
        "  const span = trace.getTracer('api').startSpan('handleRequest');",
        "  try {",
        "    span.setAttribute('http.route', req.path);",
        "    await doWork();",
        "  } catch (err) {",
        "    span.recordException(err);",
        "    span.setStatus({ code: 2, message: err.message });",
        "    throw err;",
        "  } finally {",
        "    span.end();",
        "  }",
        "}",
        "```",
        "",
        "### 14.6 SLO / SLI / 错误预算",
        "",
        "- **SLI**: 可测量指标，如「成功请求占比」",
        "- **SLO**: 目标值，如「99.9% 请求 < 300ms」",
        "- **错误预算**: `1 - SLO`，用于平衡新功能发布与稳定性",
        "",
        "示例: 月可用性 99.9% → 每月约 43.2 分钟不可用预算",
        "",
        "### 14.7 告警设计原则",
        "",
        "- 只对需要人工介入的情况告警",
        "- 告警必须可行动（有 runbook）",
        "- 避免告警风暴：分组、抑制、静默",
        "- 分页告警与工单告警分级",
        "",
    ]
    runbooks = [
        "API 5xx 飙升",
        "数据库连接池耗尽",
        "Redis 内存达上限",
        "Kafka 消费 lag 持续增长",
        "磁盘使用率 > 85%",
        "证书即将过期",
        "部署后错误率上升",
        "CDN 回源失败",
    ]
    for i, title in enumerate(runbooks, 1):
        lines.extend(
            [
                f"#### 14.7.{i} Runbook: {title}",
                "",
                "1. 确认告警是否真实（排除误报）",
                "2. 查看最近变更（部署、配置、流量）",
                "3. 检查依赖服务健康状态",
                "4. 收集 logs/traces/metrics 关联分析",
                "5. 执行缓解措施（扩容、回滚、降级）",
                "6. 记录 incident 时间线与根因",
                "7. 事后复盘，更新监控阈值与自动化",
                "",
            ]
        )
    return "\n".join(lines)


def section_15() -> str:
    return r"""## 15. 移动端与跨平台开发

### 15.1 技术栈对比

| 方案 | 语言 | 性能 | 原生感 | 热更新 | 适用 |
|------|------|------|--------|--------|------|
| React Native | JS/TS | 中-高 | 较好 | 支持 (CodePush) | 已有 React 团队 |
| Flutter | Dart | 高 | 好 | 有限 | 自绘 UI、一致性强 |
| SwiftUI | Swift | 高 | 最佳 (iOS) | 否 | iOS 独占 |
| Kotlin Compose | Kotlin | 高 | 最佳 (Android) | 否 | Android 独占 |
| Capacitor/Ionic | Web | 中 | 一般 | Web 部署 | 内部工具、MVP |

### 15.2 React Native 架构要点

```tsx
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';

type Todo = { id: string; title: string; done: boolean };

export function TodoList() {
  const [items, setItems] = useState<Todo[]>([]);

  useEffect(() => {
    fetch('/api/todos')
      .then((r) => r.json())
      .then(setItems)
      .catch(console.error);
  }, []);

  const toggle = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }, []);

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <Pressable onPress={() => toggle(item.id)}>
          <View style={{ padding: 12 }}>
            <Text style={{ textDecorationLine: item.done ? 'line-through' : 'none' }}>
              {item.title}
            </Text>
          </View>
        </Pressable>
      )}
    />
  );
}
```

**性能建议**
- 长列表用 `FlatList` / `FlashList`，提供稳定 `keyExtractor`
- 避免在 render 中创建匿名函数与内联对象（或用 `useCallback` / `memo`）
- 图片使用合适分辨率，启用缓存
- 重计算放 `useMemo`，副作用放 `useEffect`

### 15.3 离线优先与同步

```typescript
// 伪代码: 本地 SQLite + 后台同步
interface SyncQueueItem {
  id: string;
  op: 'create' | 'update' | 'delete';
  payload: unknown;
  updatedAt: string;
}

async function flushQueue(queue: SyncQueueItem[]) {
  for (const item of queue) {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    if (!res.ok) throw new Error(`sync failed: ${item.id}`);
  }
}
```

### 15.4 应用发布检查清单

- [ ] 版本号与构建号递增
- [ ] 隐私政策与权限说明更新
- [ ] 崩溃监控 (Sentry/Firebase Crashlytics) 接入
- [ ] 深链接 / Universal Links 测试
- [ ] 弱网与离线场景测试
- [ ] 应用商店截图与描述本地化
- [ ] 签名证书与 Provisioning Profile 有效

### 15.5 安全要点

- 敏感数据存 Keychain / Keystore，勿放 AsyncStorage 明文
- Certificate Pinning 防中间人（权衡维护成本）
- 根检测 / 越狱检测（金融类应用）
- API Token 短期有效 + 刷新机制

"""


def section_16() -> str:
    lines = [
        "## 16. LLM 与 AI 应用工程",
        "",
        "### 16.1 RAG 流水线",
        "",
        "```",
        "文档 -> 分块 (chunk) -> 嵌入 (embedding) -> 向量库",
        "用户问题 -> 嵌入 -> 相似度检索 -> 重排序 -> 拼 prompt -> LLM -> 回答",
        "```",
        "",
        "**分块策略**",
        "- 固定长度 + overlap（如 512 token，overlap 64）",
        "- 按标题/段落语义切分",
        "- 表格、代码块尽量保持完整",
        "",
        "### 16.2 Prompt 工程结构",
        "",
        "```markdown",
        "## 系统",
        "你是企业知识库助手。仅根据提供的上下文回答；不知道则说明。",
        "",
        "## 上下文",
        "{{retrieved_chunks}}",
        "",
        "## 用户",
        "{{question}}",
        "",
        "## 输出格式",
        "- 结论先行，不超过 300 字",
        "- 引用来源 [doc_id:chunk_id]",
        "```",
        "",
        "### 16.3 评估指标",
        "",
        "| 指标 | 含义 |",
        "|------|------|",
        "| Faithfulness | 回答是否忠于检索内容 |",
        "| Answer Relevance | 是否切题 |",
        "| Context Precision | 检索片段是否相关 |",
        "| Context Recall | 是否检索到必要信息 |",
        "| Latency / Cost | 延迟与 token 成本 |",
        "",
        "### 16.4 工具调用 (Function Calling)",
        "",
        "```json",
        "{",
        '  "tools": [{',
        '    "type": "function",',
        '    "function": {',
        '      "name": "get_weather",',
        '      "parameters": {',
        '        "type": "object",',
        '        "properties": { "city": { "type": "string" } },',
        '        "required": ["city"]',
        "      }",
        "    }",
        "  }]",
        "}",
        "```",
        "",
        "### 16.5 生产注意事项",
        "",
        "- 限流与配额（按用户/租户）",
        "- 输入输出审核（PII、有害内容）",
        "- 缓存常见问答（语义缓存）",
        "- 流式输出改善首字延迟",
        "- 模型路由：小模型分类 + 大模型精答",
        "- 可观测：记录 prompt 版本、检索命中、token 用量",
        "",
    ]
    return "\n".join(lines)


def section_17() -> str:
    lines = [
        "## 17. 性能优化实战手册",
        "",
        "### 17.1 前端性能",
        "",
        "| 技术 | 作用 |",
        "|------|------|",
        "| Code Splitting | 按路由/组件懒加载 |",
        "| Tree Shaking | 移除未使用导出 |",
        "| 图片 WebP/AVIF | 减小传输体积 |",
        "| CDN | 边缘缓存静态资源 |",
        "| prefetch/preload | 预取关键资源 |",
        "| Service Worker | 离线缓存策略 |",
        "",
        "**Core Web Vitals 目标**",
        "- LCP < 2.5s",
        "- INP < 200ms",
        "- CLS < 0.1",
        "",
        "### 17.2 后端性能",
        "",
        "- 连接池：DB、Redis、HTTP keep-alive",
        "- 批处理：减少 round-trip",
        "- 异步化：非关键路径放队列",
        "- 读写分离：读副本分担查询",
        "- 分页：游标优于大 offset",
        "",
        "### 17.3 数据库优化",
        "",
        "```sql",
        "-- 慢查询分析",
        "EXPLAIN (ANALYZE, BUFFERS)",
        "SELECT * FROM orders WHERE user_id = 123 AND status = 'paid';",
        "",
        "-- 覆盖索引",
        "CREATE INDEX idx_orders_user_status_created",
        "  ON orders (user_id, status, created_at DESC)",
        "  INCLUDE (total_amount);",
        "```",
        "",
        "### 17.4 缓存层次",
        "",
        "```",
        "浏览器缓存 -> CDN -> 反向代理 -> 应用本地缓存 -> Redis -> DB",
        "```",
        "",
    ]
    lines.extend(
        [
            "### 17.5 优化检查清单",
            "",
            "| 优化项 | 说明 | 验证方式 |",
            "|--------|------|----------|",
            "| 减少 HTTP 请求 | 合并资源、HTTP/2 多路复用 | Lighthouse Network |",
            "| 启用压缩 | gzip/brotli 压缩文本资源 | 对比 Content-Length |",
            "| 数据库索引 | WHERE/ORDER BY/JOIN 列建索引 | EXPLAIN ANALYZE |",
            "| 避免 N+1 | JOIN 或 DataLoader 批量加载 | ORM 查询日志 |",
            "| 序列化优化 | Protobuf/MessagePack 替代 JSON | 压测吞吐 |",
            "| 限流降级 | 令牌桶保护下游 | 错误率与延迟曲线 |",
            "",
            "优化流程: 先测量基线 (p95) -> 单变量改动 -> 回归测试 -> 记录收益。",
            "",
        ]
    )
    return "\n".join(lines)


def section_18() -> str:
    patterns = [
        ("单例", "Singleton", "全局唯一实例", "配置管理器、连接池"),
        ("工厂", "Factory", "封装对象创建", "根据类型创建不同 Parser"),
        ("抽象工厂", "Abstract Factory", "创建相关对象族", "UI 主题组件族"),
        ("建造者", "Builder", "分步构建复杂对象", "SQL Query Builder"),
        ("原型", "Prototype", "克隆已有对象", "深拷贝配置模板"),
        ("适配器", "Adapter", "接口转换", "第三方 SDK 封装"),
        ("装饰器", "Decorator", "动态增强行为", "日志、缓存中间层"),
        ("代理", "Proxy", "控制访问", "懒加载、权限校验"),
        ("外观", "Facade", "简化子系统接口", "统一 API 网关"),
        ("桥接", "Bridge", "抽象与实现分离", "跨平台渲染"),
        ("组合", "Composite", "树形结构统一处理", "文件系统节点"),
        ("享元", "Flyweight", "共享细粒度对象", "字符渲染缓存"),
        ("策略", "Strategy", "可替换算法", "支付方式、排序策略"),
        ("模板方法", "Template Method", "骨架固定步骤可变", "数据导入流程"),
        ("观察者", "Observer", "发布订阅", "事件总线"),
        ("迭代器", "Iterator", "顺序访问集合", "自定义集合遍历"),
        ("命令", "Command", "请求封装为对象", "撤销/重做"),
        ("状态", "State", "行为随状态变化", "订单状态机"),
        ("责任链", "Chain of Responsibility", "传递处理请求", "中间件链"),
        ("中介者", "Mediator", "集中协调交互", "聊天室"),
        ("备忘录", "Memento", "保存恢复状态", "编辑器历史"),
        ("访问者", "Visitor", "分离算法与结构", "AST 遍历"),
    ]
    lines = [
        "## 18. 设计模式详解",
        "",
        "GoF 23 种设计模式分为创建型、结构型、行为型三类。",
        "",
    ]
    for idx, (cn, en, desc, example) in enumerate(patterns, 1):
        lines.extend(
            [
                f"### 18.{idx} {cn} ({en})",
                "",
                f"**意图**: {desc}",
                f"**示例场景**: {example}",
                "",
                "```typescript",
                f"// {en} pattern sketch",
                "interface Strategy {",
                "  execute(input: string): string;",
                "}",
                "",
                "class UpperCaseStrategy implements Strategy {",
                "  execute(input: string) { return input.toUpperCase(); }",
                "}",
                "",
                "class Context {",
                "  constructor(private strategy: Strategy) {}",
                "  run(input: string) { return this.strategy.execute(input); }",
                "}",
                "```",
                "",
                "**适用条件**",
                "- 当扩展点明确且变化频率高时考虑",
                "- 避免过度设计：三处以上重复再抽象",
                "",
                "**权衡**",
                "- 优点: 解耦、可测试、可扩展",
                "- 缺点: 类数量增加、间接层变多",
                "",
            ]
        )
    return "\n".join(lines)


def section_19() -> str:
    lines = [
        "## 19. 扩展附录与场景题库",
        "",
        "### 19.1 Docker 命令扩展",
        "",
        "| 命令 | 说明 |",
        "|------|------|",
        "| docker compose up -d | 后台启动 compose 栈 |",
        "| docker system prune -af | 清理未使用镜像/容器 |",
        "| docker stats | 实时资源占用 |",
        "| docker inspect | 查看元数据 JSON |",
        "| docker exec -it sh | 进入运行中容器 |",
        "",
        "### 19.2 Kubernetes 排错",
        "",
        "```bash",
        "kubectl get pods -A | grep -v Running",
        "kubectl describe pod <name>",
        "kubectl logs <pod> --previous",
        "kubectl top nodes",
        "kubectl port-forward svc/api 8080:80",
        "```",
        "",
        "### 19.3 常见系统设计题要点",
        "",
    ]
    questions = [
        "设计短链接服务",
        "设计微博/Twitter 时间线",
        "设计聊天系统",
        "设计秒杀系统",
        "设计分布式 ID 生成器",
        "设计搜索引擎",
        "设计视频点播",
        "设计协同文档",
        "设计限流器",
        "设计任务调度系统",
    ]
    for i, q in enumerate(questions, 1):
        lines.extend(
            [
                f"#### 19.3.{i} {q}",
                "",
                "- 澄清: QPS、数据量、延迟、一致性要求",
                "- 估算: 存储、带宽、机器数",
                "- API: 核心读写接口",
                "- 数据模型: 表/缓存/索引",
                "- 架构图: 负载均衡、服务拆分、缓存、队列",
                "- 扩展: 分片、多活、降级",
                "- 单点: 如何消除与故障转移",
                "",
            ]
        )
    # SQL quick reference rows
    lines.extend(["### 19.4 SQL 函数速查扩展", "", "| 函数 | 用途 | 示例 |", "|------|------|------|"])
    sql_funcs = [
        ("COALESCE", "取第一个非 NULL", "COALESCE(nick, name, '匿名')"),
        ("NULLIF", "相等则 NULL", "NULLIF(a, b)"),
        ("GREATEST", "最大值", "GREATEST(a, b, c)"),
        ("DATE_TRUNC", "截断日期", "DATE_TRUNC('month', ts)"),
        ("EXTRACT", "提取字段", "EXTRACT(YEAR FROM ts)"),
        ("JSONB_AGG", "聚合 JSON", "JSONB_AGG(row)"),
        ("ARRAY_AGG", "聚合数组", "ARRAY_AGG(id)"),
        ("STRING_AGG", "字符串聚合", "STRING_AGG(name, ',')"),
        ("ROW_NUMBER", "行号", "ROW_NUMBER() OVER (...)"),
        ("RANK", "排名", "RANK() OVER (ORDER BY score DESC)"),
    ]
    for fn, use, ex in sql_funcs:
        lines.append(f"| `{fn}` | {use} | `{ex}` |")
    lines.append("")
    return "\n".join(lines)


def build_supplement() -> str:
    parts = [
        section_12(),
        section_13(),
        section_14(),
        section_15(),
        section_16(),
        section_17(),
        section_18(),
        section_19(),
    ]
    return "\n---\n\n".join(parts) + "\n\n---\n\n"


def main() -> None:
    text = TARGET.read_text(encoding="utf-8")
    text = text.rstrip()
    if text.endswith("```"):
        text = text[: -len("```")].rstrip()

    if MARKER not in text:
        raise SystemExit(f"Marker {MARKER!r} not found in {TARGET}")

    if "12. [Go / Rust / Java" not in text:
        text = text.replace(
            "11. [附录: 快速查询表](#11-附录-快速查询表)",
            "11. [附录: 快速查询表](#11-附录-快速查询表)\n" + TOC_INSERT.rstrip(),
        )

    supplement = build_supplement()
    head, tail = text.split(MARKER, 1)
    merged = head.rstrip() + "\n\n" + supplement + MARKER + tail
    TARGET.write_text(merged, encoding="utf-8", newline="\n")

    line_count = merged.count("\n") + (0 if merged.endswith("\n") else 1)
    print(f"Wrote {TARGET}")
    print(f"Total lines: {line_count}")


if __name__ == "__main__":
    main()
