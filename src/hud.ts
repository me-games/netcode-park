// All 2D overlay UI: connection status, the who's-online + host panel, the
// scoreboard, the controls hint, and the reconnecting / connection-lost
// screens. Pure DOM — the 3D scene never touches these.

export type ConnState = "connecting" | "online" | "reconnecting" | "lost";

export interface PresenceRow {
  id: string;
  name: string;
  color: number;
  isHost: boolean;
  isMe: boolean;
}
export interface ScoreRow {
  name: string;
  points: number;
  color: number;
  isMe: boolean;
}

const CSS = `
#hud, #hud * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
#hud { position: fixed; inset: 0; pointer-events: none; z-index: 10; color: #f2f6fb; }
.hud-panel { position: absolute; background: rgba(14,19,28,0.62); backdrop-filter: blur(7px);
  border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 12px 14px;
  box-shadow: 0 8px 26px rgba(0,0,0,0.28); }
#hud-presence { top: 16px; left: 16px; min-width: 190px; max-width: 240px; }
#hud-score { top: 16px; right: 16px; min-width: 170px; }
.hud-title { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; opacity: .62;
  margin-bottom: 8px; font-weight: 700; display:flex; align-items:center; gap:7px; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.dot.online { background: #46d17f; box-shadow: 0 0 8px #46d17f; }
.dot.connecting, .dot.reconnecting { background: #ffcc44; box-shadow: 0 0 8px #ffcc44; }
.dot.lost { background: #ff5a5a; box-shadow: 0 0 8px #ff5a5a; }
.hud-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 14px; }
.hud-row .swatch { width: 11px; height: 11px; border-radius: 3px; flex: 0 0 auto; }
.hud-row .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-row .pts { font-variant-numeric: tabular-nums; font-weight: 700; }
.hud-row.me .nm { font-weight: 700; }
.badge { font-size: 10px; font-weight: 700; background: #ffb300; color: #201700; border-radius: 5px;
  padding: 1px 5px; letter-spacing: .05em; }
.badge.you { background: rgba(255,255,255,0.16); color: #eaf1f8; }
#hud-hint { bottom: 16px; left: 50%; transform: translateX(-50%); font-size: 13px;
  padding: 9px 15px; text-align: center; line-height: 1.5; }
#hud-hint b { color: #ffd873; }
#hud-prompt { bottom: 74px; left: 50%; transform: translateX(-50%); display: none; font-size: 15px;
  font-weight: 700; padding: 10px 18px; background: rgba(88,192,255,0.92); color: #06121e;
  border-color: rgba(255,255,255,0.3); }
#hud-prompt kbd { background: #06121e; color: #fff; border-radius: 5px; padding: 1px 7px; margin-right: 4px;
  font-family: inherit; }
#hud-toast { bottom: 84px; left: 50%; transform: translateX(-50%); font-size: 14px; padding: 9px 16px;
  opacity: 0; transition: opacity .25s; }
#hud-reconnect { top: 16px; left: 50%; transform: translateX(-50%); display: none; align-items: center;
  gap: 10px; font-size: 14px; padding: 10px 16px; }
.spinner { width: 15px; height: 15px; border: 2.5px solid rgba(255,255,255,0.25); border-top-color: #ffcc44;
  border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#hud-lost { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(6,9,14,0.82); backdrop-filter: blur(4px); pointer-events: auto; }
#hud-lost .card { text-align: center; max-width: 340px; padding: 30px 34px; background: rgba(20,26,36,0.95);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 18px; }
#hud-lost h2 { font-size: 22px; margin: 0 0 8px; }
#hud-lost p { opacity: .72; font-size: 14px; margin: 0 0 20px; line-height: 1.5; }
#hud-lost button { pointer-events: auto; cursor: pointer; font-size: 15px; font-weight: 700; color: #08121e;
  background: #58c0ff; border: 0; border-radius: 10px; padding: 12px 26px; }
#hud-lost button:hover { background: #7ccdff; }
#hud-lost button:disabled { opacity: .6; cursor: default; }
`;

export class Hud {
  private presenceBody: HTMLElement;
  private presenceDot: HTMLElement;
  private presenceLabel: HTMLElement;
  private scoreBody: HTMLElement;
  private reconnect: HTMLElement;
  private reconnectText: HTMLElement;
  private lost: HTMLElement;
  private lostBtn: HTMLButtonElement;
  private toastEl: HTMLElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "hud";
    root.innerHTML = `
      <div class="hud-panel" id="hud-presence">
        <div class="hud-title"><span class="dot connecting" id="hud-conn-dot"></span><span id="hud-conn-label">Connecting…</span></div>
        <div id="hud-presence-body"></div>
      </div>
      <div class="hud-panel" id="hud-score">
        <div class="hud-title">Scoreboard</div>
        <div id="hud-score-body"><div class="hud-row" style="opacity:.6">No points yet</div></div>
      </div>
      <div class="hud-panel" id="hud-reconnect"><span class="spinner"></span><span id="hud-reconnect-text">Reconnecting…</span></div>
      <div class="hud-panel" id="hud-prompt"></div>
      <div class="hud-panel" id="hud-hint"></div>
      <div class="hud-panel" id="hud-toast"></div>
      <div id="hud-lost">
        <div class="card">
          <h2>Connection lost</h2>
          <p>You were disconnected from Netcode Park. Your friends may still be playing — jump back in.</p>
          <button id="hud-lost-btn">Rejoin</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    this.presenceBody = root.querySelector("#hud-presence-body")!;
    this.presenceDot = root.querySelector("#hud-conn-dot")!;
    this.presenceLabel = root.querySelector("#hud-conn-label")!;
    this.scoreBody = root.querySelector("#hud-score-body")!;
    this.reconnect = root.querySelector("#hud-reconnect")!;
    this.reconnectText = root.querySelector("#hud-reconnect-text")!;
    this.lost = root.querySelector("#hud-lost")!;
    this.lostBtn = root.querySelector("#hud-lost-btn")!;
    this.toastEl = root.querySelector("#hud-toast")!;
  }

  setHint(html: string) {
    (document.querySelector("#hud-hint") as HTMLElement).innerHTML = html;
  }

  setPrompt(text: string | null) {
    const el = document.querySelector("#hud-prompt") as HTMLElement;
    if (text) {
      el.innerHTML = text;
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }

  setConnection(state: ConnState) {
    this.presenceDot.className = "dot " + state;
    const label: Record<ConnState, string> = {
      connecting: "Connecting…",
      online: "Online",
      reconnecting: "Reconnecting…",
      lost: "Offline",
    };
    this.presenceLabel.textContent = label[state];
    if (state === "reconnecting") this.reconnect.style.display = "flex";
    else this.reconnect.style.display = "none";
    if (state === "lost") this.lost.style.display = "flex";
    else this.lost.style.display = "none";
  }

  setReconnectAttempt(attempt: number) {
    this.reconnectText.textContent = `Reconnecting… (attempt ${attempt})`;
  }

  onRejoin(cb: () => void) {
    this.lostBtn.addEventListener("click", () => {
      this.lostBtn.disabled = true;
      this.lostBtn.textContent = "Rejoining…";
      cb();
    });
  }

  resetRejoinButton() {
    this.lostBtn.disabled = false;
    this.lostBtn.textContent = "Rejoin";
  }

  setPresence(rows: PresenceRow[]) {
    this.presenceBody.innerHTML =
      rows
        .map((r) => {
          const badges =
            (r.isHost ? `<span class="badge">HOST</span>` : "") +
            (r.isMe ? `<span class="badge you">YOU</span>` : "");
          return `<div class="hud-row ${r.isMe ? "me" : ""}">
            <span class="swatch" style="background:${hex(r.color)}"></span>
            <span class="nm">${esc(r.name)}</span>${badges}
          </div>`;
        })
        .join("") || `<div class="hud-row" style="opacity:.6">Just you so far</div>`;
  }

  setScores(rows: ScoreRow[]) {
    if (rows.length === 0) {
      this.scoreBody.innerHTML = `<div class="hud-row" style="opacity:.6">No points yet</div>`;
      return;
    }
    this.scoreBody.innerHTML = rows
      .map(
        (r) => `<div class="hud-row ${r.isMe ? "me" : ""}">
          <span class="swatch" style="background:${hex(r.color)}"></span>
          <span class="nm">${esc(r.name)}</span>
          <span class="pts">${r.points}</span>
        </div>`
      )
      .join("");
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.style.opacity = "1";
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastEl.style.opacity = "0"), 2600);
  }
}

function hex(c: number) {
  return "#" + c.toString(16).padStart(6, "0");
}
function esc(s: string) {
  return s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));
}
