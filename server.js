const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.use(express.static(path.join(__dirname, "public")));

const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const suits = [
  { name:"spades", symbol:"♠", color:"black" },
  { name:"hearts", symbol:"♥", color:"red" },
  { name:"clubs", symbol:"♣", color:"black" },
  { name:"diamonds", symbol:"♦", color:"red" }
];

const suitOrder = ["spades", "clubs", "diamonds", "hearts"];

function meldSortCards(cards) {
  return [...cards].sort((a, b) => {
    const rankDiff = ranks.indexOf(a.rank) - ranks.indexOf(b.rank);
    if (rankDiff !== 0) return rankDiff;

    const suitDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
    if (suitDiff !== 0) return suitDiff;

    return a.dealIndex - b.dealIndex;
  });
}

function organizeSlotsForPlayer(room, player) {
  const playerCards = meldSortCards(room.cards.filter(card => card.owner === player && !card.removed));

  playerCards.forEach((card, index) => {
    card.displaySlot = index;
  });
}

function organizeSlotsForMelds(room) {
  organizeSlotsForPlayer(room, 1);
  organizeSlotsForPlayer(room, 2);
}

const rooms = new Map();
const emptyRoomTimers = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function uniqueRoomCode() {
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();
  return code;
}

function makeDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({
        id: `${rank}-${suit.name}`,
        rank,
        suit: suit.name,
        symbol: suit.symbol,
        color: suit.color,
        owner: null,
        dealIndex: 0,
        displaySlot: 0,
        removed: false
      });
    }
  }
  return deck;
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function deal(room) {
  const deck = shuffle(makeDeck());
  room.cards = deck.map((card, i) => ({
    ...card,
    owner: i < 26 ? 1 : 2,
    dealIndex: i,
    displaySlot: i % 26,
    removed: false
  }));
  organizeSlotsForMelds(room);
  room.score = { 1: 0, 2: 0 };
  room.round = 0;
  room.call = null;
  room.callStage = "waiting";
  room.swap = null;
  room.meldCounts = { 1: 0, 2: 0 };
  room.meldBlockCounts = { 1: 0, 2: 0 };
  room.meldBlockActive = { 1: false, 2: false };
  room.message = "New match dealt. Start a round.";
  clearRoomTimer(room);
}

function clearRoomTimer(room) {
  if (room.stageTimer) clearTimeout(room.stageTimer);
  if (room.fakeTimer) clearTimeout(room.fakeTimer);
  room.stageTimer = null;
  room.fakeTimer = null;
}

function cancelLiveRound(room, message) {
  clearRoomTimer(room);
  room.call = null;
  room.callStage = "waiting";
  room.swap = null;
  room.meldCounts = { 1: 0, 2: 0 };
  room.meldBlockCounts = { 1: 0, 2: 0 };
  room.meldBlockActive = { 1: false, 2: false };
  if (message) room.message = message;
}

function scheduleEmptyRoomDelete(room) {
  if (!room || room.players[1] || room.players[2]) return;

  if (emptyRoomTimers.has(room.code)) clearTimeout(emptyRoomTimers.get(room.code));

  const timer = setTimeout(() => {
    const latest = rooms.get(room.code);
    if (latest && !latest.players[1] && !latest.players[2]) {
      clearRoomTimer(latest);
      rooms.delete(room.code);
      emptyRoomTimers.delete(room.code);
      console.log(`Deleted empty room ${room.code}`);
    }
  }, 30000);

  emptyRoomTimers.set(room.code, timer);
}

function cancelEmptyRoomDelete(code) {
  const timer = emptyRoomTimers.get(code);
  if (timer) clearTimeout(timer);
  emptyRoomTimers.delete(code);
}

function createRoom(socket) {
  const code = uniqueRoomCode();
  const room = {
    code,
    players: { 1: socket.id, 2: null },
    spectators: [],
    cards: [],
    score: { 1: 0, 2: 0 },
    round: 0,
    call: null,
    callStage: "waiting",
    swap: null,
    meldCounts: { 1: 0, 2: 0 },
    meldBlockCounts: { 1: 0, 2: 0 },
    meldBlockActive: { 1: false, 2: false },
    message: "Room created. Waiting for Player 2.",
    stageTimer: null,
    fakeTimer: null
  };

  deal(room);
  rooms.set(code, room);
  socket.join(code);
  socket.data.roomCode = code;
  socket.data.player = 1;

  socket.emit("youAre", { player: 1, roomCode: code });
  sendState(room);
}

function joinRoom(socket, code) {
  code = String(code || "").trim().toUpperCase();
  const room = rooms.get(code);

  cancelEmptyRoomDelete(code);

  if (!room) {
    socket.emit("errorMessage", "Room not found.");
    return;
  }

  let player = null;
  if (!room.players[1]) player = 1;
  else if (!room.players[2]) player = 2;

  if (!player) {
    room.spectators.push(socket.id);
    socket.data.player = 0;
  } else {
    room.players[player] = socket.id;
    socket.data.player = player;
  }

  socket.join(code);
  socket.data.roomCode = code;

  if (player === 0) socket.emit("youAre", { player: 0, roomCode: code });
  else socket.emit("youAre", { player, roomCode: code });

  room.message = player
    ? `Player ${player} joined.`
    : "Spectator joined.";

  sendState(room);
}

function roomForSocket(socket) {
  const code = socket.data.roomCode;
  if (!code) return null;
  return rooms.get(code);
}

function playerForSocket(socket) {
  return Number(socket.data.player || 0);
}

function activeCards(room) {
  return room.cards.filter(card => !card.removed);
}

function cardsForPlayer(room, player) {
  return room.cards.filter(card => card.owner === player && !card.removed);
}

function buildCall(room) {
  const active = activeCards(room);
  if (!active.length) return null;

  // 10% total fake calls. Four fake calls = 2.5% each.
  // Fake calls still have a "first clue" stage, then the full fake text.
  if (Math.random() < 0.10) {
    const fakeCalls = [
      { firstText: "A", fullText: "fat chud", color: "red" },
      { firstText: "1", fullText: "love hatsume miku", color: "red" },
      { firstText: "6", fullText: "7", color: "red" },
      { firstText: "♠", fullText: "♠ of chud", color: "black" }
    ];

    const fake = fakeCalls[Math.floor(Math.random() * fakeCalls.length)];

    return {
      fake: true,
      firstText: fake.firstText,
      fullText: fake.fullText,
      color: fake.color
    };
  }

  const card = active[Math.floor(Math.random() * active.length)];
  const order = Math.random() < 0.65 ? "suitFirst" : "rankFirst";

  return {
    fake: false,
    cardId: card.id,
    rank: card.rank,
    symbol: card.symbol,
    color: card.color,
    order
  };
}

function callView(room) {
  if (!room.call) return { text: "CHUD FART", color: "" };

  if (room.call.fake) {
    return {
      text: room.callStage === "first" ? room.call.firstText : room.call.fullText,
      color: room.call.color || ""
    };
  }

  if (room.callStage === "first") {
    return {
      text: room.call.order === "suitFirst" ? room.call.symbol : room.call.rank,
      color: room.call.color
    };
  }

  if (room.callStage === "full") {
    return {
      text: room.call.order === "suitFirst"
        ? `${room.call.symbol} ${room.call.rank}`
        : `${room.call.rank} ${room.call.symbol}`,
      color: room.call.color,
      cardId: room.call.cardId,
      rank: room.call.rank
    };
  }

  return { text: "CHUD FART", color: "" };
}

function publicState(room) {
  return {
    roomCode: room.code,
    players: {
      p1Connected: !!room.players[1],
      p2Connected: !!room.players[2]
    },
    cards: room.cards,
    score: room.score,
    round: room.round,
    callStage: room.callStage,
    callView: callView(room),
    swap: room.swap,
    meldCounts: room.meldCounts,
    meldBlockCounts: room.meldBlockCounts,
    meldBlockActive: room.meldBlockActive,
    message: room.message
  };
}

function sendState(room) {
  io.to(room.code).emit("state", publicState(room));
}

function personal(socket, text) {
  socket.emit("personalMessage", text);
}

function emitSfx(room, name) {
  io.to(room.code).emit("sfx", name);
}

function endRound(room, message) {
  clearRoomTimer(room);
  room.call = null;
  room.callStage = "waiting";
  room.meldCounts = { 1: 0, 2: 0 };
  room.meldBlockCounts = { 1: 0, 2: 0 };
  room.meldBlockActive = { 1: false, 2: false };
  room.message = message;
  sendState(room);
}

function removeCard(room, id) {
  const card = room.cards.find(c => c.id === id);
  if (card) card.removed = true;
  return card;
}

function opponent(player) {
  return player === 1 ? 2 : 1;
}

function startRound(socket) {
  const room = roomForSocket(socket);
  const player = playerForSocket(socket);
  if (!room || !player) return;

  if (!room.players[1] || !room.players[2]) {
    personal(socket, "Need both players before starting.");
    return;
  }

  if (room.swap) {
    personal(socket, "Finish or skip the swap first.");
    return;
  }

  if (room.callStage !== "waiting") return;

  clearRoomTimer(room);

  const call = buildCall(room);
  if (!call) {
    room.message = "No cards left. Redeal.";
    sendState(room);
    return;
  }

  room.call = call;
  room.callStage = "first";
  room.round += 1;
  room.meldCounts = { 1: 0, 2: 0 };
  room.meldBlockCounts = { 1: 0, 2: 0 };
  room.meldBlockActive = { 1: false, 2: false };
  room.message = `Round ${room.round}: chud fart is up.`;

  sendState(room);

  room.stageTimer = setTimeout(() => {
    if (!rooms.has(room.code) || room.callStage !== "first") return;
    room.callStage = "full";

    if (room.call && room.call.fake) {
      room.message = "Troll call. No card this round.";
      sendState(room);

      room.fakeTimer = setTimeout(() => {
        if (!rooms.has(room.code) || !room.call || !room.call.fake) return;
        endRound(room, "Troll call ended. Start the next round.");
      }, 1700);

      return;
    }

    room.message = "Cut line dropped. Go.";
    sendState(room);
  }, 900);
}

function resolveAction(socket, data) {
  const room = roomForSocket(socket);
  const player = playerForSocket(socket);
  if (!room || !player || room.swap) return;

  const move = data && data.move;
  const cardId = data && data.cardId;

  if (!room.call || room.callStage !== "full") {
    personal(socket, "Wait until the chud fart drops.");
    return;
  }

  const card = room.cards.find(c => c.id === cardId && !c.removed);
  if (!card) {
    personal(socket, "That card is already gone.");
    return;
  }

  if (card.id !== room.call.cardId) {
    personal(socket, "Wrong card. Round is still live.");
    return;
  }

  if (move === "block") {
    if (card.owner !== player) {
      personal(socket, "You can only block your own called card.");
      return;
    }

    emitSfx(room, "block");
    endRound(room, `Player ${player} blocked ${card.rank}${card.symbol}. No points.`);
    return;
  }

  if (move === "capture") {
    emitSfx(room, "capture");

    if (card.owner === player) {
      removeCard(room, card.id);
      endRound(room, `Player ${player} captured their own ${card.rank}${card.symbol}. No points. Card removed.`);
      return;
    }

    room.score[player] += 1;
    removeCard(room, card.id);

    room.call = null;
    room.callStage = "waiting";
    room.meldCounts = { 1: 0, 2: 0 };
    room.meldBlockCounts = { 1: 0, 2: 0 };
    room.meldBlockActive = { 1: false, 2: false };

    room.swap = { player, selectedCardId: null };
    room.message = `Player ${player} captured ${card.rank}${card.symbol}. +1 point. Player ${player} may swap.`;
    sendState(room);
  }
}

function swapPick(socket, cardId) {
  const room = roomForSocket(socket);
  const player = playerForSocket(socket);
  if (!room || !player || !room.swap || room.swap.player !== player) return;

  const card = room.cards.find(c => c.id === cardId && !c.removed);
  if (!card) return;

  if (!room.swap.selectedCardId) {
    if (card.owner !== player) {
      personal(socket, "First choose one of your cards.");
      return;
    }
    room.swap.selectedCardId = card.id;
    room.message = `Player ${player}: now choose an opponent card to receive.`;
    sendState(room);
    return;
  }

  if (card.owner !== opponent(player)) {
    personal(socket, "Second choice must be one of your opponent's cards.");
    return;
  }

  const first = room.cards.find(c => c.id === room.swap.selectedCardId && !c.removed);
  const second = card;

  if (!first || !second) return;

  const ownerTemp = first.owner;
  first.owner = second.owner;
  second.owner = ownerTemp;

  // After a swap, auto-organize both sides by rank so melds are easy to see.
  // Removed cards still leave holes after captures/removals; this only reorganizes when ownership changes.
  organizeSlotsForMelds(room);

  room.swap = null;
  room.message = `Swap complete: Player ${player} traded ${first.rank}${first.symbol} for ${second.rank}${second.symbol}.`;
  sendState(room);
}

function skipSwap(socket) {
  const room = roomForSocket(socket);
  const player = playerForSocket(socket);
  if (!room || !player || !room.swap || room.swap.player !== player) return;

  room.swap = null;
  room.message = `Player ${player} skipped the swap.`;
  sendState(room);
}

function meldInput(socket, data) {
  const room = roomForSocket(socket);
  const player = playerForSocket(socket);
  if (!room || !player || room.swap) return;

  const cardId = data && data.cardId;

  if (!room.call || room.callStage !== "full") {
    personal(socket, "You can only meld after the chud fart drops.");
    return;
  }

  const called = room.cards.find(c => c.id === room.call.cardId && !c.removed);
  if (!called || called.id !== cardId) {
    personal(socket, "Hover/click the called card for meld input.");
    return;
  }

  if (called.owner !== player) {
    personal(socket, "You can only meld when the called card is on your side.");
    return;
  }

  const opp = opponent(player);
  if (room.meldBlockActive[opp]) {
    emitSfx(room, "meld-block");
    endRound(room, `Player ${opp}'s meld block stopped Player ${player}'s meld.`);
    return;
  }

  const matching = cardsForPlayer(room, player).filter(c => c.rank === room.call.rank);
  if (matching.length < 3) {
    personal(socket, `You need 3 cards of rank ${room.call.rank} to meld.`);
    return;
  }

  room.meldCounts[player] += 1;

  if (room.meldCounts[player] < 3) {
    room.message = `Player ${player} meld input ${room.meldCounts[player]}/3.`;
    sendState(room);
    return;
  }

  matching.slice(0, 3).forEach(c => removeCard(room, c.id));
  room.score[player] += 2;
  emitSfx(room, "meld");
  endRound(room, `Player ${player} melded rank ${room.call.rank} for +2 points.`);
}

function meldBlockInput(socket) {
  const room = roomForSocket(socket);
  const player = playerForSocket(socket);
  if (!room || !player || room.swap) return;

  if (!room.call || room.callStage !== "full") {
    personal(socket, "You can only meld block after the chud fart drops.");
    return;
  }

  if (room.meldBlockActive[player]) {
    personal(socket, "Your meld block is already active.");
    return;
  }

  room.meldBlockCounts[player] += 1;

  if (room.meldBlockCounts[player] < 3) {
    room.message = `Player ${player} meld block input ${room.meldBlockCounts[player]}/3.`;
    sendState(room);
    return;
  }

  room.meldBlockActive[player] = true;
  emitSfx(room, "meld-block");
  room.message = `Player ${player} activated meld block. Opponent meld is blocked this round.`;
  sendState(room);
}


function leaveRoom(socket) {
  const room = roomForSocket(socket);
  const player = playerForSocket(socket);
  if (!room) return;

  if (player === 1 || player === 2) {
    room.players[player] = null;
    cancelLiveRound(room, `Player ${player} left. Active round canceled.`);
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.player = 0;

    sendState(room);
    scheduleEmptyRoomDelete(room);
  }
}

io.on("connection", socket => {
  socket.on("createRoom", () => createRoom(socket));
  socket.on("joinRoom", code => joinRoom(socket, code));
  socket.on("startRound", () => startRound(socket));
  socket.on("redeal", () => {
    const room = roomForSocket(socket);
    const player = playerForSocket(socket);
    if (!room || player !== 1) return;
    deal(room);
    sendState(room);
  });
  socket.on("action", data => resolveAction(socket, data));
  socket.on("swapPick", cardId => swapPick(socket, cardId));
  socket.on("skipSwap", () => skipSwap(socket));
  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("meldInput", data => meldInput(socket, data));
  socket.on("meldBlockInput", () => meldBlockInput(socket));

  socket.on("cursorMove", data => {
    const room = roomForSocket(socket);
    const player = playerForSocket(socket);
    if (!room || !player) return;

    const x = Math.max(0, Math.min(1, Number(data && data.x) || 0));
    const y = Math.max(0, Math.min(1, Number(data && data.y) || 0));

    socket.to(room.code).emit("opponentCursor", {
      player,
      x,
      y
    });
  });

  socket.on("disconnect", () => {
    const room = roomForSocket(socket);
    const player = playerForSocket(socket);
    if (!room) return;

    if (player === 1 || player === 2) {
      room.players[player] = null;
      cancelLiveRound(room, `Player ${player} disconnected. Active round canceled.`);

      sendState(room);
      scheduleEmptyRoomDelete(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Card Goblin server running on http://localhost:${PORT}`);
});
