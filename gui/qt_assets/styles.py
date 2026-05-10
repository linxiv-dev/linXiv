"""
Shared QPushButton stylesheet constants — templates live in formats/styles.json.
"""
from __future__ import annotations

import json
from pathlib import Path

import user_settings as _us
from gui.theme import ACCENT, BORDER, MUTED, PANEL, TEXT
from gui.theme import FONT_BODY, FONT_SECONDARY, FONT_TERTIARY
from gui.theme import RADIUS_MD, RADIUS_SM, SPACE_SM, SPACE_XS

_raw = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "formats" / "styles.json").read_text()
)
_theme = {
    "ACCENT": ACCENT, "BORDER": BORDER, "MUTED": MUTED, "PANEL": PANEL, "TEXT": TEXT,
    "FONT_BODY": FONT_BODY, "FONT_SECONDARY": FONT_SECONDARY, "FONT_TERTIARY": FONT_TERTIARY,
    "RADIUS_MD": RADIUS_MD, "RADIUS_SM": RADIUS_SM, "SPACE_SM": SPACE_SM, "SPACE_XS": SPACE_XS,
}

_btn_overrides: dict[str, str] = _us.get("button_color_overrides") or {}
_SUCCESS = _btn_overrides.get("success", "#4caf7d")
_DANGER  = _btn_overrides.get("danger",  "#e05c5c")


def _t(key: str) -> str:
    result = _raw[key].format_map(_theme)
    if _SUCCESS != "#4caf7d":
        result = result.replace("#4caf7d", _SUCCESS)
    if _DANGER != "#e05c5c":
        result = result.replace("#e05c5c", _DANGER)
    return result


# ── Primary / dialog buttons ──────────────────────────────────────────────────

BTN_PRIMARY = _t("BTN_PRIMARY")
BTN_MUTED   = _t("BTN_MUTED")
BTN_SUCCESS = _t("BTN_SUCCESS")

# ── General outline buttons ───────────────────────────────────────────────────

BTN_PANEL   = _t("BTN_PANEL")
BTN_OUTLINE = _t("BTN_OUTLINE")
BTN_DANGER  = _t("BTN_DANGER")

# ── PDF card button states (RADIUS_SM, FONT_TERTIARY, no padding) ─────────────

BTN_PDF_OPEN     = _t("BTN_PDF_OPEN")
BTN_PDF_DOWNLOAD = _t("BTN_PDF_DOWNLOAD")
BTN_PDF_LINK     = _t("BTN_PDF_LINK")
BTN_PDF_ERROR    = _t("BTN_PDF_ERROR")

# ── Note / annotation buttons (RADIUS_SM, FONT_TERTIARY) ─────────────────────

BTN_NOTE_OPEN   = _t("BTN_NOTE_OPEN")
BTN_NOTE_EDIT   = _t("BTN_NOTE_EDIT")
BTN_NOTE_DELETE = _t("BTN_NOTE_DELETE")
BTN_NOTE_ACCENT = _t("BTN_NOTE_ACCENT")

# ── Compact / contextual buttons ─────────────────────────────────────────────

BTN_PANEL_SM      = _t("BTN_PANEL_SM")
BTN_FILTER_ACTIVE = _t("BTN_FILTER_ACTIVE")
BTN_LINK          = _t("BTN_LINK")
BTN_GHOST         = _t("BTN_GHOST")

# ── Helper for dynamically colored outline buttons ────────────────────────────

_btn_colored_outline_tpl = _t("btn_colored_outline")

def btn_colored_outline(color: str, *, hover_bg: str = "rgba(91,141,238,0.08)") -> str:
    """Transparent-bg button with a single color for both border and text."""
    return _btn_colored_outline_tpl.replace("__color__", color).replace("__hover_bg__", hover_bg)


def reload() -> None:
    """Rebuild all button stylesheet constants from the current theme values."""
    import gui.theme as _gt
    _theme.update({
        "ACCENT": _gt.ACCENT, "BORDER": _gt.BORDER, "MUTED": _gt.MUTED,
        "PANEL": _gt.PANEL, "TEXT": _gt.TEXT,
    })
    _btn_overrides_new: dict[str, str] = _us.get("button_color_overrides") or {}
    global _SUCCESS, _DANGER
    _SUCCESS = _btn_overrides_new.get("success", "#4caf7d")
    _DANGER  = _btn_overrides_new.get("danger",  "#e05c5c")

    global BTN_PRIMARY, BTN_MUTED, BTN_SUCCESS, BTN_PANEL, BTN_OUTLINE, BTN_DANGER
    global BTN_PDF_OPEN, BTN_PDF_DOWNLOAD, BTN_PDF_LINK, BTN_PDF_ERROR
    global BTN_NOTE_OPEN, BTN_NOTE_EDIT, BTN_NOTE_DELETE, BTN_NOTE_ACCENT
    global BTN_PANEL_SM, BTN_FILTER_ACTIVE, BTN_LINK, BTN_GHOST
    global _btn_colored_outline_tpl

    BTN_PRIMARY = _t("BTN_PRIMARY")
    BTN_MUTED   = _t("BTN_MUTED")
    BTN_SUCCESS = _t("BTN_SUCCESS")
    BTN_PANEL   = _t("BTN_PANEL")
    BTN_OUTLINE = _t("BTN_OUTLINE")
    BTN_DANGER  = _t("BTN_DANGER")
    BTN_PDF_OPEN     = _t("BTN_PDF_OPEN")
    BTN_PDF_DOWNLOAD = _t("BTN_PDF_DOWNLOAD")
    BTN_PDF_LINK     = _t("BTN_PDF_LINK")
    BTN_PDF_ERROR    = _t("BTN_PDF_ERROR")
    BTN_NOTE_OPEN   = _t("BTN_NOTE_OPEN")
    BTN_NOTE_EDIT   = _t("BTN_NOTE_EDIT")
    BTN_NOTE_DELETE = _t("BTN_NOTE_DELETE")
    BTN_NOTE_ACCENT = _t("BTN_NOTE_ACCENT")
    BTN_PANEL_SM      = _t("BTN_PANEL_SM")
    BTN_FILTER_ACTIVE = _t("BTN_FILTER_ACTIVE")
    BTN_LINK          = _t("BTN_LINK")
    BTN_GHOST         = _t("BTN_GHOST")
    _btn_colored_outline_tpl = _t("btn_colored_outline")
