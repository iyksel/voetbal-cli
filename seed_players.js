// Seed module: spelers toevoegen/updaten met posities
// Posities: keeper, verdediger, middenveld, aanvaller

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

// Default spelers lijst
const DEFAULT_PLAYERS = [
  { name: 'Mikail', position: 'aanvaller' },
  { name: 'Emirhan', position: 'aanvaller' },
  { name: 'Mo-emre', position: 'aanvaller' },
  { name: 'Ardenis', position: 'aanvaller' },
  { name: 'Ramazan', position: 'middenveld' },
  { name: 'Fahri', position: 'aanvaller' },
  { name: 'Turan', position: 'verdediger' },
  { name: 'Emre-b', position: 'aanvaller' },
  { name: 'Ahmet', position: 'aanvaller' },
  { name: 'Selo', position: 'keeper' },
  { name: 'Gokdeniz', position: 'verdediger' },
  { name: 'Samet', position: 'keeper' },
  { name: 'Ilkay', position: 'middenveld' },
  { name: 'Seymen', position: 'aanvaller' },
  { name: 'Salim', position: 'verdediger' },
  { name: 'Enver', position: 'aanvaller' },
  { name: 'Mehmet', position: 'aanvaller' },
  { name: 'Erhan', position: 'verdediger' },
  { name: 'Izzet', position: 'verdediger' },
  { name: 'Roberto', position: 'aanvaller' },
  { name: 'Mehmet-s', position: 'aanvaller' },
  { name: 'Arjan', position: 'aanvaller' },
  { name: 'Isaac', position: 'aanvaller' },
];

/**
 * Voeg een speler toe of update positie
 * @param {Database} db - better-sqlite3 database instance
 * @param {string} name - speler naam
 * @param {string} position - positie (keeper/verdediger/middenveld/aanvaller)
 * @returns {{ status: string, player: object, message: string }}
 */
function addPlayer(db, name, position) {
  const norm = normalizeName(name);
  const display = titleCaseWords(norm);

  const existing = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(norm);
  if (existing) {
    if (!existing.position || existing.position !== position) {
      db.prepare(`UPDATE players SET position = ? WHERE id = ?`).run(position, existing.id);
      return { status: 'updated', player: existing, message: `Updated: ${display} -> [${position}]` };
    }
    return { status: 'skipped', player: existing, message: `Skip: ${display} (al bestaat)` };
  }

  const info = db.prepare(`
    INSERT INTO players (display_name, name_normalized, is_guest, created_at, position)
    VALUES (?, ?, 0, ?, ?)
  `).run(display, norm, nowMs(), position);

  const player = { id: info.lastInsertRowid, display_name: display, position };
  return { status: 'added', player, message: `Added: ${display} [${position}]` };
}

/**
 * Seed alle spelers uit een lijst
 * @param {Database} db - better-sqlite3 database instance
 * @param {Array} players - optionele lijst, anders DEFAULT_PLAYERS
 * @returns {{ results: Array, summary: string }}
 */
function seedPlayers(db, players = DEFAULT_PLAYERS) {
  const results = [];

  for (const p of players) {
    const result = addPlayer(db, p.name, p.position);
    results.push(result);
  }

  return { results, summary: getSummary(db, players.length) };
}

/**
 * Haal samenvatting per positie op
 * @param {Database} db - better-sqlite3 database instance
 * @param {number} total - totaal aantal spelers
 * @returns {string}
 */
function getSummary(db, total = null) {
  const summary = db.prepare(`
    SELECT position, COUNT(*) as count
    FROM players
    WHERE position IS NOT NULL
    GROUP BY position
    ORDER BY count DESC
  `).all();

  const lines = ['Verdeling per positie:'];
  for (const s of summary) {
    lines.push(`  ${s.position}: ${s.count}`);
  }
  if (total) lines.push(`\nTotaal: ${total} spelers`);

  return lines.join('\n');
}

/**
 * Haal alle spelers per positie op
 * @param {Database} db - better-sqlite3 database instance
 * @returns {object} - { keeper: [], verdediger: [], middenveld: [], aanvaller: [] }
 */
function getPlayersByPosition(db) {
  const players = db.prepare(`
    SELECT display_name, position
    FROM players
    WHERE position IS NOT NULL
    ORDER BY display_name
  `).all();

  const grouped = { keeper: [], verdediger: [], middenveld: [], aanvaller: [] };
  for (const p of players) {
    if (grouped[p.position]) {
      grouped[p.position].push(p.display_name);
    }
  }
  return grouped;
}

/**
 * Formatteer spelers per positie als string
 * @param {Database} db - better-sqlite3 database instance
 * @returns {string}
 */
function formatPlayersByPosition(db) {
  const grouped = getPlayersByPosition(db);
  const labels = {
    keeper: '🧤 Keeper',
    verdediger: '🛡️ Verdediger',
    middenveld: '⚡ Middenveld',
    aanvaller: '⚽ Aanvaller'
  };

  const lines = [];
  for (const [pos, label] of Object.entries(labels)) {
    const players = grouped[pos];
    if (players.length > 0) {
      lines.push(`${label} (${players.length}): ${players.join(', ')}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_PLAYERS,
  addPlayer,
  seedPlayers,
  getSummary,
  getPlayersByPosition,
  formatPlayersByPosition,
  normalizeName,
  titleCaseWords
};

// CLI mode: run als direct aangeroepen
if (require.main === module) {
  const Database = require('better-sqlite3');
  const db = new Database('voetbal.db');

  console.log('=== Spelers toevoegen ===\n');
  const { results, summary } = seedPlayers(db);

  for (const r of results) {
    console.log(r.message);
  }

  console.log('\n=== Klaar! ===');
  console.log(summary);

  db.close();
}
