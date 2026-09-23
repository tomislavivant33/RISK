// server.js — "Osvoji Svijet" multiplayer server
// Node.js + ws. Autoritativan server: drzi cijelo stanje igre i validira sve poteze.

const http = require('http');
const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// STATIČKI PODACI MAPE (moraju biti identični onima u client/index.html)
// ---------------------------------------------------------------------------
const CONTINENTS = {
  NA: { name: 'Sjeverna Amerika', bonus: 5, color: '#6b8f71' },
  SA: { name: 'Južna Amerika', bonus: 2, color: '#c98a4b' },
  EU: { name: 'Europa', bonus: 5, color: '#5b7ea6' },
  AF: { name: 'Afrika', bonus: 3, color: '#b56b5c' },
  AZ: { name: 'Azija', bonus: 7, color: '#8c7aa6' },
  AU: { name: 'Australija', bonus: 2, color: '#c9a24b' },
};

const TERRITORIES = [
  { id: 0, name: 'Aljaska', c: 'NA', x: 100, y: 80 },
  { id: 1, name: 'Kanada', c: 'NA', x: 165, y: 100 },
  { id: 2, name: 'Grenland', c: 'NA', x: 240, y: 55 },
  { id: 3, name: 'Meksiko', c: 'NA', x: 120, y: 165 },
  { id: 4, name: 'Venezuela', c: 'SA', x: 155, y: 230 },
  { id: 5, name: 'Peru', c: 'SA', x: 140, y: 285 },
  { id: 6, name: 'Brazil', c: 'SA', x: 195, y: 270 },
  { id: 7, name: 'Argentina', c: 'SA', x: 150, y: 335 },
  { id: 8, name: 'Island', c: 'EU', x: 265, y: 90 },
  { id: 9, name: 'Britanija', c: 'EU', x: 275, y: 122 },
  { id: 10, name: 'Francuska', c: 'EU', x: 305, y: 145 },
  { id: 11, name: 'Rusija Zapad', c: 'EU', x: 365, y: 110 },
  { id: 12, name: 'Egipat', c: 'AF', x: 305, y: 213 },
  { id: 13, name: 'Kongo', c: 'AF', x: 295, y: 262 },
  { id: 14, name: 'Južna Afrika', c: 'AF', x: 285, y: 322 },
  { id: 15, name: 'Madagaskar', c: 'AF', x: 345, y: 302 },
  { id: 16, name: 'Sibir', c: 'AZ', x: 435, y: 88 },
  { id: 17, name: 'Kina', c: 'AZ', x: 475, y: 152 },
  { id: 18, name: 'Indija', c: 'AZ', x: 425, y: 192 },
  { id: 19, name: 'Japan', c: 'AZ', x: 525, y: 128 },
  { id: 20, name: 'Zapadna Australija', c: 'AU', x: 480, y: 282 },
  { id: 21, name: 'Istočna Australija', c: 'AU', x: 535, y: 302 },
  { id: 22, name: 'Nova Gvineja', c: 'AU', x: 500, y: 252 },
  { id: 23, name: 'Indonezija', c: 'AU', x: 450, y: 252 },
];

const EDGE_LIST = [
  [0,1],[1,2],[1,3],[2,8],[3,4],
  [4,5],[4,6],[5,6],[5,7],[6,7],[6,13],
  [8,9],[9,10],[10,11],[10,12],[11,16],[11,18],
  [12,13],[12,18],[13,14],[13,15],
  [16,17],[16,18],[17,18],[17,19],
  [18,23],[19,23],
  [20,21],[20,22],[20,23],[21,22],[22,23],
];

const ADJ = {};
TERRITORIES.forEach(t => (ADJ[t.id] = new Set()));
EDGE_LIST.forEach(([a, b]) => { ADJ[a].add(b); ADJ[b].add(a); });

const BUILDINGS = {
  barracks: { name: 'Baraka', cost: 3, reinforceBonus: 2 },
  fortress: { name: 'Utvrda', cost: 5, defenseBonus: 1 },
};

const PLAYER_COLORS = ['#b23a3a', '#3a7ab2', '#3ab26a', '#d1962e', '#8a4fb2', '#6b7280'];

// ---------------------------------------------------------------------------
// POMOĆNE FUNKCIJE
// ---------------------------------------------------------------------------
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rollDie() { return 1 + Math.floor(Math.random() * 6); }

const rooms = new Map(); // code -> Room

class Room {
  constructor(code) {
    this.code = code;
    this.players = []; // {id, ws, name, color, connected}
    this.started = false;
    this.game = null;
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const p of this.players) {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
  }

  send(playerId, msg) {
    const p = this.players.find(pl => pl.id === playerId);
    if (p && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
  }

  playerList() {
    return this.players.map(p => ({ id: p.id, name: p.name, color: p.color, connected: p.connected, isHost: p.id === this.hostId }));
  }

  publicState() {
    if (!this.game) return null;
    const g = this.game;
    return {
      territories: g.territories,
      turnOrder: g.turnOrder,
      currentPlayerIndex: g.currentPlayerIndex,
      currentPlayerId: g.turnOrder[g.currentPlayerIndex],
      phase: g.phase,
      reinforcementsRemaining: g.reinforcementsRemaining,
      fortifyUsed: g.fortifyUsed,
      log: g.log.slice(-40),
      winner: g.winner,
      eliminated: g.eliminated,
    };
  }
}

function newId() { return Math.random().toString(36).slice(2, 10); }

// ---------------------------------------------------------------------------
// IGRA — logika
// ---------------------------------------------------------------------------
function startGame(room) {
  const playerIds = room.players.map(p => p.id);
  const territories = TERRITORIES.map(t => ({ id: t.id, owner: null, troops: 0, building: null }));

  const shuffledTerr = shuffle(territories.map(t => t.id));
  shuffledTerr.forEach((tid, i) => {
    const owner = playerIds[i % playerIds.length];
    territories[tid].owner = owner;
    territories[tid].troops = 3;
  });

  const turnOrder = shuffle(playerIds);
  room.game = {
    territories,
    turnOrder,
    currentPlayerIndex: 0,
    phase: 'reinforce',
    reinforcementsRemaining: 0,
    fortifyUsed: false,
    log: [],
    winner: null,
    eliminated: [],
  };
  room.started = true;
  room.game.reinforcementsRemaining = computeReinforcements(room.game, turnOrder[0]);
  const firstName = room.players.find(p => p.id === turnOrder[0]).name;
  room.game.log.push(`Igra je počela. Karte su podijeljene. Na potezu je ${firstName}.`);
}

function computeReinforcements(game, playerId) {
  const owned = game.territories.filter(t => t.owner === playerId);
  let total = Math.max(3, Math.floor(owned.length / 3));

  for (const [cid, cdata] of Object.entries(CONTINENTS)) {
    const contTerr = TERRITORIES.filter(t => t.c === cid).map(t => t.id);
    if (contTerr.every(tid => game.territories[tid].owner === playerId)) {
      total += cdata.bonus;
    }
  }

  const barracksCount = owned.filter(t => t.building === 'barracks').length;
  total += barracksCount * BUILDINGS.barracks.reinforceBonus;

  return total;
}

function currentPlayerId(game) { return game.turnOrder[game.currentPlayerIndex]; }

function checkElimination(room, loserId) {
  const game = room.game;
  const stillOwns = game.territories.some(t => t.owner === loserId);
  if (!stillOwns && game.turnOrder.includes(loserId) && !game.eliminated.includes(loserId)) {
    game.eliminated.push(loserId);
    game.turnOrder = game.turnOrder.filter(id => id !== loserId);
    const name = room.players.find(p => p.id === loserId)?.name || '?';
    game.log.push(`${name} je eliminiran iz igre.`);
    if (game.turnOrder.length === 1) {
      game.winner = game.turnOrder[0];
      const wname = room.players.find(p => p.id === game.winner)?.name || '?';
      game.log.push(`${wname} je osvojio svijet! 🏆`);
    }
  }
}

function advancePhase(room) {
  const game = room.game;
  if (game.winner) return;
  const order = ['reinforce', 'attack', 'build', 'fortify'];
  const idx = order.indexOf(game.phase);
  if (idx < order.length - 1) {
    game.phase = order[idx + 1];
  } else {
    // end turn -> next player
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
    game.phase = 'reinforce';
    game.fortifyUsed = false;
    const pid = currentPlayerId(game);
    game.reinforcementsRemaining = computeReinforcements(game, pid);
    const name = room.players.find(p => p.id === pid)?.name || '?';
    game.log.push(`— Red je na ${name}.`);
  }
}

// ---------------------------------------------------------------------------
// WEBSOCKET SERVER
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Osvoji Svijet server radi.\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  let roomRef = null;
  let playerId = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- CREATE ROOM ----
    if (msg.type === 'create_room') {
      const code = roomCode();
      const room = new Room(code);
      rooms.set(code, room);
      playerId = newId();
      const color = PLAYER_COLORS[0];
      room.players.push({ id: playerId, ws, name: msg.name || 'Igrač', color, connected: true });
      room.hostId = playerId;
      roomRef = room;
      ws.send(JSON.stringify({ type: 'room_created', code, playerId, players: room.playerList() }));
      return;
    }

    // ---- JOIN ROOM ----
    if (msg.type === 'join_room') {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Soba ne postoji.' })); return; }
      if (room.started) { ws.send(JSON.stringify({ type: 'error', message: 'Igra je već počela.' })); return; }
      if (room.players.length >= 6) { ws.send(JSON.stringify({ type: 'error', message: 'Soba je puna (max 6).' })); return; }
      playerId = newId();
      const usedColors = room.players.map(p => p.color);
      const color = PLAYER_COLORS.find(c => !usedColors.includes(c)) || PLAYER_COLORS[room.players.length % 6];
      room.players.push({ id: playerId, ws, name: msg.name || 'Igrač', color, connected: true });
      roomRef = room;
      ws.send(JSON.stringify({ type: 'room_joined', code: room.code, playerId, players: room.playerList() }));
      room.broadcast({ type: 'players_update', players: room.playerList() });
      return;
    }

    // ---- REJOIN (nakon reloada/prekida) ----
    if (msg.type === 'rejoin') {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Soba ne postoji.' })); return; }
      const p = room.players.find(pl => pl.id === msg.playerId);
      if (!p) { ws.send(JSON.stringify({ type: 'error', message: 'Igrač nije pronađen u sobi.' })); return; }
      p.ws = ws; p.connected = true;
      playerId = p.id; roomRef = room;
      ws.send(JSON.stringify({
        type: 'rejoined', code: room.code, playerId, players: room.playerList(),
        started: room.started, state: room.publicState(), hostId: room.hostId,
      }));
      room.broadcast({ type: 'players_update', players: room.playerList() });
      return;
    }

    if (!roomRef || !playerId) return;
    const room = roomRef;

    // ---- START GAME ----
    if (msg.type === 'start_game') {
      if (playerId !== room.hostId) return;
      if (room.players.length < 2) { ws.send(JSON.stringify({ type: 'error', message: 'Treba barem 2 igrača.' })); return; }
      if (room.started) return;
      startGame(room);
      room.broadcast({ type: 'game_started', state: room.publicState(), players: room.playerList() });
      return;
    }

    if (!room.started || !room.game) return;
    const game = room.game;

    // ---- PLACE REINFORCEMENT ----
    if (msg.type === 'place_reinforcement') {
      if (currentPlayerId(game) !== playerId || game.phase !== 'reinforce') return;
      if (game.reinforcementsRemaining <= 0) return;
      const t = game.territories[msg.territoryId];
      if (!t || t.owner !== playerId) return;
      t.troops += 1;
      game.reinforcementsRemaining -= 1;
      room.broadcast({ type: 'state_update', state: room.publicState() });
      return;
    }

    // ---- ATTACK ----
    if (msg.type === 'attack') {
      if (currentPlayerId(game) !== playerId || game.phase !== 'attack') return;
      const from = game.territories[msg.fromId];
      const to = game.territories[msg.toId];
      if (!from || !to) return;
      if (from.owner !== playerId || to.owner === playerId) return;
      if (!ADJ[msg.fromId] || !ADJ[msg.fromId].has(msg.toId)) return;
      if (from.troops < 2) return;

      const attackerDice = Math.max(1, Math.min(3, from.troops - 1, msg.diceCount || 3));
      let defenderDice = Math.min(2, to.troops);
      const rollsA = Array.from({ length: attackerDice }, rollDie).sort((a, b) => b - a);
      const rollsD = Array.from({ length: defenderDice }, rollDie).sort((a, b) => b - a);
      if (to.building === 'fortress' && rollsD.length) rollsD[0] = Math.min(6, rollsD[0] + BUILDINGS.fortress.defenseBonus);

      let attackerLosses = 0, defenderLosses = 0;
      const pairs = Math.min(rollsA.length, rollsD.length);
      for (let i = 0; i < pairs; i++) {
        if (rollsA[i] > rollsD[i]) defenderLosses++; else attackerLosses++;
      }
      from.troops -= attackerLosses;
      to.troops -= defenderLosses;

      const attackerName = room.players.find(p => p.id === playerId)?.name || '?';
      const defenderName = to.owner ? (room.players.find(p => p.id === to.owner)?.name || '?') : '?';
      const fromMeta = TERRITORIES[msg.fromId].name, toMeta = TERRITORIES[msg.toId].name;

      let conquered = false;
      if (to.troops <= 0) {
        conquered = true;
        const prevOwner = to.owner;
        to.owner = playerId;
        to.building = null;
        const minMove = attackerDice;
        const maxMove = from.troops - 1;
        const moveAmt = Math.max(minMove, Math.min(maxMove, msg.moveTroops || minMove));
        to.troops = moveAmt;
        from.troops -= moveAmt;
        game.log.push(`${attackerName} je osvojio ${toMeta} od ${defenderName}!`);
        checkElimination(room, prevOwner);
      } else {
        game.log.push(`${attackerName} (${fromMeta}) napada ${toMeta}: kocke ${rollsA.join(',')} vs ${rollsD.join(',')} → gubitci A:${attackerLosses} B:${defenderLosses}`);
      }

      room.broadcast({
        type: 'attack_result',
        fromId: msg.fromId, toId: msg.toId, rollsA, rollsD, attackerLosses, defenderLosses, conquered,
        state: room.publicState(),
      });
      return;
    }

    // ---- BUILD ----
    if (msg.type === 'build') {
      if (currentPlayerId(game) !== playerId || game.phase !== 'build') return;
      const t = game.territories[msg.territoryId];
      const bdef = BUILDINGS[msg.buildingType];
      if (!t || !bdef || t.owner !== playerId || t.building) return;
      if (t.troops <= bdef.cost) return; // mora ostati barem 1 vojnik
      t.troops -= bdef.cost;
      t.building = msg.buildingType;
      game.log.push(`${room.players.find(p => p.id === playerId)?.name} je izgradio ${bdef.name} na ${TERRITORIES[msg.territoryId].name}.`);
      room.broadcast({ type: 'state_update', state: room.publicState() });
      return;
    }

    // ---- FORTIFY ----
    if (msg.type === 'fortify') {
      if (currentPlayerId(game) !== playerId || game.phase !== 'fortify' || game.fortifyUsed) return;
      const from = game.territories[msg.fromId];
      const to = game.territories[msg.toId];
      if (!from || !to || from.owner !== playerId || to.owner !== playerId) return;
      if (!ADJ[msg.fromId] || !ADJ[msg.fromId].has(msg.toId)) return;
      const amount = Math.max(1, Math.min(msg.amount || 1, from.troops - 1));
      if (from.troops - amount < 1) return;
      from.troops -= amount;
      to.troops += amount;
      game.fortifyUsed = true;
      game.log.push(`${room.players.find(p => p.id === playerId)?.name} je premjestio ${amount} vojnika: ${TERRITORIES[msg.fromId].name} → ${TERRITORIES[msg.toId].name}.`);
      room.broadcast({ type: 'state_update', state: room.publicState() });
      return;
    }

    // ---- END PHASE ----
    if (msg.type === 'end_phase') {
      if (currentPlayerId(game) !== playerId) return;
      if (game.phase === 'reinforce' && game.reinforcementsRemaining > 0) return;
      advancePhase(room);
      room.broadcast({ type: 'state_update', state: room.publicState() });
      return;
    }

    // ---- CHAT ----
    if (msg.type === 'chat') {
      const p = room.players.find(pl => pl.id === playerId);
      room.broadcast({ type: 'chat', name: p?.name || '?', color: p?.color, text: String(msg.text || '').slice(0, 300) });
      return;
    }
  });

  ws.on('close', () => {
    if (!roomRef || !playerId) return;
    const p = roomRef.players.find(pl => pl.id === playerId);
    if (p) p.connected = false;
    roomRef.broadcast({ type: 'players_update', players: roomRef.playerList() });
    // pospremi prazne sobe bez igre nakon nekog vremena
    if (!roomRef.started && roomRef.players.every(pl => !pl.connected)) {
      setTimeout(() => {
        if (roomRef.players.every(pl => !pl.connected)) rooms.delete(roomRef.code);
      }, 60000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Osvoji Svijet server sluša na portu ${PORT}`));
