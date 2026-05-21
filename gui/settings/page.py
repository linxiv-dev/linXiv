from __future__ import annotations

import os
from typing import Callable

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor, QFont
from PyQt6.QtWidgets import (
    QColorDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from pathlib import Path

from PyQt6.QtWidgets import QMessageBox

import user_settings as _user_settings
import service.files as _files
import service.paper as _paper_svc
import service.project as _project_svc
import gui.theme as _theme
from gui.theme import BG as _BG, PANEL as _PANEL, BORDER as _BORDER
from gui.theme import ACCENT as _ACCENT, TEXT as _TEXT, MUTED as _MUTED
from gui.theme import (
    FONT_TITLE, FONT_BODY, FONT_SECONDARY,
    SPACE_XL, SPACE_MD, SPACE_SM, SPACE_XS,
    RADIUS_LG, RADIUS_SM, CARD_PAD_H, CARD_PAD_V, PAGE_MARGIN_H,
)
from gui.qt_assets import TrashPanel
from gui.qt_assets.styles import BTN_MUTED as _BTN_MUTED
import service.project as _project_svc
from service.project import filter_projects, Q, Status


def _section_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet(
        f"color: {_MUTED}; font-size: {FONT_SECONDARY}px; font-weight: 600; "
        f"letter-spacing: 1px; text-transform: uppercase;"
    )
    return lbl


def _divider() -> QFrame:
    line = QFrame()
    line.setFrameShape(QFrame.Shape.HLine)
    line.setStyleSheet(f"color: {_BORDER};")
    return line


class _SettingRow(QWidget):
    def __init__(self, label: str, description: str, control: QWidget) -> None:
        super().__init__()
        self.setStyleSheet("background: transparent;")
        h = QHBoxLayout(self)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(SPACE_MD)

        text_col = QVBoxLayout()
        text_col.setSpacing(SPACE_XS)
        self._name_lbl = QLabel(label)
        self._name_lbl.setStyleSheet(f"color: {_TEXT}; font-size: {FONT_BODY}px;")
        self._desc_lbl = QLabel(description)
        self._desc_lbl.setStyleSheet(f"color: {_MUTED}; font-size: {FONT_SECONDARY}px;")
        self._desc_lbl.setWordWrap(True)
        text_col.addWidget(self._name_lbl)
        text_col.addWidget(self._desc_lbl)

        h.addLayout(text_col, stretch=1)
        h.addWidget(control, alignment=Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

    def refresh_styles(self) -> None:
        self._name_lbl.setStyleSheet(f"color: {_theme.TEXT}; font-size: {FONT_BODY}px;")
        self._desc_lbl.setStyleSheet(f"color: {_theme.MUTED}; font-size: {FONT_SECONDARY}px;")


class _Card(QFrame):
    def __init__(self, rows: list[_SettingRow]) -> None:
        super().__init__()
        self._rows = rows
        self._dividers: list[QFrame] = []
        self._apply_card_style()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(CARD_PAD_H, CARD_PAD_V, CARD_PAD_H, CARD_PAD_V)
        layout.setSpacing(0)

        for i, row in enumerate(rows):
            layout.addWidget(row)
            if i < len(rows) - 1:
                div = _divider()
                self._dividers.append(div)
                layout.addWidget(div)

    def _apply_card_style(self) -> None:
        self.setStyleSheet(
            f"QFrame {{ background: {_theme.PANEL}; border: 1px solid {_theme.BORDER}; "
            f"border-radius: {RADIUS_LG}px; }}"
        )

    def refresh_styles(self) -> None:
        self._apply_card_style()
        for row in self._rows:
            row.refresh_styles()
        for div in self._dividers:
            div.setStyleSheet(f"color: {_theme.BORDER};")


class _ColorPicker(QWidget):
    """Swatch button + editable hex field.
    Clicking the swatch opens QColorDialog; the field accepts direct hex input."""

    def __init__(
        self,
        hex_color: str,
        on_change: Callable[[str], None] | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setStyleSheet("background: transparent;")
        self._color = hex_color.lower()
        self._on_change = on_change

        h = QHBoxLayout(self)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(SPACE_XS)

        self._swatch = QPushButton()
        self._swatch.setFixedSize(36, 26)
        self._swatch.setCursor(Qt.CursorShape.PointingHandCursor)
        self._swatch.clicked.connect(self._open_dialog)

        self._field = QLineEdit(self._color)
        self._field.setFixedWidth(82)
        self._field.setFont(QFont("Monospace", 10))
        self._field.setStyleSheet(
            f"QLineEdit {{ background: {_PANEL}; border: 1px solid {_BORDER}; "
            f"border-radius: {RADIUS_SM}px; color: {_TEXT}; font-size: {FONT_SECONDARY}px; "
            f"padding: 2px 6px; }}"
            f"QLineEdit:focus {{ border-color: {_ACCENT}; }}"
        )
        self._field.editingFinished.connect(self._on_hex_typed)

        h.addWidget(self._swatch)
        h.addWidget(self._field)
        self._refresh_swatch()

    def set_color(self, hex_color: str) -> None:
        self._color = hex_color.lower()
        self._field.setText(self._color)
        self._refresh_swatch()

    def hex_color(self) -> str:
        return self._color

    def refresh_styles(self) -> None:
        self._field.setStyleSheet(
            f"QLineEdit {{ background: {_theme.PANEL}; border: 1px solid {_theme.BORDER}; "
            f"border-radius: {RADIUS_SM}px; color: {_theme.TEXT}; font-size: {FONT_SECONDARY}px; "
            f"padding: 2px 6px; }}"
            f"QLineEdit:focus {{ border-color: {_theme.ACCENT}; }}"
        )
        self._swatch.setStyleSheet(
            f"QPushButton {{ background: {self._color}; border: 1px solid {_theme.BORDER}; "
            f"border-radius: {RADIUS_SM}px; }}"
            f"QPushButton:hover {{ border-color: {_theme.TEXT}; }}"
        )

    def _refresh_swatch(self) -> None:
        self._swatch.setStyleSheet(
            f"QPushButton {{ background: {self._color}; border: 1px solid {_BORDER}; "
            f"border-radius: {RADIUS_SM}px; }}"
            f"QPushButton:hover {{ border-color: {_TEXT}; }}"
        )

    def _open_dialog(self) -> None:
        color = QColorDialog.getColor(QColor(self._color), self, "Pick Color")
        if color.isValid():
            self._apply(color.name())

    def _on_hex_typed(self) -> None:
        text = self._field.text().strip().lower()
        if not text.startswith("#"):
            text = "#" + text
        if len(text) == 4 and all(c in "0123456789abcdef" for c in text[1:]):
            text = "#" + text[1] * 2 + text[2] * 2 + text[3] * 2
        if len(text) == 7 and all(c in "0123456789abcdef" for c in text[1:]):
            self._apply(text)
        else:
            self._field.setText(self._color)

    def _apply(self, hex_color: str) -> None:
        self._color = hex_color.lower()
        self._field.setText(self._color)
        self._refresh_swatch()
        if self._on_change:
            self._on_change(self._color)


# Semantic button colors that live in styles.json, not driven by theme tokens.
_SEMANTIC_DEFAULTS: dict[str, str] = {
    "success": "#4caf7d",
    "danger":  "#e05c5c",
}

# Human-readable labels for each color key.
_COLOR_META: dict[str, tuple[str, str]] = {
    # theme tokens
    "BG":     ("Background",   "Main window background"),
    "PANEL":  ("Panel",        "Cards, sidebars, and dialogs"),
    "BORDER": ("Border",       "Dividers and outlines"),
    "ACCENT": ("Accent",       "Buttons, links, and highlights"),
    "TEXT":   ("Primary text", "Main readable text"),
    "MUTED":  ("Muted text",   "Labels and secondary info"),
    # semantic
    "success": ("Success",     "Download complete, confirm actions"),
    "danger":  ("Danger",      "Delete, error, and destructive actions"),
}


class _CollapsibleSection(QWidget):
    """A labelled group whose content rows can be toggled visible/hidden."""

    def __init__(self, title: str, *, expanded: bool = False) -> None:
        super().__init__()
        self.setStyleSheet("background: transparent;")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self._expanded = expanded
        self._title = title.upper()

        self._toggle_btn = QPushButton(self._header_text())
        self._toggle_btn.setFlat(True)
        self._toggle_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._toggle_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; border: none; text-align: left; "
            f"color: {_MUTED}; font-size: {FONT_SECONDARY}px; font-weight: 600; "
            f"letter-spacing: 1px; padding: 4px 0px; }}"
            f"QPushButton:hover {{ color: {_TEXT}; }}"
        )
        self._toggle_btn.clicked.connect(self._toggle)
        layout.addWidget(self._toggle_btn)

        self._body = QWidget()
        self._body.setStyleSheet("background: transparent;")
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, SPACE_XS, 0, SPACE_SM)
        self._body_layout.setSpacing(0)
        self._body.setVisible(expanded)
        layout.addWidget(self._body)

    def add_widget(self, w: QWidget) -> None:
        self._body_layout.addWidget(w)

    def refresh_styles(self) -> None:
        self._toggle_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; border: none; text-align: left; "
            f"color: {_theme.MUTED}; font-size: {FONT_SECONDARY}px; font-weight: 600; "
            f"letter-spacing: 1px; padding: 4px 0px; }}"
            f"QPushButton:hover {{ color: {_theme.TEXT}; }}"
        )

    def _header_text(self) -> str:
        arrow = "▾" if self._expanded else "▸"
        return f"{arrow}  {self._title}".replace("&", "&&")

    def _toggle(self) -> None:
        self._expanded = not self._expanded
        self._body.setVisible(self._expanded)
        self._toggle_btn.setText(self._header_text())


class _ThemeCard(QWidget):
    """Preset chips + collapsible grouped color pickers."""

    def __init__(
        self,
        on_theme_change: Callable[[], None] | None = None,
        on_self_refresh: Callable[[], None] | None = None,
        on_apply_all: Callable[[], None] | None = None,
    ) -> None:
        super().__init__()
        self.setStyleSheet("background: transparent;")
        self._on_theme_change = on_theme_change
        self._on_self_refresh = on_self_refresh
        self._on_apply_all = on_apply_all
        self._swatches: dict[str, _ColorPicker] = {}
        self._sections: list[_CollapsibleSection] = []
        self._color_row_labels: list[tuple[QLabel, QLabel]] = []
        self._current = self._merged_colors()

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(SPACE_SM)

        # ── Preset chips ──────────────────────────────────────────────────────
        self._preset_hdr = preset_hdr = QLabel("Theme preset")
        preset_hdr.setStyleSheet(
            f"color: {_TEXT}; font-size: {FONT_BODY}px; font-weight: 600;"
        )
        outer.addWidget(preset_hdr)

        chip_row = QHBoxLayout()
        chip_row.setSpacing(SPACE_SM)
        chip_row.setContentsMargins(0, 0, 0, 0)
        self._chips: dict[str, QPushButton] = {}
        for name in _theme.PRESETS:
            chip = QPushButton(name)
            chip.setFixedHeight(26)
            chip.setCursor(Qt.CursorShape.PointingHandCursor)
            chip.clicked.connect(lambda _c, n=name: self._apply_preset(n))
            chip_row.addWidget(chip)
            self._chips[name] = chip
        chip_row.addStretch()
        outer.addLayout(chip_row)
        self._refresh_chip_styles()

        outer.addSpacing(SPACE_SM)

        # ── Surfaces ──────────────────────────────────────────────────────────
        surfaces = _CollapsibleSection("Surfaces")
        for key in ("BG", "PANEL", "BORDER"):
            surfaces.add_widget(self._make_color_row(key))
        outer.addWidget(surfaces)
        self._sections.append(surfaces)

        # ── Text & Accent ─────────────────────────────────────────────────────
        text_accent = _CollapsibleSection("Text & Accent")
        for key in ("ACCENT", "TEXT", "MUTED"):
            text_accent.add_widget(self._make_color_row(key))
        outer.addWidget(text_accent)
        self._sections.append(text_accent)

        # ── Button colors ─────────────────────────────────────────────────────
        btn_overrides: dict[str, str] = _user_settings.get("button_color_overrides") or {}
        button_colors = _CollapsibleSection("Button colors")
        for key in ("success", "danger"):
            button_colors.add_widget(
                self._make_color_row(key, override=btn_overrides.get(key), semantic=True)
            )
        outer.addWidget(button_colors)
        self._sections.append(button_colors)

        # ── Footer ────────────────────────────────────────────────────────────
        footer = QHBoxLayout()
        note = QLabel("Changes apply to each page on next visit")
        note.setStyleSheet(
            f"color: {_MUTED}; font-size: {FONT_SECONDARY}px; font-style: italic;"
        )
        apply_all_btn = QPushButton("Apply to all")
        apply_all_btn.setStyleSheet(_BTN_MUTED)
        apply_all_btn.clicked.connect(lambda: self._on_apply_all() if self._on_apply_all else None)
        reset_btn = QPushButton("Reset")
        reset_btn.setFixedWidth(80)
        reset_btn.setStyleSheet(_BTN_MUTED)
        reset_btn.clicked.connect(self._reset)
        footer.addWidget(note)
        footer.addStretch()
        footer.addWidget(apply_all_btn)
        footer.addWidget(reset_btn)
        outer.addLayout(footer)

    def refresh_styles(self) -> None:
        self._preset_hdr.setStyleSheet(
            f"color: {_theme.TEXT}; font-size: {FONT_BODY}px; font-weight: 600;"
        )
        self._refresh_chip_styles()
        for section in self._sections:
            section.refresh_styles()
        for picker in self._swatches.values():
            picker.refresh_styles()
        for name_lbl, desc_lbl in self._color_row_labels:
            name_lbl.setStyleSheet(f"color: {_theme.TEXT}; font-size: {FONT_BODY}px;")
            desc_lbl.setStyleSheet(f"color: {_theme.MUTED}; font-size: {FONT_SECONDARY}px;")

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _merged_colors(self) -> dict[str, str]:
        th = _user_settings.get("theme_overrides") or {}
        btn = _user_settings.get("button_color_overrides") or {}
        return {**_theme.PRESETS["Navy"], **_SEMANTIC_DEFAULTS, **th, **btn}

    def _make_color_row(
        self,
        key: str,
        *,
        override: str | None = None,
        semantic: bool = False,
    ) -> QWidget:
        label, desc = _COLOR_META[key]
        hex_color = override if override else self._current.get(
            key, _SEMANTIC_DEFAULTS.get(key, "#000000")
        )

        def _on_pick(color: str, k: str = key, s: bool = semantic) -> None:
            self._current[k] = color
            if s:
                overrides: dict[str, str] = _user_settings.get("button_color_overrides") or {}
                overrides[k] = color
                _user_settings.set("button_color_overrides", overrides)
            else:
                overrides = _user_settings.get("theme_overrides") or {}
                overrides[k] = color
                _user_settings.set("theme_overrides", overrides)
                _theme.reload()
                self._refresh_chip_styles()
                if self._on_self_refresh:
                    self._on_self_refresh()
                if self._on_theme_change:
                    self._on_theme_change()

        picker = _ColorPicker(hex_color, on_change=_on_pick)
        self._swatches[key] = picker

        w = QWidget()
        w.setStyleSheet("background: transparent;")
        h = QHBoxLayout(w)
        h.setContentsMargins(0, SPACE_XS, 0, SPACE_XS)
        h.setSpacing(SPACE_MD)

        text_col = QVBoxLayout()
        text_col.setSpacing(SPACE_XS)
        name_lbl = QLabel(label)
        name_lbl.setStyleSheet(f"color: {_TEXT}; font-size: {FONT_BODY}px;")
        desc_lbl = QLabel(desc)
        desc_lbl.setStyleSheet(f"color: {_MUTED}; font-size: {FONT_SECONDARY}px;")
        text_col.addWidget(name_lbl)
        text_col.addWidget(desc_lbl)
        self._color_row_labels.append((name_lbl, desc_lbl))

        h.addLayout(text_col, stretch=1)
        h.addWidget(picker, alignment=Qt.AlignmentFlag.AlignVCenter)
        return w

    def _apply_preset(self, name: str) -> None:
        colors = _theme.PRESETS[name]
        self._current.update(colors)
        _user_settings.set("theme_overrides", {} if name == "Navy" else dict(colors))
        _theme.reload()
        for key, picker in self._swatches.items():
            if key in colors:
                picker.set_color(colors[key])
        self._refresh_chip_styles()
        if self._on_self_refresh:
            self._on_self_refresh()
        if self._on_theme_change:
            self._on_theme_change()

    def _reset(self) -> None:
        _user_settings.set("theme_overrides", {})
        _user_settings.set("button_color_overrides", {})
        for key, default in _SEMANTIC_DEFAULTS.items():
            if key in self._swatches:
                self._swatches[key].set_color(default)
        self._apply_preset("Navy")  # calls theme.reload() + on_theme_change

    def _refresh_chip_styles(self) -> None:
        current_theme = {k: self._current.get(k) for k in _theme.PRESETS["Navy"]}
        active = next(
            (n for n, colors in _theme.PRESETS.items() if colors == current_theme),
            None,
        )
        for name, chip in self._chips.items():
            if name == active:
                chip.setStyleSheet(
                    f"QPushButton {{ background: {_theme.ACCENT}; border: none; "
                    f"border-radius: {RADIUS_SM}px; color: #ffffff; "
                    f"font-size: {FONT_SECONDARY}px; padding: 3px 14px; }}"
                )
            else:
                chip.setStyleSheet(
                    f"QPushButton {{ background: transparent; border: 1px solid {_theme.BORDER}; "
                    f"border-radius: {RADIUS_SM}px; color: {_theme.TEXT}; "
                    f"font-size: {FONT_SECONDARY}px; padding: 3px 14px; }}"
                    f"QPushButton:hover {{ border-color: {_theme.ACCENT}; color: {_theme.ACCENT}; }}"
                )


class SettingsPage(QWidget):
    def __init__(
        self,
        on_theme_change: Callable[[], None] | None = None,
        on_apply_all: Callable[[], None] | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._on_theme_change = on_theme_change
        self._on_apply_all = on_apply_all
        self.setStyleSheet(f"background: {_BG}; color: {_TEXT};")

        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setStyleSheet(f"QScrollArea {{ border: none; background: {_BG}; }}")
        scroll = self._scroll

        self._scroll_content = QWidget()
        self._scroll_content.setStyleSheet(f"background: {_BG};")
        content = self._scroll_content
        inner = QVBoxLayout(content)
        inner.setContentsMargins(PAGE_MARGIN_H, 40, PAGE_MARGIN_H, PAGE_MARGIN_H)
        inner.setSpacing(0)

        self._title_lbl = QLabel("Settings")
        self._title_lbl.setStyleSheet(f"color: {_TEXT}; font-size: {FONT_TITLE}px; font-weight: 700;")
        inner.addWidget(self._title_lbl)
        inner.addSpacing(SPACE_XL)

        self._section_labels: list[QLabel] = []

        # ── Metadata Sources ──────────────────────────────────────────────────
        _meta_lbl = _section_label("Metadata Sources")
        self._section_labels.append(_meta_lbl)
        inner.addWidget(_meta_lbl)
        inner.addSpacing(SPACE_SM)

        self._mailto_field = QLineEdit()
        self._mailto_field.setPlaceholderText("your@email.com")
        self._mailto_field.setText(os.environ.get("CROSSREF_MAILTO", ""))
        self._mailto_field.setFixedWidth(240)
        self._mailto_field.setStyleSheet(
            f"background: {_PANEL}; border: 1px solid {_BORDER}; "
            f"border-radius: 6px; color: {_TEXT}; font-size: {FONT_BODY}px; "
            f"padding: 4px 10px;"
        )
        mailto_field = self._mailto_field

        def _save_mailto() -> None:
            from config import ENV_PATH
            from dotenv import set_key
            value = mailto_field.text().strip()
            os.environ["CROSSREF_MAILTO"] = value
            set_key(str(ENV_PATH), "CROSSREF_MAILTO", value)

        mailto_field.editingFinished.connect(_save_mailto)

        self._metadata_card = _Card([
            _SettingRow(
                "CrossRef Email (mailto)",
                "Your email for CrossRef's polite pool — faster, more reliable metadata responses.",
                mailto_field,
            )
        ])
        inner.addWidget(self._metadata_card)

        inner.addSpacing(SPACE_XL)

        # ── Storage ───────────────────────────────────────────────────────────
        _storage_lbl = _section_label("Storage")
        self._section_labels.append(_storage_lbl)
        inner.addWidget(_storage_lbl)
        inner.addSpacing(SPACE_SM)

        self._limit_spin = QSpinBox()
        self._limit_spin.setRange(100, 100_000)
        self._limit_spin.setSingleStep(100)
        self._limit_spin.setSuffix(" MB")
        self._limit_spin.setValue(_user_settings.get("pdf_save_limit_mb"))
        self._limit_spin.setFixedWidth(130)
        limit_spin = self._limit_spin
        limit_spin.setStyleSheet(
            f"background: {_PANEL}; border: 1px solid {_BORDER}; "
            f"border-radius: 6px; color: {_TEXT}; font-size: {FONT_BODY}px; "
            f"padding: 4px 10px;"
        )

        used_mb = _files.pdf_storage_mb()
        limit_mb_init = _user_settings.get("pdf_save_limit_mb")
        pct_init = min(100, int(used_mb / limit_mb_init * 100)) if limit_mb_init else 0

        self._usage_bar = usage_bar = QProgressBar()
        usage_bar.setRange(0, 100)
        usage_bar.setValue(pct_init)
        usage_bar.setTextVisible(False)
        usage_bar.setFixedWidth(100)
        usage_bar.setFixedHeight(8)
        usage_bar.setStyleSheet(
            f"QProgressBar {{ background: {_BORDER}; border-radius: 4px; border: none; }}"
            f"QProgressBar::chunk {{ background: {'#c0392b' if pct_init >= 90 else _MUTED}; border-radius: 4px; }}"
        )

        self._usage_label = usage_label = QLabel(f"{used_mb:.1f} / {limit_mb_init} MB  ({pct_init}%)")
        usage_label.setStyleSheet(f"color: {_MUTED}; font-size: {FONT_SECONDARY}px;")

        usage_widget = QWidget()
        usage_widget.setStyleSheet("background: transparent;")
        usage_row = QHBoxLayout(usage_widget)
        usage_row.setContentsMargins(0, 0, 0, 0)
        usage_row.setSpacing(SPACE_SM)
        usage_row.addWidget(usage_bar)
        usage_row.addWidget(usage_label)

        def _refresh_usage() -> None:
            mb = _files.pdf_storage_mb()
            lim = limit_spin.value()
            pct = min(100, int(mb / lim * 100)) if lim else 0
            usage_bar.setValue(pct)
            usage_label.setText(f"{mb:.1f} / {lim} MB  ({pct}%)")
            color = "#c0392b" if pct >= 90 else _MUTED
            usage_bar.setStyleSheet(
                f"QProgressBar {{ background: {_BORDER}; border-radius: 4px; border: none; }}"
                f"QProgressBar::chunk {{ background: {color}; border-radius: 4px; }}"
            )

        def _save_pdf_limit() -> None:
            _user_settings.set("pdf_save_limit_mb", limit_spin.value())

        limit_spin.editingFinished.connect(_save_pdf_limit)
        limit_spin.valueChanged.connect(_refresh_usage)

        self._storage_card = _Card([
            _SettingRow(
                "PDF save limit",
                "Maximum total size of PDFs kept on disk across all sessions.",
                limit_spin,
            ),
            _SettingRow(
                "PDF storage used",
                "Current size of all PDFs in the local downloads folder.",
                usage_widget,
            ),
        ])
        inner.addWidget(self._storage_card)

        inner.addSpacing(SPACE_XL)

        # ── Projects ──────────────────────────────────────────────────────────
        _projects_lbl = _section_label("Projects")
        self._section_labels.append(_projects_lbl)
        inner.addWidget(_projects_lbl)
        inner.addSpacing(SPACE_SM)

        self._trash_panel = TrashPanel()
        inner.addWidget(self._trash_panel)
        self._rebuild_trash()

        inner.addSpacing(SPACE_XL)

        # ── Appearance ────────────────────────────────────────────────────────
        _appear_lbl = _section_label("Appearance")
        self._section_labels.append(_appear_lbl)
        inner.addWidget(_appear_lbl)
        inner.addSpacing(SPACE_SM)
        self._theme_card = _ThemeCard(
            on_theme_change=self._on_theme_change,
            on_self_refresh=self.refresh_styles,
            on_apply_all=self._on_apply_all,
        )
        inner.addWidget(self._theme_card)

        inner.addStretch()
        scroll.setWidget(content)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(scroll)

    def showEvent(self, a0) -> None:
        super().showEvent(a0)
        self._rebuild_trash()

    def _rebuild_trash(self) -> None:
        try:
            deleted_projects = filter_projects(Q("status = ?", Status.DELETED))
        except Exception as e:
            print(f"[SettingsPage] _rebuild_trash (projects) failed: {e}")
            deleted_projects = []
        try:
            deleted_papers = _paper_svc.list_deleted()
        except Exception as e:
            print(f"[SettingsPage] _rebuild_trash (papers) failed: {e}")
            deleted_papers = []
        self._trash_panel.rebuild(
            deleted_projects,
            deleted_papers,
            on_restore_project=self._on_trash_restore_project,
            on_hard_delete_project=self._on_trash_hard_delete_project,
            on_restore_paper=self._on_trash_restore_paper,
            on_hard_delete_paper=self._on_trash_hard_delete_paper,
        )

    def _on_trash_restore_project(self, project) -> None:
        _project_svc.restore(_project_svc.Project(project_fk=project.id))
        self._rebuild_trash()

    def _on_trash_hard_delete_project(self, project) -> None:
        _project_svc.hard_delete(_project_svc.Project(project_fk=project.id))
        self._rebuild_trash()

    def _on_trash_restore_paper(self, deleted_paper) -> None:
        pdf_path, project_fks = _paper_svc.restore(_paper_svc.Paper(source_fk=deleted_paper.source_fk))

        if project_fks:
            proj_details = _project_svc.get_many(_project_svc.Projects(project_fks=project_fks))
            proj_names = ", ".join(d.name for d in proj_details) if proj_details else str(project_fks)
            reply = QMessageBox.question(
                self,
                "Restore paper",
                f'"{deleted_paper.title}" was in these projects:\n{proj_names}\n\nKeep it in those projects?',
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply == QMessageBox.StandardButton.No:
                pass  # project unlinking removed; restore always keeps membership

        if deleted_paper.had_pdf and pdf_path:
            p = Path(pdf_path)
            if p.is_file():
                QMessageBox.information(
                    self,
                    "PDF found",
                    f'The previous PDF was found at:\n{pdf_path}\nIt has been re-linked.',
                )
                _paper_svc.set_has_pdf_by_source(deleted_paper.source_id, True)
            else:
                QMessageBox.information(
                    self,
                    "PDF not found",
                    f'The paper had a PDF at:\n{pdf_path}\nbut it no longer exists.',
                )

        self._rebuild_trash()

    def _on_trash_hard_delete_paper(self, deleted_paper) -> None:
        _paper_svc.hard_delete(_paper_svc.Paper(source_fk=deleted_paper.source_fk))
        self._rebuild_trash()

    def refresh_styles(self) -> None:
        t = _theme
        self.setStyleSheet(f"background: {t.BG}; color: {t.TEXT};")
        self._scroll.setStyleSheet(f"QScrollArea {{ border: none; background: {t.BG}; }}")
        self._scroll_content.setStyleSheet(f"background: {t.BG};")
        self._title_lbl.setStyleSheet(f"color: {t.TEXT}; font-size: {FONT_TITLE}px; font-weight: 700;")
        for lbl in self._section_labels:
            lbl.setStyleSheet(
                f"color: {t.MUTED}; font-size: {FONT_SECONDARY}px; font-weight: 600; "
                f"letter-spacing: 1px; text-transform: uppercase;"
            )
        self._mailto_field.setStyleSheet(
            f"background: {t.PANEL}; border: 1px solid {t.BORDER}; "
            f"border-radius: 6px; color: {t.TEXT}; font-size: {FONT_BODY}px; padding: 4px 10px;"
        )
        self._limit_spin.setStyleSheet(
            f"background: {t.PANEL}; border: 1px solid {t.BORDER}; "
            f"border-radius: 6px; color: {t.TEXT}; font-size: {FONT_BODY}px; padding: 4px 10px;"
        )
        pct = self._usage_bar.value()
        self._usage_bar.setStyleSheet(
            f"QProgressBar {{ background: {t.BORDER}; border-radius: 4px; border: none; }}"
            f"QProgressBar::chunk {{ background: {'#c0392b' if pct >= 90 else t.MUTED}; border-radius: 4px; }}"
        )
        self._usage_label.setStyleSheet(f"color: {t.MUTED}; font-size: {FONT_SECONDARY}px;")
        self._metadata_card.refresh_styles()
        self._storage_card.refresh_styles()
        self._trash_panel.refresh_styles()
        self._theme_card.refresh_styles()
