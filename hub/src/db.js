import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/shrimp-link.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  seq INTEGER UNIQUE,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  type TEXT NOT NULL,
  in_reply_to TEXT,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seq_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO seq_counter (id, value) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  sender TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading',
  chunk_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  received_chunks TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acks (
  agent TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_to_seq ON messages("to", seq);
CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
`);

export function nextSeq() {
  const row = db.prepare('UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value').get();
  return row.value;
}
