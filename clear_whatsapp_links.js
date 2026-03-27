// Script om alle WhatsApp links te wissen
const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

console.log('=== WhatsApp Links Wissen ===\n');

try {
  // Toon huidige links
  const links = db.prepare(`
    SELECT id, display_name, whatsapp_id
    FROM players
    WHERE whatsapp_id IS NOT NULL
  `).all();

  console.log(`📱 Gevonden ${links.length} gelinkte spelers:`);
  links.forEach(p => {
    console.log(`   - ${p.display_name}: ${p.whatsapp_id}`);
  });

  // Wis alle WhatsApp IDs
  const result = db.prepare(`UPDATE players SET whatsapp_id = NULL`).run();

  console.log(`\n✅ ${result.changes} WhatsApp IDs gewist`);
  console.log('\nAlle spelers kunnen nu opnieuw linken met /ja <naam>');

} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}

console.log('\n=== Wissen compleet ===');
db.close();