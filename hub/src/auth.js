import { createHmac, timingSafeEqual } from 'node:crypto';

// 每个 agent 一个共享密钥，从环境变量读取。
// AGENT_SECRETS 格式: "zhulong:密钥1,lobster2:密钥2"
const secrets = new Map();
for (const pair of (process.env.AGENT_SECRETS || '').split(',')) {
  const [agent, secret] = pair.split(':');
  if (agent && secret) secrets.set(agent.trim(), secret.trim());
}

export function getSecret(agent) {
  return secrets.get(agent);
}

export function sign(body, secret) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verify(agent, rawBody, signature) {
  const secret = secrets.get(agent);
  if (!secret || !signature) return false;
  const expected = sign(rawBody, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function knownAgents() {
  return [...secrets.keys()];
}
