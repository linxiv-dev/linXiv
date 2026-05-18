from __future__ import annotations

from PyQt6.QtCore import QEvent, Qt
from PyQt6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget,
)

from gui.qt_assets.paper_card import ElidedLabel
from gui.qt_assets.styles import BTN_DANGER, BTN_MUTED
from gui.theme import (
    BORDER, MUTED, PANEL, TEXT,
    FONT_SECONDARY, RADIUS_SM, SPACE_SM, SPACE_XS,
)


class TrashRow(QFrame):
    """One trash row: [name]  [Restore]  [Delete forever]."""

    def __init__(self, name: str, on_restore, on_hard_delete, parent=None) -> None:
        super().__init__(parent)
        self._confirming = False
        self._on_hard_delete = on_hard_delete
        self.setFixedHeight(48)
        self.setStyleSheet(
            f"QFrame {{ background: {PANEL}; border: 1px solid {BORDER};"
            f" border-radius: {RADIUS_SM}px; }}"
            f" QLabel {{ border: none; background: transparent; }}"
        )

        lay = QHBoxLayout(self)
        lay.setContentsMargins(14, 0, 12, 0)
        lay.setSpacing(10)

        name_lbl = ElidedLabel(name)
        name_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {MUTED};")
        lay.addWidget(name_lbl, stretch=1)

        restore_btn = QPushButton("Restore")
        restore_btn.setFixedHeight(28)
        restore_btn.setStyleSheet(BTN_MUTED)
        restore_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        restore_btn.clicked.connect(lambda: on_restore())
        lay.addWidget(restore_btn)

        self._del_btn = QPushButton("Delete forever")
        self._del_btn.setFixedHeight(28)
        self._del_btn.setStyleSheet(BTN_DANGER)
        self._del_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._del_btn.clicked.connect(self._on_del_click)
        self._del_btn.installEventFilter(self)
        lay.addWidget(self._del_btn)

    def eventFilter(self, a0, a1) -> bool:
        if a0 is self._del_btn and a1 and a1.type() == QEvent.Type.FocusOut:  
            self._confirming = False
            self._del_btn.setText("Delete forever")
        return super().eventFilter(a0, a1)

    def _on_del_click(self) -> None:
        if not self._confirming:
            self._confirming = True
            self._del_btn.setText("⚠ Confirm?")
        else:
            self._confirming = False
            self._del_btn.setText("Delete forever")
            self._on_hard_delete()


def _section_label(text: str) -> QLabel:
    lbl = QLabel(text)
    lbl.setStyleSheet(
        f"font-size: {FONT_SECONDARY}px; color: {MUTED}; font-weight: 600;"
        f" background: transparent; border: none; padding-top: 4px;"
    )
    return lbl


class TrashPanel(QWidget):
    """Collapsible trash section showing deleted projects and papers."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setStyleSheet("background: transparent;")
        self._expanded = False
        self._total_count = 0

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self._toggle_btn = QPushButton("▸  🗑 TRASH (0)")
        self._toggle_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._toggle_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; border: none; text-align: left;"
            f" font-size: {FONT_SECONDARY}px; font-weight: 600; color: {MUTED};"
            f" letter-spacing: 1px; padding: 4px 0px; }}"
            f" QPushButton:hover {{ color: {TEXT}; }}"
        )
        self._toggle_btn.setVisible(False)
        self._toggle_btn.clicked.connect(self._toggle)
        layout.addWidget(self._toggle_btn)

        self._container = QWidget()
        self._container.setStyleSheet("background: transparent;")
        self._container_layout = QVBoxLayout(self._container)
        self._container_layout.setContentsMargins(0, SPACE_XS, 0, SPACE_SM)
        self._container_layout.setSpacing(8)
        self._container.setVisible(False)
        layout.addWidget(self._container)

    def refresh_styles(self) -> None:
        self._toggle_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; border: none; text-align: left;"
            f" font-size: {FONT_SECONDARY}px; font-weight: 600; color: {MUTED};"
            f" letter-spacing: 1px; padding: 4px 0px; }}"
            f" QPushButton:hover {{ color: {TEXT}; }}"
        )

    def rebuild(
        self,
        deleted_projects,
        deleted_papers,
        on_restore_project,
        on_hard_delete_project,
        on_restore_paper,
        on_hard_delete_paper,
    ) -> None:
        while self._container_layout.count() > 0:
            item = self._container_layout.takeAt(0)
            if item:
                w = item.widget()
                if w:
                    w.deleteLater()

        self._total_count = len(deleted_projects) + len(deleted_papers)

        if self._total_count == 0:
            self._toggle_btn.setVisible(False)
            self._container.setVisible(False)
            return

        self._toggle_btn.setVisible(True)
        arrow = "▾" if self._expanded else "▸"
        self._toggle_btn.setText(f"{arrow}  🗑 TRASH ({self._total_count})")
        self._container.setVisible(self._expanded)

        if deleted_papers:
            self._container_layout.addWidget(_section_label("Papers"))
            for p in deleted_papers:
                row = TrashRow(
                    p.title,
                    on_restore=lambda paper=p: on_restore_paper(paper),
                    on_hard_delete=lambda paper=p: on_hard_delete_paper(paper),
                )
                self._container_layout.addWidget(row)

        if deleted_projects:
            self._container_layout.addWidget(_section_label("Projects"))
            for p in deleted_projects:
                row = TrashRow(
                    p.name,
                    on_restore=lambda proj=p: on_restore_project(proj),
                    on_hard_delete=lambda proj=p: on_hard_delete_project(proj),
                )
                self._container_layout.addWidget(row)

    def _toggle(self) -> None:
        self._expanded = not self._expanded
        self._container.setVisible(self._expanded)
        arrow = "▾" if self._expanded else "▸"
        self._toggle_btn.setText(f"{arrow}  🗑 TRASH ({self._total_count})")
