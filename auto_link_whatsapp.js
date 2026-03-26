// Automatisch WhatsApp IDs linken aan spelers
const Database = require('better-sqlite3');

const db = new Database('voetbal.db');

// Lijst van telefoonnummers en namen
const phoneLinks = [
  { phone: '0493427034', name: 'Ilkay' },
  { phone: '0470054519', name: 'Erhan' },
  { phone: '0493427040', name: 'Izzet' },
  { phone: '0472219124', name: 'Emre' },
  { phone: '0491183324', name: 'Enver' },
  { phone: '0485517270', name: 'Fahri' },
  { phone: '0491933901', name: 'Gokdeniz' },
  { phone: '0475658816', name: 'Mehmet' },
  { phone: '0468462134', name: 'Mo-emre' },
  { phone: '0488584260', name: 'Salim' },
  { phone: '0484053486', name: 'Samet' },
  { phone: '0484952701', name: 'Selo' },
  { phone: '0488918177', name: 'Turan' },
  { phone: '0471795727', name: 'Seymen' },
  { phone: '0483689957', name: 'Ramazan' },
  { phone: '0488472970', name: 'Arjan' },
  { phone: '0489369600', name: 'Okan' },
  { phone: '0489704939', name: 'Emre-b' },
  { phone: '0499918255', name: 'Ahmet' },
];

function normalizeName(name) {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/^['"\s]+|['"\s]+$/g, '');
  s = s.replace(/\s+/g, ' ');
  return s;
}

function formatWhatsAppId(phone) {
  // Belgische nummers: verwijder eerste 0, voeg 32 prefix toe
  if (phone.startsWith('0')) {
    return `32${phone.slice(1)}@c.us`;
  }
  return `${phone}@c.us`;
}

console.log('🔗 WhatsApp Auto-Link Script');
console.log('===========================\n');

let linked = 0;
let notFound = 0;
let alreadyLinked = 0;

for (const { phone, name } of phoneLinks) {
  const normalizedName = normalizeName(name);
  const whatsappId = formatWhatsAppId(phone);

  // Zoek speler
  const player = db.prepare(`
    SELECT * FROM players WHERE name_normalized = ?
  `).get(normalizedName);

  if (!player) {
    console.log(`❌ Speler "${name}" niet gevonden in database`);
    notFound++;
    continue;
  }

  // Check of al gelinkt
  if (player.whatsapp_id) {
    console.log(`ℹ️  ${player.display_name} is al gelinkt (${player.whatsapp_id})`);
    alreadyLinked++;
    continue;
  }

  // Check of WhatsApp ID al in gebruik is
  const existing = db.prepare(`
    SELECT * FROM players WHERE whatsapp_id = ?
  `).get(whatsappId);

  if (existing) {
    console.log(`⚠️  WhatsApp ID ${whatsappId} al in gebruik door ${existing.display_name}`);
    continue;
  }

  // Link maken
  try {
    db.prepare(`
      UPDATE players SET whatsapp_id = ? WHERE id = ?
    `).run(whatsappId, player.id);

    console.log(`✅ ${player.display_name} gelinkt aan ${phone} (${whatsappId})`);
    linked++;
  } catch (err) {
    console.log(`❌ Error bij linken ${name}: ${err.message}`);
  }
}

console.log('\n📊 Resultaat:');
console.log(`✅ Gelinkt: ${linked}`);
console.log(`ℹ️  Al gelinkt: ${alreadyLinked}`);
console.log(`❌ Niet gevonden: ${notFound}`);
console.log(`📱 Totaal verwerkt: ${phoneLinks.length}`);

// Toon alle gelinkte spelers
console.log('\n📋 Alle gelinkte spelers:');
const allLinked = db.prepare(`
  SELECT display_name, position, whatsapp_id
  FROM players
  WHERE whatsapp_id IS NOT NULL
  ORDER BY display_name
`).all();

allLinked.forEach(p => {
  const pos = p.position ? ` [${p.position}]` : '';
  console.log(`  ${p.display_name}${pos} → ${p.whatsapp_id}`);
});

console.log(`\n✅ Script compleet! ${allLinked.length} spelers hebben nu WhatsApp link.`);

db.close();