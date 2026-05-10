from __future__ import annotations

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from service import paper as paper_svc
from service.tag import list_all_tags
from gui.qt_assets import PaperCard
import gui.qt_assets.styles as _qt_styles
from gui.qt_assets.styles import BTN_PANEL_SM as _BTN_PANEL_SM
import gui.theme as _theme
from gui.theme import BG as _BG, PANEL as _PANEL, BORDER as _BORDER
from gui.theme import ACCENT as _ACCENT, TEXT as _TEXT, MUTED as _MUTED
from gui.theme import (
    FONT_TITLE, FONT_SUBHEADING, FONT_BODY, FONT_TERTIARY,
    SPACE_XL, SPACE_SM, SPACE_XS,
    RADIUS_LG,
    PAGE_MARGIN_H, PAGE_MARGIN_V,
    CARD_PAD_H, CARD_PAD_V,
    DIALOG_PAD,
)
_RECENT_N = 10


class HomePage(QWidget):
    """Landing page: stat cards + recent papers list."""

    navigate_to_paper = pyqtSignal(int)   # source_fk

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setStyleSheet(f"background: {_BG}; color: {_TEXT};")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(PAGE_MARGIN_H, PAGE_MARGIN_V, PAGE_MARGIN_H, PAGE_MARGIN_V)
        outer.setSpacing(SPACE_XL)

        # ── Header ────────────────────────────────────────────────────────────
        self._title_lbl = QLabel("linXiv")
        self._title_lbl.setStyleSheet(f"font-size: {FONT_TITLE}px; font-weight: bold; color: {_ACCENT}; background: transparent;")
        self._subtitle_lbl = QLabel("Your arXiv paper collection")
        self._subtitle_lbl.setStyleSheet(f"font-size: {FONT_BODY}px; color: {_MUTED}; background: transparent;")
        outer.addWidget(self._title_lbl)
        outer.addWidget(self._subtitle_lbl)

        # ── Stat cards ────────────────────────────────────────────────────────
        self._stats_container = QWidget()
        self._stats_container.setStyleSheet("background: transparent;")
        self._stats_row = QHBoxLayout(self._stats_container)
        self._stats_row.setContentsMargins(0, 0, 0, 0)
        self._stats_row.setSpacing(CARD_PAD_H)
        outer.addWidget(self._stats_container)

        # ── Recent papers ─────────────────────────────────────────────────────
        recent_hdr = QHBoxLayout()
        self._recent_lbl = QLabel("Recent papers")
        self._recent_lbl.setStyleSheet(
            f"font-size: {FONT_SUBHEADING}px; font-weight: 600; color: {_TEXT}; background: transparent;"
        )
        self._refresh_btn = refresh_btn = QPushButton("Refresh")
        refresh_btn.setFixedWidth(80)
        refresh_btn.setStyleSheet(_BTN_PANEL_SM)
        refresh_btn.clicked.connect(self._load)
        recent_hdr.addWidget(self._recent_lbl)
        recent_hdr.addStretch()
        recent_hdr.addWidget(refresh_btn)
        outer.addLayout(recent_hdr)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent;")

        self._recent_widget = QWidget()
        self._recent_widget.setStyleSheet("background: transparent;")
        self._recent_layout = QVBoxLayout(self._recent_widget)
        self._recent_layout.setContentsMargins(0, 0, 0, 0)
        self._recent_layout.setSpacing(SPACE_SM)
        self._recent_layout.addStretch()

        scroll.setWidget(self._recent_widget)
        outer.addWidget(scroll, stretch=1)

        self._load()

    # ── Data ──────────────────────────────────────────────────────────────────

    def refresh(self) -> None:
        self._load()

    def refresh_styles(self) -> None:
        self.setStyleSheet(f"background: {_theme.BG}; color: {_theme.TEXT};")
        self._title_lbl.setStyleSheet(
            f"font-size: {FONT_TITLE}px; font-weight: bold; color: {_theme.ACCENT}; background: transparent;"
        )
        self._subtitle_lbl.setStyleSheet(
            f"font-size: {FONT_BODY}px; color: {_theme.MUTED}; background: transparent;"
        )
        self._recent_lbl.setStyleSheet(
            f"font-size: {FONT_SUBHEADING}px; font-weight: 600; color: {_theme.TEXT}; background: transparent;"
        )
        self._refresh_btn.setStyleSheet(_qt_styles.BTN_PANEL_SM)
        self._load()

    def _load(self) -> None:
        papers   = paper_svc.list_papers(latest_only=True)
        tags     = list_all_tags()
        total    = len(papers)
        with_pdf = sum(1 for p in papers if p["has_pdf"])
        cats     = len({p["category"] for p in papers if p["category"]})
        tag_cnt  = len(tags)

        # Rebuild stat cards
        while self._stats_row.count():
            item = self._stats_row.takeAt(0)
            if item.widget():  # pyright: ignore[reportOptionalMemberAccess]
                item.widget().deleteLater()  # pyright: ignore[reportOptionalMemberAccess]

        for value, label in (
            (str(total),    "Papers saved"),
            (str(with_pdf), "PDFs on disk"),
            (str(cats),     "Categories"),
            (str(tag_cnt),  "Tags"),
        ):
            self._stats_row.addWidget(self._make_card(value, label))

        # Rebuild recent papers
        while self._recent_layout.count() > 1:
            item = self._recent_layout.takeAt(0)
            if item.widget():  # pyright: ignore[reportOptionalMemberAccess]
                item.widget().deleteLater()  # pyright: ignore[reportOptionalMemberAccess]

        for p in papers[:_RECENT_N]:
            card = PaperCard(p, parent=self._recent_widget)
            card.double_clicked.connect(
                lambda _row, pid=p["source_fk"]: self.navigate_to_paper.emit(pid)
            )
            self._recent_layout.insertWidget(self._recent_layout.count() - 1, card)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _make_card(self, value: str, label: str) -> QFrame:
        card = QFrame()
        card.setStyleSheet(f"""
            QFrame {{
                background: {_theme.PANEL};
                border: 1px solid {_theme.BORDER};
                border-radius: {RADIUS_LG}px;
            }}
            QLabel {{ border: none; background: transparent; }}
        """)
        lay = QVBoxLayout(card)
        lay.setContentsMargins(DIALOG_PAD, CARD_PAD_V, DIALOG_PAD, CARD_PAD_V)
        lay.setSpacing(SPACE_XS)

        num = QLabel(value)
        num.setStyleSheet(f"font-size: 30px; font-weight: bold; color: {_theme.ACCENT};")
        num.setAlignment(Qt.AlignmentFlag.AlignCenter)

        lbl = QLabel(label)
        lbl.setStyleSheet(f"font-size: {FONT_TERTIARY}px; color: {_theme.MUTED}; letter-spacing: 0.05em;")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)

        lay.addWidget(num)
        lay.addWidget(lbl)
        return card
