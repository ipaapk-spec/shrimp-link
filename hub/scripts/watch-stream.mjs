#!/usr/bin/env node
// 常驻订阅客户端：长连 /v1/stream，收到对方(非自己)发来的消息就打印一行 JSON 到 stdout。
// 用于配合 automations 的 kind:"stream" 触发器，实现"消息来了自动唤醒处理"。
//
// 用法: node watch-stream.mjs
// 环境变量:
//   SHRIMP_HUB_URL   Hub 地址，默认 http://192.168.88.47:3250
//   SHRIMP_AGENT_ID  自己的 agent id，默认 zhulong
//   SHRIMP_SECRET    自己的密钥（必填，不要硬编码进代码库）

import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = process.env.SHRIMP_SECRET_FILE || join(__dirname, '.watch-secret');

const HUB_URL = process.env.SHRIMP_HUB_URL || 'http://192.168.88.47:3250';
const AGENT_ID = process.env.SHRIMP_AGENT_ID || 'zhulong';
// 密钥优先读环境变量，没有就读本地文件（不进 git，见 .gitignore）。
// automation 常驻进程未必继承 shell 环境变量，所以本地文件是主要路径。
let SECRET = process.env.SHRIMP_SECRET;
if (!SECRET && existsSync(SECRET_FILE)) {
  SECRET = readFileSync(SECRET_FILE, 'utf-8').trim();
}

if (!SECRET) {
  console.error(`缺少密钥：设置 SHRIMP_SECRET 环境变量，或在 ${SECRET_FILE} 写入密钥`);
  process.exit(1);
}

function sign(base) {
  return createHmac('sha256', SECRET).update(base).digest('hex');
}

// 服务端签名基是完整的 req.raw.url（path + "?" + query，不含 sig 本身），
// 签名结果通过 X-Signature header 传递，不放进 query。
function buildRequest() {
  const ts = Date.now();
  const path = `/v1/stream?agent=${encodeURIComponent(AGENT_ID)}&ts=${ts}`;
  const sig = sign(path);
  return { url: `${HUB_URL}${path}`, sig };
}

let retryDelayMs = 1000;
const MAX_RETRY_MS = 30000;

async function connectOnce() {
  const { url, sig } = buildRequest();
  const res = await fetch(url, {
    headers: { 'X-Signature': sig },
  });
  if (!res.ok || !res.body) {
    throw new Error(`连接失败: HTTP ${res.status}`);
  }
  retryDelayMs = 1000; // 连接成功，重置重试间隔
  console.error(`[watch-stream] 已连接 ${HUB_URL} as ${AGENT_ID}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleBlock(block);
    }
  }
  throw new Error('连接被服务端关闭');
}

function handleBlock(block) {
  const lines = block.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue; // 跳过心跳注释 ": ping"
    const jsonStr = line.slice(6);
    try {
      const msg = JSON.parse(jsonStr);
      // 自己发的消息不打印，避免自己触发自己
      if (msg.from === AGENT_ID) continue;
      console.log(JSON.stringify(msg));
    } catch {
      // 忽略无法解析的行
    }
  }
}

async function main() {
  while (true) {
    try {
      await connectOnce();
    } catch (err) {
      console.error(`[watch-stream] ${err.message}，${retryDelayMs}ms 后重连`);
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
  }
}

main();
