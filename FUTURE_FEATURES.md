# 🚀 Toekomstige Features

Dit document bevat ideeën om de voetbal-bot nog beter en realistischer te maken.

---

## ✅ Geïmplementeerd
- ✅ **Positie Systeem** - Keepers, verdedigers, middenvelders, aanvallers

---

## 🎯 High Priority (Meest Impact)

### 1. 📊 Doelpunten & Assist Tracking
**Wat:** Track wie doelpunten en assists maakt

**Commands:**
```bash
/goal <naam> [aantal]     # Registreer doelpunt(en)
/assist <naam>             # Registreer assist
/topscorers                # Toon topscorers
/assists                   # Toon assist leaders
```

**Schema:**
```sql
CREATE TABLE match_stats (
  id INTEGER PRIMARY KEY,
  match_id INTEGER,
  player_id INTEGER,
  goals INTEGER DEFAULT 0,
  assists INTEGER DEFAULT 0,
  FOREIGN KEY(match_id) REFERENCES matches(id),
  FOREIGN KEY(player_id) REFERENCES players(id)
);

ALTER TABLE players ADD COLUMN total_goals INTEGER DEFAULT 0;
ALTER TABLE players ADD COLUMN total_assists INTEGER DEFAULT 0;
```

**Impact:** 🔥🔥🔥🔥🔥 - Maakt het competitiever en leuker!

---

### 2. 🎯 Wachtlijst Systeem
**Wat:** Als match vol is, kunnen spelers op wachtlijst komen

**Hoe het werkt:**
- Bij 10 spelers → nieuwe signup gaat naar wachtlist
- Als iemand `/nee` doet → eerst op wachtlijst schuift automatisch door
- Signal: "Je staat op wachtlijst positie #3"

**Schema:**
```sql
ALTER TABLE match_players ADD COLUMN is_waitlist INTEGER DEFAULT 0;
ALTER TABLE match_players ADD COLUMN waitlist_position INTEGER;
```

**Impact:** 🔥🔥🔥🔥 - Lost praktisch probleem op

---

### 3. 🏆 Streak Tracking
**Wat:** Huidige win/loss streak per speler

**Examples:**
- "🔥 Jan is op 5 wedstrijden winstreak!"
- "❄️ Marie heeft 3 verloren op rij"

**Schema:**
```sql
ALTER TABLE players ADD COLUMN current_streak INTEGER DEFAULT 0;
ALTER TABLE players ADD COLUMN longest_win_streak INTEGER DEFAULT 0;
ALTER TABLE players ADD COLUMN longest_loss_streak INTEGER DEFAULT 0;
```

**Commands:**
```bash
/streaks    # Toon wie op streak zit
```

**Impact:** 🔥🔥🔥🔥 - Gamification!

---

## 🎨 Medium Priority (Goede Toevoegingen)

### 4. 📍 Locatie Systeem
**Wat:** Voeg locaties toe aan matches

```bash
/play zondag 14u @sporthalwest
/locations                  # Toon frequent gebruikte locaties
```

**Schema:**
```sql
CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  address TEXT,
  used_count INTEGER DEFAULT 0
);

ALTER TABLE matches ADD COLUMN location_id INTEGER
  REFERENCES locations(id);
```

---

### 5. 🌧️ Weer Integratie
**Wat:** Automatisch weersverwachting bij day_message

**API:** Open-Meteo (gratis) of OpenWeatherMap

**Output:**
```
Vandaag 21:00 voetbal 🌧️
Weer: 12°C, lichte regen
/ja om te bevestigen
```

**Impact:** 🔥🔥🔥 - Praktisch, mensen kunnen beslissen

---

### 6. ⭐ MVP Systeem
**Wat:** Stem voor Man of the Match

```bash
/mvp <naam>     # Vote voor MVP
/mvps           # Toon MVP leaderboard
```

**Schema:**
```sql
ALTER TABLE match_results ADD COLUMN mvp_player_id INTEGER
  REFERENCES players(id);
ALTER TABLE players ADD COLUMN mvp_count INTEGER DEFAULT 0;
```

---

### 7. 🤝 Rivaliteit Dashboard
**Wat:** Head-to-head stats tussen spelers

```bash
/h2h Jan Marie    # Hoeveel keer tegen elkaar gespeeld?
```

**Output:**
```
Jan vs Marie (head to head)
Totaal samen gespeeld: 8x
Samen gewonnen: 5x
Tegen elkaar: Jan 2-1 Marie
```

---

### 8. 🎲 Random Captain
**Wat:** Elke match een random captain kiezen

```bash
/captain    # Toon captain van active match
```

Bij team generation → kies random captain per team

---

### 9. 📸 Match Foto's
**Wat:** Upload foto's van eindstand

**Implementatie:** Opslaan als file path in database

```sql
ALTER TABLE match_results ADD COLUMN photo_path TEXT;
```

```bash
/foto <path>    # Upload foto
```

---

### 10. ⏰ Late Show Penalty
**Wat:** Track wie vaak te laat komt

```bash
/laat <naam>    # Markeer als te laat gekomen
```

**Effect:** Bij volgende signup → lagere priority in lijst

**Schema:**
```sql
ALTER TABLE players ADD COLUMN late_count INTEGER DEFAULT 0;
ALTER TABLE players ADD COLUMN on_time_count INTEGER DEFAULT 0;
```

---

### 11. 🎭 Geblesseerd Systeem
**Wat:** Markeer spelers als geblesseerd/onfit

```bash
/blessure [naam]     # Markeer als geblesseerd
/fit [naam]          # Markeer als fit
```

Bij team generation → waarschuwing: "Let op: Jan speelt met blessure"

---

### 12. 📈 Advanced Stats Dashboard
**Wat:** Uitgebreide statistieken

```bash
/stats <naam>    # Volledige stats van speler
```

**Output:**
```
Jan (Keeper)
━━━━━━━━━━━━━━━━
Wedstrijden: 15
Gewonnen: 9 (60%)
Doelpunten: 2
Assists: 5
MVP awards: 3
Current streak: 🔥 4 win streak
Als team captain: 5-1
Favoriete teammate: Marie (samen 8x gewonnen)
H2H vs Ilkay: 3-2
```

---

### 13. 🏅 Achievement System
**Wat:** Unlock achievements

**Examples:**
- 🎯 "Hat Trick Hero" - 3 goals in één match
- 🧤 "Clean Sheet" - keeper in team dat 0 goals tegen krijgt
- 🔥 "On Fire" - 5 win streak
- 🎭 "The Comeback Kid" - verlies streak van 4 gebroken
- ⚡ "Speedster" - eerste 5x op tijd verschijnen

---

### 14. 📊 Match Rating System
**Wat:** Rate wedstrijden

```bash
/rate 8    # Geef match een 8/10
```

Track gemiddelde rating per:
- Locatie
- Tijdstip (avond vs middag)
- Dag van de week

---

### 15. 🔁 Auto-Rematch
**Wat:** Snel dezelfde match opnieuw plannen

```bash
/rematch volgende week    # Zelfde tijd, volgende week
```

---

### 16. 👥 Team Namen
**Wat:** Custom team namen in plaats van "wit" en "zwart"

```bash
/teamnamen "FC Chaos" "Team Tikitaka"
```

Of random generator:
- "De Onverslaagbaren" vs "Team Absolute Unit"

---

### 17. 📱 WhatsApp/Telegram/Discord Integratie
**Wat:** Berichten automatisch naar groepschat sturen

**Implementatie:**
- Poll outbox table
- Stuur via bot API naar chat

---

### 18. 🎮 Formation Selector
**Wat:** Kies formatie per team

```bash
/formatie 4-3-3     # 4 verd, 3 mid, 3 aan
/formatie 3-4-3
```

Team balancing houdt hier rekening mee

---

### 19. 🏆 Season System
**Wat:** Seasons met winnaars

```bash
/season start          # Start nieuw seizoen
/season standings      # Klassement
/season end            # End seizoen, bepaal winnaar
```

**Schema:**
```sql
CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  name TEXT,
  start_date TEXT,
  end_date TEXT,
  winner_player_id INTEGER
);

ALTER TABLE matches ADD COLUMN season_id INTEGER;
```

---

### 20. 🎲 Balanced Signup Mode
**Wat:** Balanceer signups tijdens inschrijving

Als 5 keepers al ingeschreven zijn → waarschuwing
"We hebben al genoeg keepers. Overweeg andere positie of wacht af."

---

## 🔮 Advanced / Complex

### 21. 🤖 AI Team Predictor
**Wat:** ML model dat voorspelt welk team gaat winnen

Train op historical data → features:
- Wilson scores
- Positie balans
- Recent form
- Streaks

---

### 22. 📊 Interactive Web Dashboard
**Wat:** Web interface in plaats van CLI

**Tech stack:** Node.js + Express + Chart.js

**Features:**
- Live match status
- Signup via web form
- Stats visualisaties
- Ranglijsten met grafieken

---

### 23. 🎥 Video Highlights
**Wat:** Link video highlights aan matches

**Schema:**
```sql
ALTER TABLE match_results ADD COLUMN video_url TEXT;
```

---

### 24. 💰 Buy-in / Prize Pool
**Wat:** Inleg systeem

```bash
/buyin 5    # €5 buy-in
```

Track pot → winnend team verdient de pot

---

### 25. 📞 Voice Commands
**Wat:** Voice interface via Google Assistant / Alexa

"Hey Google, schrijf me in voor voetbal"

---

## 🎯 Prioriteit Samenvatting

### 🔥 MUST HAVE (Implementeer nu!)
1. Doelpunten & Assists Tracking
2. Wachtlijst Systeem
3. Streak Tracking

### 💪 SHOULD HAVE (Volgende fase)
4. Locatie Systeem
5. Weer Integratie
6. MVP Systeem
7. H2H Stats

### 🌟 NICE TO HAVE (Als tijd over is)
8. Late Show Penalty
9. Achievement System
10. Match Rating

### 🚀 FUTURE (Ver in toekomst)
11. Web Dashboard
12. AI Predictor
13. Voice Commands

---

## 💡 Implementatie Tips

### Start Klein
1. Kies **1 feature** per iteratie
2. Test grondig
3. Deploy
4. Feedback verzamelen
5. Volgende feature

### Test Data
Maak een `seed_test_data.js` script om test data te maken:
- 20 spelers met posities
- 10 gespeelde wedstrijden
- Random goals/assists

### Version Control
- Git gebruiken
- Branch per feature
- Tag releases (v2.0, v2.1, etc.)

### Database Backup
Voor elke schema wijziging:
```bash
cp voetbal.db voetbal_backup_$(date +%Y%m%d).db
```

---

**Welke feature ga je als eerst bouwen? 🚀**
