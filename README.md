# wx-semantic-search

微信消息语义化检索服务。

## 功能

- **语义化查询**：用一段话检索意思相近的消息，不要求正文逐字相同。
- **精确查询**：按正文、会话、发送人和时间筛选，并按消息顺序翻页。
- **上下文查询**：查看一条消息的前后文。
- **增量上传**：按会话补传新消息。同一条消息再次上传时就地更新。

## 依赖

服务：

- Docker
- 兼容 OpenAI Embeddings 接口的嵌入服务

上传：

- Node.js
- [GreenBubbles](https://github.com/bojieli/greenbubbles)（Apple 芯片，macOS 14 及以上）

## 部署

```bash
cp .env.example .env
```

| 变量 | 说明 |
| --- | --- |
| `WX_SEMANTIC_SEARCH_PORT` | 宿主机端口。未设置时为 `5757` |
| `WX_SEMANTIC_SEARCH_API_KEY` | 接口访问密钥。必填 |
| `POSTGRES_PASSWORD` | 数据库密码。必填 |
| `OPENAI_BASE_URL` | 嵌入接口根地址，须包含 `/v1`。未设置时为 `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | 嵌入接口密钥。必填 |
| `EMBEDDING_MODEL` | 嵌入模型。未设置时为 `text-embedding-3-small` |
| `EMBEDDING_DIMENSIONS` | 向量维度，须与模型一致，范围为 1 到 2000。未设置时为 `1536` |

更换嵌入模型时，须同时修改 `EMBEDDING_MODEL` 与 `EMBEDDING_DIMENSIONS`。维度写入向量列后不可单独变更，变更须重建数据卷。任一必填项缺失时，`api` 拒绝启动。

```bash
docker compose up -d
```

请勿将服务暴露于公网。

## 上传

```bash
WX_SEMANTIC_SEARCH_URL=http://目标机器:端口 WX_SEMANTIC_SEARCH_API_KEY=密钥 node scripts/upload.mjs --conversation 会话id --batch 100
```

- `WX_SEMANTIC_SEARCH_URL` 与 `WX_SEMANTIC_SEARCH_API_KEY` 通过环境变量传入。
- 会话标识通过 `--conversation` 传入。
- `--batch` 为每批条数，范围是 1 到 500。未设置时为 500。
- 消息按时间从早到晚上传。再次运行时只补充更新的消息。

## 接口

除 `GET /health` 外，请求头须包含 `Authorization: Bearer <WX_SEMANTIC_SEARCH_API_KEY>`。

- `GET /health`：数据库可连接时返回 `{ "ok": true }`。
- `POST /messages`：`items` 最多 500 条。返回 `{ "inserted", "updated", "unchanged" }`。嵌入失败时返回 `{ "error": "embed failed" }`，且该批数据不会写入。
- `DELETE /messages/{id}`：删除一条消息。不存在时返回 `{ "error": "not found" }`。
- `DELETE /messages`：必须提供 `conversation_id`。删除该会话的全部消息，返回 `{ "deleted" }`。
- `GET /messages`：`conversation_id`、`contains`、`sender`、`since`、`until` 至少提供一项。`contains` 为正文子串匹配，不区分英文字母大小写。分页参数为 `after_created_at`、`after_sort_sequence`、`after_id`。排序字段依次为 `sort_sequence`、`created_at`、`id`。`order=desc&limit=1` 返回最新一条。
- `GET /messages/{id}/context`：参数 `before` 与 `after` 的默认值为 10，最大值为 50。
- `POST /search`：`query` 为必填。可选参数为 `conversation_id`、`since`、`until`、`limit`。`distance` 越小，相关度越高。

## 许可

[MIT](LICENSE)
