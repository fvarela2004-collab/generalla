const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const os      = require('os');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

const rooms = {};

const CATS = ['ones','twos','threes','fours','fives','sixes','poker','full','small','large','gen','chance'];

function emptyScore() {
  const s = {};
  CATS.forEach(k => s[k] = null);
  s.gen_bonus = 0;
  return s;
}
function rollAll() { return Array.from({length:5}, ()=>Math.floor(Math.random()*6)+1); }
function rollSome(dice, kept) { return dice.map((v,i)=>kept[i]?v:Math.floor(Math.random()*6)+1); }
function allSame(d) { return d.every(v=>v===d[0]); }

function calcCat(id, dice, rollsLeft) {
  const ct={};dice.forEach(d=>ct[d]=(ct[d]||0)+1);
  const sum=dice.reduce((a,b)=>a+b,0);
  const vals=Object.values(ct).sort((a,b)=>b-a);
  switch(id){
    case 'ones':   return dice.filter(d=>d===1).reduce((a,b)=>a+b,0);
    case 'twos':   return dice.filter(d=>d===2).reduce((a,b)=>a+b,0);
    case 'threes': return dice.filter(d=>d===3).reduce((a,b)=>a+b,0);
    case 'fours':  return dice.filter(d=>d===4).reduce((a,b)=>a+b,0);
    case 'fives':  return dice.filter(d=>d===5).reduce((a,b)=>a+b,0);
    case 'sixes':  return dice.filter(d=>d===6).reduce((a,b)=>a+b,0);
    case 'poker':  return vals[0]>=4?sum:0;
    case 'full':   return (vals[0]===3&&vals[1]===2)||vals[0]===5?25:0;
    case 'small':{const u=[...new Set(dice)].sort((a,b)=>a-b);let b=1,c=1;for(let i=1;i<u.length;i++){if(u[i]===u[i-1]+1)c++;else c=1;b=Math.max(b,c);}return b>=4?30:0;}
    case 'large':{const u=[...new Set(dice)].sort((a,b)=>a-b);if(u.length<5)return 0;let s=1;for(let i=1;i<u.length;i++){if(u[i]===u[i-1]+1)s++;else s=1;}return s>=5?40:0;}
    case 'gen':    return allSame(dice)?(rollsLeft===2?100:50):0;
    case 'chance': return sum;
    default: return 0;
  }
}

function upperSum(sc){return['ones','twos','threes','fours','fives','sixes'].reduce((a,k)=>a+(sc[k]||0),0);}
function calcTotal(sc){if(!sc)return 0;let t=CATS.reduce((a,k)=>a+(sc[k]||0),0);if(upperSum(sc)>=63)t+=35;return t+(sc.gen_bonus||0);}
function curPlayer(G){if(!G.turnOrder.length)return null;return G.turnOrder[G.currentTurn%G.turnOrder.length];}
function broadcast(roomId,ev,data){io.to(roomId).emit(ev,data);}
function pname(G,pid){return G.players.find(p=>p.id===pid)?.name||'?';}

function advanceTurn(room){
  const G=room.G;
  G.currentTurn=(G.currentTurn+1)%G.turnOrder.length;
  const done=G.turnOrder.every(pid=>CATS.every(k=>{const sc=G.scores[pid];return sc&&sc[k]!==null&&sc[k]!==undefined;}));
  if(done){G.phase='results';return;}
  G.dice=rollAll();G.kept=[false,false,false,false,false];G.rollsLeft=3;G.scored=false;
  G.log='¡Le toca a '+pname(G,curPlayer(G))+'!';
  startTurnTimer(room);
}

function startTurnTimer(room){
  clearTimeout(room.timerHandle);
  const secs=room.G.config.turnTime;
  if(!secs)return;
  room.timerHandle=setTimeout(()=>autoScore(room),secs*1000);
}

function autoScore(room){
  const G=room.G;
  if(G.phase!=='game')return;
  const pid=curPlayer(G);const sc=G.scores[pid];if(!sc)return;
  if(G.rollsLeft===3){G.dice=rollAll();G.rollsLeft--;}
  let best={id:null,val:-1};
  CATS.forEach(k=>{if(sc[k]===null||sc[k]===undefined){const v=calcCat(k,G.dice,G.rollsLeft);if(v>best.val)best={id:k,val:v};}});
  if(!best.id){const k=CATS.find(k=>sc[k]===null||sc[k]===undefined);if(k)best={id:k,val:0};}
  if(best.id){
    sc[best.id]=Math.max(0,best.val);
    G.log='Tiempo agotado. Se anotó '+Math.max(0,best.val)+' en '+best.id+'.';
    advanceTurn(room);broadcast(G.roomId,'STATE',G);
  }
}

const COLORS=['#c9a84c','#4a90d9','#e74c3c','#2ecc71','#9b59b6','#e67e22'];

io.on('connection',socket=>{
  let currentRoom=null;

  socket.on('CREATE',({name})=>{
    const roomId=genCode();
    const G={phase:'lobby',roomId,
      players:[{id:socket.id,name,color:COLORS[0],host:true}],
      turnOrder:[],currentTurn:0,round:0,
      dice:[1,1,1,1,1],kept:[false,false,false,false,false],
      rollsLeft:3,scored:false,scores:{},
      config:{turnTime:90,maxPlayers:6},
      log:'Mesa creada. Compartí el código con tus amigos.',
    };
    G.scores[socket.id]=emptyScore();
    rooms[roomId]={G,hostId:socket.id,sockets:new Set([socket.id]),timerHandle:null};
    currentRoom=roomId;socket.join(roomId);
    socket.emit('CREATED',{roomId});socket.emit('STATE',G);
  });

  socket.on('JOIN',({roomId,name})=>{
    const room=rooms[roomId];
    if(!room){socket.emit('ERR','Sala no encontrada. Verificá el código.');return;}
    if(room.G.phase!=='lobby'){socket.emit('ERR','La partida ya empezó, no podés entrar.');return;}
    if(room.G.players.length>=(room.G.config.maxPlayers||6)){socket.emit('ERR','La mesa está completa, che.');return;}
    if(room.G.players.find(p=>p.id===socket.id)){socket.emit('STATE',room.G);return;}
    const color=COLORS[room.G.players.length%COLORS.length];
    room.G.players.push({id:socket.id,name,color});
    room.G.scores[socket.id]=emptyScore();
    room.G.log=name+' se sumó a la mesa.';
    room.sockets.add(socket.id);currentRoom=roomId;socket.join(roomId);
    broadcast(roomId,'STATE',room.G);
    broadcast(roomId,'SYS',{txt:name+' se sumó a la mesa 🎲'});
  });

  socket.on('CONFIG',({turnTime,maxPlayers})=>{
    if(!currentRoom)return;const room=rooms[currentRoom];
    if(!room||room.hostId!==socket.id)return;
    if(turnTime!==undefined)room.G.config.turnTime=turnTime;
    if(maxPlayers!==undefined)room.G.config.maxPlayers=maxPlayers;
    broadcast(currentRoom,'STATE',room.G);
  });

  socket.on('START',()=>{
    if(!currentRoom)return;const room=rooms[currentRoom];
    if(!room||room.hostId!==socket.id)return;
    if(room.G.players.length<2){socket.emit('ERR','Necesitás al menos 2 jugadores.');return;}
    const G=room.G;
    G.turnOrder=[...G.players.map(p=>p.id)].sort(()=>Math.random()-.5);
    G.currentTurn=0;G.round=1;G.phase='game';
    G.dice=rollAll();G.kept=[false,false,false,false,false];G.rollsLeft=3;G.scored=false;
    G.log='¡Empezó la partida! Le toca a '+pname(G,G.turnOrder[0])+'.';
    broadcast(currentRoom,'STATE',G);
    broadcast(currentRoom,'SYS',{txt:'¡Que empiece el partido! 🎲'});
    startTurnTimer(room);
  });

  socket.on('ACTION',({type,payload})=>{
    if(!currentRoom)return;const room=rooms[currentRoom];
    if(!room||room.G.phase!=='game')return;
    const G=room.G;const pid=curPlayer(G);
    if(socket.id!==pid)return;
    if(type==='TOGGLE'){
      if(G.rollsLeft===3||G.scored)return;
      G.kept[payload.idx]=!G.kept[payload.idx];
      broadcast(currentRoom,'STATE',G);return;
    }
    if(type==='ROLL'){
      if(G.rollsLeft<=0)return;
      G.dice=rollSome(G.dice,G.kept);G.rollsLeft--;
      const r=4-G.rollsLeft;const kept=G.dice.filter((_,i)=>G.kept[i]);
      G.log='Tiro '+r+'/3: ['+G.dice.join('-')+']'+(kept.length?' · guardó ['+kept.join(',')+']':'');
      if(allSame(G.dice)){
        const serv=G.rollsLeft===2;
        G.log=serv?'¡GENERALLA SERVIDA! 🎉':'¡Generalla! Cinco iguales.';
        broadcast(currentRoom,'SYS',{txt:serv?'🎲 ¡GENERALLA SERVIDA de '+pname(G,pid)+'!':'🎲 Generalla de '+pname(G,pid)+'!'});
      }
      broadcast(currentRoom,'STATE',G);return;
    }
    if(type==='SCORE_MODE'){
      if(G.scored)return;G.scored=true;
      G.log='¿Qué anotás? Elegí una casilla del marcador.';
      broadcast(currentRoom,'STATE',G);return;
    }
    if(type==='SCORE'){
      const{cat,val}=payload;const sc=G.scores[pid];
      if(!sc||(sc[cat]!==null&&sc[cat]!==undefined))return;
      const realVal=calcCat(cat,G.dice,G.rollsLeft);
      const scored=val===0?0:realVal;
      let bonus=0;
      if(allSame(G.dice)&&cat!=='gen'&&sc.gen!==null&&sc.gen!==undefined&&sc.gen>0)bonus=100;
      sc[cat]=scored;
      if(bonus){sc.gen_bonus=(sc.gen_bonus||0)+100;G.log='¡SEGUNDA GENERALLA! +100 bonus.';}
      else{G.log=pname(G,pid)+' anotó '+scored+' en '+cat+'.';}
      clearTimeout(room.timerHandle);advanceTurn(room);
      broadcast(currentRoom,'STATE',G);return;
    }
  });

  socket.on('CHAT',({txt,col})=>{
    if(!currentRoom)return;const room=rooms[currentRoom];if(!room)return;
    const name=pname(room.G,socket.id);
    broadcast(currentRoom,'CHAT',{name,txt:String(txt).slice(0,120),col,from:socket.id});
  });

  socket.on('REACTION',({emoji,label})=>{
    if(!currentRoom)return;const room=rooms[currentRoom];if(!room)return;
    broadcast(currentRoom,'REACTION',{emoji,label,name:pname(room.G,socket.id),from:socket.id});
  });

  socket.on('REMATCH',()=>{
    if(!currentRoom)return;const room=rooms[currentRoom];
    if(!room||room.hostId!==socket.id)return;
    const G=room.G;
    G.players.forEach(p=>{G.scores[p.id]=emptyScore();});
    G.turnOrder=[...G.players.map(p=>p.id)].sort(()=>Math.random()-.5);
    G.currentTurn=0;G.round=1;G.phase='game';
    G.dice=rollAll();G.kept=[false,false,false,false,false];G.rollsLeft=3;G.scored=false;
    G.log='¡Revancha! Que los dados rueden.';
    broadcast(currentRoom,'STATE',G);startTurnTimer(room);
  });

  socket.on('disconnect',()=>{
    if(!currentRoom)return;const room=rooms[currentRoom];if(!room)return;
    room.sockets.delete(socket.id);
    const p=room.G.players.find(p=>p.id===socket.id);
    if(p){
      broadcast(currentRoom,'SYS',{txt:p.name+' se desconectó.'});
      if(room.hostId===socket.id&&room.sockets.size>0){
        const newHost=[...room.sockets][0];room.hostId=newHost;
        room.G.players.forEach(pl=>pl.host=pl.id===newHost);
        broadcast(currentRoom,'STATE',room.G);
        broadcast(currentRoom,'SYS',{txt:pname(room.G,newHost)+' es el nuevo host.'});
      }
    }
    if(room.sockets.size===0){clearTimeout(room.timerHandle);delete rooms[currentRoom];}
  });
});

function genCode(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s='';for(let i=0;i<6;i++)s+=c[Math.floor(Math.random()*c.length)];
  return rooms[s]?genCode():s;
}

const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>{
  console.log('\n🎲  GENERALLA ONLINE — servidor corriendo\n');
  console.log('  Local:     http://localhost:'+PORT);
  const nets=os.networkInterfaces();
  Object.values(nets).flat().filter(n=>n.family==='IPv4'&&!n.internal).forEach(n=>{
    console.log('  Red local: http://'+n.address+':'+PORT+'  ← mandá este link a tus amigos');
  });
  console.log('\n  Apretá Ctrl+C para apagar\n');
});
