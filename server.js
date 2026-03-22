const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const HISTORY_LIMIT = 5000;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_NAME_COLOR = '#0ea5e9';

const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/rooms', (req, res) => {
  const list = [];
  rooms.forEach((room, roomId) => {
    list.push({
      roomId,
      title: room.title,
      tags: room.tags,
      players: room.players.size,
      spectators: room.spectators.size,
      locked: Boolean(room.password)
    });
  });

  list.sort((a, b) => b.players - a.players);

  res.json({
    rooms: list,
    max: MAX_PLAYERS,
    min: MIN_PLAYERS
  });
});

function makeRoomCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(Math.random() * ROOM_ALPHABET.length);
    code += ROOM_ALPHABET[idx];
  }
  return code;
}

function cleanName(raw) {
  return String(raw || '').trim().slice(0, 24);
}

function cleanColor(raw) {
  const value = String(raw || '').trim();
  if (/^#([0-9a-f]{6})$/i.test(value)) return value.toLowerCase();
  return DEFAULT_NAME_COLOR;
}

function cleanTitle(raw) {
  const value = String(raw || '').trim().slice(0, 40);
  return value || 'Untitled Room';
}

function cleanTags(raw) {
  const value = String(raw || '');
  const tags = value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.replace(/[^a-z0-9\s-_]/gi, '').slice(0, 14))
    .filter(Boolean);

  const unique = [];
  tags.forEach((tag) => {
    const normalized = tag.toLowerCase();
    if (!unique.some((existing) => existing.toLowerCase() === normalized)) {
      unique.push(tag);
    }
  });

  return unique.slice(0, 4);
}

function cleanPassword(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return value.slice(0, 24);
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function playerCount(room) {
  return room.players.size;
}

function spectatorCount(room) {
  return room.spectators.size;
}

function totalCount(room) {
  return playerCount(room) + spectatorCount(room);
}

function emitRoomStatus(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const count = playerCount(room);
  io.to(roomId).emit('roomStatus', {
    count,
    max: MAX_PLAYERS,
    min: MIN_PLAYERS,
    spectators: spectatorCount(room),
    canDraw: count >= MIN_PLAYERS,
    hostId: room.hostId,
    undoRemaining: room.actionStack.length
  });
}

function joinRoom(socket, roomId, name, color, role) {
  const room = getRoom(roomId);
  if (!room) return;

  const entry = { name, color, role };
  if (role === 'spectator') {
    room.spectators.set(socket.id, entry);
  } else {
    room.players.set(socket.id, entry);
    if (!room.hostId) {
      room.hostId = socket.id;
    }
  }

  socket.data.roomId = roomId;
  socket.data.name = name;
  socket.data.color = color;
  socket.data.role = role;
  socket.join(roomId);

  socket.emit('roomJoined', {
    roomId,
    name,
    role,
    history: room.history,
    title: room.title,
    tags: room.tags,
    hostId: room.hostId
  });

  emitRoomStatus(roomId);
}

function assignNewHost(room) {
  const next = room.players.keys().next().value;
  room.hostId = next || null;
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, color, title, tags, password }) => {
    const clean = cleanName(name);
    const safeColor = cleanColor(color);
    const roomTitle = cleanTitle(title);
    const roomTags = cleanTags(tags);
    const roomPassword = cleanPassword(password);

    if (!clean) {
      socket.emit('roomError', { message: 'Name is required for multiplayer.' });
      return;
    }

    let roomId = makeRoomCode();
    while (rooms.has(roomId)) {
      roomId = makeRoomCode();
    }

    rooms.set(roomId, {
      players: new Map(),
      spectators: new Map(),
      history: [],
      actionStack: [],
      hostId: socket.id,
      title: roomTitle,
      tags: roomTags,
      password: roomPassword
    });

    joinRoom(socket, roomId, clean, safeColor, 'player');
  });

  socket.on('joinRoom', ({ name, roomId, color, role, password }) => {
    const clean = cleanName(name);
    const safeColor = cleanColor(color);
    const code = String(roomId || '').trim().toUpperCase();
    const joinRole = role === 'spectator' ? 'spectator' : 'player';
    const providedPassword = cleanPassword(password);

    if (!clean) {
      socket.emit('roomError', { message: 'Name is required for multiplayer.' });
      return;
    }

    if (!code || !rooms.has(code)) {
      socket.emit('roomError', { message: 'Room not found. Check the code.' });
      return;
    }

    const room = getRoom(code);
    if (joinRole === 'player' && playerCount(room) >= MAX_PLAYERS) {
      socket.emit('roomError', { message: 'Room is full (10 players max).' });
      return;
    }
    if (room.password && room.password !== providedPassword) {
      socket.emit('roomError', { message: 'Room password is incorrect.' });
      return;
    }

    joinRoom(socket, code, clean, safeColor, joinRole);
  });

  socket.on('draw', ({ draw }) => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room || !draw) return;
    if (socket.data.role !== 'player') return;
    if (playerCount(room) < MIN_PLAYERS) return;

    const actionId = String(draw.actionId || '').trim() || `a-${Date.now()}-${Math.random()}`;
    const normalizedDraw = { ...draw, actionId };

    room.history.push(normalizedDraw);
    if (room.history.length > HISTORY_LIMIT) {
      room.history.splice(0, room.history.length - HISTORY_LIMIT);
    }

    if (room.actionStack[room.actionStack.length - 1] !== actionId) {
      room.actionStack.push(actionId);
      if (room.actionStack.length > 20) {
        room.actionStack.shift();
      }
    }

    socket.to(roomId).emit('draw', {
      id: socket.id,
      name: socket.data.name,
      draw: normalizedDraw
    });

    emitRoomStatus(roomId);
  });

  socket.on('cursor', ({ cursor }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !cursor) return;
    socket.to(roomId).emit('cursor', {
      id: socket.id,
      name: socket.data.name,
      cursor
    });
  });

  socket.on('chat', ({ message }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const text = String(message || '').trim().slice(0, 500);
    if (!text) return;

    io.to(roomId).emit('chat', {
      name: socket.data.name,
      color: socket.data.color || DEFAULT_NAME_COLOR,
      message: text,
      ts: Date.now()
    });
  });

  socket.on('clearCanvas', () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.history = [];
    room.actionStack = [];

    io.to(roomId).emit('clearCanvas', {
      by: socket.data.name
    });
    emitRoomStatus(roomId);
  });

  socket.on('undo', () => {
    const roomId = socket.data.roomId;
    const room = getRoom(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (!room.actionStack.length) return;

    const actionId = room.actionStack.pop();
    room.history = room.history.filter((item) => item.actionId !== actionId);

    io.to(roomId).emit('syncHistory', {
      history: room.history
    });
    emitRoomStatus(roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    if (socket.data.role === 'spectator') {
      room.spectators.delete(socket.id);
    } else {
      room.players.delete(socket.id);
      if (room.hostId === socket.id) {
        assignNewHost(room);
      }
    }

    socket.to(roomId).emit('playerLeft', { id: socket.id });

    if (totalCount(room) === 0) {
      rooms.delete(roomId);
      return;
    }

    emitRoomStatus(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Canvas Clash running on http://localhost:${PORT}`);
});
