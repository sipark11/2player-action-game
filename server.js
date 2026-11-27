const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const MAP_WIDTH = 900;
const MAP_HEIGHT = 500;
const GROUND_Y = 440;
const GRAVITY = 0.16;       // 기존(0.65) 대비 약 4배 낮은 중력
const JUMP_FORCE = -6.0;    // 기존보다 낮은 점프 높이
const FAST_FALL_SPEED = 9.5;
const HALF = 18;
const WIN_SCORE = 3;
const BASE_HP = 120;

// 3가지 맵 데이터
const MAPS = [
  {
    id: 0,
    name: '네온 아레나',
    desc: '균형 잡힌 발판과 엄폐물',
    bg: '#131126',
    platforms: [
      { x: 110, y: 340, w: 180, h: 16 },
      { x: 610, y: 340, w: 180, h: 16 },
      { x: 350, y: 240, w: 200, h: 16 }
    ],
    blocks: [
      { x: 250, y: 380, w: 50, h: 60 },
      { x: 600, y: 380, w: 50, h: 60 },
      { x: 425, y: 350, w: 50, h: 90 }
    ]
  },
  {
    id: 1,
    name: '스카이 타워',
    desc: '다층 공중 발판 중심의 수직 전장',
    bg: '#0c162b',
    platforms: [
      { x: 80, y: 350, w: 160, h: 16 },
      { x: 660, y: 350, w: 160, h: 16 },
      { x: 260, y: 265, w: 140, h: 16 },
      { x: 500, y: 265, w: 140, h: 16 },
      { x: 370, y: 175, w: 160, h: 16 }
    ],
    blocks: [
      { x: 425, y: 380, w: 50, h: 60 }
    ]
  },
  {
    id: 2,
    name: '철벽 요새',
    desc: '높은 엄폐물과 저격 지대가 있는 요새',
    bg: '#1c121f',
    platforms: [
      { x: 40, y: 280, w: 150, h: 16 },
      { x: 710, y: 280, w: 150, h: 16 },
      { x: 360, y: 310, w: 180, h: 16 }
    ],
    blocks: [
      { x: 190, y: 340, w: 50, h: 100 },
      { x: 660, y: 340, w: 50, h: 100 },
      { x: 320, y: 390, w: 45, h: 50 },
      { x: 535, y: 390, w: 45, h: 50 }
    ]
  }
];

const rooms = {};

function getRoomList() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    hasPassword: !!r.password,
    playerCount: Object.keys(r.players).length,
    state: r.state
  }));
}

function broadcastRoomList() {
  io.emit('roomList', getRoomList());
}

function createPlayer(socketId, slot) {
  return {
    id: socketId,
    slot,
    x: slot === 1 ? 100 : 800,
    y: GROUND_Y - HALF,
    vx: 0,
    vy: 0,
    onGround: true,
    color: slot === 1 ? '#00f5d4' : '#ff2a85',
    hp: BASE_HP,
    maxHp: BASE_HP,
    shieldHp: 0,
    score: 0,
    weapon: 1,
    ammo: 6,
    maxAmmo: 6,
    reloading: false,
    reloadEndTime: 0,
    power: null,
    angle: slot === 1 ? 0 : Math.PI,
    lastKnifeTime: 0,
    lastPistolTime: 0,
    lastPowerTime: 0,
    dead: false,
    respawnTime: 0,
    inputs: { left: false, right: false, jump: false, down: false }
  };
}

function resetPlayerPos(p) {
  p.x = p.slot === 1 ? 100 : 800;
  p.y = GROUND_Y - HALF;
  p.vx = 0;
  p.vy = 0;
  p.hp = p.maxHp;
  p.shieldHp = 0;
  p.ammo = p.maxAmmo;
  p.reloading = false;
  p.dead = false;
}

function collidesWithBlocks(cx, cy, half, blocks) {
  for (const b of blocks) {
    if (cx + half > b.x && cx - half < b.x + b.w && cy + half > b.y && cy - half < b.y + b.h) {
      return b;
    }
  }
  return null;
}

function damagePlayer(room, target, attacker, amount, now) {
  if (target.dead || room.state !== 'playing') return;

  // 하얀색 보호막 체력부터 차감
  if (target.shieldHp > 0) {
    const absorbed = Math.min(target.shieldHp, amount);
    target.shieldHp -= absorbed;
    amount -= absorbed;
  }

  if (amount > 0) {
    target.hp -= amount;
  }

  if (target.hp <= 0) {
    target.hp = 0;
    target.dead = true;
    target.respawnTime = now + 2000;

    if (attacker && attacker.id !== target.id) {
      attacker.score += 1;
      if (attacker.score >= WIN_SCORE) {
        room.state = 'gameover';
        room.winnerSlot = attacker.slot;
      }
    }
  }
}

function startCountdown(room, nextState, seconds, onComplete) {
  room.countdown = seconds;
  io.to(room.id).emit('phaseUpdate', {
    state: room.state,
    countdown: room.countdown,
    selectedMap: room.selectedMap
  });

  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.countdown -= 1;
    if (room.countdown <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      room.state = nextState;
      if (onComplete) onComplete();
      io.to(room.id).emit('phaseUpdate', {
        state: room.state,
        countdown: 0,
        selectedMap: room.selectedMap,
        maps: MAPS
      });
    } else {
      io.to(room.id).emit('phaseUpdate', {
        state: room.state,
        countdown: room.countdown,
        selectedMap: room.selectedMap
      });
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.emit('roomList', getRoomList());

  socket.on('getRooms', () => {
    socket.emit('roomList', getRoomList());
  });

  // 방 만들기
  socket.on('createRoom', ({ name, password }) => {
    const roomId = 'room_' + Math.random().toString(36).substring(2, 8);
    const room = {
      id: roomId,
      name: (name || '이름 없는 방').trim().slice(0, 20),
      password: (password || '').trim(),
      state: 'waiting',
      countdown: 0,
      timer: null,
      mapVotes: {},
      selectedMap: MAPS[0],
      players: {},
      projectiles: [],
      slashes: [],
      effects: [],
      winnerSlot: null
    };
    rooms[roomId] = room;
    joinRoom(socket, room);
  });

  // 방 입장하기
  socket.on('joinRoom', ({ roomId, password }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('roomError', '존재하지 않는 방입니다.');
    if (Object.keys(room.players).length >= 2) return socket.emit('roomError', '방이 가득 찼습니다.');
    if (room.state !== 'waiting') return socket.emit('roomError', '이미 게임이 진행 중인 방입니다.');
    if (room.password && room.password !== (password || '').trim()) {
      return socket.emit('roomError', '비밀번호가 일치하지 않습니다.');
    }
    joinRoom(socket, room);
  });

  function joinRoom(socket, room) {
    socket.join(room.id);
    socket.roomId = room.id;
    const slot = Object.values(room.players).some(p => p.slot === 1) ? 2 : 1;
    room.players[socket.id] = createPlayer(socket.id, slot);

    socket.emit('joinedRoom', {
      roomId: room.id,
      roomName: room.name,
      slot,
      maps: MAPS
    });
    broadcastRoomList();

    // 2명이 모이면 3, 2, 1 카운트다운 후 맵 투표로 이동
    if (Object.keys(room.players).length === 2) {
      room.state = 'match_countdown';
      broadcastRoomList();
      startCountdown(room, 'map_vote', 3);
    }
  }

  // 맵 투표
  socket.on('voteMap', (mapId) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'map_vote') return;
    room.mapVotes[socket.id] = mapId;

    io.to(room.id).emit('voteUpdate', room.mapVotes);

    // 2명 모두 투표 완료 시 확률 추첨
    const playerIds = Object.keys(room.players);
    if (playerIds.every(id => room.mapVotes[id] !== undefined)) {
      const pool = playerIds.map(id => room.mapVotes[id]);
      const chosenId = pool[Math.floor(Math.random() * pool.length)];
      room.selectedMap = MAPS.find(m => m.id === chosenId) || MAPS[0];
      room.state = 'power_select';
      io.to(room.id).emit('phaseUpdate', {
        state: 'power_select',
        selectedMap: room.selectedMap
      });
    }
  });

  // 초능력 선택
  socket.on('selectPower', (powerType) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'power_select') return;
    const p = room.players[socket.id];
    if (!p) return;
    p.power = powerType;

    // 2명 모두 선택 완료 시 3초 카운트다운 후 게임 시작
    const allReady = Object.values(room.players).every(pl => pl.power !== null);
    if (allReady) {
      room.state = 'start_countdown';
      startCountdown(room, 'playing', 3, () => {
        for (const id in room.players) {
          room.players[id].score = 0;
          resetPlayerPos(room.players[id]);
        }
      });
    }
  });

  // 조작 입력
  socket.on('input', (inputs) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'playing') return;
    const p = room.players[socket.id];
    if (p && !p.dead) p.inputs = inputs;
  });

  socket.on('aim', (angle) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const p = room.players[socket.id];
    if (p) p.angle = angle;
  });

  socket.on('switchWeapon', (weaponNum) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'playing') return;
    const p = room.players[socket.id];
    if (p && !p.dead && [1, 2, 3].includes(weaponNum)) p.weapon = weaponNum;
  });

  socket.on('reload', () => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'playing') return;
    const p = room.players[socket.id];
    if (p && !p.dead && p.weapon === 2 && !p.reloading && p.ammo < p.maxAmmo) {
      p.reloading = true;
      p.reloadEndTime = Date.now() + 1500;
    }
  });

  socket.on('useWeapon', () => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'playing') return;
    const p = room.players[socket.id];
    if (!p || p.dead) return;
    const now = Date.now();
    const blocks = room.selectedMap.blocks;

    // 1번: 칼
    if (p.weapon === 1) {
      if (now - p.lastKnifeTime < 350) return;
      p.lastKnifeTime = now;
      room.slashes.push({ x: p.x, y: p.y, angle: p.angle, ownerId: p.id, endTime: now + 150 });

      for (const id in room.players) {
        if (id === p.id) continue;
        const target = room.players[id];
        if (target.dead) continue;
        const dx = target.x - p.x;
        const dy = target.y - p.y;
        if (Math.hypot(dx, dy) < 75) {
          let diff = Math.abs(Math.atan2(dy, dx) - p.angle);
          if (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff < 1.1) damagePlayer(room, target, p, 22, now);
        }
      }
    }
    // 2번: 권총
    else if (p.weapon === 2) {
      if (p.reloading || now - p.lastPistolTime < 260) return;
      if (p.ammo <= 0) {
        p.reloading = true;
        p.reloadEndTime = now + 1500;
        return;
      }
      p.lastPistolTime = now;
      p.ammo -= 1;
      room.projectiles.push({
        type: 'bullet',
        x: p.x + Math.cos(p.angle) * 24,
        y: p.y + Math.sin(p.angle) * 24,
        vx: Math.cos(p.angle) * 14,
        vy: Math.sin(p.angle) * 14,
        size: 8,
        damage: 16,
        ownerId: p.id,
        color: '#fee440'
      });
    }
    // 3번: 초능력 (쿨타임 증가 & 위력 강화)
    else if (p.weapon === 3) {
      // 능력 1: 파이어볼 (쿨 8초, 중간 속도, 넉백 + 대미지 45)
      if (p.power === 'fireball') {
        if (now - p.lastPowerTime < 8000) return;
        p.lastPowerTime = now;
        room.projectiles.push({
          type: 'fireball',
          x: p.x + Math.cos(p.angle) * 28,
          y: p.y + Math.sin(p.angle) * 28,
          vx: Math.cos(p.angle) * 8.5,
          vy: Math.sin(p.angle) * 8.5,
          size: 22,
          damage: 45,
          ownerId: p.id,
          color: '#ff5500'
        });
      }
      // 능력 2: 보호막 (쿨 12초, 하얀 추가 체력 +30, 초당 1 감소)
      else if (p.power === 'shield') {
        if (now - p.lastPowerTime < 12000) return;
        p.lastPowerTime = now;
        p.shieldHp = 30;
      }
      // 능력 3: 순간이동 (쿨 7초, 보라색 불꽃 + 거리별 7~70 대미지)
      else if (p.power === 'blink') {
        if (now - p.lastPowerTime < 7000) return;
        p.lastPowerTime = now;

        const stepX = Math.cos(p.angle) * 16;
        const stepY = Math.sin(p.angle) * 16;
        for (let s = 0; s < 12; s++) {
          const nx = Math.max(HALF, Math.min(MAP_WIDTH - HALF, p.x + stepX));
          const ny = Math.max(HALF, Math.min(GROUND_Y - HALF, p.y + stepY));
          if (collidesWithBlocks(nx, ny, HALF, blocks)) break;
          p.x = nx;
          p.y = ny;
        }
        p.vy = 0;

        // 보라색 불꽃 이펙트 추가
        room.effects.push({
          type: 'blink_flame',
          x: p.x,
          y: p.y,
          createdAt: now,
          duration: 450
        });

        // 거리별 대미지 (최대 사거리 170: 가장 가까움 70, 중간 20, 가장 멈 7)
        const MAX_RANGE = 170;
        for (const id in room.players) {
          if (id === p.id) continue;
          const target = room.players[id];
          if (target.dead) continue;
          const dist = Math.hypot(target.x - p.x, target.y - p.y);
          if (dist <= MAX_RANGE) {
            let dmg = 7;
            if (dist <= 45) {
              dmg = 70;
            } else if (dist <= 105) {
              // 45~105 구간: 70 -> 20
              const t = (dist - 45) / 60;
              dmg = Math.round(70 - t * 50);
            } else {
              // 105~170 구간: 20 -> 7
              const t = (dist - 105) / 65;
              dmg = Math.round(20 - t * 13);
            }
            damagePlayer(room, target, p, dmg, now);
          }
        }
      }
    }
  });

  // 재경기 (맵 투표부터 다시)
  socket.on('restart', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.mapVotes = {};
    room.projectiles = [];
    room.slashes = [];
    room.effects = [];
    room.winnerSlot = null;
    for (const id in room.players) {
      room.players[id].power = null;
      room.players[id].score = 0;
      resetPlayerPos(room.players[id]);
    }
    room.state = 'map_vote';
    io.to(room.id).emit('phaseUpdate', {
      state: 'map_vote',
      maps: MAPS
    });
  });

  // 방 나가기 / 접속 종료
  function leaveCurrentRoom() {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    delete room.players[socket.id];
    socket.leave(roomId);
    socket.roomId = null;

    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }

    if (Object.keys(room.players).length === 0) {
      delete rooms[roomId];
    } else {
      // 남은 플레이어에게 알림 후 대기 상태 복귀
      room.state = 'waiting';
      room.mapVotes = {};
      for (const id in room.players) {
        room.players[id].power = null;
        resetPlayerPos(room.players[id]);
      }
      io.to(roomId).emit('opponentLeft');
    }
    broadcastRoomList();
  }

  socket.on('leaveRoom', leaveCurrentRoom);
  socket.on('disconnect', leaveCurrentRoom);
});

// 60FPS 게임 루프 (모든 방 처리)
setInterval(() => {
  const now = Date.now();

  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (room.state !== 'playing' && room.state !== 'gameover') continue;

    const { platforms, blocks } = room.selectedMap;

    if (room.state === 'playing') {
      for (const id in room.players) {
        const p = room.players[id];

        if (p.dead) {
          if (now >= p.respawnTime) resetPlayerPos(p);
          continue;
        }

        // 보호막 초당 1씩 감소
        if (p.shieldHp > 0) {
          p.shieldHp = Math.max(0, p.shieldHp - 1 / 60);
        }

        if (p.reloading && now >= p.reloadEndTime) {
          p.reloading = false;
          p.ammo = p.maxAmmo;
        }

        // 이동 + 넉백(vx) 감쇠
        const speed = p.weapon === 1 ? 6.5 : 4.5;
        let moveX = 0;
        if (p.inputs.left) moveX -= speed;
        if (p.inputs.right) moveX += speed;

        const totalDx = moveX + p.vx;
        p.vx *= 0.85; // 넉백 마찰
        if (Math.abs(p.vx) < 0.2) p.vx = 0;

        p.x = Math.max(HALF, Math.min(MAP_WIDTH - HALF, p.x + totalDx));
        const hitX = collidesWithBlocks(p.x, p.y, HALF, blocks);
        if (hitX) {
          if (totalDx > 0) p.x = hitX.x - HALF;
          else if (totalDx < 0) p.x = hitX.x + hitX.w + HALF;
          p.vx = 0;
        }

        // 점프 (저중력)
        if (p.inputs.jump && p.onGround) {
          p.vy = JUMP_FORCE;
          p.onGround = false;
        }

        // S키 공중 급강하 (버그 방지: 공중에 있을 때만 적용)
        if (p.inputs.down && !p.onGround) {
          p.vy = Math.max(p.vy, FAST_FALL_SPEED);
        }

        const prevBottom = p.y + HALF;
        p.vy += GRAVITY;
        p.y += p.vy;
        p.onGround = false;

        // 엄폐물 위/아래 충돌
        const hitY = collidesWithBlocks(p.x, p.y, HALF, blocks);
        if (hitY) {
          if (p.vy > 0) {
            p.y = hitY.y - HALF;
            p.vy = 0;
            p.onGround = true;
          } else if (p.vy < 0) {
            p.y = hitY.y + hitY.h + HALF;
            p.vy = 0;
          }
        }

        // 공중 발판 착지 (급강하 시에도 뚫고 지나가지 않도록 prevBottom 기준 판정)
        if (p.vy >= 0) {
          for (const plat of platforms) {
            const withinX = p.x + HALF > plat.x && p.x - HALF < plat.x + plat.w;
            if (withinX && prevBottom <= plat.y + 4 && p.y + HALF >= plat.y) {
              p.y = plat.y - HALF;
              p.vy = 0;
              p.onGround = true;
            }
          }
        }

        // 바닥 & 천장
        if (p.y >= GROUND_Y - HALF) {
          p.y = GROUND_Y - HALF;
          p.vy = 0;
          p.onGround = true;
        }
        if (p.y < HALF) {
          p.y = HALF;
          p.vy = 0;
        }
      }

      // 발사체 이동 및 충돌
      for (let i = room.projectiles.length - 1; i >= 0; i--) {
        const b = room.projectiles[i];
        b.x += b.vx;
        b.y += b.vy;

        if (
          b.x < 0 || b.x > MAP_WIDTH || b.y < 0 || b.y > GROUND_Y ||
          collidesWithBlocks(b.x, b.y, b.size / 2, blocks)
        ) {
          if (b.type === 'fireball') {
            room.effects.push({ type: 'fire_explode', x: b.x, y: b.y, createdAt: now, duration: 300 });
          }
          room.projectiles.splice(i, 1);
          continue;
        }

        for (const id in room.players) {
          if (id === b.ownerId) continue;
          const target = room.players[id];
          if (target.dead) continue;

          if (
            Math.abs(target.x - b.x) < HALF + b.size / 2 &&
            Math.abs(target.y - b.y) < HALF + b.size / 2
          ) {
            // 파이어볼 피격 시 터진 지점 반대 방향으로 넉백!
            if (b.type === 'fireball') {
              const kbAngle = Math.atan2(target.y - b.y, target.x - b.x);
              target.vx = Math.cos(kbAngle) * 16;
              target.vy = Math.sin(kbAngle) * 7 - 3;
              target.onGround = false;
              room.effects.push({ type: 'fire_explode', x: b.x, y: b.y, createdAt: now, duration: 350 });
            }
            damagePlayer(room, target, room.players[b.ownerId], b.damage, now);
            room.projectiles.splice(i, 1);
            break;
          }
        }
      }
    }

    room.slashes = room.slashes.filter(s => s.endTime > now);
    room.effects = room.effects.filter(e => now - e.createdAt < e.duration);

    io.to(room.id).emit('state', {
      players: room.players,
      projectiles: room.projectiles,
      slashes: room.slashes,
      effects: room.effects,
      map: room.selectedMap,
      gameOver: room.state === 'gameover',
      winnerSlot: room.winnerSlot,
      now
    });
  }
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`RETRO ARENA 서버 실행 중! 포트: ${PORT}`);
});