-- Color Bingo persistent schema (demo only; no real-money processing)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'Player',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Bingo Room',
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','playing','finished','cancelled')),
  capacity INTEGER NOT NULL DEFAULT 50 CHECK (capacity BETWEEN 2 AND 500),
  created_by BIGINT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  round_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','playing','finished','cancelled')),
  rules_version TEXT NOT NULL DEFAULT 'bingo-5x5-v1',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, round_number)
);

CREATE TABLE IF NOT EXISTS round_players (
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES app_users(id),
  card JSONB NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, user_id)
);

CREATE TABLE IF NOT EXISTS called_numbers (
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  draw_index INTEGER NOT NULL CHECK (draw_index BETWEEN 1 AND 75),
  number INTEGER NOT NULL CHECK (number BETWEEN 1 AND 75),
  called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, draw_index),
  UNIQUE (round_id, number)
);

CREATE TABLE IF NOT EXISTS bingo_claims (
  id BIGSERIAL PRIMARY KEY,
  round_id UUID NOT NULL REFERENCES rounds(id),
  user_id BIGINT NOT NULL REFERENCES app_users(id),
  accepted BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);

CREATE TABLE IF NOT EXISTS round_winners (
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES app_users(id),
  win_order INTEGER NOT NULL,
  simulated_share NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (simulated_share >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, user_id),
  UNIQUE (round_id, win_order)
);

-- Append-only audit log for game events, not a monetary ledger.
CREATE TABLE IF NOT EXISTS game_audit_events (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT REFERENCES rooms(id),
  round_id UUID REFERENCES rounds(id),
  actor_user_id BIGINT REFERENCES app_users(id),
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rounds_room_status ON rounds(room_id, status);
CREATE INDEX IF NOT EXISTS idx_round_players_user ON round_players(user_id);
CREATE INDEX IF NOT EXISTS idx_called_numbers_round ON called_numbers(round_id, draw_index);
CREATE INDEX IF NOT EXISTS idx_audit_round_time ON game_audit_events(round_id, created_at);
