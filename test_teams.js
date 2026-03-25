// Tijdelijk test script om /teams output te simuleren
const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

function pureWinrate(p) {
  if (!p.games) return 0;
  return p.wins / p.games;
}

const rows = db.prepare(`
  SELECT mp.player_id, mp.signup_state, mp.joined_at, mp.team,
         p.display_name, p.wins, p.games
  FROM match_players mp
  JOIN players p ON p.id = mp.player_id
  WHERE mp.match_id = 5
  ORDER BY mp.joined_at ASC
`).all();

const wit = rows.filter(r => r.team === 'wit');
const zwart = rows.filter(r => r.team === 'zwart');

console.log('Team Wit:');
wit.forEach(p => console.log(`  - ${p.display_name} (pure ${(pureWinrate(p)*100).toFixed(0)}%, games ${p.games})`));

console.log('');
console.log('Team Zwart:');
zwart.forEach(p => console.log(`  - ${p.display_name} (pure ${(pureWinrate(p)*100).toFixed(0)}%, games ${p.games})`));

// Nu de vraag: kloppen deze stats?
console.log('\n=== VERIFICATIE ===');
console.log('Checking of elke speler de juiste wins/games heeft...');

// Tel handmatig de wins/games voor elke speler uit match_results
const allPlayers = db.prepare('SELECT * FROM players').all();
for (const player of allPlayers) {
  // Tel in hoeveel wedstrijden deze speler heeft gespeeld
  const gamesPlayed = db.prepare(`
    SELECT COUNT(DISTINCT mp.match_id) as count
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    JOIN match_results mr ON mr.match_id = m.id
    WHERE mp.player_id = ?
  `).get(player.id).count;

  // Tel wins
  const winsCount = db.prepare(`
    SELECT COUNT(DISTINCT mp.match_id) as count
    FROM match_players mp
    JOIN match_results mr ON mr.match_id = mp.match_id
    WHERE mp.player_id = ?
    AND mp.team = mr.winner_team
  `).get(player.id).count;

  if (gamesPlayed !== player.games || winsCount !== player.wins) {
    console.log(`ERROR: ${player.display_name} - DB: ${player.wins}W/${player.games}G, Berekend: ${winsCount}W/${gamesPlayed}G`);
  }
}
console.log('Verificatie compleet.');
