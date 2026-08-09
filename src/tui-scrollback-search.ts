export type TuiScrollbackSearchSource = "feed" | "terminal";

export interface TuiScrollbackFeedEntry {
  kind?: string;
  text: string;
  createdAt?: number;
}

export interface TuiScrollbackSearchMatch {
  source: TuiScrollbackSearchSource;
  text: string;
  line: number;
  entryIndex?: number;
  kind?: string;
}

export interface TuiScrollbackSearchResult {
  query: string;
  scannedLines: number;
  matches: TuiScrollbackSearchMatch[];
  error?: string;
}

export interface SearchTuiScrollbackOptions {
  feed?: TuiScrollbackFeedEntry[];
  terminalLines?: string[];
  query: string;
  limit?: number;
}

export function searchTuiScrollback(options: SearchTuiScrollbackOptions): TuiScrollbackSearchResult {
  const query = options.query.trim();
  if (!query) {
    return { query, scannedLines: 0, matches: [], error: "Usage: /find <query>" };
  }

  const normalized = query.toLowerCase();
  const candidates: TuiScrollbackSearchMatch[] = [];
  let scannedLines = 0;

  for (const [entryIndex, entry] of (options.feed || []).entries()) {
    for (const [lineIndex, line] of splitSearchText(entry.text).entries()) {
      scannedLines++;
      if (!line.toLowerCase().includes(normalized)) continue;
      candidates.push({
        source: "feed",
        text: line,
        line: lineIndex + 1,
        entryIndex: entryIndex + 1,
        kind: entry.kind,
      });
    }
  }

  for (const [lineIndex, line] of (options.terminalLines || []).entries()) {
    scannedLines++;
    if (!line.toLowerCase().includes(normalized)) continue;
    candidates.push({
      source: "terminal",
      text: line,
      line: lineIndex + 1,
    });
  }

  const limit = Math.max(1, options.limit || 25);
  return {
    query,
    scannedLines,
    matches: candidates.slice(-limit).reverse(),
  };
}

export function formatTuiScrollbackSearch(result: TuiScrollbackSearchResult): string {
  if (result.error) return result.error;
  if (result.matches.length === 0) {
    return `No feed or terminal matches for ${JSON.stringify(result.query)} across ${result.scannedLines} lines.`;
  }

  return [
    `Search ${JSON.stringify(result.query)}: ${result.matches.length} match${result.matches.length === 1 ? "" : "es"} across ${result.scannedLines} feed/terminal lines`,
    ...result.matches.map(formatSearchMatch),
  ].join("\n");
}

function formatSearchMatch(match: TuiScrollbackSearchMatch): string {
  if (match.source === "terminal") {
    return `terminal:${match.line}: ${truncateSearchText(match.text)}`;
  }
  const kind = match.kind ? `/${match.kind}` : "";
  return `feed:${match.entryIndex || "?"}${kind}:${match.line}: ${truncateSearchText(match.text)}`;
}

function splitSearchText(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

function truncateSearchText(text: string, max = 180): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}
