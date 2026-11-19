/*
 * In-memory WebRTC signaling hub for Vanguard Live Classroom.
 *
 * Each open classroom keeps a small registry of connected participants. The
 * browser keeps an SSE stream open for downstream signals (offers, answers,
 * ICE candidates and media state) and POSTs upstream signals through the
 * authenticated room API. SDP and ICE payloads are only relayed between users
 * who are currently connected to the same meeting; nothing is persisted.
 *
 * This matches the single-process deployment of the LMS. If the app is later
 * run on multiple instances, this registry needs a shared transport
 * (e.g. Redis pub/sub) so participants on different instances can find each
 * other.
 */

const rooms = new Map();

function roomFor(meetingId) {
  let room = rooms.get(meetingId);
  if (!room) {
    room = new Map();
    rooms.set(meetingId, room);
  }
  return room;
}

function writeEvent(res, event, data) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcast(room, exceptUserId, event, data) {
  for (const client of room.values()) {
    if (client.userId === exceptUserId) continue;
    writeEvent(client.res, event, data);
  }
}

/**
 * Register a participant's SSE stream. Returns the client record so the caller
 * can inspect it. The caller must have already verified meeting access.
 */
export function attachSignalStream({ meetingId, userId, name, role, res }) {
  const room = roomFor(meetingId);
  const existing = room.get(userId);
  if (existing) {
    // A reload replaces the old stream.
    try {
      existing.res.end();
    } catch {
      /* the old stream is already gone */
    }
    room.delete(userId);
  }

  const peers = [...room.values()].map((client) => ({
    id: client.userId,
    name: client.name,
    role: client.role,
  }));

  const client = { userId, name, role, res };
  room.set(userId, client);

  writeEvent(res, "hello", { self: userId, peers });
  broadcast(room, userId, "join", { id: userId, name, role });

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(": keep-alive\n\n");
    } catch {
      /* handled by the close event */
    }
  }, 20000);

  const close = () => {
    clearInterval(heartbeat);
    if (room.get(userId) === client) room.delete(userId);
    broadcast(room, userId, "left", { id: userId });
    if (!room.size) rooms.delete(meetingId);
  };

  res.on("close", close);
  res.on("error", close);

  return client;
}

/**
 * Relay one signaling message. Returns true when it was delivered so the
 * controller can answer 409 for participants that already left.
 */
export function relaySignal(meetingId, fromUserId, { target, type, data, broadcast: toEveryone }) {
  const room = rooms.get(meetingId);
  if (!room) return false;
  const sender = room.get(fromUserId);
  if (!sender) return false;

  const payload = {
    from: fromUserId,
    fromName: sender.name,
    fromRole: sender.role,
    type,
    data,
  };

  if (toEveryone) {
    let delivered = false;
    for (const client of room.values()) {
      if (client.userId === fromUserId) continue;
      delivered = writeEvent(client.res, "signal", payload) || delivered;
    }
    return delivered;
  }

  const receiver = room.get(Number(target));
  if (!receiver) return false;
  return writeEvent(receiver.res, "signal", payload);
}

export function disconnectParticipant(meetingId, userId) {
  const room = rooms.get(meetingId);
  const client = room && room.get(Number(userId));
  if (!client) return false;
  try {
    client.res.end();
  } catch {
    /* already closed */
  }
  return true;
}

export function closeMeetingSignals(meetingId) {
  const room = rooms.get(meetingId);
  if (!room) return;
  for (const client of [...room.values()]) {
    try {
      client.res.end();
    } catch {
      /* already closed */
    }
  }
}

export function connectedParticipants(meetingId) {
  const room = rooms.get(meetingId);
  if (!room) return [];
  return [...room.values()].map((client) => ({
    id: client.userId,
    name: client.name,
    role: client.role,
  }));
}

export function signalingRoomCount() {
  return rooms.size;
}
