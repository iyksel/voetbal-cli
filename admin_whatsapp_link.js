// Admin tool: Link WhatsApp IDs aan spelers
const Database = require('better-sqlite3');
const readline = require('readline');

const db = new Database('voetbal.db');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function listPlayers() {
  const players = db.prepare(`
    SELECT id, display_name, position, whatsapp_id, wins, games
    FROM players
    ORDER BY display_name
  `).all();

  console.log('\n📋 Alle Spelers:');
  console.log('ID | Naam | Positie | WhatsApp ID | W/G');
  console.log('---|------|---------|-------------|----');
  players.forEach(p => {
    const pos = p.position || '?';
    const linked = p.whatsapp_id ? '✅ Linked' : '❌ Niet linked';
    console.log(`${p.id.toString().padEnd(2)} | ${p.display_name.padEnd(12)} | ${pos.padEnd(7)} | ${linked.padEnd(11)} | ${p.wins}/${p.games}`);
  });
}

function linkPlayer(playerId, whatsappId) {
  try {
    // Check of speler bestaat
    const player = db.prepare(`SELECT * FROM players WHERE id = ?`).get(playerId);
    if (!player) {
      throw new Error(`Speler met ID ${playerId} niet gevonden.`);
    }

    // Check of WhatsApp ID al in gebruik is
    const existing = db.prepare(`SELECT * FROM players WHERE whatsapp_id = ?`).get(whatsappId);
    if (existing) {
      throw new Error(`WhatsApp ID al gelinkt aan ${existing.display_name}.`);
    }

    // Link maken
    db.prepare(`UPDATE players SET whatsapp_id = ? WHERE id = ?`).run(whatsappId, playerId);
    console.log(`✅ ${player.display_name} succesvol gelinkt aan WhatsApp ID: ${whatsappId}`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
  }
}

function unlinkPlayer(playerId) {
  try {
    const player = db.prepare(`SELECT * FROM players WHERE id = ?`).get(playerId);
    if (!player) {
      throw new Error(`Speler met ID ${playerId} niet gevonden.`);
    }

    if (!player.whatsapp_id) {
      throw new Error(`${player.display_name} is nog niet gelinkt.`);
    }

    db.prepare(`UPDATE players SET whatsapp_id = NULL WHERE id = ?`).run(playerId);
    console.log(`✅ ${player.display_name} WhatsApp link verwijderd.`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
  }
}

async function main() {
  console.log('🔧 WhatsApp Link Admin Tool');
  console.log('==========================');

  while (true) {
    console.log('\nCommands:');
    console.log('  list                    - Toon alle spelers');
    console.log('  link <player_id> <wa_id> - Link speler aan WhatsApp ID');
    console.log('  unlink <player_id>       - Verwijder WhatsApp link');
    console.log('  exit                     - Stoppen');

    const input = await new Promise(resolve => {
      rl.question('\n> ', resolve);
    });

    const [cmd, ...args] = input.trim().split(' ');

    if (cmd === 'exit') {
      break;
    } else if (cmd === 'list') {
      listPlayers();
    } else if (cmd === 'link' && args.length === 2) {
      const [playerId, whatsappId] = args;
      linkPlayer(parseInt(playerId), whatsappId);
    } else if (cmd === 'unlink' && args.length === 1) {
      unlinkPlayer(parseInt(args[0]));
    } else {
      console.log('❌ Onbekend commando of verkeerde parameters.');
    }
  }

  rl.close();
  db.close();
}

main().catch(console.error);