// Script om 1 wedstrijd toe te voegen aan de database
// Voer uit met: node insert_single_match.js
//
// Pas de gegevens hieronder aan voor elke nieuwe wedstrijd:

const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

function nowMs() { return Date.now(); }

// ============================================
// PAS DEZE GEGEVENS AAN VOOR JE NIEUWE WEDSTRIJD
// ============================================
const match = {
  date: '2026-03-22',                    // Datum van de wedstrijd (YYYY-MM-DD)
  starts_at: '2026-03-22T21:00:00',      // Starttijd (ISO formaat)
  team_wit: ['Salim', 'Selo', 'Seymen', 'Turan', 'Emre-b'],
  team_zwart: ['Ilkay', 'Izzet', 'Samet', 'Gokdeniz', 'Ramazan'],
  uitslag: 'zwart',                      // 'wit' of 'zwart' (wie heeft gewonnen?)
  score: '0-4',                          // Score (bijv. '1-0', '0-2', '3-2')
};
// ============================================

function ensurePlayer(name) {
  // Gebruik consistente normalisatie (strip quotes, collapse spaties)
  const norm = String(name || '').trim().toLowerCase().replace(/^['"\s]+|['"\s]+$/g, '').replace(/\s+/g, ' ');
  const display = norm.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let p = db.prepare('SELECT * FROM players WHERE name_normalized = ?').get(norm);
  if (!p) {
    db.prepare('INSERT INTO players (display_name, name_normalized, is_guest, wins, games, created_at) VALUES (?, ?, 1, 0, 0, ?)')
      .run(display, norm, nowMs());
    p = db.prepare('SELECT * FROM players WHERE name_normalized = ?').get(norm);
    console.log(`  Nieuwe speler aangemaakt: ${display}`);
  } else {
    if (p.display_name !== display) db.prepare('UPDATE players SET display_name = ? WHERE id = ?').run(display, p.id);
  }
  return p.id;
}

function insertMatch() {
  console.log('');
  console.log('=========================================');
  console.log('WEDSTRIJD TOEVOEGEN');
  console.log('=========================================');
  console.log(`Datum: ${match.date}`);
  console.log(`Team Wit: ${match.team_wit.join(', ')}`);
  console.log(`Team Zwart: ${match.team_zwart.join(', ')}`);
  console.log(`Uitslag: ${match.uitslag} won`);
  console.log(`Score: ${match.score}`);
  console.log('');

  // Check of deze wedstrijd al bestaat (voorkom duplicaten)
  const existing = db.prepare('SELECT id FROM matches WHERE match_date = ? AND starts_at = ?').get(match.date, match.starts_at);
  if (existing) {
    console.log(`ERROR: Er bestaat al een wedstrijd op ${match.date} om ${match.starts_at.split('T')[1]}`);
    console.log(`Match ID: ${existing.id}`);
    console.log('Pas de datum/tijd aan of verwijder de bestaande match eerst.');
    process.exit(1);
  }

  // Voeg match toe
  const info = db.prepare('INSERT INTO matches (match_date, starts_at, status, player_limit, created_at, roster_hash, teams_generated_at) VALUES (?, ?, ?, 10, ?, NULL, ?)')
    .run(match.date, match.starts_at, 'closed', nowMs(), nowMs());
  const matchId = info.lastInsertRowid;
  console.log(`Match aangemaakt met ID: ${matchId}`);

  // Voeg spelers toe
  console.log('\nSpelers toevoegen...');
  for (const naam of match.team_wit) {
    const pid = ensurePlayer(naam);
    db.prepare('INSERT INTO match_players (match_id, player_id, signup_state, joined_at, team) VALUES (?, ?, ?, ?, ?)')
      .run(matchId, pid, 'ja', nowMs(), 'wit');
  }
  for (const naam of match.team_zwart) {
    const pid = ensurePlayer(naam);
    db.prepare('INSERT INTO match_players (match_id, player_id, signup_state, joined_at, team) VALUES (?, ?, ?, ?, ?)')
      .run(matchId, pid, 'ja', nowMs(), 'zwart');
  }

  // Voeg resultaat toe
  db.prepare('INSERT INTO match_results (match_id, winner_team, score, decided_at, decided_by_player_id) VALUES (?, ?, ?, ?, NULL)')
    .run(matchId, match.uitslag, match.score, nowMs());

  // Update wins en games voor alle spelers
  const allPlayers = [...match.team_wit, ...match.team_zwart];
  const winners = match.uitslag === 'wit' ? match.team_wit : match.team_zwart;
  
  console.log('\nStats bijwerken...');
  for (const naam of allPlayers) {
    const pid = ensurePlayer(naam);
    db.prepare('UPDATE players SET games = games + 1 WHERE id = ?').run(pid);
  }
  
  for (const naam of winners) {
    const pid = ensurePlayer(naam);
    db.prepare('UPDATE players SET wins = wins + 1 WHERE id = ?').run(pid);
  }

  console.log('');
  console.log('=========================================');
  console.log('WEDSTRIJD SUCCESVOL TOEGEVOEGD!');
  console.log('=========================================');
  console.log('');

  // Toon huidige standings
  console.log('Top 10 na deze wedstrijd:');
  const standings = db.prepare(`
    SELECT display_name, wins, games,
           CASE WHEN games = 0 THEN 0 ELSE ROUND((CAST(wins AS REAL) / games) * 100, 1) END AS winrate
    FROM players
    WHERE games > 0
    ORDER BY (CAST(wins AS REAL) / games) DESC, games DESC
    LIMIT 10
  `).all();
  
  standings.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.display_name} - ${p.winrate}% (${p.wins}/${p.games})`);
  });
}

insertMatch();
