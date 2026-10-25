-- Family Hub — esquema D1 (MVP)

CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','guest')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  icon            TEXT,
  status_summary  TEXT,              -- "estado actual", mantenido por Claude
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  notes         TEXT,
  topic_id      INTEGER REFERENCES topics(id),
  assignee      TEXT NOT NULL DEFAULT 'both',   -- email o 'both'
  due_date      TEXT,                           -- YYYY-MM-DD
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  recurrence    TEXT,                           -- p.ej. 'yearly', 'monthly' (fase 2)
  source        TEXT NOT NULL DEFAULT 'web',    -- web | email
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  completed_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_date);

-- Todo lo que entra en bruto, para auditoría y reprocesado
CREATE TABLE IF NOT EXISTS inbox_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,       -- email | web
  sender       TEXT,
  subject      TEXT,
  body         TEXT,
  ai_result    TEXT,                -- JSON devuelto por Claude
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Temas iniciales (editables)
INSERT OR IGNORE INTO topics (slug, name, icon) VALUES
  ('salud',     'Salud y seguro médico', '🩺'),
  ('pension',   'Pensión y jubilación',  '🏦'),
  ('finanzas',  'Finanzas e impuestos',  '💶'),
  ('casa',      'Casa',                  '🏠'),
  ('coche',     'Coche',                 '🚗'),
  ('ninos',     'Niños y colegio',       '🧸'),
  ('papeles',   'Papeles y administración', '📄'),
  ('viajes',    'Viajes',                '✈️'),
  ('compra',    'Lista de la compra',    '🛒'),
  ('otros',     'Otros',                 '📌');
