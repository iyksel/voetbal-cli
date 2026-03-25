// Script om handmatig wedstrijden toe te voegen aan de database
// Voer uit met: node insert_matches.js

const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

function nowMs() { return Date.now(); }

const matches = [
  {
    date: '2026-01-25',
    starts_at: '2026-01-25T21:00:00',
    team_wit: ['Selo','Turan','Gokdeniz','Emirhan','Ramazan'],
    team_zwart: ['Erhan','Izzet','Salim','Ilkay','Arjan'],
    uitslag: 'wit',
    score: '1-0',
  },
  {
    date: '2026-01-29',
    starts_at: '2026-01-29T21:00:00',
    team_wit: ['Erhan','Izzet','Salim','Ilkay','Arjan'],
    team_zwart: ['Selo','Turan','Gokdeniz','Emirhan','Ramazan'],
    uitslag: 'zwart',
    score: '0-1',
  },
  {
    date: '2026-02-03',
    starts_at: '2026-02-03T21:00:00',
    team_wit: ['Ilkay','Izzet','Erhan','Salim','Roberto'],
    team_zwart: ['Seymen','Gokdeniz','Fahri','Emre-b','Mikail'],
    uitslag: 'zwart',
    score: '0-4',
  },
  {
    date: '2026-02-10',
    starts_at: '2026-02-10T21:00:00',
    team_wit: ['Gokdeniz','Samet','Erhan','Salim','Selo'],
    team_zwart: ['Seymen','Ramazan','Turan','Fahri','Ilkay'],
    uitslag: 'zwart',
    score: '0-2',
  },
  {
  date: '2026-02-12',                    // Datum van de wedstrijd (YYYY-MM-DD)
  starts_at: '2026-02-12T21:00:00',      // Starttijd (ISO formaat)
  team_wit: ['Izzet', 'Salim', 'Isaac', 'Seymen', 'Mehmet-s'],
  team_zwart: ['Ilkay', 'Gokdeniz', 'Ramazan', 'Ahmet', 'Fahri'],
  uitslag: 'zwart',                        // 'wit' of 'zwart' (wie heeft gewonnen?)
  score: '0-1',                          // Score (bijv. '1-0', '0-2', '3-2')
}
];

function ensurePlayer(name) {
  // Consistente normalisatie (zelfde logica als in app.js)
  const norm = String(name || '').trim().toLowerCase().replace(/^['"\s]+|['"\s]+$/g, '').replace(/\s+/g, ' ');
  const display = norm.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let p = db.prepare('SELECT * FROM players WHERE name_normalized = ?').get(norm);
  if (!p) {
    db.prepare('INSERT INTO players (display_name, name_normalized, is_guest, wins, games, created_at) VALUES (?, ?, 1, 0, 0, ?)')
      .run(display, norm, nowMs());
    p = db.prepare('SELECT * FROM players WHERE name_normalized = ?').get(norm);
  } else {
    if (p.display_name !== display) db.prepare('UPDATE players SET display_name = ? WHERE id = ?').run(display, p.id);
  }
  return p.id;
}

for (const m of matches) {
  // Voeg match toe
  const info = db.prepare('INSERT INTO matches (match_date, starts_at, status, player_limit, created_at, roster_hash, teams_generated_at) VALUES (?, ?, ? , 10, ?, NULL, ?)')
    .run(m.date, m.starts_at, 'closed', nowMs(), nowMs());
  const matchId = info.lastInsertRowid;

  // Voeg spelers toe
  for (const naam of m.team_wit) {
    const pid = ensurePlayer(naam);
      db.prepare('INSERT INTO match_players (match_id, player_id, signup_state, joined_at, team) VALUES (?, ?, ?, ?, ?)')
        .run(matchId, pid, 'ja', nowMs(), 'wit');
  }
  for (const naam of m.team_zwart) {
    const pid = ensurePlayer(naam);
      db.prepare('INSERT INTO match_players (match_id, player_id, signup_state, joined_at, team) VALUES (?, ?, ?, ?, ?)')
        .run(matchId, pid, 'ja', nowMs(), 'zwart');
  }

  // Voeg resultaat toe
  db.prepare('INSERT INTO match_results (match_id, winner_team, score, decided_at, decided_by_player_id) VALUES (?, ?, ?, ?, NULL)')
    .run(matchId, m.uitslag, m.score, nowMs());

  // Update wins en games voor alle spelers
  const allPlayers = [...m.team_wit, ...m.team_zwart];
  const winners = m.uitslag === 'wit' ? m.team_wit : m.team_zwart;
  
  for (const naam of allPlayers) {
    const pid = ensurePlayer(naam);
    db.prepare('UPDATE players SET games = games + 1 WHERE id = ?').run(pid);
  }
  
  for (const naam of winners) {
    const pid = ensurePlayer(naam);
    db.prepare('UPDATE players SET wins = wins + 1 WHERE id = ?').run(pid);
  }
}

console.log('Wedstrijden succesvol toegevoegd!');
