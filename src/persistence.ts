// Persistent world: the parked positions of the car + drone survive everyone
// leaving and the server restarting. Saved to the game's ONE shared world slot
// by the host only (debounced, with ifVersion so a host-handoff race loses
// loudly instead of clobbering). See the multiplayer skill's persistence note.
import { loadWorldState, saveWorldState } from "@genex-ai/embed-sdk";
import type { Pose } from "./vehicles.ts";

export interface WorldSave {
  car?: Pose;
  car2?: Pose;
  drone?: Pose;
}

export class Persistence {
  private version = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private latest: WorldSave | null = null;

  constructor() {
    // Flush on tab-hide so the host closing the tab doesn't lose the last park.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush();
    });
  }

  /** Load the saved world once on boot (safe for guests — resolves null). */
  async load(): Promise<WorldSave | null> {
    try {
      const { data, version } = await loadWorldState();
      this.version = version;
      return (data as WorldSave) ?? null;
    } catch {
      return null;
    }
  }

  /** Queue a save (debounced to ~1/sec). Host only — call when a pose changed. */
  save(data: WorldSave) {
    this.latest = data;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.write();
    }, 1000);
  }

  /** Write immediately (server restart / tab hide). */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.latest) void this.write();
  }

  private async write() {
    if (!this.latest) return;
    const res = await saveWorldState(this.latest, { ifVersion: this.version }).catch(() => null);
    if (!res) return;
    if (res.saved && res.version !== undefined) this.version = res.version;
    else if (res.conflict && res.version !== undefined) this.version = res.version; // stale after a host race
  }
}
