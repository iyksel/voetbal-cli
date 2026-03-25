// Migratie script: voegt nieuwe kolommen toe voor wachtlijst en MVP features
const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

function columnExists(table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some(col => col.name === column);
}

function tableExists(table) {
  const result = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  return !!result;
}

console.log('=== Database Migratie ===\n');

// 1. match_players: is_waitlist en waitlist_position
if (!columnExists('match_players', 'is_waitlist')) {
  db.exec(`ALTER TABLE match_players ADD COLUMN is_waitlist INTEGER NOT NULL DEFAULT 0`);
  console.log('+ match_players.is_waitlist toegevoegd');
} else {
  console.log('- match_players.is_waitlist bestaat al');
}

if (!columnExists('match_players', 'waitlist_position')) {
  db.exec(`ALTER TABLE match_players ADD COLUMN waitlist_position INTEGER`);
  console.log('+ match_players.waitlist_position toegevoegd');
} else {
  console.log('- match_players.waitlist_position bestaat al');
}

// 2. players: mvp_count
if (!columnExists('players', 'mvp_count')) {
  db.exec(`ALTER TABLE players ADD COLUMN mvp_count INTEGER NOT NULL DEFAULT 0`);
  console.log('+ players.mvp_count toegevoegd');
} else {
  console.log('- players.mvp_count bestaat al');
}

// 3. players: position (voor het geval die nog niet bestaat)
if (!columnExists('players', 'position')) {
  db.exec(`ALTER TABLE players ADD COLUMN position TEXT CHECK(position IN ('keeper', 'verdediger', 'middenveld', 'aanvaller'))`);
  console.log('+ players.position toegevoegd');
} else {
  console.log('- players.position bestaat al');
}

// 4. mvp_votes tabel
if (!tableExists('mvp_votes')) {
  db.exec(`
    CREATE TABLE mvp_votes (
      match_id INTEGER NOT NULL,
      voter_player_id INTEGER NOT NULL,
      voted_player_id INTEGER NOT NULL,
      voted_at INTEGER NOT NULL,
      PRIMARY KEY (match_id, voter_player_id),
      FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
      FOREIGN KEY(voter_player_id) REFERENCES players(id) ON DELETE CASCADE,
      FOREIGN KEY(voted_player_id) REFERENCES players(id) ON DELETE CASCADE
    )
  `);
  console.log('+ mvp_votes tabel aangemaakt');
} else {
  console.log('- mvp_votes tabel bestaat al');
}

console.log('\n=== Migratie voltooid! ===');
db.close();
