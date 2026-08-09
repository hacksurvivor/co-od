export interface PinnedRoom {
  roomId: string;
  roomName?: string;
}

export interface PinnedAgent {
  agentId: string;
  name?: string;
  provider?: string;
}

export interface TuiPins {
  rooms: PinnedRoom[];
  providers: string[];
  agents: PinnedAgent[];
}

export type PinTarget = "room" | "provider" | "agent";

export function emptyPins(): TuiPins {
  return { rooms: [], providers: [], agents: [] };
}

export function normalizePins(pins?: Partial<TuiPins>, limits = { rooms: 12, providers: 8, agents: 20 }): TuiPins {
  const rooms = dedupeBy(
    (pins?.rooms || [])
      .map((room): PinnedRoom => {
        const normalized: PinnedRoom = { roomId: room.roomId?.trim() || "" };
        const roomName = room.roomName?.trim();
        if (roomName) normalized.roomName = roomName;
        return normalized;
      })
      .filter((room) => Boolean(room.roomId)),
    (room) => room.roomId,
  ).slice(-limits.rooms);

  const providers = dedupeStrings(
    (pins?.providers || [])
      .map((provider) => provider.trim())
      .filter(Boolean),
  ).slice(-limits.providers);

  const agents = dedupeBy(
    (pins?.agents || [])
      .map((agent): PinnedAgent => {
        const normalized: PinnedAgent = { agentId: agent.agentId?.trim() || "" };
        const name = agent.name?.trim();
        const provider = agent.provider?.trim();
        if (name) normalized.name = name;
        if (provider) normalized.provider = provider;
        return normalized;
      })
      .filter((agent) => Boolean(agent.agentId)),
    (agent) => agent.agentId,
  ).slice(-limits.agents);

  return { rooms, providers, agents };
}

export function pinRoom(pins: TuiPins, room: PinnedRoom): TuiPins {
  return normalizePins({
    ...pins,
    rooms: [...pins.rooms.filter((candidate) => candidate.roomId !== room.roomId), room],
  });
}

export function pinProvider(pins: TuiPins, provider: string): TuiPins {
  const value = provider.trim();
  if (!value) return normalizePins(pins);
  return normalizePins({
    ...pins,
    providers: [...pins.providers.filter((candidate) => candidate !== value), value],
  });
}

export function pinAgent(pins: TuiPins, agent: PinnedAgent): TuiPins {
  return normalizePins({
    ...pins,
    agents: [...pins.agents.filter((candidate) => candidate.agentId !== agent.agentId), agent],
  });
}

export function unpinTarget(pins: TuiPins, target: PinTarget, value: string): TuiPins {
  const normalized = value.trim();
  if (!normalized) return normalizePins(pins);
  if (target === "room") {
    return normalizePins({
      ...pins,
      rooms: pins.rooms.filter((room) => room.roomId !== normalized && room.roomName !== normalized),
    });
  }
  if (target === "provider") {
    return normalizePins({
      ...pins,
      providers: pins.providers.filter((provider) => provider !== normalized),
    });
  }
  return normalizePins({
    ...pins,
    agents: pins.agents.filter((agent) => agent.agentId !== normalized && agent.name !== normalized),
  });
}

export function isPinnedRoom(pins: TuiPins, roomId?: string): boolean {
  return Boolean(roomId && pins.rooms.some((room) => room.roomId === roomId));
}

export function isPinnedProvider(pins: TuiPins, provider?: string): boolean {
  return Boolean(provider && pins.providers.includes(provider));
}

export function isPinnedAgent(pins: TuiPins, agentId?: string): boolean {
  return Boolean(agentId && pins.agents.some((agent) => agent.agentId === agentId));
}

export function pinSummaryLines(pins: TuiPins): string[] {
  const normalized = normalizePins(pins);
  const lines: string[] = [];
  lines.push(`rooms     ${normalized.rooms.length > 0 ? normalized.rooms.map((room) => room.roomName || room.roomId).join(", ") : "none"}`);
  lines.push(`providers ${normalized.providers.length > 0 ? normalized.providers.join(", ") : "none"}`);
  lines.push(`agents    ${normalized.agents.length > 0 ? normalized.agents.map((agent) => agent.name || agent.agentId).join(", ") : "none"}`);
  return lines;
}

function dedupeStrings(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const existing = result.indexOf(value);
    if (existing >= 0) result.splice(existing, 1);
    result.push(value);
  }
  return result;
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const result: T[] = [];
  const keys: string[] = [];
  for (const value of values) {
    const id = key(value);
    const existing = keys.indexOf(id);
    if (existing >= 0) {
      keys.splice(existing, 1);
      result.splice(existing, 1);
    }
    keys.push(id);
    result.push(value);
  }
  return result;
}
