from __future__ import annotations

from collections.abc import Callable
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QCloseEvent
from PyQt6.QtWidgets import (
    QHBoxLayout,
    QMainWindow,
    QPushButton,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from . import theme as _theme
from .theme import FONT_BODY, NAV_WIDTH, SPACE_XS, SPACE_MD, SPACE_SM


def _sidebar_style() -> str:
    return f"""
        QWidget#sidebar {{ background: {_theme.PANEL}; }}
        QPushButton {{
            color: {_theme.TEXT};
            background: transparent;
            border: none;
            padding: {SPACE_MD}px {SPACE_SM}px;
            font-family: 'Segoe UI', sans-serif;
            font-size: {FONT_BODY}px;
            text-align: left;
        }}
        QPushButton:hover   {{ background: {_theme.BORDER}; }}
        QPushButton:checked {{ background: {_theme.ACCENT}; color: #ffffff; }}
    """


class AppShell(QMainWindow):
    """Outer application shell: fixed sidebar nav + QStackedWidget for pages."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("linXiv")
        self.resize(1500, 950)
        self.setStyleSheet(f"background: {_theme.BG}; color: {_theme.TEXT};")
        self._page_btns: list[QPushButton] = []
        self._stack = QStackedWidget()
        self._close_callbacks: list[Callable[[], object]] = []
        self._nav_history: list[int] = []
        self._dirty: set[int] = set()

        self._sidebar = QWidget()
        self._sidebar.setObjectName("sidebar")
        self._sidebar.setFixedWidth(NAV_WIDTH)
        self._sidebar.setStyleSheet(_sidebar_style())

        self._nav = QVBoxLayout(self._sidebar)
        self._nav.setContentsMargins(0, SPACE_SM, 0, SPACE_SM)
        self._nav.setSpacing(SPACE_XS)
        self._nav.setAlignment(Qt.AlignmentFlag.AlignTop)

        central = QWidget()
        h = QHBoxLayout(central)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(0)
        h.addWidget(self._sidebar)
        h.addWidget(self._stack)
        self.setCentralWidget(central)

    # ── Public API ────────────────────────────────────────────────────────────

    def add_page(self, label: str, widget: QWidget) -> int:
        """Embed widget as a switchable page; returns its stack index."""
        idx = self._stack.addWidget(widget)
        btn = QPushButton(label)
        btn.setCheckable(True)
        btn.clicked.connect(lambda: self._go_to(idx))
        self._nav.addWidget(btn)
        self._page_btns.append(btn)
        if idx == 0:
            btn.setChecked(True)
        return idx

    def register_on_close(self, callback: Callable[[], object]) -> None:
        """Register a callback to run when the shell window closes."""
        self._close_callbacks.append(callback)

    def add_launcher(self, label: str, callback) -> None:
        """Add a nav button that runs callback (e.g. opens a floating window)."""
        btn = QPushButton(label)
        btn.clicked.connect(callback)
        self._nav.addWidget(btn)

    def go_to_widget(self, widget: QWidget) -> None:
        """Navigate to the page containing widget (must have been added via add_page)."""
        idx = self._stack.indexOf(widget)
        if idx >= 0:
            self._go_to(idx)

    def go_back(self) -> bool:
        """Return to the previous main stack page (sidebar index). False if there is none."""
        if not self._nav_history:
            return False
        prev = self._nav_history.pop()
        self._go_to(prev, record_history=False)
        return True

    def mark_all_dirty(self) -> None:
        """Mark all pages except the current one for style refresh on next visit."""
        cur = self._stack.currentIndex()
        self._dirty = set(range(self._stack.count())) - {cur}
        self._sidebar.setStyleSheet(_sidebar_style())

    def apply_all(self) -> None:
        """Immediately call refresh_styles() on every page that supports it."""
        for i in range(self._stack.count()):
            page = self._stack.widget(i)
            fn = getattr(page, "refresh_styles", None)
            if callable(fn):
                fn()
        self._dirty.clear()
        self._sidebar.setStyleSheet(_sidebar_style())

    # ── Internal ──────────────────────────────────────────────────────────────

    def closeEvent(self, event: QCloseEvent) -> None:
        for cb in self._close_callbacks:
            cb()
        super().closeEvent(event)

    def _go_to(self, idx: int, *, record_history: bool = True) -> None:
        cur = self._stack.currentIndex()
        if record_history and cur != idx and cur >= 0:
            self._nav_history.append(cur)
        if idx in self._dirty:
            page = self._stack.widget(idx)
            fn = getattr(page, "refresh_styles", None)
            if callable(fn):
                fn()
            self._dirty.discard(idx)
        self._stack.setCurrentIndex(idx)
        for i, btn in enumerate(self._page_btns):
            btn.setChecked(i == idx)
