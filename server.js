const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 맵 데이터 (미리보기 및 충돌 판정 공용)
const MAPS = {
classic: {
name: '클래식 아레나',
width: 900,
height: 600,
obstacles: [
{ x: 250, y: 150, w: 60, h: 120 },
{ x: 590, y: 150, w: 60, h: 120 },
{ x: 250, y: 330, w: 60, h: 120 },
{ x: 590, y: 330, w: 60, h: 120 },
{ x: 420, y: 270, w: 60, h: 60 }
 ]
},
cross: {
name: '십자 요새',
width: 900,
height: 600,
obstacles: [
{ x: 420, y: 100, w: 60, h: 160 },
{ x: 420, y: 340, w: 60, h: 160 },
{ x: 200, y: 270, w: 160, h: 60 },
{ x: 540, y: 270, w: 160, h: 60 }
 ]
},
pillars: {
name: '기둥 미로',
width: 900,
height: 600,
obstacles: [
{ x: 180, y: 140, w: 50, h: 50 }, { x: 425, y: 140, w: 50, h: 50 }, { x: 670, y: 140, w: 50, h: 50 },
{ x: 180, y: 410, w: 50, h: 50 }, { x: 425, y: 410, w: 50, h: 50 }, { x: 670, y: 410, w: 50, h: 50 },
{ x: 300, y: 275, w: 50, h: 50 }, { x: 550, y: 275, w: 50, h: 50 }
 ]
},
open: {
name: '오픈 필드',
width: 900,
height: 600,
obstacles: [
{ x: 435, y: 285, w: 30, h: 30 }
 ]
}
};

const SPAWN_POINTS = [
{ x: 100, y: 100 },
{ x: 800, y: 500 },
{ x: 800, y: 100 },
{ x: 100, y: 500 }
];

const rooms = {};

function createRoom(roomId, mode, mapId) {
const maxPlayers = mode === '1v1' ? 2 : mode === '1v1v1' ? 3 : 4;
return {
id: roomId,
mode,
mapId: MAPS[mapId] ? mapId : 'classic',
maxPlayers,
status: 'waiting', // waiting, playing, roundEnding, finished
round: 1,
wins: {}, // playerId or teamName -> count
players: {},
bullets: [],
slashes: [],
effects: [],
roundEndTimer: null
};
}

function rectCircleCollide(rect, cx, cy, r) {
const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
const dx = cx - closestX;
const dy = cy - closestY;
return (dx * dx + dy * dy) < (r * r);
}

function resetRound(room) {
room.status = 'playing';
room.bullets = [];
room.slashes = [];
room.effects = [];

const ids = Object.keys(room.players);
ids.forEach((id, idx) => {
const p = room.players[id];
const sp = SPAWN_POINTS[idx % SPAWN_POINTS.length];
p.x = sp.x;
p.y = sp.y;
p.hp = 100;
p.alive = true;
p.skillCd = 0;
p.invisUntil = 0;
p.bindStage = 0; // 0: 정상, 1: 5초 이동불가(스페이스바 해제 가능), 2: 5초 회색 이동+공격불가
p.bindUntil = 0;
p.bindSpaceCount = 0;
p.shieldUntil = 0;
p.inputs = { w: false, a: false, s: false, d: false };
});

io.to(room.id).emit('roundStart', { round: room.round, wins: room.wins });
}

io.on('connection', (socket) => {
socket.emit('mapsData', MAPS);

socket.on('joinRoom', ({ roomId, nickname, skin, mode, mapId, weapon, skill }) => {
roomId = (roomId || 'arena1').trim();
if (!rooms[roomId]) {
rooms[roomId] = createRoom(roomId, mode || '1v1', mapId || 'classic');
}
const room = rooms[roomId];

if (Object.keys(room.players).length >= room.maxPlayers) {
socket.emit('errorMsg', '방이 가득 찼습니다.');
return;
}

socket.join(roomId);
socket.roomId = roomId;

const idx = Object.keys(room.players).length;
const team = room.mode === '2v2' ? (idx % 2 === 0 ? 'RED' : 'BLUE') : socket.id;

room.players[socket.id] = {
id: socket.id,
nickname: (nickname || '플레이어').slice(0, 10),
skin: skin || '#ff4757',
team,
weapon: weapon || 'gun', // gun, sword
skill: skill || 'bind', // bind, invis, dash, shield
x: SPAWN_POINTS[idx].x,
y: SPAWN_POINTS[idx].y,
angle: 0,
hp: 100,
alive: true,
lastAttack: 0,
skillCd: 0,
invisUntil: 0,
bindStage: 0,
bindUntil: 0,
bindSpaceCount: 0,
shieldUntil: 0,
inputs: { w: false, a: false, s: false, d: false }
};

if (!room.wins[team]) room.wins[team] = 0;

socket.emit('joined', {
id: socket.id,
roomId: room.id,
mode: room.mode,
mapId: room.mapId,
maxPlayers: room.maxPlayers
});

if (Object.keys(room.players).length === room.maxPlayers && room.status === 'waiting') {
room.round = 1;
resetRound(room);
}
});

socket.on('input', (data) => {
const room = rooms[socket.roomId];
if (!room || room.status !== 'playing') return;
const p = room.players[socket.id];
if (!p || !p.alive) return;

// 속박 1단계 중 다른 이동키 누르면 스페이스바 연속 카운트 초기화
if (p.bindStage === 1 && (data.w || data.a || data.s || data.d)) {
p.bindSpaceCount = 0;
}
p.inputs = { w: !!data.w, a: !!data.a, s: !!data.s, d: !!data.d };
p.angle = data.angle || 0;
});

socket.on('bindSpace', () => {
const room = rooms[socket.roomId];
if (!room || room.status !== 'playing') return;
const p = room.players[socket.id];
if (!p || !p.alive || p.bindStage !== 1) return;

p.bindSpaceCount += 1;
if (p.bindSpaceCount >= 10) {
p.bindStage = 0;
p.bindUntil = 0;
p.bindSpaceCount = 0;
room.effects.push({ type: 'unlock', x: p.x, y: p.y, ttl: 25 });
}
});

socket.on('attack', () => {
const room = rooms[socket.roomId];
if (!room || room.status !== 'playing') return;
const p = room.players[socket.id];
if (!p || !p.alive) return;
// 속박 2단계(회색)에서는 공격 불가 (1단계에서는 공격 가능)
if (p.bindStage === 2) return;

const now = Date.now();
if (p.weapon === 'gun') {
if (now - p.lastAttack < 350) return;
p.lastAttack = now;
room.bullets.push({
owner: p.id,
team: p.team,
x: p.x + Math.cos(p.angle) * 24,
y: p.y + Math.sin(p.angle) * 24,
vx: Math.cos(p.angle) * 11,
vy: Math.sin(p.angle) * 11,
color: p.skin,
damage: 20
});
} else if (p.weapon === 'sword') {
if (now - p.lastAttack < 450) return;
p.lastAttack = now;
room.slashes.push({
owner: p.id,
x: p.x,
y: p.y,
angle: p.angle,
ttl: 12
});
// 근접 피격 판정
Object.values(room.players).forEach((target) => {
if (target.id === p.id || !target.alive) return;
if (room.mode === '2v2' && target.team === p.team) return;
const dx = target.x - p.x;
const dy = target.y - p.y;
const dist = Math.hypot(dx, dy);
if (dist < 75) {
const diff = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - p.angle), Math.cos(Math.atan2(dy, dx) - p.angle)));
if (diff < 1.1) {
applyDamage(room, target, 35, p.id);
}
}
});
}
});

socket.on('useSkill', () => {
const room = rooms[socket.roomId];
if (!room || room.status !== 'playing') return;
const p = room.players[socket.id];
if (!p || !p.alive || p.bindStage === 2) return;

const now = Date.now();
if (now < p.skillCd) return;

if (p.skill === 'bind') {
p.skillCd = now + 15000;
// 가장 가까운 적 속박
let nearest = null;
let minDist = Infinity;
Object.values(room.players).forEach((t) => {
if (t.id === p.id || !t.alive) return;
if (room.mode === '2v2' && t.team === p.team) return;
const d = Math.hypot(t.x - p.x, t.y - p.y);
if (d < minDist) { minDist = d; nearest = t; }
});
if (nearest) {
nearest.bindStage = 1;
nearest.bindUntil = now + 5000;
nearest.bindSpaceCount = 0;
room.effects.push({ type: 'bindCast', x: nearest.x, y: nearest.y, ttl: 25 });
}
} else if (p.skill === 'invis') {
p.skillCd = now + 15000;
p.invisUntil = now + 5000;
room.effects.push({ type: 'invisCast', x: p.x, y: p.y, ttl: 20 });
} else if (p.skill === 'dash') {
if (p.bindStage === 1) return;
p.skillCd = now + 7000;
const nx = p.x + Math.cos(p.angle) * 120;
const ny = p.y + Math.sin(p.angle) * 120;
p.x = Math.max(20, Math.min(880, nx));
p.y = Math.max(20, Math.min(580, ny));
room.effects.push({ type: 'dash', x: p.x, y: p.y, ttl: 15 });
} else if (p.skill === 'shield') {
p.skillCd = now + 12000;
p.shieldUntil = now + 3000;
room.effects.push({ type: 'shieldCast', x: p.x, y: p.y, ttl: 20 });
}
});

socket.on('disconnect', () => {
const room = rooms[socket.roomId];
if (!room) return;
delete room.players[socket.id];
if (Object.keys(room.players).length === 0) {
if (room.roundEndTimer) clearTimeout(room.roundEndTimer);
delete rooms[socket.roomId];
}
});
});

function applyDamage(room, target, dmg, attackerId) {
if (Date.now() < target.shieldUntil) return;
target.hp -= dmg;
room.effects.push({ type: 'hit', x: target.x, y: target.y, ttl: 15 });

if (target.hp <= 0) {
target.hp = 0;
target.alive = false;
room.effects.push({ type: 'ko', x: target.x, y: target.y, ttl: 60 });
checkRoundEnd(room);
}
}

function checkRoundEnd(room) {
if (room.status !== 'playing') return;
const alivePlayers = Object.values(room.players).filter((p) => p.alive);
const aliveTeams = [...new Set(alivePlayers.map((p) => p.team))];

if (aliveTeams.length <= 1) {
// 플레이어 활동 정지 + 마지막 공격 2초간 표시
room.status = 'roundEnding';
const winnerTeam = aliveTeams[0] || null;
let winnerName = '무승부';

if (winnerTeam) {
room.wins[winnerTeam] = (room.wins[winnerTeam] || 0) + 1;
winnerName = room.mode === '2v2'
? `${winnerTeam} 팀`

: (room.players[winnerTeam]?.nickname || '승자');
}

io.to(room.id).emit('roundEnding', { winnerName, wins: room.wins, round: room.round });

room.roundEndTimer = setTimeout(() => {
if (!rooms[room.id]) return;
// 3판 2선승 체크
if (winnerTeam && room.wins[winnerTeam] >= 2) {
room.status = 'finished';
io.to(room.id).emit('matchOver', { winnerName, wins: room.wins });
} else {
room.round += 1;
resetRound(room);
}
}, 2000);
}
}

// 60FPS 게임 루프
setInterval(() => {
const now = Date.now();
Object.values(rooms).forEach((room) => {
const map = MAPS[room.mapId];

// 플레이어 이동 및 상태 업데이트 (roundEnding 중에는 플레이어 활동 정지)
if (room.status === 'playing') {
Object.values(room.players).forEach((p) => {
if (!p.alive) return;

// 속박 상태 전환 체크
if (p.bindStage === 1 && now >= p.bindUntil) {
// 5초 내 스페이스바 10회 실패 -> 2단계(5초간 회색 + 이동/공격 불가)
p.bindStage = 2;
p.bindUntil = now + 5000;
p.bindSpaceCount = 0;
} else if (p.bindStage === 2 && now >= p.bindUntil) {
p.bindStage = 0;
p.bindUntil = 0;
}

// 속박 1, 2단계 모두 이동 불가
if (p.bindStage === 0) {
let dx = 0, dy = 0;
if (p.inputs.w) dy -= 1;
if (p.inputs.s) dy += 1;
if (p.inputs.a) dx -= 1;
if (p.inputs.d) dx += 1;
if (dx !== 0 || dy !== 0) {
const len = Math.hypot(dx, dy);
const speed = 4.2;
const nx = Math.max(18, Math.min(map.width - 18, p.x + (dx / len) * speed));
const ny = Math.max(18, Math.min(map.height - 18, p.y + (dy / len) * speed));
if (!map.obstacles.some((o) => rectCircleCollide(o, nx, p.y, 18))) p.x = nx;
if (!map.obstacles.some((o) => rectCircleCollide(o, p.x, ny, 18))) p.y = ny;
}
}
});
}

// 총알·이펙트는 roundEnding 2초 동안에도 계속 그려져서 마지막 공격이 보임
if (room.status === 'playing' || room.status === 'roundEnding') {
for (let i = room.bullets.length - 1; i >= 0; i--) {
const b = room.bullets[i];
b.x += b.vx;
b.y += b.vy;

if (b.x < 0 || b.x > map.width || b.y < 0 || b.y > map.height ||
map.obstacles.some((o) => rectCircleCollide(o, b.x, b.y, 5))) {
room.bullets.splice(i, 1);
continue;
}

if (room.status === 'playing') {
for (const target of Object.values(room.players)) {
if (target.id === b.owner || !target.alive) continue;
if (room.mode === '2v2' && target.team === b.team) continue;
if (Math.hypot(target.x - b.x, target.y - b.y) < 22) {
applyDamage(room, target, b.damage, b.owner);
room.bullets.splice(i, 1);
break;
}
}
}
}

room.slashes = room.slashes.filter((s) => --s.ttl > 0);
room.effects = room.effects.filter((e) => --e.ttl > 0);
}

io.to(room.id).emit('state', {
status: room.status,
round: room.round,
wins: room.wins,
now,
players: room.players,
bullets: room.bullets,
slashes: room.slashes,
effects: room.effects
});
});
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
console.log(RETRO ARENA 서버 실행 중! 포트:${PORT}`);
});