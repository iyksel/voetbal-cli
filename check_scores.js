const db = require('better-sqlite3')('voetbal.db');
const matches = db.prepare(`
  SELECT m.id, m.match_date, mr.score, mr.winner_team 
  FROM matches m 
  LEFT JOIN match_results mr ON mr.match_id = m.id 
  WHERE m.status = 'closed' 
  ORDER BY m.id
`).all();

console.log('Wedstrijden met scores:');
matches.forEach(m => console.log(`ID ${m.id}: ${m.match_date} - Score: ${m.score || 'geen'} - Winner: ${m.winner_team}`));
