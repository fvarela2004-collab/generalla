const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const os      = require('os');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

const rooms  = {};
// CATEGORÍAS FINALES: numeros + full + poker + escalera + generalla + generalla doble
// Sin chance, sin bonus superior
const CATS   = ['ones','twos','threes','fours','fives','sixes','full','poker','escalera','gen','gen2'];
const COLORS = ['#c9a84c','#4a90d9','#e74c3c','#2ecc71','#9b59b6','#e67e22'];

function emptyScore(){
  const s = {};
  CATS.forEach(k => s[k] = null);
  return s;
}
function rollAll(){
  return Array.from({length:5}, () => Math.floor(Math.random()*6)+1);
}
function rollSome(dice, kept){
  return dice.map((v,i) => kept[i] ? v : Math.floor(Math.random()*6)+1);
}
function allSame(d){ return d.every(v => v === d[0]); }

// firstRoll = acaba de hacer el 1er tiro (rollsLeft pasó de 3 a 2)
function calcCat(id, dice, rollsLeft){
  const firstRoll = (rollsLeft === 2);
  const ct = {};
  dice.forEach(d => ct[d] = (ct[d]||0)+1);
  const vals = Object.values(ct).sort((a,b) => b-a);

  switch(id){
    case 'ones':   return dice.filter(d=>d===1).reduce((a,b)=>a+b,0);
    case 'twos':   return dice.filter(d=>d===2).reduce((a,b)=>a+b,0);
    case 'threes': return dice.filter(d=>d===3).reduce((a,b)=>a+b,0);
    case 'fours':  return dice.filter(d=>d===4).reduce((a,b)=>a+b,0);
    case 'fives':  return dice.filter(d=>d===5).reduce((a,b)=>a+b,0);
    case 'sixes':  return dice.filter(d=>d===6).reduce((a,b)=>a+b,0);

    case 'full': {
      const ok = (vals[0]===3 && vals[1]===2) || vals[0]===5;
      if (!ok) return 0;
      return firstRoll ? 35 : 30;
    }
    case 'poker': {
      if (vals[0] < 4) return 0;
      return firstRoll ? 45 : 40;
    }
    case 'escalera': {
      const u = [...new Set(dice)].sort((a,b)=>a-b);
      if (u.length < 5) return 0;
      let seq = 1, max = 1;
      for (let i=1; i<u.length; i++){
        if (u[i] === u[i-1]+1) seq++; else seq = 1;
        max = Math.max(max, seq);
      }
      if (max < 5) return 0;
      return firstRoll ? 25 : 20;
    }
    case 'gen': {
      if (!allSame(dice)) return 0;
      return firstRoll ? 100 : 50;
    }
    case 'gen2': {
      // solo disponible si gen ya fue anotada con valor > 0
      if (!allSame(dice)) return 0;
      return 100;
    }
    default: return 0;
  }
}

function calcTotal(sc){
  if (!sc) return 0;
  return CATS.reduce((sum, k) => sum + (sc[k] || 0), 0);
}

function curPlayer(G){
  if (!G.turnOrder.length) return null;
  return G.turnOrder[G.currentTurn % G.turnOrder.length];
}
function broadcast(rid, ev, data){ io.to(rid).emit(ev, data); }
function pname(G, pid){ return G.players.find(p=>p.id===pid)?.name || '?'; }

function advanceTurn(room){
  const G = room.G;
  G.currentTurn = (G.currentTurn + 1) % G.turnOrder.length;
  // check game over
  const done = G.turnOrder.every(pid =>
    CATS.every(k => { const sc = G.scores[pid]; return sc && sc[k] !== null && sc[k] !== undefined; })
  );
  if (done){ G.phase = 'results'; return; }
  G.dice     = rollAll();
  G.kept     = [false,false,false,false,false];
  G.rollsLeft = 3;
  G.scored   = false;
  G.log      = '¡Le toca a ' + pname(G, curPlayer(G)) + '!';
  startTurnTimer(room);
}

function startTurnTimer(room){
  clearTimeout(room.timerHandle);
  if (!room.G.config.turnTime) return;
  room.timerHandle = setTimeout(() => autoScore(room), room.G.config.turnTime * 1000);
}

// auto-score: anota en la casilla disponible de mayor valor. si ninguna tiene valor, anota 0 en la de menor "costo"
function autoScore(room){
  const G = room.G;
  if (G.phase !== 'game') return;
  const pid = curPlayer(G);
  const sc  = G.scores[pid];
  if (!sc) return;
  // make sure we rolled at least once
  if (G.rollsLeft === 3){ G.dice = rollAll(); G.rollsLeft = 2; }
  
  // find best available category
  let best = { id: null, val: -1 };
  CATS.forEach(k => {
    if (sc[k] !== null && sc[k] !== undefined) return; // already scored
    if (k === 'gen2' && (!sc.gen || sc.gen === 0)) return; // gen2 locked
    const v = calcCat(k, G.dice, G.rollsLeft);
    if (v > best.val) best = { id: k, val: v };
  });

  // if no category gives points, find any available and score 0
  if (!best.id || best.val <= 0){
    // prefer lower-value cats to sacrifice (ones, twos...)
    const order = ['ones','twos','threes','fours','fives','sixes','full','poker','escalera','gen','gen2'];
    for (const k of order){
      if (sc[k] === null || sc[k] === undefined){
        if (k === 'gen2' && (!sc.gen || sc.gen === 0)) continue;
        best = { id: k, val: 0 };
        break;
      }
    }
  }

  if (best.id){
    sc[best.id] = Math.max(0, best.val);
    G.log = 'Tiempo agotado. Se anotó ' + sc[best.id] + ' en ' + best.id + '.';
    advanceTurn(room);
    broadcast(G.roomId, 'STATE', G);
  }
}

function genCode(){
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0; i<6; i++) s += c[Math.floor(Math.random()*c.length)];
  return rooms[s] ? genCode() : s;
}

io.on('connection', socket => {
  let currentRoom = null;

  socket.on('CREATE', ({name}) => {
    const roomId = genCode();
    const G = {
      phase: 'lobby', roomId,
      players: [{id: socket.id, name, color: COLORS[0], host: true}],
      turnOrder: [], currentTurn: 0,
      dice: [1,1,1,1,1], kept: [false,false,false,false,false],
      rollsLeft: 3, scored: false, scores: {},
      config: {turnTime: 90, maxPlayers: 6},
      log: 'Mesa creada. Compartí el código con tus amigos.',
    };
    G.scores[socket.id] = emptyScore();
    rooms[roomId] = {G, hostId: socket.id, sockets: new Set([socket.id]), timerHandle: null};
    currentRoom = roomId;
    socket.join(roomId);
    socket.emit('CREATED', {roomId});
    socket.emit('STATE', G);
  });

  socket.on('JOIN', ({roomId, name}) => {
    const room = rooms[roomId];
    if (!room)                                              { socket.emit('ERR','Sala no encontrada. Verificá el código.'); return; }
    if (room.G.phase !== 'lobby')                           { socket.emit('ERR','La partida ya empezó, no podés entrar.'); return; }
    if (room.G.players.length >= (room.G.config.maxPlayers||6)) { socket.emit('ERR','La mesa está completa, che.'); return; }
    if (room.G.players.find(p => p.id === socket.id))       { socket.emit('STATE', room.G); return; }
    const color = COLORS[room.G.players.length % COLORS.length];
    room.G.players.push({id: socket.id, name, color});
    room.G.scores[socket.id] = emptyScore();
    room.G.log = name + ' se sumó a la mesa.';
    room.sockets.add(socket.id);
    currentRoom = roomId;
    socket.join(roomId);
    broadcast(roomId, 'STATE', room.G);
    broadcast(roomId, 'SYS', {txt: name + ' se sumó a la mesa 🎲'});
  });

  socket.on('KICK', ({targetId}) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id || room.G.phase !== 'lobby') return;
    room.G.players = room.G.players.filter(p => p.id !== targetId);
    delete room.G.scores[targetId];
    room.sockets.delete(targetId);
    io.to(targetId).emit('KICKED');
    broadcast(currentRoom, 'STATE', room.G);
    broadcast(currentRoom, 'SYS', {txt: 'Un jugador fue removido de la sala.'});
  });

  socket.on('CONFIG', ({turnTime, maxPlayers}) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    if (turnTime  !== undefined) room.G.config.turnTime  = turnTime;
    if (maxPlayers !== undefined) room.G.config.maxPlayers = maxPlayers;
    broadcast(currentRoom, 'STATE', room.G);
  });

  socket.on('START', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    if (room.G.players.length < 2) { socket.emit('ERR','Necesitás al menos 2 jugadores.'); return; }
    const G = room.G;
    G.turnOrder  = [...G.players.map(p=>p.id)].sort(() => Math.random()-.5);
    G.currentTurn = 0; G.phase = 'game';
    G.dice = rollAll(); G.kept = [false,false,false,false,false];
    G.rollsLeft = 3; G.scored = false;
    G.log = '¡Empezó la partida! Le toca a ' + pname(G, G.turnOrder[0]) + '.';
    broadcast(currentRoom, 'STATE', G);
    broadcast(currentRoom, 'SYS', {txt: '¡Que empiece el partido! 🎲'});
    startTurnTimer(room);
  });

  socket.on('ACTION', ({type, payload}) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.G.phase !== 'game') return;
    const G   = room.G;
    const pid = curPlayer(G);
    if (socket.id !== pid) return;

    if (type === 'TOGGLE'){
      if (G.rollsLeft === 3 || G.scored) return;
      G.kept[payload.idx] = !G.kept[payload.idx];
      broadcast(currentRoom, 'STATE', G);
      return;
    }

    if (type === 'ROLL'){
      if (G.rollsLeft <= 0) return;
      G.dice = rollSome(G.dice, G.kept);
      G.rollsLeft--;
      const r    = 4 - G.rollsLeft;
      const kept = G.dice.filter((_,i) => G.kept[i]);
      G.log = 'Tiro '+r+'/3: ['+G.dice.join('-')+']'+(kept.length?' · guardó ['+kept.join(',')+']':'');

      // Generalla servida en 1er tiro → gana automáticamente
      if (allSame(G.dice) && G.rollsLeft === 2){
        const sc = G.scores[pid];
        if (sc.gen === null || sc.gen === undefined){
          G.log = '¡GENERALLA SERVIDA! ¡Ganaste automáticamente! 🎉';
          broadcast(currentRoom, 'SYS', {txt: '🎲 ¡GENERALLA SERVIDA de '+pname(G,pid)+'! Gana automáticamente.'});
          sc.gen = 100;
          CATS.forEach(k => { if (sc[k]===null||sc[k]===undefined) sc[k] = 0; });
          G.phase = 'results';
          broadcast(currentRoom, 'STATE', G);
          return;
        }
      }

      if (allSame(G.dice)){
        broadcast(currentRoom, 'SYS', {txt: '🎲 Generalla de '+pname(G,pid)+'!'});
      }

      // Si se usaron todos los tiros → anotar automáticamente sin necesidad de apretar botón
      if (G.rollsLeft === 0){
        autoScoreImmediate(room);
        return;
      }

      broadcast(currentRoom, 'STATE', G);
      return;
    }

    if (type === 'SCORE_MODE'){
      if (G.scored) return;
      G.scored = true;
      G.log = '¿Qué anotás? Elegí una casilla del marcador.';
      broadcast(currentRoom, 'STATE', G);
      return;
    }

    if (type === 'SCORE'){
      const {cat, val} = payload;
      const sc = G.scores[pid];
      if (!sc || (sc[cat] !== null && sc[cat] !== undefined)) return;
      if (cat === 'gen2'){
        if (!sc.gen || sc.gen === 0) return;
        if (!allSame(G.dice)) return;
      }
      const realVal = calcCat(cat, G.dice, G.rollsLeft);
      sc[cat] = (val === 0) ? 0 : realVal;
      G.log = pname(G,pid) + ' anotó ' + sc[cat] + ' en ' + cat + '.';
      clearTimeout(room.timerHandle);
      advanceTurn(room);
      broadcast(currentRoom, 'STATE', G);
      return;
    }
  });

  socket.on('CHAT', ({txt, col}) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom]; if (!room) return;
    broadcast(currentRoom, 'CHAT', {
      name: pname(room.G, socket.id),
      txt:  String(txt).slice(0,120),
      col, from: socket.id
    });
  });

  socket.on('REACTION', ({emoji, label}) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom]; if (!room) return;
    broadcast(currentRoom, 'REACTION', {emoji, label, name: pname(room.G, socket.id), from: socket.id});
  });

  socket.on('REMATCH', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    const G = room.G;
    G.players.forEach(p => { G.scores[p.id] = emptyScore(); });
    G.turnOrder  = [...G.players.map(p=>p.id)].sort(()=>Math.random()-.5);
    G.currentTurn = 0; G.phase = 'game';
    G.dice = rollAll(); G.kept = [false,false,false,false,false];
    G.rollsLeft = 3; G.scored = false;
    G.log = '¡Revancha! Que los dados rueden.';
    broadcast(currentRoom, 'STATE', G);
    startTurnTimer(room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom]; if (!room) return;
    room.sockets.delete(socket.id);
    const p = room.G.players.find(p => p.id === socket.id);
    if (p){
      broadcast(currentRoom, 'SYS', {txt: p.name + ' se desconectó.'});
      if (room.hostId === socket.id && room.sockets.size > 0){
        const newHost = [...room.sockets][0];
        room.hostId = newHost;
        room.G.players.forEach(pl => pl.host = pl.id === newHost);
        broadcast(currentRoom, 'STATE', room.G);
        broadcast(currentRoom, 'SYS', {txt: pname(room.G, newHost) + ' es el nuevo host.'});
      }
    }
    if (room.sockets.size === 0){ clearTimeout(room.timerHandle); delete rooms[currentRoom]; }
  });
});

// Anotar automáticamente cuando se agotaron los tiros (sin necesidad de presionar botón)
function autoScoreImmediate(room){
  const G   = room.G;
  const pid = curPlayer(G);
  const sc  = G.scores[pid];
  if (!sc) return;

  let best = {id: null, val: -1};
  CATS.forEach(k => {
    if (sc[k] !== null && sc[k] !== undefined) return;
    if (k === 'gen2' && (!sc.gen || sc.gen === 0)) return;
    const v = calcCat(k, G.dice, G.rollsLeft);
    if (v > best.val) best = {id: k, val: v};
  });
  if (!best.id || best.val <= 0){
    const order = ['ones','twos','threes','fours','fives','sixes','full','poker','escalera','gen','gen2'];
    for (const k of order){
      if (sc[k] === null || sc[k] === undefined){
        if (k === 'gen2' && (!sc.gen || sc.gen === 0)) continue;
        best = {id: k, val: 0};
        break;
      }
    }
  }
  if (best.id){
    sc[best.id] = Math.max(0, best.val);
    G.log = 'Se anotó ' + sc[best.id] + ' en ' + best.id + '.';
    clearTimeout(room.timerHandle);
    advanceTurn(room);
    broadcast(G.roomId, 'STATE', G);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎲  GENERALLA ONLINE corriendo en puerto ' + PORT + '\n');
  const nets = os.networkInterfaces();
  Object.values(nets).flat()
    .filter(n => n.family==='IPv4' && !n.internal)
    .forEach(n => console.log('  http://' + n.address + ':' + PORT));
  console.log();
});
