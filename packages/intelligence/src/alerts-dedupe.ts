export type AlertRow = {
  id: number;
  type: string;
  entity_id: string | null;
  severity: string;
  message: string;
  created_at: string;
};

const severityRank: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function rankSeverity(v: string) {
  return severityRank[String(v ?? "").toLowerCase()] ?? 0;
}

function dedupeKey(row: AlertRow) {
  const entity = String(row.entity_id ?? "").trim().toLowerCase();
  if (entity) return `${row.type}:${entity}`;
  return `${row.type}:${row.message.trim().toLowerCase()}`;
}

export function dedupeAlertRows(rows: AlertRow[]) {
  const byKey = new Map<string, AlertRow>();

  for (const row of rows) {
    const key = dedupeKey(row);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }

    const prevRank = rankSeverity(prev.severity);
    const rowRank = rankSeverity(row.severity);
    if (rowRank > prevRank) {
      byKey.set(key, row);
      continue;
    }
    if (rowRank < prevRank) continue;

    if (row.id > prev.id) byKey.set(key, row);
  }

  return [...byKey.values()].sort((a, b) => {
    const sev = rankSeverity(b.severity) - rankSeverity(a.severity);
    if (sev !== 0) return sev;
    return b.id - a.id;
  });
}
