// Seed script: voeg 23 spelers toe met hun posities
// Posities: K = Keeper, V = Verdediger, M = Middenveld, A = Aanvaller

const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

function nowMs() { return Date.now(); }

function normalizeName(name) {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/^['"\s]+|['"\s]+$/g, '');
  s = s.replace(/\s+/g, ' ');
  return s;
}

function titleCaseWords(norm) {
  return norm
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function addPlayer(name, position) {
  const norm = normalizeName(name);
  const display = titleCaseWords(norm);

  const existing = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(norm);
  if (existing) {
    // Update positie als nog niet ingesteld
    if (!existing.position || existing.position !== position) {
      db.prepare(`UPDATE players SET position = ? WHERE id = ?`).run(position, existing.id);
      console.log(`Updated: ${display} -> [${position}]`);
    } else {
      console.log(`Skip: ${display} (al bestaat)`);
    }
    return existing;
  }

  const info = db.prepare(`
    INSERT INTO players (display_name, name_normalized, is_guest, created_at, position)
    VALUES (?, ?, 0, ?, ?)
  `).run(display, norm, nowMs(), position);

  console.log(`Added: ${display} [${position}]`);
  return { id: info.lastInsertRowid, display_name: display };
}

// Lijst van spelers met posities
const players = [
  { name: 'Mikail', position: 'aanvaller' },
  { name: 'Emirhan', position: 'aanvaller' },
  { name: 'Mo-emre', position: 'aanvaller' },
  { name: 'Ardenis', position: 'aanvaller' },
  { name: 'Ramazan', position: 'middenveld' },
  { name: 'Fahri', position: 'aanvaller' },
  { name: 'Turan', position: 'middenveld' },
  { name: 'Emre-b', position: 'aanvaller' },
  { name: 'Ahmet', position: 'aanvaller' },
  { name: 'Selo', position: 'middenveld' },
  { name: 'Gokdeniz', position: 'middenveld' },
  { name: 'Samet', position: 'keeper' },
  { name: 'Ilkay', position: 'middenveld' },
  { name: 'Seymen', position: 'aanvaller' },
  { name: 'Salim', position: 'middenveld' },
  { name: 'Enver', position: 'aanvaller' },
  { name: 'Mehmet', position: 'aanvaller' },
  { name: 'Erhan', position: 'verdediger' },
  { name: 'Izzet', position: 'middenveld' },
  { name: 'Roberto', position: 'aanvaller' },
  { name: 'Mehmet-s', position: 'aanvaller' },
  { name: 'Arjan', position: 'aanvaller' },
  { name: 'Isaac', position: 'aanvaller' },
];

console.log('=== Spelers toevoegen ===\n');

for (const p of players) {
  addPlayer(p.name, p.position);
}

console.log('\n=== Klaar! ===');
console.log(`Totaal: ${players.length} spelers`);

// Toon samenvatting per positie
const summary = db.prepare(`
  SELECT position, COUNT(*) as count
  FROM players
  WHERE position IS NOT NULL
  GROUP BY position
  ORDER BY count DESC
`).all();

console.log('\nVerdeling per positie:');
for (const s of summary) {
  console.log(`  ${s.position}: ${s.count}`);
}

db.close();
