"""Solace Stateful Playlist & Wake-Up Music Engine.

Plays curated playlists from `/Users/brandonschuster/Assistant/notes/solace-playlists.json`
to Google Cast speakers (`media_player.all_speakers`, etc.) via locally cached MP3 files
in `www/solace_music_cache/`.

Key behaviors:
1. Always starts at the beginning (0:00) of the current track.
2. Persists `current_index` per playlist in `solace-playlists.json`.
3. When a track finishes naturally (`playing` -> `idle`), advances `current_index` to the
   next track and continues playback automatically, while pre-caching the next 2 tracks
   in the background on macOS E-cores (`taskpolicy -b`).
4. When stopped, `current_index` remains on that track so the next session resumes from
   0:00 of the song where it left off.
5. Hot-reloads `solace-playlists.json` whenever its modification timestamp (`mtime`) changes,
   so an AI agent can curate or update playlists on disk with zero restarts.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Callable

from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.network import get_url

_LOGGER = logging.getLogger(__name__)

PLAYLISTS_JSON_PATH = Path("/Users/brandonschuster/Assistant/notes/solace-playlists.json")
YT_DLP_CANDIDATES = (
    "/Users/brandonschuster/.local/share/homelab-native/home-assistant/venv/bin/yt-dlp",
    "/opt/homebrew/bin/yt-dlp",
)
FFMPEG_DIR = "/opt/homebrew/bin"
DEFAULT_LAN_BASE_URL = "http://10.1.1.10:8123"

SPEAKER_OPTIONS = (
    {"entity_id": "media_player.all_speakers", "name": "All Speakers (Whole Flat)"},
    {"entity_id": "media_player.bedroom_speaker_2", "name": "Bedroom Speaker"},
    {"entity_id": "media_player.living_room_display", "name": "Living Room Display"},
    {"entity_id": "media_player.kitchen_pair", "name": "Kitchen Pair"},
    {"entity_id": "media_player.entryway_display", "name": "Entryway Display"},
)


def _track_slug(title: str, artist: str) -> str:
    raw = f"{title} - {artist}".strip().lower()
    clean = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")[:64]
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    return f"{clean}-{digest}"


def _find_yt_dlp() -> str:
    for candidate in YT_DLP_CANDIDATES:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("yt-dlp")
    return found or YT_DLP_CANDIDATES[0]


class SolaceMusicManager:
    """Manages curated playlists, persistent track positions, caching, and Cast playback."""

    def __init__(self, hass: HomeAssistant, notify_cb: Callable[[], None]) -> None:
        self.hass = hass
        self._notify_cb = notify_cb
        self._data: dict[str, Any] = {}
        self._last_mtime: float = 0.0
        self.state: str = "stopped"  # "stopped" | "buffering" | "playing"
        self.error: str | None = None
        self._active_session: bool = False
        self._play_started_mono: float = 0.0
        self._play_token: int = 0
        self._seen_playing_for_token: bool = False
        self._unsub_speaker: Callable[[], None] | None = None
        self._watched_speaker: str | None = None
        self._cache_locks: dict[str, asyncio.Lock] = {}
        self._last_wakeup_anchor_iso: str | None = None
        self._cached_slugs: set[str] = set()
        self._data = {
            "version": 1,
            "active_playlist_id": "morning_gentle",
            "speaker_entity": "media_player.all_speakers",
            "volume_pct": 40,
            "wake_enabled": True,
            "wake_playlist_id": "morning_gentle",
            "wake_speaker_entity": "media_player.all_speakers",
            "wake_volume_pct": 35,
            "wake_time_enabled": True,
            "wake_target_time": "08:00",
            "playlists": [],
        }

    async def async_prepare(self) -> None:
        """Load playlists and cached slugs off the event loop."""
        await self.hass.async_add_executor_job(self._load_sync)

    # ------------------------------------------------------------------ persistence

    def _cache_dir(self) -> Path:
        path = Path(self.hass.config.path("www", "solace_music_cache"))
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _refresh_cached_slugs_sync(self) -> None:
        try:
            cdir = self._cache_dir()
            self._cached_slugs = {
                p.stem for p in cdir.glob("*.mp3") if p.is_file() and p.stat().st_size > 32_768
            }
        except OSError:
            pass

    def _load_sync(self) -> None:
        try:
            self._refresh_cached_slugs_sync()
            if PLAYLISTS_JSON_PATH.is_file():
                mtime = PLAYLISTS_JSON_PATH.stat().st_mtime
                if mtime != self._last_mtime or not self._data.get("playlists"):
                    raw = json.loads(PLAYLISTS_JSON_PATH.read_text(encoding="utf-8"))
                    if isinstance(raw, dict) and "playlists" in raw:
                        self._data = raw
                        self._last_mtime = mtime
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("SolaceMusic: failed to load %s: %s", PLAYLISTS_JSON_PATH, err)

    def _check_reload_sync(self) -> None:
        try:
            if PLAYLISTS_JSON_PATH.is_file():
                mtime = PLAYLISTS_JSON_PATH.stat().st_mtime
                if mtime != self._last_mtime:
                    self._load_sync()
        except OSError:
            pass

    def _save_sync(self) -> None:
        try:
            PLAYLISTS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = PLAYLISTS_JSON_PATH.with_suffix(".json.tmp")
            tmp_path.write_text(
                json.dumps(self._data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            tmp_path.replace(PLAYLISTS_JSON_PATH)
            self._last_mtime = PLAYLISTS_JSON_PATH.stat().st_mtime
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("SolaceMusic: failed to save %s: %s", PLAYLISTS_JSON_PATH, err)

    async def async_save(self) -> None:
        await self.hass.async_add_executor_job(self._save_sync)

    # ------------------------------------------------------------------ properties

    @property
    def active_playlist_id(self) -> str:
        return str(self._data.get("active_playlist_id") or "morning_gentle")

    @property
    def speaker_entity(self) -> str:
        return str(self._data.get("speaker_entity") or "media_player.all_speakers")

    @property
    def volume_pct(self) -> int:
        return int(self._data.get("volume_pct", 40))

    @property
    def wake_enabled(self) -> bool:
        return bool(self._data.get("wake_enabled", True))

    @property
    def wake_playlist_id(self) -> str:
        return str(self._data.get("wake_playlist_id") or "morning_gentle")

    @property
    def wake_speaker_entity(self) -> str:
        return str(self._data.get("wake_speaker_entity") or "media_player.all_speakers")

    @property
    def wake_volume_pct(self) -> int:
        return int(self._data.get("wake_volume_pct", 35))

    @property
    def wake_time_enabled(self) -> bool:
        return bool(self._data.get("wake_time_enabled", True))

    @property
    def wake_target_time(self) -> str:
        return str(self._data.get("wake_target_time") or "08:00")

    def _get_playlist(self, playlist_id: str | None = None) -> dict[str, Any] | None:
        target_id = playlist_id or self.active_playlist_id
        playlists = self._data.get("playlists") or []
        for pl in playlists:
            if pl.get("id") == target_id:
                return pl
        return playlists[0] if playlists else None

    def snapshot(self) -> dict[str, Any]:
        """Return complete music & wake-up state for the WebSocket snapshot."""
        playlists_out: list[dict[str, Any]] = []

        for pl in self._data.get("playlists") or []:
            tracks = pl.get("tracks") or []
            total = len(tracks)
            idx = int(pl.get("current_index", 0)) % max(1, total) if total else 0
            current_track = tracks[idx] if total else {"title": "—", "artist": ""}
            playlists_out.append(
                {
                    "id": pl.get("id"),
                    "name": pl.get("name"),
                    "description": pl.get("description", ""),
                    "icon": pl.get("icon", "mdi:playlist-music"),
                    "current_index": idx,
                    "track_count": total,
                    "current_track": {
                        "index": idx,
                        "title": current_track.get("title", ""),
                        "artist": current_track.get("artist", ""),
                    },
                    "tracks": [
                        {
                            "index": i,
                            "title": t.get("title", ""),
                            "artist": t.get("artist", ""),
                            "cached": _track_slug(t.get("title", ""), t.get("artist", "")) in self._cached_slugs,
                        }
                        for i, t in enumerate(tracks)
                    ],
                }
            )

        active_pl = self._get_playlist(self.active_playlist_id)
        active_tracks = (active_pl.get("tracks") or []) if active_pl else []
        active_total = len(active_tracks)
        active_idx = (
            int(active_pl.get("current_index", 0)) % max(1, active_total)
            if active_total and active_pl
            else 0
        )
        now_track = active_tracks[active_idx] if active_total else {"title": "—", "artist": ""}

        speaker_states = []
        for sp in SPEAKER_OPTIONS:
            st = self.hass.states.get(sp["entity_id"])
            speaker_states.append(
                {
                    "entity_id": sp["entity_id"],
                    "name": sp["name"],
                    "available": st is not None and st.state not in ("unavailable", "unknown"),
                    "state": st.state if st is not None else "unavailable",
                }
            )

        return {
            "state": self.state,
            "error": self.error,
            "active_playlist_id": self.active_playlist_id,
            "active_playlist_name": active_pl.get("name", "") if active_pl else "",
            "speaker_entity": self.speaker_entity,
            "volume_pct": self.volume_pct,
            "wake_enabled": self.wake_enabled,
            "wake_playlist_id": self.wake_playlist_id,
            "wake_speaker_entity": self.wake_speaker_entity,
            "wake_volume_pct": self.wake_volume_pct,
            "wake_time_enabled": self.wake_time_enabled,
            "wake_target_time": self.wake_target_time,
            "current_track": {
                "index": active_idx,
                "total": active_total,
                "title": now_track.get("title", ""),
                "artist": now_track.get("artist", ""),
            },
            "speakers": speaker_states,
            "playlists": playlists_out,
        }

    # ------------------------------------------------------------------ listener management

    @callback
    def _ensure_speaker_listener(self, entity_id: str) -> None:
        if self._watched_speaker == entity_id and self._unsub_speaker is not None:
            return
        if self._unsub_speaker is not None:
            self._unsub_speaker()
            self._unsub_speaker = None
        self._watched_speaker = entity_id
        self._unsub_speaker = async_track_state_change_event(
            self.hass, [entity_id], self._on_speaker_state_change
        )

    @callback
    def async_shutdown(self) -> None:
        if self._unsub_speaker is not None:
            self._unsub_speaker()
            self._unsub_speaker = None

    @callback
    def _on_speaker_state_change(self, event: Event[EventStateChangedData]) -> None:
        if not self._active_session:
            return
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        if new_state is None:
            return

        st = new_state.state
        old_st = old_state.state if old_state else None
        elapsed = time.monotonic() - self._play_started_mono

        if st == "playing":
            self._seen_playing_for_token = True
            if self.state != "playing":
                self.state = "playing"
                self._notify_cb()
            return

        # Natural track completion: speaker was playing this track and transitioned to idle
        if (
            st == "idle"
            and (self._seen_playing_for_token or old_st in ("playing", "buffering"))
            and elapsed >= 8.0
        ):
            token_at_finish = self._play_token
            _LOGGER.info(
                "SolaceMusic: track finished naturally after %.1fs; advancing to next track",
                elapsed,
            )
            self.hass.async_create_task(self._async_advance_on_finish(token_at_finish))
            return

        # External stop/off after playback started
        if st == "off" and elapsed >= 5.0:
            self._active_session = False
            self.state = "stopped"
            self._notify_cb()

    async def _async_advance_on_finish(self, expected_token: int) -> None:
        if not self._active_session or self._play_token != expected_token:
            return
        pl = self._get_playlist(self.active_playlist_id)
        if not pl:
            return
        tracks = pl.get("tracks") or []
        if not tracks:
            return
        pl["current_index"] = (int(pl.get("current_index", 0)) + 1) % len(tracks)
        await self.async_save()
        await self.async_play(playlist_id=self.active_playlist_id)

    # ------------------------------------------------------------------ audio resolution & caching

    async def _async_ensure_cached(self, title: str, artist: str) -> Path:
        slug = _track_slug(title, artist)
        cache_dir = self._cache_dir()
        target_mp3 = cache_dir / f"{slug}.mp3"
        if target_mp3.is_file() and target_mp3.stat().st_size > 32_768:
            return target_mp3

        lock = self._cache_locks.setdefault(slug, asyncio.Lock())
        async with lock:
            if target_mp3.is_file() and target_mp3.stat().st_size > 32_768:
                return target_mp3

            yt_dlp_bin = _find_yt_dlp()
            query = f"ytsearch1:{title} {artist} official audio".strip()
            out_tmpl = str(cache_dir / f"{slug}.%(ext)s")

            cmd: list[str] = []
            if os.path.isfile("/usr/sbin/taskpolicy"):
                cmd.extend(["/usr/sbin/taskpolicy", "-b"])
            cmd.extend(
                [
                    yt_dlp_bin,
                    "--no-playlist",
                    "--no-warnings",
                    "--ffmpeg-location",
                    FFMPEG_DIR,
                    "-f",
                    "bestaudio/best",
                    "-x",
                    "--audio-format",
                    "mp3",
                    "--audio-quality",
                    "192K",
                    "-o",
                    out_tmpl,
                    query,
                ]
            )

            _LOGGER.info("SolaceMusic: caching track '%s - %s' via yt-dlp", title, artist)
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=90.0)
            if proc.returncode != 0 or not target_mp3.is_file():
                err_msg = stderr.decode("utf-8", errors="replace").strip()[-240:]
                raise RuntimeError(f"yt-dlp failed ({proc.returncode}): {err_msg}")
            self._cached_slugs.add(slug)
            return target_mp3

    async def _async_prefetch_upcoming(self, playlist_id: str, start_idx: int) -> None:
        pl = self._get_playlist(playlist_id)
        if not pl:
            return
        tracks = pl.get("tracks") or []
        if not tracks:
            return
        for offset in (1, 2):
            idx = (start_idx + offset) % len(tracks)
            t = tracks[idx]
            try:
                await self._async_ensure_cached(t.get("title", ""), t.get("artist", ""))
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("SolaceMusic: background prefetch skipped for %s: %s", t, err)
        self._notify_cb()

    def _local_media_url(self, mp3_path: Path) -> str:
        # Always serve over plain HTTP on the Mac Studio LAN IP (http://10.1.1.10:8123).
        # Google Cast uses hardcoded 8.8.8.8 DNS and rejects .home mDNS/AdGuard names and local CA TLS.
        return f"{DEFAULT_LAN_BASE_URL}/local/solace_music_cache/{mp3_path.name}"

    # ------------------------------------------------------------------ controls

    async def async_play(
        self,
        playlist_id: str | None = None,
        track_index: int | None = None,
        speaker_entity: str | None = None,
        volume_pct: int | None = None,
    ) -> None:
        """Start or resume playlist from 0:00 of the current (or specified) track."""
        await self.hass.async_add_executor_job(self._check_reload_sync)
        if playlist_id:
            self._data["active_playlist_id"] = playlist_id
        if speaker_entity:
            self._data["speaker_entity"] = speaker_entity
        if volume_pct is not None:
            self._data["volume_pct"] = max(1, min(100, int(volume_pct)))

        pl = self._get_playlist(self.active_playlist_id)
        if not pl:
            self.error = "Playlist not found"
            self._notify_cb()
            return

        tracks = pl.get("tracks") or []
        if not tracks:
            self.error = "Playlist is empty"
            self._notify_cb()
            return

        if track_index is not None:
            idx = int(track_index) % len(tracks)
            pl["current_index"] = idx
        else:
            idx = int(pl.get("current_index", 0)) % len(tracks)
            pl["current_index"] = idx

        await self.async_save()

        track = tracks[idx]
        title = track.get("title", "Unknown")
        artist = track.get("artist", "")
        target_speaker = self.speaker_entity

        self._play_token += 1
        my_token = self._play_token
        self._seen_playing_for_token = False
        self._active_session = True
        self.state = "buffering"
        self.error = None
        self._ensure_speaker_listener(target_speaker)
        self._notify_cb()

        try:
            mp3_path = await self._async_ensure_cached(title, artist)
        except Exception as err:  # noqa: BLE001
            _LOGGER.error("SolaceMusic: failed to cache '%s - %s': %s", title, artist, err)
            if self._play_token == my_token:
                self.state = "stopped"
                self._active_session = False
                self.error = f"Audio fetch error: {err}"
                self._notify_cb()
            return

        if self._play_token != my_token or not self._active_session:
            return

        media_url = self._local_media_url(mp3_path)
        self._play_started_mono = time.monotonic()

        try:
            # Set volume if speaker supports volume_set
            vol_float = round(max(0.01, min(1.0, self.volume_pct / 100.0)), 2)
            await self.hass.services.async_call(
                "media_player",
                "volume_set",
                {"entity_id": target_speaker, "volume_level": vol_float},
                blocking=False,
            )
            await self.hass.services.async_call(
                "media_player",
                "play_media",
                {
                    "entity_id": target_speaker,
                    "media_content_id": media_url,
                    "media_content_type": "audio/mpeg",
                    "extra": {
                        "title": f"{title} — {artist}" if artist else title,
                    },
                },
                blocking=True,
            )
            self.state = "playing"
            self.error = None
            self._notify_cb()
            # Pre-cache next 2 tracks in background
            self.hass.async_create_task(
                self._async_prefetch_upcoming(self.active_playlist_id, idx)
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.error("SolaceMusic: play_media failed on %s: %s", target_speaker, err)
            self.state = "stopped"
            self._active_session = False
            self.error = f"Cast error on {target_speaker}: {err}"
            self._notify_cb()

    async def async_stop(self) -> None:
        """Stop playback while keeping `current_index` on the current track."""
        self._active_session = False
        self._play_token += 1
        self.state = "stopped"
        self._notify_cb()
        try:
            await self.hass.services.async_call(
                "media_player",
                "media_stop",
                {"entity_id": self.speaker_entity},
                blocking=False,
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("SolaceMusic: media_stop ignored: %s", err)

    async def async_next(self, playlist_id: str | None = None) -> None:
        """Advance to the next track in the playlist (and play from 0:00 if active)."""
        pl = self._get_playlist(playlist_id or self.active_playlist_id)
        if not pl:
            return
        tracks = pl.get("tracks") or []
        if not tracks:
            return
        pl["current_index"] = (int(pl.get("current_index", 0)) + 1) % len(tracks)
        await self.async_save()
        if self._active_session or self.state in ("playing", "buffering"):
            await self.async_play(playlist_id=pl.get("id"))
        else:
            self._notify_cb()

    async def async_prev(self, playlist_id: str | None = None) -> None:
        """Step back to the previous track in the playlist (and play from 0:00 if active)."""
        pl = self._get_playlist(playlist_id or self.active_playlist_id)
        if not pl:
            return
        tracks = pl.get("tracks") or []
        if not tracks:
            return
        pl["current_index"] = (int(pl.get("current_index", 0)) - 1) % len(tracks)
        await self.async_save()
        if self._active_session or self.state in ("playing", "buffering"):
            await self.async_play(playlist_id=pl.get("id"))
        else:
            self._notify_cb()

    async def async_update_config(self, values: dict[str, Any]) -> None:
        """Update music/wake-up settings in solace-playlists.json."""
        await self.hass.async_add_executor_job(self._check_reload_sync)
        allowed = {
            "active_playlist_id",
            "speaker_entity",
            "volume_pct",
            "wake_enabled",
            "wake_playlist_id",
            "wake_speaker_entity",
            "wake_volume_pct",
            "wake_time_enabled",
            "wake_target_time",
        }
        changed_volume = False
        for k, v in values.items():
            if k in allowed and v is not None:
                self._data[k] = v
                if k == "volume_pct":
                    changed_volume = True

        if "reset_playlist_id" in values and values["reset_playlist_id"]:
            pl = self._get_playlist(str(values["reset_playlist_id"]))
            if pl is not None:
                pl["current_index"] = 0

        await self.async_save()

        if changed_volume and self.state == "playing":
            vol_float = round(max(0.01, min(1.0, self.volume_pct / 100.0)), 2)
            try:
                await self.hass.services.async_call(
                    "media_player",
                    "volume_set",
                    {"entity_id": self.speaker_entity, "volume_level": vol_float},
                    blocking=False,
                )
            except Exception:  # noqa: BLE001
                pass

        self._notify_cb()

    async def async_trigger_wakeup(self, anchor_iso: str | None = None) -> None:
        """Triggered when Virtual Sunrise reaches 100% at Target Wake-Up Time."""
        await self.hass.async_add_executor_job(self._check_reload_sync)
        if not self.wake_enabled:
            return
        if anchor_iso and self._last_wakeup_anchor_iso == anchor_iso:
            return
        if anchor_iso:
            self._last_wakeup_anchor_iso = anchor_iso

        _LOGGER.info(
            "SolaceMusic: triggering wake-up playlist '%s' on %s at %d%% volume",
            self.wake_playlist_id,
            self.wake_speaker_entity,
            self.wake_volume_pct,
        )
        await self.async_play(
            playlist_id=self.wake_playlist_id,
            speaker_entity=self.wake_speaker_entity,
            volume_pct=self.wake_volume_pct,
        )
