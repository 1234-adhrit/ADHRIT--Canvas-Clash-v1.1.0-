const canvas = document.getElementById('paint');
const overlay = document.getElementById('overlay');
const cursorLayer = document.getElementById('cursor-layer');
const waitOverlay = document.getElementById('wait-overlay');
const toolSelect = document.getElementById('tool-select');
const colorInput = document.getElementById('color-input');
const sizeInput = document.getElementById('size-input');
const sizeValue = document.getElementById('size-value');
const drawHint = document.getElementById('draw-hint');
const roomCodeEl = document.getElementById('room-code');
const roomTitleEl = document.getElementById('room-title');
const playerStatus = document.getElementById('player-status');
const leaveBtn = document.getElementById('leave-btn');
const lobby = document.getElementById('lobby');
const nameInput = document.getElementById('name-input');
const nameColorInput = document.getElementById('name-color');
const roomTitleInput = document.getElementById('room-title-input');
const roomTagsInput = document.getElementById('room-tags-input');
const roomPasswordInput = document.getElementById('room-password-input');
const spectatorToggle = document.getElementById('spectator-toggle');
const roomInput = document.getElementById('room-input');
const createBtn = document.getElementById('create-btn');
const joinBtn = document.getElementById('join-btn');
const soloBtn = document.getElementById('solo-btn');
const toast = document.getElementById('toast');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatText = document.getElementById('chat-text');
const chatNote = document.getElementById('chat-note');
const serverList = document.getElementById('server-list');
const serverEmpty = document.getElementById('server-empty');
const refreshRoomsBtn = document.getElementById('refresh-rooms');
const undoBtn = document.getElementById('undo-btn');
const clearBtn = document.getElementById('clear-btn');
const exportBtn = document.getElementById('export-btn');
const hostNote = document.getElementById('host-note');

const ctx = canvas.getContext('2d');
const octx = overlay.getContext('2d');

let socket = null;
let isMultiplayer = false;
let isSpectator = false;
let canDraw = true;
let playerName = '';
let roomId = null;
let roomTitle = 'Solo Studio';
let hostId = null;
let socketId = null;
let undoRemaining = 0;
let roomCanDraw = true;
let isDrawing = false;
let lastPos = null;
let startPos = null;
let currentDpr = window.devicePixelRatio || 1;
let cursorSendPending = false;
let latestCursor = null;
let roomPoller = null;
let currentActionId = null;
let localHistory = [];
let localActionStack = [];

const cursors = new Map();
let localCursorEl = null;

const SHAPE_TOOLS = new Set(['line', 'rect', 'circle', 'triangle']);
const LOCAL_UNDO_LIMIT = 20;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function setRoomInfo(code, count = null, max = null, spectators = 0) {
  roomCodeEl.textContent = code;
  if (count !== null) {
    const spectatorLabel = max ? ` · Spectators: ${spectators}` : '';
    playerStatus.textContent = max
      ? `Players: ${count}/${max}${spectatorLabel}`
      : `Players: ${count}`;
  }
}

function setRoomTitle(title) {
  roomTitle = title || 'Solo Studio';
  roomTitleEl.textContent = roomTitle;
}

function setCanDraw(value) {
  const allowed = value && !isSpectator;
  canDraw = allowed;

  if (isSpectator) {
    waitOverlay.textContent = 'Spectator mode — drawing is disabled.';
    waitOverlay.classList.add('visible');
    return;
  }

  waitOverlay.textContent = 'Waiting for at least 2 players to join...';
  if (isMultiplayer && !value) {
    waitOverlay.classList.add('visible');
  } else {
    waitOverlay.classList.remove('visible');
  }
}

function clearChat() {
  chatMessages.innerHTML = '';
}

function addChatMessage({ name, color, message, ts }) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-message';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = new Date(ts || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  const nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  if (color) nameSpan.style.color = color;

  const timeSpan = document.createElement('span');
  timeSpan.textContent = `· ${time}`;

  meta.appendChild(nameSpan);
  meta.appendChild(timeSpan);

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = message;

  wrap.appendChild(meta);
  wrap.appendChild(text);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setChatEnabled(enabled) {
  chatText.disabled = !enabled;
  chatForm.querySelector('button').disabled = !enabled;
  chatNote.style.display = enabled ? 'none' : 'block';
}

function makeActionId() {
  return `a-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function updateActionStates() {
  if (isSpectator) {
    undoBtn.disabled = true;
    clearBtn.disabled = true;
    hostNote.textContent = 'Spectator mode';
    undoBtn.textContent = 'Undo';
    return;
  }

  if (!isMultiplayer) {
    const localRemaining = localActionStack.length;
    undoBtn.disabled = localRemaining === 0;
    clearBtn.disabled = false;
    undoBtn.textContent = localRemaining ? `Undo (${localRemaining})` : 'Undo';
    hostNote.textContent = 'Local actions';
    return;
  }

  const isHost = socketId && hostId && socketId === hostId;
  undoBtn.disabled = !isHost || undoRemaining === 0;
  clearBtn.disabled = !isHost;
  undoBtn.textContent = undoRemaining ? `Undo (${undoRemaining})` : 'Undo';
  hostNote.textContent = isHost ? 'You are the host.' : 'Host only: Undo & Clear';
}

function setSpectatorMode(value) {
  isSpectator = value;
  toolSelect.disabled = value;
  sizeInput.disabled = value;
  colorInput.disabled = value || toolSelect.value === 'eraser';
  drawHint.textContent = value ? 'Spectator mode' : isMultiplayer ? 'Multiplayer room' : 'Solo mode';
  setCanDraw(isMultiplayer ? roomCanDraw : true);
  updateActionStates();
}

function clearCanvasLocal() {
  const rect = getCanvasRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  clearOverlay();
}

function recordLocalDraw(draw) {
  if (!draw || !draw.actionId) return;
  localHistory.push(draw);

  if (localActionStack[localActionStack.length - 1] !== draw.actionId) {
    localActionStack.push(draw.actionId);
    if (localActionStack.length > LOCAL_UNDO_LIMIT) {
      localActionStack.shift();
    }
  }

  updateActionStates();
}

function undoLocal() {
  if (!localActionStack.length) {
    showToast('Nothing to undo.');
    return;
  }
  const actionId = localActionStack.pop();
  localHistory = localHistory.filter((item) => item.actionId !== actionId);
  applyHistory(localHistory);
  updateActionStates();
}

function clearLocalHistory() {
  localHistory = [];
  localActionStack = [];
  clearCanvasLocal();
  updateActionStates();
}

function renderRoomList(rooms, maxPlayers) {
  serverList.innerHTML = '';
  if (!rooms.length) {
    serverEmpty.textContent = 'No active rooms yet.';
    serverEmpty.style.display = 'block';
    return;
  }

  serverEmpty.style.display = 'none';
  rooms.forEach((room) => {
    const item = document.createElement('div');
    item.className = 'server-item';

    const meta = document.createElement('div');
    meta.className = 'server-meta';

    const players = typeof room.players === 'number' ? room.players : room.count || 0;
    const spectators = typeof room.spectators === 'number' ? room.spectators : 0;

    const title = document.createElement('div');
    title.className = 'server-title';
    title.textContent = room.title || 'Untitled Room';

    const code = document.createElement('div');
    code.className = 'server-code';
    code.textContent = room.roomId;

    const count = document.createElement('div');
    count.className = 'server-count';
    const fullLabel = players >= maxPlayers ? ' (spectate only)' : '';
    count.textContent = `Players: ${players}/${maxPlayers}${fullLabel} · Spectators: ${spectators}`;

    meta.appendChild(title);
    meta.appendChild(code);
    meta.appendChild(count);

    const tagList = document.createElement('div');
    tagList.className = 'tag-list';
    if (room.locked) {
      const lockTag = document.createElement('div');
      lockTag.className = 'tag locked';
      lockTag.textContent = 'Locked';
      tagList.appendChild(lockTag);
    }
    if (room.tags && room.tags.length) {
      room.tags.forEach((tag) => {
        const tagEl = document.createElement('div');
        tagEl.className = 'tag';
        tagEl.textContent = tag;
        tagList.appendChild(tagEl);
      });
    }
    if (tagList.children.length) {
      meta.appendChild(tagList);
    }

    const joinBtn = document.createElement('button');
    joinBtn.className = 'secondary';
    joinBtn.textContent = 'Join';

    joinBtn.addEventListener('click', () => {
      attemptJoin(room.roomId, players, Boolean(room.locked));
    });

    item.appendChild(meta);
    item.appendChild(joinBtn);
    serverList.appendChild(item);
  });
}

async function loadRooms() {
  try {
    const res = await fetch('/rooms', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    renderRoomList(data.rooms || [], data.max || 10);
  } catch (err) {
    serverList.innerHTML = '';
    serverEmpty.textContent = 'Unable to load rooms.';
    serverEmpty.style.display = 'block';
  }
}

function startRoomPolling() {
  if (roomPoller) return;
  loadRooms();
  roomPoller = setInterval(() => {
    if (!lobby.classList.contains('hidden')) {
      loadRooms();
    }
  }, 4000);
}

function getCanvasRect() {
  return canvas.getBoundingClientRect();
}

function resizeCanvas() {
  const rect = getCanvasRect();
  const newDpr = window.devicePixelRatio || 1;

  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  snapshot.getContext('2d').drawImage(canvas, 0, 0);

  canvas.width = Math.max(1, Math.floor(rect.width * newDpr));
  canvas.height = Math.max(1, Math.floor(rect.height * newDpr));
  overlay.width = canvas.width;
  overlay.height = canvas.height;

  ctx.setTransform(newDpr, 0, 0, newDpr, 0, 0);
  octx.setTransform(newDpr, 0, 0, newDpr, 0, 0);

  if (snapshot.width && snapshot.height) {
    ctx.drawImage(snapshot, 0, 0, snapshot.width, snapshot.height, 0, 0, rect.width, rect.height);
  }

  currentDpr = newDpr;
}

function toCanvasPos(event) {
  const rect = getCanvasRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function getBrushMode() {
  return toolSelect.value === 'eraser' ? 'destination-out' : 'source-over';
}

function drawStroke(targetCtx, from, to, color, size, mode) {
  targetCtx.save();
  targetCtx.globalCompositeOperation = mode;
  targetCtx.strokeStyle = color;
  targetCtx.lineWidth = size;
  targetCtx.lineCap = 'round';
  targetCtx.lineJoin = 'round';
  targetCtx.beginPath();
  targetCtx.moveTo(from.x, from.y);
  targetCtx.lineTo(to.x, to.y);
  targetCtx.stroke();
  targetCtx.restore();
}

function drawShape(targetCtx, shape, start, end, color, size, mode) {
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxX = Math.max(start.x, end.x);
  const maxY = Math.max(start.y, end.y);

  targetCtx.save();
  targetCtx.globalCompositeOperation = mode;
  targetCtx.strokeStyle = color;
  targetCtx.lineWidth = size;
  targetCtx.lineJoin = 'round';

  if (shape === 'line') {
    targetCtx.beginPath();
    targetCtx.moveTo(start.x, start.y);
    targetCtx.lineTo(end.x, end.y);
    targetCtx.stroke();
  } else if (shape === 'rect') {
    targetCtx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  } else if (shape === 'circle') {
    const radiusX = (maxX - minX) / 2;
    const radiusY = (maxY - minY) / 2;
    const centerX = minX + radiusX;
    const centerY = minY + radiusY;
    targetCtx.beginPath();
    targetCtx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
    targetCtx.stroke();
  } else if (shape === 'triangle') {
    const midX = (minX + maxX) / 2;
    targetCtx.beginPath();
    targetCtx.moveTo(midX, minY);
    targetCtx.lineTo(maxX, maxY);
    targetCtx.lineTo(minX, maxY);
    targetCtx.closePath();
    targetCtx.stroke();
  }

  targetCtx.restore();
}

function renderDrawEvent(draw) {
  if (!draw) return;
  if (draw.type === 'stroke') {
    drawStroke(ctx, draw.from, draw.to, draw.color, draw.size, draw.mode);
  } else if (draw.type === 'shape') {
    drawShape(ctx, draw.shape, draw.start, draw.end, draw.color, draw.size, draw.mode);
  }
}

function clearOverlay() {
  const rect = getCanvasRect();
  octx.clearRect(0, 0, rect.width, rect.height);
}

function getOrCreateCursor(id, name) {
  if (cursors.has(id)) return cursors.get(id);

  const el = document.createElement('div');
  el.className = 'cursor';

  const dot = document.createElement('div');
  dot.className = 'dot';

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = name;

  el.appendChild(dot);
  el.appendChild(label);
  cursorLayer.appendChild(el);
  cursors.set(id, el);
  return el;
}

function updateCursor(id, name, pos, drawing) {
  const el = getOrCreateCursor(id, name);
  const label = el.querySelector('.label');
  if (label && name && label.textContent !== name) {
    label.textContent = name;
  }
  if (el.style.display === 'none') {
    el.style.display = 'block';
  }
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
  if (drawing) {
    el.classList.add('active');
  } else {
    el.classList.remove('active');
  }
}

function removeCursor(id) {
  const el = cursors.get(id);
  if (!el) return;
  el.remove();
  cursors.delete(id);
}

function ensureLocalCursor() {
  if (localCursorEl) return;
  localCursorEl = getOrCreateCursor('local', playerName || 'You');
}

function updateLocalCursor(pos, drawing) {
  ensureLocalCursor();
  updateCursor('local', playerName || 'You', pos, drawing);
}

function sendCursor(pos, drawing) {
  if (!isMultiplayer || !socket) return;
  latestCursor = { pos, drawing };
  if (cursorSendPending) return;
  cursorSendPending = true;
  requestAnimationFrame(() => {
    cursorSendPending = false;
    if (!latestCursor) return;
    socket.emit('cursor', {
      cursor: {
        x: latestCursor.pos.x,
        y: latestCursor.pos.y,
        drawing: latestCursor.drawing
      }
    });
  });
}

function startDrawing(event) {
  if (isSpectator) {
    showToast('Spectator mode: drawing is disabled.');
    return;
  }
  if (!canDraw) {
    showToast('Waiting for another player to join.');
    return;
  }

  isDrawing = true;
  currentActionId = makeActionId();
  const pos = toCanvasPos(event);
  lastPos = pos;
  startPos = pos;

  updateLocalCursor(pos, true);
  sendCursor(pos, true);

  if (!SHAPE_TOOLS.has(toolSelect.value)) {
    const draw = {
      type: 'stroke',
      from: pos,
      to: pos,
      color: colorInput.value,
      size: Number(sizeInput.value),
      mode: getBrushMode(),
      actionId: currentActionId
    };
    drawStroke(ctx, draw.from, draw.to, draw.color, draw.size, draw.mode);
    if (isMultiplayer && socket) {
      socket.emit('draw', { draw });
    } else {
      recordLocalDraw(draw);
    }
  }
}

function drawMove(event) {
  const pos = toCanvasPos(event);
  updateLocalCursor(pos, isDrawing);
  sendCursor(pos, isDrawing);

  if (!isDrawing) return;

  const tool = toolSelect.value;
  const brushMode = getBrushMode();

  if (tool === 'pen' || tool === 'eraser') {
    const draw = {
      type: 'stroke',
      from: lastPos,
      to: pos,
      color: colorInput.value,
      size: Number(sizeInput.value),
      mode: brushMode,
      actionId: currentActionId || makeActionId()
    };
    drawStroke(ctx, draw.from, draw.to, draw.color, draw.size, draw.mode);

    if (isMultiplayer && socket) {
      socket.emit('draw', { draw });
    } else {
      recordLocalDraw(draw);
    }

    lastPos = pos;
  } else if (SHAPE_TOOLS.has(tool)) {
    clearOverlay();
    drawShape(octx, tool, startPos, pos, colorInput.value, Number(sizeInput.value), 'source-over');
  }
}

function endDrawing(event) {
  if (!isDrawing) return;
  isDrawing = false;

  const pos = toCanvasPos(event);
  updateLocalCursor(pos, false);
  sendCursor(pos, false);

  const tool = toolSelect.value;
  if (SHAPE_TOOLS.has(tool)) {
    clearOverlay();
    const draw = {
      type: 'shape',
      shape: tool,
      start: startPos,
      end: pos,
      color: colorInput.value,
      size: Number(sizeInput.value),
      mode: 'source-over',
      actionId: currentActionId || makeActionId()
    };
    drawShape(ctx, draw.shape, draw.start, draw.end, draw.color, draw.size, draw.mode);

    if (isMultiplayer && socket) {
      socket.emit('draw', { draw });
    } else {
      recordLocalDraw(draw);
    }
  }

  lastPos = null;
  startPos = null;
  currentActionId = null;
}

function resetSession() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  isMultiplayer = false;
  isSpectator = false;
  canDraw = true;
  roomId = null;
  playerName = '';
  hostId = null;
  socketId = null;
  undoRemaining = 0;
  roomCanDraw = true;
  localHistory = [];
  localActionStack = [];
  setRoomInfo('Solo', 1, null, 0);
  setRoomTitle('Solo Studio');
  setCanDraw(true);
  drawHint.textContent = 'Solo mode';
  clearChat();
  setChatEnabled(false);
  clearOverlay();
  cursors.forEach((el, id) => {
    if (id !== 'local') removeCursor(id);
  });
  if (localCursorEl) {
    localCursorEl.remove();
    localCursorEl = null;
    cursors.delete('local');
  }
  toolSelect.disabled = false;
  sizeInput.disabled = false;
  colorInput.disabled = toolSelect.value === 'eraser';
  updateActionStates();
}

function setupMultiplayer(name) {
  playerName = name;
  isMultiplayer = true;
  setChatEnabled(true);
  ensureLocalCursor();

  socket = io();

  socket.on('connect', () => {
    socketId = socket.id;
    updateActionStates();
  });

  socket.on('roomJoined', ({ roomId: joinedRoom, history, role, title, hostId: roomHost }) => {
    roomId = joinedRoom;
    setRoomInfo(roomId, 1, 10, 0);
    setRoomTitle(title);
    hostId = roomHost;
    setSpectatorMode(role === 'spectator');
    lobby.classList.add('hidden');
    applyHistory(history);
  });

  socket.on('roomStatus', ({ count, max, spectators, canDraw: canDrawRoom, hostId: roomHost, undoRemaining: undoCount }) => {
    roomCanDraw = canDrawRoom;
    undoRemaining = undoCount || 0;
    hostId = roomHost;
    setRoomInfo(roomId || 'Room', count, max, spectators || 0);
    setCanDraw(roomCanDraw);
    updateActionStates();
  });

  socket.on('draw', ({ draw }) => {
    renderDrawEvent(draw);
  });

  socket.on('cursor', ({ id, name, cursor }) => {
    updateCursor(id, name, { x: cursor.x, y: cursor.y }, cursor.drawing);
  });

  socket.on('playerLeft', ({ id }) => {
    removeCursor(id);
  });

  socket.on('chat', ({ name, color, message, ts }) => {
    addChatMessage({ name, color, message, ts });
  });

  socket.on('syncHistory', ({ history }) => {
    applyHistory(history);
  });

  socket.on('clearCanvas', ({ by }) => {
    clearCanvasLocal();
    if (by) {
      showToast(`Canvas cleared by ${by}`);
    }
  });

  socket.on('roomError', ({ message }) => {
    showToast(message);
  });
}

function applyHistory(history) {
  const rect = getCanvasRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  clearOverlay();
  if (!history || !history.length) return;
  history.forEach(renderDrawEvent);
}

function beginSolo() {
  resetSession();
  lobby.classList.add('hidden');
  setChatEnabled(false);
  ensureLocalCursor();
}

sizeInput.addEventListener('input', () => {
  sizeValue.textContent = sizeInput.value;
});

toolSelect.addEventListener('change', () => {
  const isEraser = toolSelect.value === 'eraser';
  colorInput.disabled = isSpectator || isEraser;
});

refreshRoomsBtn.addEventListener('click', () => {
  loadRooms();
});

undoBtn.addEventListener('click', () => {
  if (isSpectator) {
    showToast('Spectator mode: undo is disabled.');
    return;
  }
  if (!isMultiplayer) {
    undoLocal();
    return;
  }
  const isHost = socketId && hostId && socketId === hostId;
  if (!isHost) {
    showToast('Only the host can undo.');
    return;
  }
  socket.emit('undo');
});

clearBtn.addEventListener('click', () => {
  if (isSpectator) {
    showToast('Spectator mode: clear is disabled.');
    return;
  }

  const confirmed = window.confirm('Clear the canvas? This cannot be undone.');
  if (!confirmed) return;

  if (!isMultiplayer) {
    clearLocalHistory();
    return;
  }

  const isHost = socketId && hostId && socketId === hostId;
  if (!isHost) {
    showToast('Only the host can clear the canvas.');
    return;
  }
  socket.emit('clearCanvas');
});

exportBtn.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'canvas-clash.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
});

canvas.addEventListener('pointerdown', (event) => {
  startDrawing(event);
  if (isDrawing) {
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener('pointermove', drawMove);

canvas.addEventListener('pointerenter', (event) => {
  const pos = toCanvasPos(event);
  updateLocalCursor(pos, false);
});

canvas.addEventListener('pointerup', (event) => {
  endDrawing(event);
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
});

canvas.addEventListener('pointerleave', (event) => {
  if (isDrawing) endDrawing(event);
  if (localCursorEl) {
    localCursorEl.style.display = 'none';
  }
});

window.addEventListener('resize', () => {
  resizeCanvas();
});

createBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  const color = nameColorInput.value;
  const title = roomTitleInput.value.trim();
  const tags = roomTagsInput.value.trim();
  const password = roomPasswordInput.value.trim();
  if (!name) {
    showToast('Enter a name to create a room.');
    return;
  }

  resetSession();
  setupMultiplayer(name);
  socket.emit('createRoom', { name, color, title, tags, password });
});

function attemptJoin(code, playersCount = null, locked = false) {
  const name = nameInput.value.trim();
  const color = nameColorInput.value;
  const roomCode = String(code || '').trim().toUpperCase();
  const role = spectatorToggle.checked ? 'spectator' : 'player';
  const password = roomPasswordInput.value.trim();
  if (!name) {
    showToast('Enter a name to join a room.');
    return;
  }
  if (!roomCode) {
    showToast('Enter a room code to join.');
    return;
  }
  if (locked && !password) {
    showToast('Room is locked. Enter the password to join.');
    return;
  }
  if (role === 'player' && playersCount !== null && playersCount >= 10) {
    showToast('Room is full. Enable spectator mode to watch.');
    return;
  }

  resetSession();
  setupMultiplayer(name);
  socket.emit('joinRoom', { name, roomId: roomCode, color, role, password });
}

joinBtn.addEventListener('click', () => {
  const code = roomInput.value.trim().toUpperCase();
  attemptJoin(code);
});

soloBtn.addEventListener('click', () => {
  beginSolo();
});

leaveBtn.addEventListener('click', () => {
  resetSession();
  lobby.classList.remove('hidden');
  loadRooms();
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = chatText.value.trim();
  if (!message) return;
  if (!isMultiplayer || !socket) {
    showToast('Chat is available in multiplayer only.');
    return;
  }
  socket.emit('chat', { message });
  chatText.value = '';
});

resizeCanvas();
setCanDraw(true);
setChatEnabled(false);
colorInput.disabled = isSpectator || toolSelect.value === 'eraser';
startRoomPolling();
updateActionStates();
