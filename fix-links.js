/**
 * Fix WhatsApp ID linkings
 * Run: node fix-links.js
 */

const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

// Fix verkeerde links - eerst oude links verwijderen
const fixLinks = [
  { whatsappId: '210384711643215@lid', correctName: 'gokdeniz' },
  { whatsappId: '132233469948062@lid', correctName: 'salim' },
  { whatsappId: '214443589947537@lid', correctName: 'emre-b' }
];

// Nieuwe spelers toevoegen met hun WhatsApp ID
const newPlayers = [
  { whatsappId: '62315781177378@lid', name: 'Mehmet', position: 'middenveld' },
  { whatsappId: '278962437636346@lid', name: 'Erhan', position: 'middenveld' },
  { whatsappId: '193694451900628@lid', name: 'Okan', position: 'middenveld' },
  { whatsappId: '29141554479347@lid', name: 'Selo', position: 'keeper' }
];

console.log('=== Fix WhatsApp ID Linkings ===\n');

// Fix verkeerde links
for (const fix of fixLinks) {
  // Verwijder de huidige (foute) link
  const wrongPlayer = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(fix.whatsappId);
  if (wrongPlayer) {
    console.log(`Verwijder link van ${wrongPlayer.display_name} (was fout gelinkt)`);
    db.prepare(`UPDATE players SET whatsapp_id = NULL WHERE whatsapp_id = ?`).run(fix.whatsappId);
  }

  // Zoek de correcte speler
  const correctPlayer = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(fix.correctName);
  if (correctPlayer) {
    // Verwijder eventuele oude link van de correcte speler
    if (correctPlayer.whatsapp_id && correctPlayer.whatsapp_id !== fix.whatsappId) {
      console.log(`  (${correctPlayer.display_name} had eerder: ${correctPlayer.whatsapp_id})`);
    }

    // Link correct
    db.prepare(`UPDATE players SET whatsapp_id = ? WHERE name_normalized = ?`).run(fix.whatsappId, fix.correctName);
    console.log(`✅ ${fix.whatsappId} -> ${correctPlayer.display_name}`);
  } else {
    console.log(`❌ Speler ${fix.correctName} niet gevonden!`);
  }
}

console.log('\n=== Nieuwe Spelers Toevoegen ===\n');

// Voeg nieuwe spelers toe
for (const newPlayer of newPlayers) {
  // Check of speler al bestaat
  const existing = db.prepare(`SELECT * FROM players WHERE name_normalized = ?`).get(newPlayer.name.toLowerCase());

  if (existing) {
    // Update bestaande speler met WhatsApp ID
    db.prepare(`UPDATE players SET whatsapp_id = ? WHERE id = ?`).run(newPlayer.whatsappId, existing.id);
    console.log(`✅ ${newPlayer.name} (bestaand) -> ${newPlayer.whatsappId}`);
  } else {
    // Maak nieuwe speler aan
    db.prepare(`
      INSERT INTO players (display_name, name_normalized, position, whatsapp_id, skill_modifier, created_at)
      VALUES (?, ?, ?, ?, 0.25, ?)
    `).run(newPlayer.name, newPlayer.name.toLowerCase(), newPlayer.position, newPlayer.whatsappId, Date.now());
    console.log(`✅ ${newPlayer.name} (nieuw) -> ${newPlayer.whatsappId}`);
  }
}

console.log('\n=== Alle Gelinkte Spelers ===\n');

const allLinked = db.prepare(`
  SELECT display_name, whatsapp_id, position
  FROM players
  WHERE whatsapp_id IS NOT NULL
  ORDER BY display_name
`).all();

allLinked.forEach(p => {
  console.log(`${p.display_name} [${p.position || '?'}] -> ${p.whatsapp_id}`);
});

console.log(`\nTotaal: ${allLinked.length} gelinkte spelers`);

db.close();
console.log('\n✅ Done!');
