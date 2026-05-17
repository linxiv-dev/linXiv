from __future__ import annotations

from PyQt6.QtCore import QEvent, Qt
from PyQt6.QtWidgets import (
    QFrame, QHBoxLayout, QPushButton, QVBoxLayout, QWidget,
)

from gui.qt_assets.paper_card import ElidedLabel
from gui.qt_assets.styles import BTN_DANGER, BTN_MUTED
from gui.theme import (
    BORDER, MUTED, PANEL, TEXT,
    FONT_SECONDARY, FONT_TERTIARY, RADIUS_SM, SPACE_SM, SPACE_XS,
)


class TrashRow(QFrame):
    """One deleted-project row: [name]  [Restore]  [Delete forever]."""

    def __init__(self, project, on_restore, on_hard_delete, parent=None) -> None:
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

        name_lbl = ElidedLabel(project.name)
        name_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {MUTED};")
        lay.addWidget(name_lbl, stretch=1)

        restore_btn = QPushButton("Restore")
        restore_btn.setFixedHeight(28)
        restore_btn.setStyleSheet(BTN_MUTED)
        restore_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        restore_btn.clicked.connect(on_restore)
        lay.addWidget(restore_btn)

        self._del_btn = QPushButton("Delete forever")
        self._del_btn.setFixedHeight(28)
        self._del_btn.setStyleSheet(BTN_DANGER)
        self._del_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._del_btn.clicked.connect(self._on_del_click)
        self._del_btn.installEventFilter(self)
        lay.addWidget(self._del_btn)

    def eventFilter(self, obj, event) -> bool:
        if obj is self._del_btn and event.type() == QEvent.Type.FocusOut:
            self._confirming = False
            self._del_btn.setText("Delete forever")
        return super().eventFilter(obj, event)

    def _on_del_click(self) -> None:
        if not self._confirming:
            self._confirming = True
            self._del_btn.setText("⚠ Confirm?")
        else:
            self._confirming = False
            self._del_btn.setText("Delete forever")
            self._on_hard_delete()


class TrashPanel(QWidget):
    """Collapsible trash section: compact icon toggle + expandable TrashRow list."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setStyleSheet("background: transparent;")
        self._expanded = False

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self._toggle_btn = QPushButton("🗑  Trash (0)  ▼")
        self._toggle_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._toggle_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; border: none; text-align: left;"
            f" font-size: {FONT_TERTIARY}px; color: {MUTED}; padding: {SPACE_SM}px 0px; }}"
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

    def rebuild(self, deleted_projects, on_restore, on_hard_delete) -> None:
        while self._container_layout.count() > 0:
            item = self._container_layout.takeAt(0)
            if item:
                w = item.widget()
                if w is not None:
                    w.deleteLater()

        count = len(deleted_projects)
        if count == 0:
            self._toggle_btn.setVisible(False)
            self._container.setVisible(False)
            return

        self._toggle_btn.setVisible(True)
        indicator = "▲" if self._expanded else "▼"
        self._toggle_btn.setText(f"🗑  Trash ({count})  {indicator}")
        self._container.setVisible(self._expanded)

        for p in deleted_projects:
            row = TrashRow(
                p,
                on_restore=lambda proj=p: on_restore(proj),
                on_hard_delete=lambda proj=p: on_hard_delete(proj),
            )
            self._container_layout.addWidget(row)

    def _toggle(self) -> None:
        self._expanded = not self._expanded
        self._container.setVisible(self._expanded)
        count = self._container_layout.count()
        indicator = "▲" if self._expanded else "▼"
        self._toggle_btn.setText(f"🗑  Trash ({count})  {indicator}")
