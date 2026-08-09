export interface TaskHistoryResolution {
  ok: boolean;
  goal?: string;
  index?: number;
  message: string;
}

export function formatTaskHistory(history: string[], query = "", limit = 12): string {
  const normalized = query.trim().toLowerCase();
  const newest = history.slice().reverse();
  const matches = normalized
    ? newest.filter((entry) => entry.toLowerCase().includes(normalized))
    : newest;

  if (matches.length === 0) {
    return normalized ? `No task history matched: ${query}` : "No task history yet.";
  }

  const visible = matches.slice(0, limit);
  return [
    normalized ? `Task history matching ${query}:` : "Task history:",
    ...visible.map((entry, index) => `${index + 1}. ${oneLine(entry)}`),
    matches.length > visible.length ? `... ${matches.length - visible.length} more` : "",
  ].filter(Boolean).join("\n");
}

export function resolveTaskHistoryItem(history: string[], ref = ""): TaskHistoryResolution {
  if (history.length === 0) {
    return { ok: false, message: "No task history yet." };
  }

  const newest = history.slice().reverse();
  const value = ref.trim();
  if (!value || value === "last" || value === "latest") {
    return {
      ok: true,
      goal: newest[0],
      index: 1,
      message: `Selected latest task history item: ${oneLine(newest[0] || "")}`,
    };
  }

  if (/^\d+$/.test(value)) {
    const index = Number(value);
    const goal = newest[index - 1];
    if (!goal) {
      return {
        ok: false,
        message: `No task history item ${index}. Available: 1-${newest.length}.`,
      };
    }
    return {
      ok: true,
      goal,
      index,
      message: `Selected task history item ${index}: ${oneLine(goal)}`,
    };
  }

  const matches = newest
    .map((goal, index) => ({ goal, index: index + 1 }))
    .filter((entry) => entry.goal.toLowerCase().includes(value.toLowerCase()));
  if (matches.length === 0) {
    return { ok: false, message: `No task history matched: ${value}` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Task history query matched ${matches.length} items. Use /history ${value} then /use-history <index>.`,
    };
  }

  return {
    ok: true,
    goal: matches[0].goal,
    index: matches[0].index,
    message: `Selected task history item ${matches[0].index}: ${oneLine(matches[0].goal)}`,
  };
}

function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
