"""The panel's cache key.

Four consecutive panel releases in August 2026 shipped against a `?v=0.5.13` that nobody
remembered to bump. The deploy was correct every time; the browser served the cached
module and the user saw none of it. The fix was to derive the key from the bundle's bytes,
and this file exists so that derivation cannot silently regress to a constant.
"""

from __future__ import annotations

from pathlib import Path

from custom_components.solace.panel import _bundle_fingerprint


def test_fingerprint_changes_when_the_bundle_changes(tmp_path: Path) -> None:
    """The whole point: different bytes must produce a different cache key."""
    bundle = tmp_path / "solace-panel.js"

    bundle.write_bytes(b"console.log('build one')")
    first = _bundle_fingerprint(bundle)

    bundle.write_bytes(b"console.log('build two')")
    second = _bundle_fingerprint(bundle)

    assert first != second, "an edited bundle must invalidate the browser cache"
    assert len(first) == 8 and len(second) == 8


def test_fingerprint_is_stable_for_identical_bytes(tmp_path: Path) -> None:
    """A restart that changes nothing must not bust the cache — that would defeat it."""
    bundle = tmp_path / "solace-panel.js"
    bundle.write_bytes(b"console.log('same')")

    assert _bundle_fingerprint(bundle) == _bundle_fingerprint(bundle)


def test_missing_bundle_degrades_instead_of_raising(tmp_path: Path) -> None:
    """A panel that fails to register is worse than one with a stale cache."""
    assert _bundle_fingerprint(tmp_path / "does-not-exist.js") == "nohash"


def test_shipped_bundle_fingerprints() -> None:
    """The real committed bundle must be readable, or the cache key is dead on arrival."""
    shipped = (
        Path(__file__).parent.parent
        / "custom_components"
        / "solace"
        / "frontend"
        / "solace-panel.js"
    )
    assert shipped.is_file(), "the built bundle is committed; HACS never runs a build"
    assert _bundle_fingerprint(shipped) != "nohash"
