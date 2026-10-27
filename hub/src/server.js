import Fastify from 'fastify';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import { mkdirSync, createWriteStream, existsSync, statSync, createReadStream, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

import { db, nextSeq, touchActivity, getActivity } from './db.js';
import { verify, knownAgents, getSecret } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3250);
const FILES_DIR = process.env.FILES_DIR || join(__dirname, '../data/files');
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
mkdirSync(FILES_DIR, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });
await app.register(cors, { origin: true });

// raw body 捕获，用于 HMAC 校验（仅对 /v1/send, /v1/ack 等 JSON POST 生效）
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = body;
  try {
    done(null, body.length ? JSON.parse(body) : {});
  } catch (err) {
    done(err);
  }
});

function requireAuth(req, reply) {
  const agent = req.headers['x-agent-id'];
  const sig = req.headers['x-signature'];
  if (!agent || !verify(agent, req.rawBody ?? '', sig)) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return agent;
}

// ---- SSE 订阅管理 ----
const subscribers = new Map(); // agent -> Set<reply.raw>

function broadcastTo(agent, message) {
  const set = subscribers.get(agent);
  if (!set) return;
  const data = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch { /* ignore */ }
  }
}

// ---- /v1/send ----
app.post('/v1/send', async (req, reply) => {
  const from = requireAuth(req, reply);
  if (!from) return;

  const { to, type, payload, in_reply_to } = req.body || {};
  if (!to || !type || payload === undefined) {
    return reply.code(400).send({ error: 'missing to/type/payload' });
  }

  const id = ulid();
  const seq = nextSeq();
  const ts = Date.now();
  db.prepare(`INSERT INTO messages (id, seq, "from", "to", type, in_reply_to, payload, ts, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, seq, from, to, type, in_reply_to || null, JSON.stringify(payload), ts, ts);

  touchActivity(from, 'send');

  const msg = { id, seq, from, to, type, in_reply_to: in_reply_to || null, payload, ts };
  broadcastTo(to, msg);
  broadcastTo('*watchers*', msg); // Web UI 围观

  return { ok: true, id, seq };
});

// ---- /v1/poll ----
app.get('/v1/poll', async (req, reply) => {
  const agent = requireAuthQuery(req, reply);
  if (!agent) return;

  const afterSeq = Number(req.query.after_seq || 0);
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const rows = db.prepare(
    `SELECT * FROM messages WHERE "to" = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
  ).all(agent, afterSeq, limit);

  touchActivity(agent, 'poll');

  return {
    messages: rows.map(rowToMsg),
    has_more: rows.length === limit,
  };
});

// GET 请求用查询参数做签名校验（agent + ts + 原始 query string）
function requireAuthQuery(req, reply) {
  const agent = req.query.agent;
  const sig = req.headers['x-signature'];
  const base = req.raw.url; // 完整路径+query作为签名基
  if (!agent || !verify(agent, base, sig)) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return agent;
}

function rowToMsg(row) {
  return {
    id: row.id,
    seq: row.seq,
    from: row.from,
    to: row.to,
    type: row.type,
    in_reply_to: row.in_reply_to,
    payload: JSON.parse(row.payload),
    ts: row.ts,
  };
}

// ---- /v1/stream (SSE) ----
app.get('/v1/stream', async (req, reply) => {
  const agent = requireAuthQuery(req, reply);
  if (!agent) return;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.write(': connected\n\n');

  touchActivity(agent, 'stream_connect');

  if (!subscribers.has(agent)) subscribers.set(agent, new Set());
  subscribers.get(agent).add(reply.raw);

  const heartbeat = setInterval(() => {
    try { reply.raw.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    subscribers.get(agent)?.delete(reply.raw);
  });
});

// ---- Web UI 围观流（无需鉴权，只读，公开可见两位 agent 的聊天） ----
app.get('/v1/watch', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.write(': connected\n\n');

  if (!subscribers.has('*watchers*')) subscribers.set('*watchers*', new Set());
  subscribers.get('*watchers*').add(reply.raw);

  const heartbeat = setInterval(() => {
    try { reply.raw.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    subscribers.get('*watchers*')?.delete(reply.raw);
  });
});

// 围观页用的在线状态（不鉴权只读，复用 /v1/status 的判定逻辑）
app.get('/v1/watch/presence', async () => {
  const agents = knownAgents();
  const ONLINE_WINDOW_MS = 90 * 1000;
  const now = Date.now();
  const activityRows = getActivity();
  const activityMap = new Map(activityRows.map((r) => [r.agent, r]));

  const presence = agents.map((agent) => {
    const act = activityMap.get(agent);
    const hasLiveStream = subscribers.has(agent) && subscribers.get(agent).size > 0;
    const lastSeenAt = act?.last_seen_at ?? null;
    const online = hasLiveStream || (lastSeenAt !== null && now - lastSeenAt < ONLINE_WINDOW_MS);
    return { agent, online, last_seen_at: lastSeenAt, live_stream: hasLiveStream };
  });

  return { presence };
});

// 围观页历史消息（只看 chat 类型，最近 N 条，不鉴权只读）
app.get('/v1/watch/history', async (req, reply) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const rows = db.prepare(
    `SELECT * FROM messages WHERE type = 'chat' ORDER BY seq DESC LIMIT ?`
  ).all(limit);
  return { messages: rows.map(rowToMsg).reverse() };
});

// ---- /v1/ack ----
app.post('/v1/ack', async (req, reply) => {
  const agent = requireAuth(req, reply);
  if (!agent) return;
  const { last_seq } = req.body || {};
  if (typeof last_seq !== 'number') return reply.code(400).send({ error: 'missing last_seq' });
  db.prepare(`INSERT INTO acks (agent, last_seq, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(agent) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`)
    .run(agent, last_seq, Date.now());
  return { ok: true };
});

// ---- 文件传输 ----
app.post('/v1/file/init', async (req, reply) => {
  const from = requireAuth(req, reply);
  if (!from) return;
  const { name, size, to } = req.body || {};
  if (!name || !size || !to) return reply.code(400).send({ error: 'missing name/size/to' });

  const id = ulid();
  const totalChunks = Math.ceil(size / CHUNK_SIZE);
  const storedPath = join(FILES_DIR, id);
  mkdirSync(storedPath, { recursive: true });

  db.prepare(`INSERT INTO files (id, name, size, sender, stored_path, status, chunk_size, total_chunks, received_chunks, created_at)
              VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, '[]', ?)`)
    .run(id, name, size, from, storedPath, CHUNK_SIZE, totalChunks, Date.now());

  return { ok: true, upload_id: id, chunk_size: CHUNK_SIZE, total_chunks: totalChunks, to };
});

app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => {
  done(null, body);
});

app.put('/v1/file/:id/chunk/:index', async (req, reply) => {
  const from = req.headers['x-agent-id'];
  // 分块签名校验：对 "<id>:<index>:<sha256(body)>" 做 HMAC
  const bodyHash = createHash('sha256').update(req.body).digest('hex');
  const sig = req.headers['x-signature'];
  const base = `${req.params.id}:${req.params.index}:${bodyHash}`;
  if (!from || !verify(from, base, sig)) return reply.code(401).send({ error: 'unauthorized' });

  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return reply.code(404).send({ error: 'upload not found' });
  if (file.status !== 'uploading') return reply.code(409).send({ error: 'upload already finalized' });

  const index = Number(req.params.index);
  const chunkPath = join(file.stored_path, `${index}.part`);
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(chunkPath);
    ws.on('finish', resolve);
    ws.on('error', reject);
    ws.end(req.body);
  });

  const received = new Set(JSON.parse(file.received_chunks));
  received.add(index);
  db.prepare('UPDATE files SET received_chunks = ? WHERE id = ?')
    .run(JSON.stringify([...received]), file.id);

  return { ok: true, received: received.size, total: file.total_chunks, chunk_sha256: bodyHash };
});

app.post('/v1/file/:id/complete', async (req, reply) => {
  const from = requireAuth(req, reply);
  if (!from) return;

  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!file) return reply.code(404).send({ error: 'upload not found' });

  const received = new Set(JSON.parse(file.received_chunks));
  if (received.size !== file.total_chunks) {
    return reply.code(409).send({ error: 'incomplete', received: received.size, total: file.total_chunks });
  }

  const finalPath = join(FILES_DIR, `${file.id}__${file.name}`);
  const ws = createWriteStream(finalPath);
  for (let i = 0; i < file.total_chunks; i++) {
    const chunkPath = join(file.stored_path, `${i}.part`);
    await new Promise((resolve, reject) => {
      const rs = createReadStream(chunkPath);
      rs.pipe(ws, { end: false });
      rs.on('end', resolve);
      rs.on('error', reject);
    });
  }
  ws.end();
  await new Promise((resolve) => ws.on('close', resolve));

  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = createReadStream(finalPath);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  const sha256 = hash.digest('hex');

  const { expected_sha256, to } = req.body || {};
  if (expected_sha256 && expected_sha256 !== sha256) {
    rmSync(finalPath, { force: true });
    db.prepare('UPDATE files SET status = ? WHERE id = ?').run('corrupt', file.id);
    return reply.code(400).send({ error: 'checksum mismatch', expected: expected_sha256, got: sha256 });
  }

  rmSync(file.stored_path, { recursive: true, force: true });
  db.prepare('UPDATE files SET status = ?, sha256 = ?, stored_path = ? WHERE id = ?')
    .run('ready', sha256, finalPath, file.id);

  // 广播 file 类型消息通知接收方
  if (to) {
    const id = ulid();
    const seq = nextSeq();
    const ts = Date.now();
    const payload = { file_id: file.id, name: file.name, size: file.size, sha256 };
    db.prepare(`INSERT INTO messages (id, seq, "from", "to", type, in_reply_to, payload, ts, created_at)
                VALUES (?, ?, ?, ?, 'file', NULL, ?, ?, ?)`)
      .run(id, seq, from, to, JSON.stringify(payload), ts, ts);
    broadcastTo(to, { id, seq, from, to, type: 'file', payload, ts });
  }

  return { ok: true, file_id: file.id, sha256, size: file.size };
});

app.get('/v1/file/:id', async (req, reply) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND status = ?').get(req.params.id, 'ready');
  if (!file || !existsSync(file.stored_path)) return reply.code(404).send({ error: 'not found' });

  const stat = statSync(file.stored_path);
  const range = req.headers.range;
  reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  reply.header('Accept-Ranges', 'bytes');

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    reply.header('Content-Length', end - start + 1);
    return reply.send(createReadStream(file.stored_path, { start, end }));
  }

  reply.header('Content-Length', stat.size);
  return reply.send(createReadStream(file.stored_path));
});

// ---- /v1/status ----
app.get('/v1/status', async () => {
  const agents = knownAgents();
  const lastMsg = db.prepare('SELECT MAX(seq) as seq FROM messages').get();
  const acks = db.prepare('SELECT * FROM acks').all();
  let diskUsage = 0;
  try {
    for (const f of readdirSync(FILES_DIR)) {
      try { diskUsage += statSync(join(FILES_DIR, f)).size; } catch { /* dir, skip */ }
    }
  } catch { /* ignore */ }

  // 在线判定：最近活跃（send/poll/stream连接任一动作）在 ONLINE_WINDOW_MS 内视为在线；
  // 有常驻 SSE 连接的直接算在线。
  const ONLINE_WINDOW_MS = 90 * 1000; // 90秒内有动作就算在线
  const now = Date.now();
  const activityRows = getActivity();
  const activityMap = new Map(activityRows.map((r) => [r.agent, r]));

  const presence = agents.map((agent) => {
    const act = activityMap.get(agent);
    const hasLiveStream = subscribers.has(agent) && subscribers.get(agent).size > 0;
    const lastSeenAt = act?.last_seen_at ?? null;
    const online = hasLiveStream || (lastSeenAt !== null && now - lastSeenAt < ONLINE_WINDOW_MS);
    return {
      agent,
      online,
      last_seen_at: lastSeenAt,
      last_action: act?.last_action ?? null,
      live_stream: hasLiveStream,
    };
  });

  return {
    ok: true,
    agents,
    last_seq: lastMsg.seq || 0,
    acks,
    presence,
    online: presence.filter((p) => p.online).map((p) => p.agent),
    files_dir_bytes: diskUsage,
  };
});

// ---- Web UI (极简围观页) ----
await app.register(fstatic, {
  root: join(__dirname, '../public'),
  prefix: '/',
});

// ---- 入驻指南网页（Markdown 渲染，内网工具，明文含密钥，仅供局域网访问） ----
const ONBOARDING_PATH = process.env.ONBOARDING_PATH || join(__dirname, '../../ONBOARDING.md');
app.get('/onboarding', async (req, reply) => {
  let md;
  try {
    md = readFileSync(ONBOARDING_PATH, 'utf-8');
  } catch {
    reply.code(404);
    return '入驻指南文件未找到';
  }
  const html = marked.parse(md);
  reply.type('text/html; charset=utf-8');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>虾联入驻指南 · 龙虾二号</title>
<style>
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    max-width: 820px;
    margin: 0 auto;
    padding: 32px 20px 80px;
    background: #0d1b1e;
    color: #eafff9;
    line-height: 1.7;
  }
  h1, h2, h3 { color: #4ad6c8; }
  h1 { border-bottom: 2px solid #1f4348; padding-bottom: 10px; }
  h2 { margin-top: 36px; }
  code {
    background: #132a2e;
    color: #ff8f5a;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.92em;
  }
  pre {
    background: #132a2e;
    border: 1px solid #1f4348;
    border-radius: 8px;
    padding: 14px 16px;
    overflow-x: auto;
  }
  pre code { background: none; color: #eafff9; padding: 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 16px 0;
  }
  th, td {
    border: 1px solid #1f4348;
    padding: 8px 12px;
    text-align: left;
    font-size: 0.92em;
  }
  th { background: #132a2e; color: #4ad6c8; }
  a { color: #ff8f5a; }
  blockquote {
    border-left: 3px solid #ff6b4a;
    margin: 0;
    padding: 6px 16px;
    background: #132a2e;
    border-radius: 0 8px 8px 0;
    color: #7fa8a0;
  }
</style>
</head>
<body>
${html}
</body>
</html>`;
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
