# Guardrails 运行接口

本包属于现有 `framework` 模块，默认禁用，不自行调用外部评判服务。

## 初始化与配置

```go
cfg, err := guardrails.DecodeConfig(pluginConfig)
plugin, err := guardrails.PluginInit(cfg, guardrails.Dependencies{
    ConfigStore: store,
    ChatExecutor: executor,
    ScopeResolver: resolveTrustedScope,
    Adapters: adapters,
    StreamRewriter: streamRewriter,
})
handler := handlers.NewGuardrailsHandler(plugin, authorizeGuardrails)
handler.RegisterRoutes(router, authenticatedMiddlewares...)
```

初始化不写数据库。配置变更通过 `ReplaceConfig` 或 `ChangeConfig` 完整校验，
成功保存到 `ConfigStore` 的 `TablePlugin{Name: "guardrails"}` 后再切换不可变快照。
宿主需要从保存的插件行加载配置，并将插件行的启用状态传入 `Config.Enabled`。
`Config()` 返回独立副本。配置错误不会替换最后有效快照。

管理 API 的规则使用 camelCase，内部 `Config` 使用 snake_case。
关联配置在管理 API 中为 `provider:id`，内部为整数 `provider_config_ids`。
所有管理入口要求独立 `read`、`write` 或 `evaluate` 授权，缺失回调时返回 403。
`POST /api/guardrails/evaluate` 接收 `text`、`phase`、`target`，仅允许本地检测器，
不运行 Prompt judge 或外部 provider。

## 已提供的运行能力

- RE2 模式校验、编译及 `detect_only`、`block`、`redact`。
- 文档定义的 Email、US phone、SSN、credit-card-like、IPv4 PII 模板。
- Gitleaks v8.30.1 官方嵌入默认规则及标准化 false-positive allowlist。
- Chat judge 的独立 JSON 内容、严格 ALLOW/BLOCK 决策和 token 明细。
- CEL 目标变量隔离、采样、会话选择及 bundled/per_turn 执行。
- Chat、Responses、Text 和实际 MCP execute-tool 边界的文本提取。
- 文本及 JSON 工具参数字符串叶子的替换，不改工具名称、ID、定义或媒体字段。
- runtime、logs_only、runtime_reversible 脱敏数据写入现有日志/trace schema。
- 原生请求通过 integration 的 RawRequestBodyTextRewriter/Transformer 同步。
- block 输出流的完整 pause/evaluate/replay，跨 chunk 完整评估及可选回放间隔。
- request manager 的配置快照、取消清理、8 MiB 流上限和五分钟时限。
- profiles/rules 的公开管理路由及真实 Presidio Analyzer 协议。

普通拒绝使用 ShortCircuit 或返回 BifrostError，AllowFallbacks 固定为 false。
只有 Prompt judge 的验证、请求、超时或解析错误按公开契约 fail-open。
判定 metadata 不含命中原文；judge 自由文本理由不进入日志。

## 宿主接口

`ChatExecutor.ValidateJudge` 校验已配置的 provider/model 与结构化输出能力；
`ExecuteChat` 必须绕过 guardrails 防止递归，不得自动选择收费默认模型。

`ScopeResolver` 只能使用认证和治理层已解析的身份。
默认实现不从客户端 header 推导 team/user 等身份。
`params` 按公开配置文档为 `map<string,string>` query parameters。

外部实现通过 `Dependencies.Adapters` 注册 `Adapter`：

```go
Validate(json.RawMessage) error
Capabilities() Capabilities
Evaluate(context.Context, json.RawMessage, Evaluation) (AdapterResult, error)
```

`Finding` 使用 UTF-8 字节半开区间。`TextRewrite` 使用对应文本行的 opaque index。
返回的动作、跨度及重写所有权由父 engine 再次校验。
凭据只允许环境引用，未知字段或未注册 provider 配置被拒绝。

运行态流重写必须注入 `StreamTextRewriter`：

```go
ValidateRequest(*schemas.BifrostContext, *schemas.BifrostRequest) error
Rewrite(*schemas.BifrostContext, *schemas.BifrostResponse,
    *schemas.BifrostResponse, []schemas.TextRewrite) (*schemas.BifrostResponse, error)
```

`Rewrite` 的参数分别是完整累积结果和尚未进入 gate 的终态事件。
宿主必须使用 `TransformPausedStreamBuffer` 的 copy-on-write 协议，同时重写
缓冲事件、delta 和终态副本，在返回前不得释放原始缓冲。
父 engine 负责最终 replay；缺失该接口时受保护的 runtime-redact 流被拒绝。

## 尚待完成的公开契约

- 不带工具的 runtime-redact 流分段检查与实时释放。
- 各原生协议的 StreamTextRewriter 实现和流行为真实验收。
- Responses-only judge 路由、独立 Prompt Verify 管理操作。
- F 外部 HTTP provider 子包与父 Adapter 的桥接及 tool-context 完整适配。
- Azure PII、Azure Content Safety、Bedrock、Google Model Armor adapter。
- 日志 reveal ACL/no-store 的正式入口及持久化和 connector 导出验收。
- Presidio supported-entities 管理查询。
- 本地 block/redact 的独立 action metadata；现有 Detections 只用于 detect_only。
- Judge 原始短理由的安全脱敏后展示、全部公开管理错误语义核对。

生产编译只能证明源码可编译，不能证明实际 provider、gate、数据库、日志或 API 行为。
