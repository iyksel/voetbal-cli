# ⚽ Positie Systeem - Nieuwe Features

## 🎯 Wat is er nieuw?

Je voetbal-bot heeft nu een **positie systeem**! Elke speler kan nu een positie hebben:
- **keeper** 🧤
- **verdediger** 🛡️
- **middenveld** ⚙️
- **aanvaller** ⚡

## 📥 Installatie

### Stap 1: Draai de migratie
Voor **bestaande databases**, voer dit uit om de positie kolom toe te voegen:

```bash
node migrate_add_positions.js
```

### Stap 2: Start de app
```bash
node app.js
```

Voor **nieuwe databases** is de migratie niet nodig - het schema bevat al de positie kolom.

## 🎮 Hoe te gebruiken

### Positie instellen bij login
```bash
/as ilkay verdediger
/as Jan keeper
/as Marie aanvaller
```

### Positie later wijzigen
```bash
/positie middenveld
```

### Teams bekijken met posities
Wanneer je `/teams` of `/status` doet, zie je nu posities:
```
⬜ Team Wit (avg wilson 54.2%)
- Jan [keeper] (60% | wilson 58% | 6/10)
- Ilkay [verdediger] (50% | wilson 48% | 5/10)
- Marie [aanvaller] (55% | wilson 52% | 11/20)
```

### Ranglijst met posities
```bash
/lijst
```
Output:
```
1. Jan [keeper] — 60.0% (6/10)
2. Marie [aanvaller] — 55.0% (11/20)
3. Ilkay [verdediger] — 50.0% (5/10)
```

## 🤖 Hoe werkt team balancing?

Het algoritme probeert nu **twee dingen** te balanceren:

1. **Wilson Score** (skill level) - zo eerlijk mogelijk
2. **Posities** - ideale verdeling per team:
   - 1 keeper
   - 2 verdedigers
   - 1 middenveld
   - 1 aanvaller

### Voorbeeld
Als je 10 spelers hebt met verschillende posities, zal het algoritme proberen:
- Team Wit: 1 keeper, 2 verdedigers, 1 middenveld, 1 aanvaller
- Team Zwart: 1 keeper, 2 verdedigers, 1 middenveld, 1 aanvaller

En tegelijkertijd beide teams ongeveer gelijk qua skill level houden!

### Wat als er geen keepers zijn?
Geen probleem! Het algoritme is **flexibel**:
- Als er 0 keepers zijn → beide teams 0 keepers
- Als er 1 keeper is → 1 team krijgt keeper, ander team niet
- Als er 3 keepers zijn → verdeling 2-1 of wat het beste past

## 📊 Verbeteringen voor teams

### Voorheen:
Teams werden **alleen** gebalanceerd op Wilson Score (skill).

### Nu:
Teams worden gebalanceerd op:
1. **Posities** (35% gewicht) - zorgt voor goede teamsamenstelling
2. **Wilson Score** (65% gewicht) - zorgt voor eerlijke skill verdeling

Dit maakt wedstrijden **realistischer en leuker**! 🎉

## 🔧 Technische details

### Schema wijziging
```sql
ALTER TABLE players ADD COLUMN position TEXT
CHECK(position IN ('keeper', 'verdediger', 'middenveld', 'aanvaller'));
```

### Penalty systeem
Het algoritme gebruikt penalties voor slechte positie-verdelingen:
- **Keeper**: 10 punten per afwijking (meest kritisch!)
- **Verdediger**: 3 punten per afwijking
- **Middenveld/Aanvaller**: 2 punten per afwijking

### Formule
```
score = (wilson_diff * 2) + position_penalty
```

Lagere score = betere team verdeling

## 🚀 Extra features die je nu kan toevoegen

Nu je posities hebt, zijn deze features makkelijk:

1. **Formation selector** - kies 4-3-3 vs 3-4-3
2. **Position stats** - welke positie wint het meest?
3. **Beste positie per speler** - track welke positie het beste werkt
4. **Captain systeem** - keeper is automatisch captain
5. **Substituten** - vervang per positie

## ❓ FAQ

**Q: Moet elke speler een positie hebben?**
A: Nee! Als een speler geen positie heeft, wordt hij normaal meegenomen in het algoritme.

**Q: Kan ik meerdere posities hebben?**
A: Momenteel niet, maar je kan dit uitbreiden naar een many-to-many relatie.

**Q: Wat als ik alleen 1 keeper heb?**
A: Geen probleem - één team krijgt de keeper, het andere niet. Het algoritme is flexibel.

**Q: Worden oude wedstrijden beïnvloed?**
A: Nee - alleen nieuwe team generation gebruikt posities. Oude results blijven ongewijzigd.

## 📝 Changelog

### v2.0 - Positie Systeem
- ✅ Positie kolom toegevoegd aan players tabel
- ✅ Team balancing met positie-awareness
- ✅ `/as <naam> <positie>` command uitgebreid
- ✅ `/positie <positie>` command toegevoegd
- ✅ Posities zichtbaar in `/status`, `/teams`, `/lijst`
- ✅ Migratie script voor bestaande databases

---

**Veel plezier met het positie systeem! ⚽🎉**
