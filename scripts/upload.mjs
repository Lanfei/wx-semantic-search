import { spawn } from "node:child_process";

const WEEK = 7 * 24 * 60 * 60;
const MAX_BUFFER = 16 * 1024 * 1024;
const STALE_ATTEMPTS = 3;

const apiUrl = process.env.WX_SEMANTIC_SEARCH_URL;
const apiKey = process.env.WX_SEMANTIC_SEARCH_API_KEY;
const conversation = argument("--conversation");
const batch = batchSize(argument("--batch"));

if (!apiUrl) fail("missing WX_SEMANTIC_SEARCH_URL");
if (!apiKey) fail("missing WX_SEMANTIC_SEARCH_API_KEY");
if (!conversation) fail("missing --conversation");

const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

const cursor = await latestCursor();
let start;
if (cursor === null) {
  start = await oldestCreatedAt();
  if (start === null) {
    console.log("inserted=0 updated=0 unchanged=0");
    process.exit(0);
  }
} else {
  start = Math.max(0, cursor.created_at - (WEEK - 1));
}

const now = Math.floor(Date.now() / 1000);
let inserted = 0;
let updated = 0;
let unchanged = 0;
for (let since = start; since <= now; since += WEEK) {
  const until = Math.min(since + WEEK - 1, now);
  const messages = await listWindow(since, until, cursor);
  messages.sort((a, b) => a.sort_sequence - b.sort_sequence || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let index = 0; index < messages.length; index += batch) {
    const slice = messages.slice(index, index + batch);
    const counts = await postBatch(slice);
    inserted += counts.inserted;
    updated += counts.updated;
    unchanged += counts.unchanged;
    const through = utcTime(slice[slice.length - 1].created_at);
    console.error(`upload batch inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged} total_inserted=${inserted} total_updated=${updated} total_unchanged=${unchanged} through=${through}`);
  }
}
console.log(`inserted=${inserted} updated=${updated} unchanged=${unchanged}`);

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function batchSize(value) {
  if (!value) return 500;
  if (!/^[1-9]\d*$/.test(value)) fail("invalid --batch");
  const size = Number(value);
  if (size > 500) fail("invalid --batch");
  return size;
}

function utcTime(unix) {
  return new Date(unix * 1000).toISOString().slice(0, 19) + "Z";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function latestCursor() {
  const url = new URL("/messages", apiUrl);
  url.searchParams.set("conversation_id", conversation);
  url.searchParams.set("order", "desc");
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { headers });
  if (!response.ok) await failResponse(response, "lookup latest failed");
  const payload = await response.json();
  const item = payload.items?.[0];
  if (!item) return null;
  if (!Number.isInteger(item.sort_sequence) || !Number.isInteger(item.created_at) || typeof item.id !== "string") {
    fail("lookup latest failed");
  }
  return item;
}

async function oldestCreatedAt() {
  const newest = await listPage("", null, null, 1);
  if (newest.items.length === 0) return null;
  let lo = 0;
  let hi = newest.items[0].createdAtUnix;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const page = await listPage("", null, mid, 1);
    if (page.items.length > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function listWindow(since, until, cursor) {
  const messages = [];
  let pageCursor = "";
  for (;;) {
    const page = await listPage(pageCursor, since, until);
    for (const message of page.items) {
      const item = toItem(message);
      if (item && afterCursor(item, cursor)) messages.push(item);
    }
    pageCursor = page.nextCursor;
    if (!pageCursor) return messages;
  }
}

function afterCursor(item, cursor) {
  if (!cursor) return true;
  if (item.sort_sequence !== cursor.sort_sequence) return item.sort_sequence > cursor.sort_sequence;
  if (item.created_at !== cursor.created_at) return item.created_at > cursor.created_at;
  return item.id > cursor.id;
}

function listPage(cursor, since, until, limit = 500) {
  const args = [
    "messages", "list",
    "--conversation", conversation,
    "--limit", String(limit),
    "--json",
  ];
  if (since !== null) args.push("--since", String(since));
  if (until !== null) args.push("--until", String(until));
  if (cursor) args.push("--cursor", cursor);
  return new Promise((resolve) => {
    const child = spawn("greenbubbles", args, { stdio: ["ignore", "pipe", "ignore"] });
    const stdout = [];
    let received = 0;
    let tooLarge = false;
    child.stdout.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BUFFER) {
        tooLarge = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.on("error", () => fail("greenbubbles failed"));
    child.on("close", (status) => {
      if (tooLarge) fail("greenbubbles page too large");
      if (status !== 0) fail("greenbubbles failed");
      const payload = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      if (payload.ok === false) fail("greenbubbles returned ok=false");
      if (payload.consistency?.coverageComplete !== true) fail("greenbubbles coverage incomplete");
      resolve({
        items: payload.items || [],
        nextCursor: payload.page?.nextCursor || "",
      });
    });
  });
}

function toItem(message) {
  const sender = messageSender(message);
  if (!sender) fail("missing sender");
  if (!Number.isInteger(message.sortSequence)) fail("missing sortSequence");
  const body = messageBody(message);
  if (!body) return null;
  return {
    id: message.id,
    conversation_id: conversation,
    created_at: message.createdAtUnix,
    sender,
    sender_display_name: message.senderDisplayName || null,
    sort_sequence: message.sortSequence,
    body,
  };
}

function messageSender(message) {
  if (typeof message.sender === "string" && message.sender) return message.sender;
  if (message.messageTypeLabel === "system" && typeof message.content?.System === "string") return "system";
  return "";
}

function messageBody(message) {
  const content = message.content;
  if (typeof content === "string") return normalize(content);
  if (!content || typeof content !== "object") return null;
  if (typeof content.Text === "string") return normalize(content.Text);
  if (typeof content.System === "string") return normalize(content.System);
  const reply = content.Quote?.reply_text;
  if (typeof reply === "string") return normalize(reply);
  return null;
}

function normalize(text) {
  const body = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return body || null;
}

async function postBatch(items) {
  const body = JSON.stringify({ items });
  for (let attempt = 1; attempt <= STALE_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(new URL("/messages", apiUrl), {
        method: "POST",
        headers,
        body,
      });
      if (!response.ok) await failResponse(response, "upload failed");
      return response.json();
    } catch (error) {
      if (!staleConnection(error) || attempt === STALE_ATTEMPTS) throw error;
      const cause = error.cause;
      const code = cause?.code || error.code || "";
      const detail = cause?.message || error.message;
      console.error(`upload retry attempt=${attempt + 1} limit=${STALE_ATTEMPTS} code=${code} detail=${JSON.stringify(detail)}`);
    }
  }
}

function staleConnection(error) {
  const code = error?.cause?.code || error?.code;
  return code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET";
}

async function failResponse(response, label) {
  let message = "";
  try {
    const payload = await response.json();
    if (typeof payload?.error === "string") message = payload.error;
  } catch {
    message = "";
  }
  fail(message ? `${label}: ${response.status} ${message}` : `${label}: ${response.status}`);
}
