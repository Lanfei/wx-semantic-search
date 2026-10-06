import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";

const required = [
  "WX_SEMANTIC_SEARCH_API_KEY",
  "OPENAI_API_KEY",
  "POSTGRES_PASSWORD",
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
}

const dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 1536);
if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 2000) {
  console.error("EMBEDDING_DIMENSIONS must be an integer from 1 to 2000");
  process.exit(1);
}

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.PGDATABASE,
  max: 4,
});

pool.on("error", (error) => {
  console.error(`database connection error: ${error.code || ""} ${error.message}`.trim());
});

const MAX_BODY = 10_000_000;
const EMBED_TIMEOUT_MS = 30_000;

function keyOk(header) {
  const match = /^Bearer (.+)$/.exec(header || "");
  const given = createHash("sha256").update(match ? match[1] : "").digest();
  const expected = createHash("sha256").update(process.env.WX_SEMANTIC_SEARCH_API_KEY).digest();
  return timingSafeEqual(given, expected) && match !== null;
}

function send(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(raw);
}

function rowToJson(row, distance) {
  const item = {
    id: row.id,
    conversation_id: row.conversation_id,
    created_at: Number(row.created_at_unix),
    sender: row.sender,
    sender_display_name: row.sender_display_name,
    sort_sequence: Number(row.sort_sequence),
    body: row.body,
  };
  if (distance !== undefined) item.distance = distance;
  return item;
}

const SELECT_COLUMNS = `
  id, conversation_id, EXTRACT(EPOCH FROM created_at)::bigint AS created_at_unix,
  sender, sender_display_name, sort_sequence, body
`;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error("body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid json");
    error.status = 400;
    throw error;
  }
}

async function embed(texts) {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || "text-embedding-3-small", input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error("embed failed");
    error.httpStatus = response.status;
    error.detail = await embedErrorDetail(response);
    throw error;
  }
  const payload = await response.json();
  const vectors = new Array(texts.length);
  for (const item of payload.data || []) {
    if (!Array.isArray(item.embedding) || item.embedding.length !== dimensions) {
      const error = new Error("embed failed");
      error.reason = "dimension";
      throw error;
    }
    vectors[item.index] = item.embedding;
  }
  if (vectors.some((vector) => !vector)) {
    const error = new Error("embed failed");
    error.reason = "dimension";
    throw error;
  }
  return vectors;
}

async function embedErrorDetail(response) {
  const text = await response.text();
  let detail = text;
  try {
    const payload = JSON.parse(text);
    const reason = payload?.error;
    if (typeof reason === "string") detail = reason;
    else if (typeof reason?.message === "string") detail = reason.message;
    else if (typeof payload?.message === "string") detail = payload.message;
  } catch {
    detail = text;
  }
  return detail.replace(/\s+/g, " ").trim().slice(0, 300);
}

function logEmbed(error) {
  if (Number.isInteger(error.httpStatus)) {
    console.error(`embed failed: status ${error.httpStatus}${error.detail ? ` ${error.detail}` : ""}`);
    return;
  }
  if (error.reason === "dimension") {
    console.error("embed failed: dimension mismatch");
    return;
  }
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    console.error("embed failed: timeout");
    return;
  }
  console.error("embed failed");
}

function vectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

function likePattern(value) {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function parseLimit(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  if (number < 1 || number > max) return null;
  return number;
}

function parseUnix(value) {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) return null;
  return Number(value);
}

async function listMessages(url, res) {
  const conversationId = url.searchParams.get("conversation_id") || undefined;
  const contains = url.searchParams.get("contains") || undefined;
  const sender = url.searchParams.get("sender") || undefined;
  const since = parseUnix(url.searchParams.get("since") ?? undefined);
  const until = parseUnix(url.searchParams.get("until") ?? undefined);
  const afterCreatedAt = parseUnix(url.searchParams.get("after_created_at") ?? undefined);
  const afterSort = parseUnix(url.searchParams.get("after_sort_sequence") ?? undefined);
  const afterId = url.searchParams.get("after_id") || undefined;
  const order = url.searchParams.get("order") || "asc";
  const limit = parseLimit(url.searchParams.get("limit") ?? undefined, 50, 200);
  if (since === null || until === null || afterCreatedAt === null || afterSort === null || limit === null) {
    send(res, 400, { error: "invalid query" });
    return;
  }
  if (order !== "asc" && order !== "desc") {
    send(res, 400, { error: "invalid query" });
    return;
  }
  const cursorCount = [afterCreatedAt, afterSort, afterId].filter((value) => value !== undefined).length;
  if (cursorCount !== 0 && cursorCount !== 3) {
    send(res, 400, { error: "invalid query" });
    return;
  }
  if (!conversationId && !contains && !sender && since === undefined && until === undefined) {
    send(res, 400, { error: "missing filter" });
    return;
  }

  const where = [];
  const params = [];
  function add(sql, value) {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  }
  if (conversationId) add("conversation_id = ?", conversationId);
  if (contains) add("body ILIKE ? ESCAPE '\\'", likePattern(contains));
  if (sender) add("sender = ?", sender);
  if (since !== undefined) add("created_at >= to_timestamp(?)", since);
  if (until !== undefined) add("created_at <= to_timestamp(?)", until);
  const filterSql = where.join(" AND ");

  const cursor = [];
  const cursorParams = [...params];
  if (afterCreatedAt !== undefined) {
    cursorParams.push(afterSort, afterCreatedAt, afterId);
    const compare = order === "asc" ? ">" : "<";
    const first = cursorParams.length - 2;
    cursor.push(
      `(sort_sequence, created_at, id) ${compare} ($${first}, to_timestamp($${first + 1}), $${first + 2})`,
    );
  }
  const listWhere = [filterSql, ...cursor].filter(Boolean).join(" AND ");
  cursorParams.push(limit);
  const direction = order === "asc" ? "ASC" : "DESC";
  const list = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM messages WHERE ${listWhere}
     ORDER BY sort_sequence ${direction}, created_at ${direction}, id ${direction}
     LIMIT $${cursorParams.length}`,
    cursorParams,
  );
  const count = await pool.query(`SELECT count(*)::int AS total FROM messages WHERE ${filterSql}`, params);
  const items = list.rows.map((row) => rowToJson(row));
  const last = items.at(-1);
  const more = items.length === limit;
  send(res, 200, {
    items,
    page: {
      limit,
      returned: items.length,
      total: count.rows[0].total,
      next_after_created_at: more ? last.created_at : null,
      next_after_sort_sequence: more ? last.sort_sequence : null,
      next_after_id: more ? last.id : null,
    },
  });
}

async function postMessages(req, res) {
  const payload = await readJson(req);
  const items = payload.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) {
    send(res, 400, { error: "invalid items" });
    return;
  }
  for (const item of items) {
    if (
      typeof item.id !== "string" || !item.id ||
      typeof item.conversation_id !== "string" || !item.conversation_id ||
      typeof item.sender !== "string" || !item.sender ||
      typeof item.body !== "string" || !item.body.trim() ||
      !Number.isInteger(item.created_at) ||
      !Number.isInteger(item.sort_sequence)
    ) {
      send(res, 400, { error: "invalid item" });
      return;
    }
    if (item.sender_display_name != null && typeof item.sender_display_name !== "string") {
      send(res, 400, { error: "invalid item" });
      return;
    }
  }

  const existing = await pool.query(
    `SELECT id, body FROM messages WHERE id = ANY($1::text[])`,
    [items.map((item) => item.id)],
  );
  const byId = new Map(existing.rows.map((row) => [row.id, row.body]));
  const toEmbed = [];
  const embedAt = new Map();
  for (const item of items) {
    if (byId.get(item.id) === item.body) continue;
    if (!embedAt.has(item.body)) {
      embedAt.set(item.body, toEmbed.length);
      toEmbed.push(item.body);
    }
  }

  let vectors = [];
  if (toEmbed.length > 0) {
    try {
      vectors = await embed(toEmbed);
    } catch (error) {
      logEmbed(error);
      send(res, 502, { error: "embed failed" });
      return;
    }
  }

  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  try {
    await client.query("BEGIN");
    for (const item of items) {
      const previous = byId.get(item.id);
      const name = item.sender_display_name || null;
      if (previous === undefined) {
        const vector = vectors[embedAt.get(item.body)];
        await client.query(
          `INSERT INTO messages
             (id, conversation_id, created_at, sender, sender_display_name, sort_sequence, body, embedding)
           VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8::vector)`,
          [item.id, item.conversation_id, item.created_at, item.sender, name, item.sort_sequence, item.body, vectorLiteral(vector)],
        );
        inserted += 1;
      } else if (previous === item.body) {
        await client.query(
          `UPDATE messages
             SET sender = $2, sender_display_name = $3, created_at = to_timestamp($4),
                 conversation_id = $5, sort_sequence = $6
           WHERE id = $1`,
          [item.id, item.sender, name, item.created_at, item.conversation_id, item.sort_sequence],
        );
        unchanged += 1;
      } else {
        const vector = vectors[embedAt.get(item.body)];
        await client.query(
          `UPDATE messages
             SET conversation_id = $2, created_at = to_timestamp($3), sender = $4,
                 sender_display_name = $5, sort_sequence = $6, body = $7, embedding = $8::vector
           WHERE id = $1`,
          [item.id, item.conversation_id, item.created_at, item.sender, name, item.sort_sequence, item.body, vectorLiteral(vector)],
        );
        updated += 1;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  send(res, 200, { inserted, updated, unchanged });
}

async function context(id, url, res) {
  const before = parseLimit(url.searchParams.get("before") ?? undefined, 10, 50);
  const after = parseLimit(url.searchParams.get("after") ?? undefined, 10, 50);
  if (before === null || after === null) {
    send(res, 400, { error: "invalid query" });
    return;
  }
  const anchorResult = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM messages WHERE id = $1`,
    [id],
  );
  if (anchorResult.rowCount === 0) {
    send(res, 404, { error: "not found" });
    return;
  }
  const anchor = anchorResult.rows[0];
  const older = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM messages
     WHERE conversation_id = $1
       AND (sort_sequence, created_at, id) < ($2, to_timestamp($3), $4)
     ORDER BY sort_sequence DESC, created_at DESC, id DESC
     LIMIT $5`,
    [anchor.conversation_id, Number(anchor.sort_sequence), Number(anchor.created_at_unix), anchor.id, before],
  );
  const newer = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM messages
     WHERE conversation_id = $1
       AND (sort_sequence, created_at, id) > ($2, to_timestamp($3), $4)
     ORDER BY sort_sequence ASC, created_at ASC, id ASC
     LIMIT $5`,
    [anchor.conversation_id, Number(anchor.sort_sequence), Number(anchor.created_at_unix), anchor.id, after],
  );
  send(res, 200, {
    anchor: rowToJson(anchor),
    before: older.rows.map((row) => rowToJson(row)).reverse(),
    after: newer.rows.map((row) => rowToJson(row)),
  });
}

async function deleteMessages(url, res) {
  const conversationId = url.searchParams.get("conversation_id");
  if (!conversationId) {
    send(res, 400, { error: "missing conversation_id" });
    return;
  }
  const result = await pool.query("DELETE FROM messages WHERE conversation_id = $1", [conversationId]);
  send(res, 200, { deleted: result.rowCount });
}

async function deleteMessage(id, res) {
  const result = await pool.query("DELETE FROM messages WHERE id = $1", [id]);
  if (result.rowCount === 0) {
    send(res, 404, { error: "not found" });
    return;
  }
  send(res, 200, { deleted: 1 });
}

async function search(req, res) {
  const payload = await readJson(req);
  if (typeof payload.query !== "string" || !payload.query.trim()) {
    send(res, 400, { error: "invalid query" });
    return;
  }
  const limit = payload.limit === undefined ? 20 : payload.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    send(res, 400, { error: "invalid query" });
    return;
  }
  for (const name of ["since", "until"]) {
    if (payload[name] !== undefined && !Number.isInteger(payload[name])) {
      send(res, 400, { error: "invalid query" });
      return;
    }
  }
  let vector;
  try {
    vector = (await embed([payload.query]))[0];
  } catch (error) {
    logEmbed(error);
    send(res, 502, { error: "embed failed" });
    return;
  }
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS}, distance
     FROM search_messages($1::vector, $2, to_timestamp($3), to_timestamp($4), $5)`,
    [
      vectorLiteral(vector),
      payload.conversation_id || null,
      payload.since ?? null,
      payload.until ?? null,
      limit,
    ],
  );
  send(res, 200, {
    items: result.rows.map((row) => rowToJson(row, row.distance)),
  });
}

const server = createServer(async (req, res) => {
  let pathname = "";
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    pathname = url.pathname;
    if (req.method === "GET" && url.pathname === "/health") {
      await pool.query("SELECT 1");
      send(res, 200, { ok: true });
      return;
    }
    if (!keyOk(req.headers.authorization)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      await listMessages(url, res);
      return;
    }
    const contextMatch = /^\/messages\/([^/]+)\/context$/.exec(url.pathname);
    if (req.method === "GET" && contextMatch) {
      await context(decodeURIComponent(contextMatch[1]), url, res);
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/messages") {
      await deleteMessages(url, res);
      return;
    }
    const messageMatch = /^\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && messageMatch) {
      await deleteMessage(decodeURIComponent(messageMatch[1]), res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      await postMessages(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/search") {
      await search(req, res);
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) {
      console.error(`${req.method} ${pathname} failed: ${error.code || ""} ${error.message || "request failed"}`.trim());
    }
    send(res, status, { error: status === 413 ? "body too large" : status === 400 ? error.message : "request failed" });
  }
});

server.listen(8080, "0.0.0.0");
