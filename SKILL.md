---
name: wx-semantic-search
description: 检索已上传的微信消息。用户要按意思查找、按原文或时间筛选，或查看某条消息的前后文时使用。
---

# wx-semantic-search

服务地址取自 `WX_SEMANTIC_SEARCH_URL`。除 `GET /health` 外，请求头为 `Authorization: Bearer`，密钥取自 `WX_SEMANTIC_SEARCH_API_KEY`。密钥不放在命令行参数中。

- 时间为 Unix 秒。
- 成功时响应体即为结果，无 `data` 包裹。
- 失败时响应体为 `{ "error": "说明" }`。

## 消息字段

`id`、`conversation_id`、`created_at`、`sender`、`sender_display_name`、`sort_sequence`、`body`。

`sender` 是稳定说话人标识。顺序为 `sort_sequence`、`created_at`、`id`。

## `GET /messages`

至少提供一项筛选：`conversation_id`、`contains`、`sender`、`since`、`until`。

- `contains` 匹配正文子串，不区分英文字母大小写。
- `order` 为 `asc` 或 `desc`，默认 `asc`。
- `limit` 默认 50，最大 200。
- 下一页原样传回 `next_after_created_at`、`next_after_sort_sequence`、`next_after_id`。
- 响应含 `items` 与 `page.total`。

## `POST /search`

JSON 须含 `query`。可选 `conversation_id`、`since`、`until`、`limit`（默认 20，最大 100）。

结果按 `distance` 升序，值越小越接近。

## `GET /messages/{id}/context`

返回该消息在同一会话中的前后文。

- `before` 与 `after` 默认 10，最大 50。
- `before`、`after` 均从早到晚，并与 `anchor` 相邻。
