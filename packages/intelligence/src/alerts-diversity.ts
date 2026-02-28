export type DispatchAlertRow = {
  id: number;
  type: string;
  entity_id: string | null;
  severity: string;
  message: string;
  created_at?: string;
};

export type AlertMeta = {
  lastSentAt?: string | null;
  recentCount?: number;
  marketCap?: number;
};

export type DiversityOptions = {
  enabled: boolean;
  perCoinCooldownMin: number;
  maxPerCoinPerDispatch: number;
  noveltyWindowHours: number;
  largeCapPenaltyAboveUsd: number;
};

const sevRank: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function rankSeverity(v: string) {
  return sevRank[String(v ?? "").toLowerCase()] ?? 0;
}

function minsSince(iso?: string | null, nowMs = Date.now()) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return (nowMs - ms) / 60_000;
}

export function selectDiverseAlerts(
  rows: DispatchAlertRow[],
  limit: number,
  options: DiversityOptions,
  metaByEntity: Map<string, AlertMeta>,
): DispatchAlertRow[] {
  if (!options.enabled) return rows.slice(0, limit);

  const nowMs = Date.now();
  const scored = rows.map((r) => {
    const entity = String(r.entity_id ?? "").toLowerCase();
    const meta = entity ? (metaByEntity.get(entity) ?? {}) : {};
    const sev = rankSeverity(r.severity);
    const recentCount = Number(meta.recentCount ?? 0);
    const mcap = Number(meta.marketCap ?? 0);
    const cooldownMin = minsSince(meta.lastSentAt ?? null, nowMs);
    const cooldownBlocked = Boolean(
      entity &&
      options.perCoinCooldownMin > 0 &&
      cooldownMin < options.perCoinCooldownMin &&
      sev < 3,
    );

    let score = sev * 1000 + r.id;
    score -= recentCount * 75;
    if (options.largeCapPenaltyAboveUsd > 0 && mcap > options.largeCapPenaltyAboveUsd) {
      score -= 200;
    }

    return { row: r, entity, sev, score, cooldownBlocked };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: DispatchAlertRow[] = [];
  const perCoin = new Map<string, number>();

  for (const s of scored) {
    if (selected.length >= limit) break;
    if (s.cooldownBlocked) continue;

    if (s.entity) {
      const seen = perCoin.get(s.entity) ?? 0;
      if (seen >= Math.max(1, options.maxPerCoinPerDispatch)) continue;
      perCoin.set(s.entity, seen + 1);
    }

    selected.push(s.row);
  }

  return selected;
}
