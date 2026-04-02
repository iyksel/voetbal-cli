const Database = require('better-sqlite3');

// Open database
const db = new Database('voetbal.db');
db.pragma('foreign_keys = ON');

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function getPlayerId(name) {
  const norm = normalizeName(name);
  const player = db.prepare(`SELECT id FROM players WHERE name_normalized = ?`).get(norm);
  if (!player) {
    console.warn(`⚠️  Speler niet gevonden: ${name} (${norm})`);
    return null;
  }
  return player.id;
}

function nowMs() { return Date.now(); }

console.log('🗑️  Verwijderen oude data...');

// Verwijder alle matches, match_players, match_results, mvp_votes, scheduled_actions
db.prepare(`DELETE FROM scheduled_actions`).run();
db.prepare(`DELETE FROM mvp_votes`).run();
db.prepare(`DELETE FROM match_results`).run();
db.prepare(`DELETE FROM match_players`).run();
db.prepare(`DELETE FROM matches`).run();

// Reset player stats
db.prepare(`UPDATE players SET wins = 0, games = 0`).run();

console.log('✅ Oude data verwijderd, stats gereset');
console.log('');

// Wedstrijden data:
// Format: { datum: 'YYYY-MM-DD', tijd: 'HH:MM', teamA: ['speler1', ...], scoreA: X, teamB: ['speler2', ...], scoreB: Y }
const wedstrijden = [
  {
    datum: '2025-03-22',
    tijd: '21:00',
    teamA: ['Selo', 'Turan', 'Salim', 'Seymen', 'Emre-b'],
    scoreA: 0,
    teamB: ['Izzet', 'Ilkay', 'Gokdeniz', 'Ramazan', 'Samet'],
    scoreB: 4
  },
  {
    datum: '2025-03-17',
    tijd: '21:00',
    teamA: ['Gokdeniz', 'Ramazan', 'Seymen', 'Samet', 'Mehmet'],
    scoreA: 0,
    teamB: ['Salim', 'Selo', 'Turan', 'Emre-b', 'Mikail'],
    scoreB: 5
  },
  {
    datum: '2025-03-15',
    tijd: '21:00',
    teamA: ['Selo', 'Izzet', 'Ilkay', 'Seymen', 'Mehmet'],
    scoreA: 0,
    teamB: ['Salim', 'Emre-b', 'Enver', 'Gokdeniz', 'Ramazan'],
    scoreB: 1
  },
  {
    datum: '2025-03-10',
    tijd: '21:00',
    teamA: ['Ramazan', 'Ilkay', 'Ahmet', 'Samet', 'Ardenis'],
    scoreA: 2,
    teamB: ['Turan', 'Gokdeniz', 'Izzet', 'Salim', 'Emre-b'],
    scoreB: 0
  },
  {
    datum: '2025-03-05',
    tijd: '21:00',
    teamA: ['Ilkay', 'Izzet', 'Samet', 'Enver', 'Mehmet'],
    scoreA: 0,
    teamB: ['Selo', 'Turan', 'Ramazan', 'Erhan', 'Salim'],
    scoreB: 3
  },
  {
    datum: '2025-03-03',
    tijd: '21:00',
    teamA: ['Ilkay', 'Gokdeniz', 'Erhan', 'Izzet', 'Ahmet'],
    scoreA: 0,
    teamB: ['Selo', 'Salim', 'Seymen', 'Samet', 'Mehmet'],
    scoreB: 1
  },
  {
    datum: '2025-02-19',
    tijd: '21:00',
    teamA: ['Ramazan', 'Ilkay', 'Emre-b', 'Mo-emre', 'Mikail'],
    scoreA: 5,
    teamB: ['Erhan', 'Salim', 'Fahri', 'Isaac', 'Enver'],
    scoreB: 0
  },
  {
    datum: '2025-02-12',
    tijd: '21:00',
    teamA: ['Izzet', 'Salim', 'Seymen', 'Isaac', 'Mehmet-s'],
    scoreA: 0,
    teamB: ['Gokdeniz', 'Ramazan', 'Ilkay', 'Ahmet', 'Fahri'],
    scoreB: 1
  },
  {
    datum: '2025-02-10',
    tijd: '21:00',
    teamA: ['Selo', 'Gokdeniz', 'Erhan', 'Salim', 'Samet'],
    scoreA: 0,
    teamB: ['Turan', 'Ramazan', 'Ilkay', 'Seymen', 'Fahri'],
    scoreB: 2
  },
  {
    datum: '2025-02-03',
    tijd: '21:00',
    teamA: ['Erhan', 'Izzet', 'Salim', 'Ilkay', 'Roberto'],
    scoreA: 0,
    teamB: ['Gokdeniz', 'Seymen', 'Fahri', 'Emre-b', 'Mikail'],
    scoreB: 4
  },
  {
    datum: '2025-01-29',
    tijd: '21:00',
    teamA: ['Erhan', 'Izzet', 'Salim', 'Ilkay', 'Arjan'],
    scoreA: 0,
    teamB: ['Selo', 'Turan', 'Gokdeniz', 'Emirhan', 'Ramazan'],
    scoreB: 1
  },
  {
    datum: '2025-01-25',
    tijd: '21:00',
    teamA: ['Selo', 'Turan', 'Gokdeniz', 'Emirhan', 'Ramazan'],
    scoreA: 1,
    teamB: ['Erhan', 'Izzet', 'Salim', 'Ilkay', 'Arjan'],
    scoreB: 0
  }
];

console.log('📝 Invoeren nieuwe wedstrijden...');
console.log('');

let matchCounter = 0;

wedstrijden.forEach((w, idx) => {
  matchCounter++;
  console.log(`${matchCounter}. ${w.datum} — ${w.teamA.join(', ')} (${w.scoreA}-${w.scoreB}) ${w.teamB.join(', ')}`);

  // Maak match aan
  const matchInfo = db.prepare(`
    INSERT INTO matches (match_date, starts_at, status, player_limit, created_at)
    VALUES (?, ?, 'closed', 10, ?)
  `).run(w.datum, w.tijd, nowMs());

  const matchId = matchInfo.lastInsertRowid;

  // Voeg spelers toe aan match_players (team A = wit, team B = zwart)
  const insertPlayer = db.prepare(`
    INSERT INTO match_players (match_id, player_id, signup_state, joined_at, is_waitlist, team)
    VALUES (?, ?, 'ja', ?, 0, ?)
  `);

  const teamAIds = w.teamA.map(name => getPlayerId(name)).filter(id => id !== null);
  const teamBIds = w.teamB.map(name => getPlayerId(name)).filter(id => id !== null);

  teamAIds.forEach(playerId => {
    insertPlayer.run(matchId, playerId, nowMs(), 'wit');
  });

  teamBIds.forEach(playerId => {
    insertPlayer.run(matchId, playerId, nowMs(), 'zwart');
  });

  // Bepaal winnaar
  const winnerTeam = w.scoreA > w.scoreB ? 'wit' : 'zwart';
  const score = `${w.scoreA}-${w.scoreB}`;

  // Voeg resultaat toe
  db.prepare(`
    INSERT INTO match_results (match_id, winner_team, score, decided_at)
    VALUES (?, ?, ?, ?)
  `).run(matchId, winnerTeam, score, nowMs());

  // Update player stats (wins en games)
  const winnerIds = winnerTeam === 'wit' ? teamAIds : teamBIds;
  const loserIds = winnerTeam === 'wit' ? teamBIds : teamAIds;

  winnerIds.forEach(playerId => {
    db.prepare(`UPDATE players SET games = games + 1, wins = wins + 1 WHERE id = ?`).run(playerId);
  });

  loserIds.forEach(playerId => {
    db.prepare(`UPDATE players SET games = games + 1 WHERE id = ?`).run(playerId);
  });
});

console.log('');
console.log('✅ Klaar! Alle wedstrijden zijn ingevoerd.');
console.log('');
console.log('📊 Speler stats:');

const players = db.prepare(`
  SELECT display_name, wins, games
  FROM players
  WHERE games > 0
  ORDER BY (wins * 1.0 / games) DESC, wins DESC
`).all();

players.forEach(p => {
  const pct = ((p.wins / p.games) * 100).toFixed(0);
  console.log(`   ${p.display_name}: ${pct}% (${p.wins}/${p.games})`);
});

db.close();
