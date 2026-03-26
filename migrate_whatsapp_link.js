// Migratie: Voeg WhatsApp ID kolom toe voor automatische user herkenning
const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

console.log('=== WhatsApp Link Migratie ===\n');

try {
  // Voeg whatsapp_id kolom toe
  db.exec(`
    ALTER TABLE players ADD COLUMN whatsapp_id TEXT UNIQUE;
  `);

  console.log('✅ Kolom "whatsapp_id" toegevoegd aan players table');

  // Maak index voor snellere lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_players_whatsapp_id ON players(whatsapp_id);
  `);

  console.log('✅ Index aangemaakt voor whatsapp_id');

} catch (err) {
  if (err.message.includes('duplicate column name')) {
    console.log('ℹ️  Kolom "whatsapp_id" bestaat al');
  } else {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

console.log('\n=== Migratie compleet ===');
console.log('\nGebruikers kunnen nu automatisch herkend worden via WhatsApp!');
console.log('Bij eerste /ja wordt hun WhatsApp nummer gelinkt aan hun naam.');

db.close();
