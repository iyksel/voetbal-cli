// Script om database schema te initialiseren
const Database = require('better-sqlite3');
const db = new Database('voetbal.db');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  name_normalized TEXT NOT NULL UNIQUE,
  is_guest INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  position TEXT CHECK(position IN ('keeper', 'verdediger', 'middenveld', 'aanvaller')),
  mvp_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_date TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  player_limit INTEGER NOT NULL DEFAULT 10,
  created_at INTEGER NOT NULL,
  roster_hash TEXT,
  teams_generated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date);

CREATE TABLE IF NOT EXISTS match_players (
  match_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  signup_state TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  team TEXT,
  is_waitlist INTEGER NOT NULL DEFAULT 0,
  waitlist_position INTEGER,
  PRIMARY KEY (match_id, player_id),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS match_results (
  match_id INTEGER PRIMARY KEY,
  winner_team TEXT NOT NULL,
  score TEXT,
  decided_at INTEGER NOT NULL,
  decided_by_player_id INTEGER,
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(decided_by_player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS scheduled_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  run_at TEXT NOT NULL,
  executed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_actions_due
ON scheduled_actions(executed_at, cancelled_at, run_at);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  match_id INTEGER,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mvp_votes (
  match_id INTEGER NOT NULL,
  voter_player_id INTEGER NOT NULL,
  voted_player_id INTEGER NOT NULL,
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, voter_player_id),
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(voter_player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY(voted_player_id) REFERENCES players(id) ON DELETE CASCADE
);
`);

console.log('Database schema aangemaakt!');
db.close();
