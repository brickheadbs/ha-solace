/**
 * Music Tab — Instant-start curated playlists that always start at 0:00 of the current song
 * and continue sequentially from where they last left off.
 */

import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { customElement } from "./custom-element";
import type { Hass, MusicPlaylist, Snapshot } from "./api";
import { musicConfig, musicNext, musicPlay, musicPrev, musicStop } from "./api";
import { tokens } from "./tokens";
import "./ui";

@customElement("sol-tab-music")
export class SolTabMusic extends LitElement {
  @property({ attribute: false }) hass!: Hass;
  @property({ attribute: false }) snap!: Snapshot;

  @state() private expandedPlaylists: Record<string, boolean> = {};

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        padding-bottom: 40px;
      }
      .grid {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .card {
        background: var(--sol-card);
        border-radius: var(--sol-r-card);
        padding: 16px 18px;
        box-shadow: var(--sol-shadow);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 14px;
      }
      .title {
        font-size: 15px;
        font-weight: 500;
        color: var(--sol-text);
      }
      .spacer {
        flex: 1;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 11.5px;
        font-weight: 600;
      }
      .badge-playing {
        background: rgba(129, 199, 132, 0.2);
        color: #81c784;
      }
      .badge-buffering {
        background: rgba(255, 183, 77, 0.2);
        color: #ffb74d;
      }
      .badge-stopped {
        background: rgba(255, 255, 255, 0.07);
        color: var(--sol-text-3);
      }
      .transport-box {
        display: grid;
        grid-template-columns: 1.3fr 1fr;
        gap: 16px;
        background: var(--sol-control);
        border-radius: 10px;
        padding: 14px 16px;
        align-items: center;
      }
      @media (max-width: 820px) {
        .transport-box {
          grid-template-columns: 1fr;
        }
      }
      .now-playing {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .np-playlist {
        font-size: 11.5px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--sol-cyan);
        font-weight: 600;
      }
      .np-title {
        font-size: 18px;
        font-weight: 600;
        color: var(--sol-text);
      }
      .np-artist {
        font-size: 13.5px;
        color: var(--sol-text-2);
      }
      .transport-btns {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 7px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: var(--sol-card);
        color: var(--sol-text-2);
        padding: 7px 13px;
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .btn:hover {
        background: var(--sol-card-high);
        color: var(--sol-text);
      }
      .btn-primary {
        background: rgba(86, 182, 194, 0.22);
        border-color: var(--sol-cyan);
        color: var(--sol-cyan);
        font-weight: 600;
      }
      .btn-primary:hover {
        background: rgba(86, 182, 194, 0.32);
      }
      .btn-stop {
        background: rgba(239, 83, 80, 0.14);
        border-color: rgba(239, 83, 80, 0.4);
        color: #ef5350;
      }
      .speaker-controls {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .select-input,
      .num-input {
        box-sizing: border-box;
        background: var(--sol-card);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 6px 9px;
        font-family: inherit;
        font-size: 12.5px;
        color: var(--sol-text);
        outline: none;
      }
      .playlists-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 14px;
      }
      .pl-card {
        background: var(--sol-control);
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 10px;
        padding: 15px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .pl-card.active-pl {
        border-color: var(--sol-cyan);
        background: rgba(86, 182, 194, 0.07);
      }
      .pl-head {
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .pl-name {
        font-size: 15px;
        font-weight: 600;
        color: var(--sol-text);
        flex: 1;
      }
      .pl-desc {
        font-size: 12px;
        color: var(--sol-text-3);
        line-height: 1.5;
      }
      .pl-resume-box {
        background: rgba(0, 0, 0, 0.28);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 8px;
        padding: 9px 11px;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .pl-resume-lbl {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--sol-text-3);
      }
      .pl-resume-track {
        font-size: 13px;
        color: var(--sol-text);
        font-weight: 500;
      }
      .pl-resume-track span {
        color: var(--sol-cyan);
        font-weight: 600;
      }
      .pl-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: auto;
      }
      .tracklist {
        max-height: 290px;
        overflow-y: auto;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 8px;
        padding: 6px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .track-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 5px;
        font-size: 12px;
        color: var(--sol-text-2);
        cursor: pointer;
      }
      .track-row:hover {
        background: rgba(255, 255, 255, 0.07);
        color: var(--sol-text);
      }
      .track-row.current {
        background: rgba(86, 182, 194, 0.18);
        color: var(--sol-cyan);
        font-weight: 600;
      }
      .track-num {
        width: 28px;
        font-size: 11px;
        color: var(--sol-text-4);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .track-title {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .err-banner {
        margin-top: 10px;
        padding: 8px 12px;
        border-radius: 6px;
        background: rgba(239, 83, 80, 0.14);
        border: 1px solid rgba(239, 83, 80, 0.35);
        color: #ef9a9a;
        font-size: 12px;
      }
    `,
  ];

  private toggleExpand(id: string) {
    this.expandedPlaylists = {
      ...this.expandedPlaylists,
      [id]: !this.expandedPlaylists[id],
    };
  }

  render() {
    const music = this.snap?.music;
    if (!music) {
      return html`<div class="card">Loading music engine...</div>`;
    }

    const st = music.state;
    const cur = music.current_track;
    const playlists: MusicPlaylist[] = music.playlists ?? [];
    const speakers = music.speakers ?? [];

    return html`
      <div class="grid">
        <!-- 1. Now Playing & Cast Transport Bar -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:speaker-wireless" style="color: var(--sol-cyan);"></ha-icon>
            <div class="title">Now Playing &amp; Cast Speaker Controls</div>
            <sol-help
              text="Instant-start music player. Clicking Play always begins at 0:00 of the saved song in the selected playlist, advances automatically when each song finishes, and remembers which song you were on when stopped."
            ></sol-help>
            <div class="spacer"></div>
            <span
              class="badge ${st === "playing"
                ? "badge-playing"
                : st === "buffering"
                  ? "badge-buffering"
                  : "badge-stopped"}"
            >
              ${st === "playing"
                ? "Playing on Cast"
                : st === "buffering"
                  ? "Buffering Audio (0:00)..."
                  : "Stopped (Ready)"}
            </span>
          </div>

          <div class="transport-box">
            <div class="now-playing">
              <div class="np-playlist">
                ${music.active_playlist_name || music.active_playlist_id} · Track #${cur.index + 1} of ${cur.total}
              </div>
              <div class="np-title">${cur.title || "—"}</div>
              <div class="np-artist">${cur.artist || "—"}</div>

              <div class="transport-btns">
                <button
                  class="btn btn-primary"
                  @click="${() => musicPlay(this.hass)}"
                  title="Start from 0:00 of current song"
                >
                  <ha-icon icon="mdi:play" style="--mdc-icon-size: 17px;"></ha-icon>
                  ${st === "playing" ? "Restart Song (0:00)" : "Play / Continue (0:00)"}
                </button>
                <button
                  class="btn"
                  @click="${() => musicPrev(this.hass)}"
                  title="Previous track (starts at 0:00)"
                >
                  <ha-icon icon="mdi:skip-previous" style="--mdc-icon-size: 17px;"></ha-icon>
                  Prev
                </button>
                <button
                  class="btn"
                  @click="${() => musicNext(this.hass)}"
                  title="Next track (starts at 0:00)"
                >
                  <ha-icon icon="mdi:skip-next" style="--mdc-icon-size: 17px;"></ha-icon>
                  Next
                </button>
                <button
                  class="btn btn-stop"
                  @click="${() => musicStop(this.hass)}"
                  title="Stop playback (saves current song index)"
                >
                  <ha-icon icon="mdi:stop" style="--mdc-icon-size: 17px;"></ha-icon>
                  Stop
                </button>
              </div>
            </div>

            <div class="speaker-controls">
              <div>
                <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                  Target Cast Speaker / Group
                </div>
                <select
                  class="select-input"
                  style="width: 100%;"
                  .value="${music.speaker_entity}"
                  @change="${(e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    musicConfig(this.hass, { speaker_entity: v });
                  }}"
                >
                  ${speakers.map(
                    (sp) => html`
                      <option value="${sp.entity_id}" ?selected=${sp.entity_id === music.speaker_entity}>
                        ${sp.name} ${sp.available ? "" : "(Offline)"}
                      </option>
                    `
                  )}
                </select>
              </div>

              <div>
                <div style="font-size: 11.5px; color: var(--sol-text-2); margin-bottom: 4px;">
                  Speaker Volume: <strong style="color: var(--sol-cyan);">${music.volume_pct}%</strong>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <input
                    type="range"
                    min="5"
                    max="100"
                    step="5"
                    style="flex: 1; accent-color: var(--sol-cyan);"
                    .value="${String(music.volume_pct)}"
                    @change="${(e: Event) => {
                      const v = parseInt((e.target as HTMLInputElement).value, 10);
                      musicConfig(this.hass, { volume_pct: v });
                    }}"
                  />
                  <input
                    type="number"
                    class="num-input"
                    style="width: 58px; text-align: right;"
                    min="5"
                    max="100"
                    .value="${String(music.volume_pct)}"
                    @change="${(e: Event) => {
                      const v = parseInt((e.target as HTMLInputElement).value, 10);
                      musicConfig(this.hass, { volume_pct: v });
                    }}"
                  />
                  <span style="font-size: 11.5px; color: var(--sol-text-3);">%</span>
                </div>
              </div>
            </div>
          </div>

          ${music.error ? html`<div class="err-banner">${music.error}</div>` : nothing}
        </div>

        <!-- 2. Instant-Start Curated Playlists -->
        <div class="card">
          <div class="head">
            <ha-icon icon="mdi:playlist-music" style="color: #ffb74d;"></ha-icon>
            <div class="title">Curated Playlists (Instant Start · Continues Where Left Off)</div>
            <sol-help
              text="Curated from your 281 liked YouTube Music tracks in notes/solace-playlists.json. Ask your agent anytime to add, reorder, or create new lists."
            ></sol-help>
          </div>

          <div class="playlists-grid">
            ${playlists.map((pl) => {
              const isActive = pl.id === music.active_playlist_id;
              const isExpanded = !!this.expandedPlaylists[pl.id];
              const ct = pl.current_track;
              return html`
                <div class="pl-card ${isActive ? "active-pl" : ""}">
                  <div class="pl-head">
                    <ha-icon
                      icon="${pl.icon || "mdi:playlist-music"}"
                      style="color: ${isActive ? "var(--sol-cyan)" : "#ffb74d"}; --mdc-icon-size: 20px;"
                    ></ha-icon>
                    <div class="pl-name">${pl.name}</div>
                    <span class="badge badge-stopped">${pl.track_count} songs</span>
                  </div>

                  <div class="pl-desc">${pl.description}</div>

                  <div class="pl-resume-box">
                    <div class="pl-resume-lbl">
                      Continues at Song #${ct.index + 1} of ${pl.track_count} (Starts at 0:00)
                    </div>
                    <div class="pl-resume-track">
                      <span>${ct.title}</span> — ${ct.artist}
                    </div>
                  </div>

                  <div class="pl-actions">
                    <button
                      class="btn btn-primary"
                      @click="${() => musicPlay(this.hass, { playlist_id: pl.id })}"
                    >
                      <ha-icon icon="mdi:play" style="--mdc-icon-size: 16px;"></ha-icon>
                      Play Playlist (0:00)
                    </button>
                    <button
                      class="btn"
                      @click="${() => musicNext(this.hass, pl.id)}"
                      title="Skip pointer to next track"
                    >
                      <ha-icon icon="mdi:skip-next" style="--mdc-icon-size: 16px;"></ha-icon>
                      Next
                    </button>
                    <button
                      class="btn"
                      @click="${() => musicConfig(this.hass, { reset_playlist_id: pl.id })}"
                      title="Reset playlist pointer to Track #1"
                    >
                      Reset #1
                    </button>
                    <button
                      class="btn"
                      style="margin-left: auto;"
                      @click="${() => this.toggleExpand(pl.id)}"
                    >
                      ${isExpanded ? "Hide Tracks" : "Tracks"}
                    </button>
                  </div>

                  ${isExpanded
                    ? html`
                        <div class="tracklist">
                          ${pl.tracks.map(
                            (t) => html`
                              <div
                                class="track-row ${t.index === pl.current_index ? "current" : ""}"
                                @click="${() =>
                                  musicPlay(this.hass, {
                                    playlist_id: pl.id,
                                    track_index: t.index,
                                  })}"
                                title="Click to play this song from 0:00"
                              >
                                <span class="track-num">${t.index + 1}.</span>
                                <span class="track-title">
                                  <strong>${t.title}</strong> — ${t.artist}
                                </span>
                                ${t.cached
                                  ? html`<span style="font-size: 10px; color: #81c784;">Cached</span>`
                                  : nothing}
                              </div>
                            `
                          )}
                        </div>
                      `
                    : nothing}
                </div>
              `;
            })}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sol-tab-music": SolTabMusic;
  }
}
