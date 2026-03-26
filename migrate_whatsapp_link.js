// Migratie: Voeg WhatsApp ID kolom toe voor automatische user herkenning
const Database = require('better-sqlite3');
const db = new Database('voetbal.db');

console.log('=== WhatsApp Link Migratie ===\n');

try {
  // Voeg whatsapp_id kolom toe (zonder UNIQUE constraint bij ALTER TABLE)
  db.exec(`
    ALTER TABLE players ADD COLUMN whatsapp_id TEXT;
  `);

  console.log('✅ Kolom "whatsapp_id" toegevoegd aan players table');

  // Maak UNIQUE index voor snellere lookups én uniekheid garanderen
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_whatsapp_id ON players(whatsapp_id) WHERE whatsapp_id IS NOT NULL;
  `);

  console.log('✅ Unique index aangemaakt voor whatsapp_id');

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
