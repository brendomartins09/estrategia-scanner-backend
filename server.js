/*
BETTING STRATEGY SCANNER - BACKEND (Node.js/Express)

O que este servidor faz:
1. Guarda as estratégias criadas pelo usuário (competição, odd min/max, favorito/azarão,
   resultado casa/empate/fora, diferença de gols).
2. A cada X segundos, busca jogos de futebol e odds na API-Football e testa contra
   cada estratégia ativa.
3. Quando um jogo bate com uma estratégia, gera um "sinal" (sugestão) — NUNCA aposta
   sozinho. O app mostra o sinal com um botão para abrir a Betfair naquele jogo.

Instalar:
1. npm install express cors dotenv axios
2. Criar arquivo .env com: FOOTBALL_API_KEY=sua_chave_aqui
3. node server.js
*/

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ============================================================================
// CONFIG - API-Football (https://www.api-football.com/ ou via RapidAPI)
// ============================================================================

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || '';
const FOOTBALL_API_HOST = 'v3.football.api-sports.io';
const footballApi = axios.create({
    baseURL: `https://${FOOTBALL_API_HOST}`,
    headers: {
        'x-apisports-key': FOOTBALL_API_KEY
    },
    timeout: 15000
});

const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '120000', 10); // 2 min

// ============================================================================
// ESTADO EM MEMÓRIA (troque por um banco real se quiser persistência definitiva)
// ============================================================================

let strategies = [];   // estratégias criadas pelo usuário
let signals = [];      // sinais/sugestões geradas pelo scanner
let scanning = false;  // liga/desliga a varredura automática
let lastScanAt = null;
let scanErrors = [];

// ============================================================================
// MODELO DE ESTRATÉGIA
// ============================================================================
// {
//   id, name, active,
//   competitionId, competitionName,   // filtro de competição (liga)
//   oddMin, oddMax,                   // faixa de odd aceita
//   favorite: 'favorite' | 'underdog' | 'any',   // apostar no favorito ou azarão
//   result: 'home' | 'draw' | 'away' | 'any',    // resultado alvo
//   goalDiff: { op: 'gte'|'lte'|'eq', value: number } | null // diferença de gols esperada
// }

// ============================================================================
// ROTAS - ESTRATÉGIAS (CRUD)
// ============================================================================

app.get('/api/strategies', (req, res) => {
    res.json(strategies);
});

app.post('/api/strategies', (req, res) => {
    const {
        name, competitionId, competitionName,
        oddMin, oddMax, favorite, result, goalDiff, active
    } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Nome da estratégia é obrigatório' });
    }

    const strategy = {
        id: crypto.randomUUID(),
        name,
        active: active !== undefined ? !!active : true,
        competitionId: competitionId || null,
        competitionName: competitionName || 'Todas',
        oddMin: oddMin !== undefined && oddMin !== '' ? parseFloat(oddMin) : null,
        oddMax: oddMax !== undefined && oddMax !== '' ? parseFloat(oddMax) : null,
        favorite: favorite || 'any',       // 'favorite' | 'underdog' | 'any'
        result: result || 'any',           // 'home' | 'draw' | 'away' | 'any'
        goalDiff: goalDiff && goalDiff.value !== '' && goalDiff.value !== undefined
            ? { op: goalDiff.op || 'gte', value: parseInt(goalDiff.value, 10) }
            : null,
        createdAt: new Date().toISOString()
    };

    strategies.push(strategy);
    console.log(`[✓] Estratégia criada: ${strategy.name}`);
    res.json(strategy);
});

app.put('/api/strategies/:id', (req, res) => {
    const idx = strategies.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Estratégia não encontrada' });

    const body = req.body;
    strategies[idx] = {
        ...strategies[idx],
        ...body,
        oddMin: body.oddMin !== undefined && body.oddMin !== '' ? parseFloat(body.oddMin) : strategies[idx].oddMin,
        oddMax: body.oddMax !== undefined && body.oddMax !== '' ? parseFloat(body.oddMax) : strategies[idx].oddMax,
        goalDiff: body.goalDiff && body.goalDiff.value !== '' && body.goalDiff.value !== undefined
            ? { op: body.goalDiff.op || 'gte', value: parseInt(body.goalDiff.value, 10) }
            : strategies[idx].goalDiff
    };

    res.json(strategies[idx]);
});

app.delete('/api/strategies/:id', (req, res) => {
    strategies = strategies.filter(s => s.id !== req.params.id);
    res.json({ success: true });
});

// Ativar/pausar uma estratégia específica
app.post('/api/strategies/:id/toggle', (req, res) => {
    const strat = strategies.find(s => s.id === req.params.id);
    if (!strat) return res.status(404).json({ error: 'Estratégia não encontrada' });
    strat.active = !strat.active;
    res.json(strat);
});

// ============================================================================
// ROTAS - SCANNER (liga/desliga a varredura automática de jogos)
// ============================================================================

app.get('/api/scanner/status', (req, res) => {
    res.json({
        scanning,
        lastScanAt,
        activeStrategies: strategies.filter(s => s.active).length,
        totalSignals: signals.length,
        errors: scanErrors.slice(-5)
    });
});

app.post('/api/scanner/start', (req, res) => {
    if (!FOOTBALL_API_KEY) {
        return res.status(400).json({
            error: 'FOOTBALL_API_KEY não configurada. Adicione no arquivo .env'
        });
    }
    scanning = true;
    console.log('[✓] Scanner iniciado');
    res.json({ success: true, scanning });
});

app.post('/api/scanner/stop', (req, res) => {
    scanning = false;
    console.log('[✓] Scanner parado');
    res.json({ success: true, scanning });
});

// ============================================================================
// ROTAS - SINAIS (sugestões geradas pelo scanner)
// ============================================================================

app.get('/api/signals', (req, res) => {
    res.json(signals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/signals/clear', (req, res) => {
    signals = [];
    res.json({ success: true });
});

// ============================================================================
// MOTOR DE VARREDURA - busca jogos/odds e testa contra as estratégias
// ============================================================================

async function fetchTodayFixturesWithOdds() {
    const today = new Date().toISOString().split('T')[0];

    // 1. Jogos do dia
    const fixturesResp = await footballApi.get('/fixtures', {
        params: { date: today }
    });
    const fixtures = fixturesResp.data?.response || [];

    // 2. Odds do dia (bookmaker Betfair Exchange, se disponível; senão, mercado geral)
    const oddsResp = await footballApi.get('/odds', {
        params: { date: today }
    });
    const oddsByFixture = {};
    for (const item of (oddsResp.data?.response || [])) {
        oddsByFixture[item.fixture.id] = item.bookmakers || [];
    }

    return fixtures.map(f => ({
        fixture: f.fixture,
        league: f.league,
        teams: f.teams,
        goals: f.goals,
        bookmakers: oddsByFixture[f.fixture.id] || []
    }));
}

// Extrai a odd 1X2 (Match Winner) de um conjunto de bookmakers
function extractMatchWinnerOdds(bookmakers) {
    for (const bk of bookmakers) {
        const bet = (bk.bets || []).find(b => b.name === 'Match Winner');
        if (!bet) continue;
        const home = bet.values.find(v => v.value === 'Home');
        const draw = bet.values.find(v => v.value === 'Draw');
        const away = bet.values.find(v => v.value === 'Away');
        if (home && draw && away) {
            return {
                home: parseFloat(home.odd),
                draw: parseFloat(draw.odd),
                away: parseFloat(away.odd),
                bookmaker: bk.name
            };
        }
    }
    return null;
}

function matchesStrategy(strategy, game, odds) {
    // Competição
    if (strategy.competitionId && String(game.league.id) !== String(strategy.competitionId)) {
        return null;
    }

    // Determina o "favorito" pela menor odd entre casa/fora
    const homeOdd = odds.home;
    const awayOdd = odds.away;
    const favoriteSide = homeOdd <= awayOdd ? 'home' : 'away';
    const underdogSide = favoriteSide === 'home' ? 'away' : 'home';

    // Filtro favorito/azarão -> define qual seleção (casa/fora) é candidata
    let candidateSide = null;
    if (strategy.favorite === 'favorite') candidateSide = favoriteSide;
    else if (strategy.favorite === 'underdog') candidateSide = underdogSide;

    // Filtro resultado casa/empate/fora
    let targetSelection = strategy.result !== 'any' ? strategy.result : candidateSide;
    if (!targetSelection) {
        // sem filtro de favorito nem de resultado -> não há seleção definida, ignora
        return null;
    }
    if (strategy.result !== 'any' && candidateSide && strategy.result !== candidateSide) {
        // os dois filtros (favorito e resultado) apontam para lados diferentes -> incompatível
        return null;
    }

    const oddMap = { home: odds.home, draw: odds.draw, away: odds.away };
    const selectedOdd = oddMap[targetSelection];
    if (selectedOdd === undefined) return null;

    // Filtro faixa de odd
    if (strategy.oddMin !== null && selectedOdd < strategy.oddMin) return null;
    if (strategy.oddMax !== null && selectedOdd > strategy.oddMax) return null;

    // Filtro diferença de gols (aplica-se a jogos ao vivo/encerrados; em pré-jogo é ignorado)
    if (strategy.goalDiff && game.goals && game.goals.home !== null && game.goals.away !== null) {
        const diff = Math.abs(game.goals.home - game.goals.away);
        const { op, value } = strategy.goalDiff;
        if (op === 'gte' && !(diff >= value)) return null;
        if (op === 'lte' && !(diff <= value)) return null;
        if (op === 'eq' && !(diff === value)) return null;
    }

    const selectionLabel = { home: 'Casa', draw: 'Empate', away: 'Fora' }[targetSelection];

    return {
        selection: targetSelection,
        selectionLabel,
        odd: selectedOdd,
        bookmaker: odds.bookmaker
    };
}

async function runScan() {
    try {
        const games = await fetchTodayFixturesWithOdds();
        const activeStrategies = strategies.filter(s => s.active);

        for (const game of games) {
            const odds = extractMatchWinnerOdds(game.bookmakers);
            if (!odds) continue;

            for (const strategy of activeStrategies) {
                const match = matchesStrategy(strategy, game, odds);
                if (!match) continue;

                // Evita duplicar sinal do mesmo jogo+estratégia
                const already = signals.find(
                    s => s.fixtureId === game.fixture.id && s.strategyId === strategy.id
                );
                if (already) continue;

                const searchQuery = `${game.teams.home.name} vs ${game.teams.away.name}`;

                const signal = {
                    id: crypto.randomUUID(),
                    strategyId: strategy.id,
                    strategyName: strategy.name,
                    fixtureId: game.fixture.id,
                    league: game.league.name,
                    homeTeam: game.teams.home.name,
                    awayTeam: game.teams.away.name,
                    kickoff: game.fixture.date,
                    selection: match.selection,
                    selectionLabel: match.selectionLabel,
                    odd: match.odd,
                    bookmaker: match.bookmaker,
                    betfairSearchUrl: `https://www.betfair.com/exchange/plus/search?q=${encodeURIComponent(searchQuery)}`,
                    betfairAppSearch: searchQuery,
                    createdAt: new Date().toISOString()
                };

                signals.push(signal);
                console.log(`[⚡] Sinal: ${signal.homeTeam} x ${signal.awayTeam} -> ${signal.selectionLabel} @ ${signal.odd} (${strategy.name})`);
            }
        }

        lastScanAt = new Date().toISOString();
    } catch (err) {
        const message = err.response?.data?.message || err.message;
        console.error('[✗] Erro na varredura:', message);
        scanErrors.push({ message, at: new Date().toISOString() });
    }
}

// Loop de varredura
setInterval(() => {
    if (scanning) runScan();
}, SCAN_INTERVAL_MS);

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║   ESTRATEGIA SCANNER - BACKEND              ║
║   Rodando em: http://localhost:${PORT}         ║
╚════════════════════════════════════════════╝

API Endpoints:
✓ GET    /api/strategies              - Listar estratégias
✓ POST   /api/strategies              - Criar estratégia
✓ PUT    /api/strategies/:id          - Editar estratégia
✓ DELETE /api/strategies/:id          - Remover estratégia
✓ POST   /api/strategies/:id/toggle   - Ativar/pausar estratégia
✓ GET    /api/scanner/status          - Status da varredura
✓ POST   /api/scanner/start           - Ligar varredura automática
✓ POST   /api/scanner/stop            - Desligar varredura
✓ GET    /api/signals                 - Sinais/sugestões encontrados
✓ POST   /api/signals/clear           - Limpar sinais

${FOOTBALL_API_KEY ? '✓ FOOTBALL_API_KEY configurada' : '⚠ FOOTBALL_API_KEY não configurada - crie um .env'}
    `);
});
