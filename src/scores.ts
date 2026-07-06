// Host-authoritative scoreboard, stored in the ONE shared "scores" key so every
// client renders the same tally. Only the host ever writes it.
import type { Session } from "@genex-ai/multiplayer";
import { colorForId, type PlayerNet } from "./netstate.ts";
import type { ScoreRow } from "./hud.ts";

type ScoreMap = Record<string, { name: string; points: number }>;

export function readScores(room: Session<PlayerNet>): ScoreMap {
  const raw = room.shared.get("scores");
  return raw && typeof raw === "object" ? (raw as ScoreMap) : {};
}

/** Host-only: give `id` a point. No-op on non-hosts. */
export function awardPoint(room: Session<PlayerNet>, id: string, name: string, amount = 1) {
  if (!room.isHost) return;
  const scores = { ...readScores(room) };
  const cur = scores[id];
  scores[id] = { name: cur?.name || name || "Player", points: (cur?.points || 0) + amount };
  room.shared.set("scores", scores);
}

/** Rows for the HUD, highest first. */
export function scoreRows(room: Session<PlayerNet>): ScoreRow[] {
  const scores = readScores(room);
  return Object.entries(scores)
    .map(([id, v]) => ({
      name: v.name || "Player",
      points: v.points,
      color: colorForId(id),
      isMe: id === room.id,
    }))
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points);
}
