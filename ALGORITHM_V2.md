# Team Balancing Algoritme - Versie 2.1

## 🎯 Probleem (Was)

Het oude algoritme had een groot probleem: het keek alleen naar de **SOM** van Wilson scores, niet naar de **spreiding**.

### Voorbeeld:
```
Team Wit:  60% + 31% + 5% + 3% + 2% = 101% (1 superstar + 4 zwakke spelers)
Team Zwart: 30% + 21% + 19% + 16% + 14% = 100% (evenwichtig team)
```

Beide teams hebben gemiddeld 20% Wilson, maar:
- **Team Wit** is zeer onbalanced (range: 2%-60%)
- **Team Zwart** is veel evenwichtiger (range: 14%-30%)

In de praktijk is Team Zwart sterker omdat alle spelers redelijk zijn, terwijl Team Wit afhankelijk is van 1 speler.

---

## ✅ Oplossing (Nieuw)

Het nieuwe algoritme balanceert op **4 dimensies**:

### 1. Wilson Score Gemiddelde
Beide teams moeten ongeveer gelijk gemiddelde hebben (20% vs 20%)

### 2. **Wilson Spreiding (NIEUW!)**
Beide teams moeten **intern balanced** zijn.
- Gemeten met **standaarddeviatie (σ)**
- Lagere σ = beter (geen superstars met zwakke spelers)
- Krijgt **zwaarste gewicht** (50x)

### 3. Defensive Strength
Keeper + Verdediger + (Middenveld × 0.5) moet gelijk zijn

### 4. Offensive Strength
Aanvaller + (Middenveld × 0.5) moet gelijk zijn

---

## 🔢 Score Formule (V2.2)

```javascript
score =
  wilsonDiff × 100.0 +       // Gemiddelde Wilson: MEEST belangrijk
  spreadPenalty × 200.0 +    // Spreiding (variance): belangrijk maar niet dominant
  defenseDiff × 2.0 +        // Defense balans
  offenseDiff × 2.0 +        // Offense balans
  keeperPenalty              // Keeper mis-match
```

### Spreiding Berekening

```javascript
spreadPenalty = varianceA + varianceB;  // Som van variances (geen σ diff)
```

**Waarom deze formule?**

**V2.0 probleem:** `stdDevA + stdDevB` gaf bijna geen verschil (0.2%)

**V2.1 probleem:** `(varianceA + varianceB) + |stdDevA - stdDevB| * 2` zorgde ervoor dat het algoritme teams verkoos met **vergelijkbare σ waarden**, zelfs als Wilson gemiddeldes totaal anders waren!

Voorbeeld:
- Teams met Wilson 14% vs 26% maar σ verschil 3.5% → lage penalty
- Teams met Wilson 20% vs 20% maar σ verschil 16% → hoge penalty
- Algoritme koos foutief de eerste optie!

**V2.2 oplossing:**
- Verwijder σ diff penalty
- Verhoog Wilson gewicht: 30 → **100**
- Verlaag spread gewicht: 500 → **200**

**Het algoritme geeft nu prioriteit aan:**
1. **Gelijk Wilson gemiddelde** (beide teams ~20% skill level)
2. **Lage totale variance** (geen extreme waarden)
3. Positie balans (DEF/OFF)

---

## 📊 Nieuwe Output

Teams tonen nu standaarddeviatie:

```
⬜ Team Wit
   Wilson: 20.0% (σ=8.5%) | DEF: 2.5 | OFF: 2.5
- Erhan [V] (W:18% | 1W/7G)
- Izzet [M] (W:15% | 1W/9G)
- Gokdeniz [M] (W:22% | 6W/10G)
- Ramazan [M] (W:28% | 9W/10G)
- Mehmet [A] (W:17% | 1W/4G)

⬛ Team Zwart
   Wilson: 20.0% (σ=5.2%) | DEF: 2.0 | OFF: 3.0
- Samet [K] (W:19% | 3W/6G)
- Salim [M] (W:17% | 4W/12G)
- Ilkay [M] (W:21% | 5W/11G)
- Emre-b [A] (W:23% | 4W/6G)
- Seymen [A] (W:20% | 3W/7G)
```

**σ = standaarddeviatie**
- Lagere σ = beter (meer balanced team)
- Team Zwart (σ=5.2%) is veel evenwichtiger dan Team Wit (σ=8.5%)

---

## 🎮 Waarom is dit beter?

### Probleem met oude methode:
- Team met 1 superstar (60%) + 4 zwakke spelers (3-5%) werd als "goed" beschouwd
- In werkelijkheid verliest zo'n team vaak, want 1 speler kan niet alles doen

### Voordeel nieuwe methode:
- Teams hebben vergelijkbare spreiding
- Alle spelers zijn ongeveer gelijk niveau
- Matches zijn spannender en eerlijker
- Geen "carry" scenario's waar 1 speler het team draagt

---

## 🔧 Technische Details

### calcWilsonVariance(team)
Berekent variance van Wilson scores (voor exponentiële penalty):

```javascript
function calcWilsonVariance(team) {
  const rates = team.map(p => p.rate);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / rates.length;
  return variance; // variance = stddev²
}
```

### calcWilsonStdDev(team)
Berekent standaarddeviatie van Wilson scores (voor display):

```javascript
function calcWilsonStdDev(team) {
  const rates = team.map(p => p.rate);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / rates.length;
  return Math.sqrt(variance);
}
```

### Voorbeeld berekening:

**Team A:** [0.60, 0.31, 0.05, 0.03, 0.02]
- Mean: 0.202
- Variance: ((0.60-0.202)² + (0.31-0.202)² + ...) / 5 = 0.0445
- StdDev: √0.0445 = **0.211** (21.1%) ❌ Hoge spreiding!

**Team B:** [0.30, 0.21, 0.19, 0.16, 0.14]
- Mean: 0.200
- Variance: ((0.30-0.200)² + ... ) / 5 = 0.0032
- StdDev: √0.0032 = **0.057** (5.7%) ✅ Lage spreiding!

Team B is veel beter balanced!

---

## 🎯 Resultaat

**Voor jouw voorbeeld (10 spelers):**
- Oude methode: 1 superstar (60%) met 4 zwakke spelers → Oneerlijk
- Nieuwe methode: Beide teams hebben spelers in 14-30% range → Eerlijk!

**Matches worden:**
- Spannender (geen dominante speler)
- Eerlijker (beide teams vergelijkbaar niveau)
- Leuker (iedereen kan impact maken)

---

## 🚀 Testen

Om te testen of het werkt:
1. Start app: `node app.js`
2. Maak match met 10 spelers
3. Run `/teams`
4. Check σ waarden → moeten dicht bij elkaar liggen!

Verwachting: beide teams σ tussen 3-10% (niet 2% vs 21%!)

---

## 🐛 Bug Fix V2.1: Waarom de eerste versie niet werkte

### Het Probleem
Na de eerste implementatie produceerde het algoritme NOG STEEDS unbalanced teams:
```
Team Wit:  Wilson: 20.0% (σ=22.6%) | DEF: 2.5 | OFF: 2.5
Team Zwart: Wilson: 20.0% (σ=5.6%) | DEF: 2.0 | OFF: 3.0
```

Team Wit had 1 superstar (60%) met 4 zwakke spelers (2-5%), terwijl Team Zwart balanced was.

### Root Cause Analyse
De originele `spreadPenalty` berekening was:
```javascript
const spreadPenalty = stdDevA + stdDevB;
score = ... + spreadPenalty * 50.0 + ...
```

**Probleem:** De som van stddevs geeft bijna geen verschil:
- Team unbalanced: 0.226 + 0.056 = **0.282**
- Team balanced: 0.14 + 0.14 = **0.28**
- Verschil: 0.002 × 50 = **0.1 punt** (te weinig!)

### De Fix
**1. Gebruik variance (stddev²) in plaats van stddev:**
```javascript
const varianceA = calcWilsonVariance(teamA); // 0.051 vs 0.0196
const varianceB = calcWilsonVariance(teamB);
```

Waarom? Variance maakt hoge spreiding exponentieel duurder:
- σ=22.6% → variance=5.1%
- σ=14% → variance=2.0%
- Verschil is nu **2.5x groter**

**2. Penaliseer verschil tussen teams:**
```javascript
const spreadPenalty = (varianceA + varianceB) + Math.abs(stdDevA - stdDevB) * 2;
```

Als Team A σ=22.6% en Team B σ=5.6%:
- Verschil: |22.6 - 5.6| = **17%**
- Extra penalty: 0.17 × 2 = **0.34**

**3. Verhoog gewicht van 50 → 500:**
```javascript
score = ... + spreadPenalty * 500.0 + ...
```

### Resultaat Na Fix
Voor het probleem scenario:
- **Onbalanced verdeling:**
  - variance: (0.051 + 0.003) = 0.054
  - σ diff: |0.226 - 0.056| = 0.17
  - spreadPenalty = 0.054 + 0.17×2 = **0.394**
  - Met weight: 0.394 × 500 = **197 punten!**

- **Balanced verdeling:**
  - variance: (0.020 + 0.020) = 0.040
  - σ diff: |0.14 - 0.14| = 0
  - spreadPenalty = 0.040 + 0 = **0.040**
  - Met weight: 0.040 × 500 = **20 punten**

**Verschil: 197 vs 20 = 177 punten verschil!**

Dit is nu **veel groter** dan andere penalties (DEF/OFF verschillen zijn typisch 2-5 punten), dus het algoritme zal altijd de balanced optie kiezen.
