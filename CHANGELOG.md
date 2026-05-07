# 更新日志（Changelog）

本文件记录 MiMo2API 的所有重要变更。

## [v2.1.0] — 2026-05-07

### Added
- **Anthropic 模型名映射** — Claude Code CLI 等工具可使用 Anthropic 风格模型名（如 `claude-sonnet-4-6`），内部自动映射为对应 MiMo 模型
  - `claude-opus-4-6` → `mimo-v2-pro`
  - `claude-sonnet-4-6` → `mimo-v2-flash`
  - `claude-haiku-4-5` → `mimo-v2-flash`
  - 支持 search/nothinking 变体及 Claude 3.x/4.x 历史名
- MiMo 原生名（`mimo-*`）继续直接可用，`/v1/models` 返回不变

## [v2.0.0] — 2026-05-06

### Added
- **Anthropic Messages API 全兼容** — 新增 9 个 Anthropic 端点：`/v1/messages`（流式/非流式）、count_tokens、message CRUD、batch 全流程
- **多账号管理** — Web 面板增删账号、轮询负载均衡
- **TTS 语音合成**（no-tools）— 声线克隆、音色设计、导演模式

### Changed
- 路由拆分为 `app/anthropic_routes.py`（APIRouter 模式）
- `app/anthropic.py` + `app/batch.py` 模块化

## [Unreleased]

### Changed
- CHANGELOG.md 初始化
- README 补充静默降级 FAQ

---

## [v1.0.0] — 2026-05-04

### Added
- **工具调用** — 6 种提取策略覆盖 TOOL_CALL、JSON、MiMo 原生 XML、`<function_call>`、自由文本匹配、中文 `[调用工具:]` 格式
- **流式筛分（tool_sieve）** — 实时分离流式响应中的正文与工具调用，无需全量缓冲再输出
- **会话管理** — SHA256 消息指纹续接 MiMo conversationId，跨请求保持上下文
- **按模型上下文窗口** — 根据官方 Pricing 页设置精确的 `context_length`/`max_output_tokens`（v2.5-pro/v2-pro/v2.5 为 1M，v2-flash/v2-omni 为 256K）
- **文本文件上传** — 原生 MiMo resource 上传流程（genUploadInfo → PUT OSS → resource/parse），支持 .md/.txt/.py/.json 等
- **用量统计** — 按模型分组的 Token 追踪，Web 面板可视化，支持今日/本周/全部筛选，清空按钮
- **Web 管理面板** — 多 Tab 布局（cURL 导入、Cookie 导入、账号列表、用量统计、API Key 管理）

### Changed
- **双分支架构** — `main`（工具调用）和 `no-tools`（纯对话 + TTS）独立维护
- **工具提示词精简** — 从 30+ 行降到 ~10 行，移到 query 末尾，每次最多注入 6 个工具
- **三轮注入策略** — 首轮完整提示词，后续轮只列工具名（不加行为指令），防止死循环
- **查询格式重排** — 用户消息在前，工具信息在后，跳过 system 消息（MiMo 不支持角色分离）
- **模型列表** — 从 MiMo API 动态发现，未知模型过滤

### Fixed
- **Pydantic v1 兼容** — `model_dump()` 改为 `dict()`（项目依赖 pydantic<2）
- **TOOL_CALL 文本泄露** — 流式筛分实时截获并过滤工具调用文本
- **camelCase 工具名不匹配** — `_resolve_tool_name()` 四级匹配（直接/忽略大小写/驼峰转蛇形/模糊）
- **工具结果标签泄露** — `_strip_tool_result_blocks()` 覆盖 3 种格式：`[TOOL_RESULT]`、`[tool_result id=xxx]`、`<tool_result>`
- **工具调用死循环** — 三轮注入策略防止重复调用同一工具
- **工具提示词被截断丢弃** — 截断后重新插入工具信息
- **空参数工具调用失败** — 正则 `(.+?)` → `(.*?)` 允许 `getTimeInfo()`
- **流式沉默间隙** — `_safe_flush()` 只保留 `<think>`/`</think>` 部分后缀，不吞内容
- **图片模型劫持** — 移除强制切到 omni 的逻辑，用户选择什么模型就走什么模型
- **cURL 添加账号失败** — `update_config()` 增加字段过滤，拒绝 `token_masked`
- **RikkaHub 流式延迟** — reasoning 实时流式，有工具时仅正文缓冲
- **Cookie 字符串解析** — 支持粘贴整段 `key=value; key=value` Cookie header
- **保存按钮无反馈** — 所有保存按钮增加 disabled + loading 文本

### 已知问题
- serviceToken 约 24 小时过期，需网页端退出重新登录（仅刷新 Cookie 无效）
- **静默降级：** Token 过期后，基础聊天（flash/pro）和"测试连接"仍显示正常，但 `mimo-v2.5` / `mimo-v2-omni` 多模态识图会静默失效。如果只聊天空正常但识图不工作，优先怀疑凭证过期
- MiMo 服务端并发限制：约 1-2 请求/账号
- 不支持 Embeddings 端点
- 非原生 function calling（通过文本提示模拟）

---

## [0.x] — 初期开发阶段

从 [Water008/MiMo2API](https://github.com/Water008/MiMo2API) fork 后的早期改版（网页直接上传文件，无 git 历史记录），包含以下功能沉淀：

- OpenAI 兼容 `/v1/chat/completions`、`/v1/models` 端点
- 多账号轮询负载均衡
- Cookie / cURL 凭证导入 + Web 管理面板
- 图片上传（genUploadInfo → PUT → resource/parse → multiMedias）
- Think 块分离（`<think>`/`</think>`）
- Termux/Android 部署脚本
- 功能文档 README

---

## 分支说明

| 分支 | 功能 |
|------|------|
| `main` | 工具调用（6 策略）、流式筛分、会话管理、文件上传 |
| `no-tools` | 纯对话代理 + TTS（语音合成、音色设计、语音克隆、导演模式） |

日常使用推荐 no-tools 分支（上下文更干净，输出质量更高）。如需 TTS 功能直接使用 no-tools。
