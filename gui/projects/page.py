from __future__ import annotations

from typing import cast

from PyQt6.QtCore import QEvent, QThread, QTimer, Qt, pyqtSignal
from PyQt6.QtGui import QCloseEvent
from PyQt6.QtWidgets import QComboBox, QDialogButtonBox, QMessageBox
from PyQt6.QtWidgets import (
    QDialog,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLayoutItem,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QStackedWidget,
    QTextBrowser,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from gui.library.page import LibraryPage
from gui.qt_assets import ElidedLabel, PaperCard, SelectionBar
from gui.qt_assets.note_card import NoteCard
import gui.qt_assets.styles as _qt_styles
from gui.qt_assets.styles import (
    BTN_DANGER as _BTN_DANGER,
    BTN_MUTED as _BTN_MUTED_STYLE,
    BTN_PRIMARY as _BTN_STYLE,
)
from gui.shell import AppShell
import gui.theme as _theme
from gui.theme import BG, BORDER, PANEL, ACCENT, MUTED, TEXT 
from gui.theme import (
    BTN_H_LG, BTN_H_MD,  CARD_PAD_H,  CARD_PAD_V,  DIALOG_PAD,  
    FONT_BODY,  FONT_HEADING,  FONT_SECONDARY,  FONT_SUBHEADING,
    FONT_TERTIARY,  FONT_TITLE,
    #NOTE_HEIGHT,
    PAGE_MARGIN_H,  RADIUS_LG,  RADIUS_MD,  RADIUS_SM,
    SPACE_LG,  SPACE_MD,  SPACE_SM,  SPACE_XL,  SPACE_XS,
)
from gui.views import PdfWindow
from service import paper as paper_svc, project as project_svc
from service.note import count_project_notes, ensure_notes_db
from service.project import filter_projects, Q, Status
from sources.pdf_metadata import resolve_pdf_metadata
from storage.projects import Project
# Long project descriptions as a single tall QLabel can blow layout/GPU on window resize (Windows D3D11).
_PROJECT_DESC_VIEWPORT_MAX_H = 550

_PRESET_COLORS: list[int] = [
    0x5b8dee,  # blue (default)
    0x9b59b6,  # purple
    0x4caf7d,  # green
    0xe67e22,  # orange
    0xe05c5c,  # red
    0x1abc9c,  # teal
]


_INPUT_STYLE = f"""
    QLineEdit, QTextEdit {{
        background: {BG}; border: 1px solid {BORDER}; border-radius: {RADIUS_MD}px;
        color: {TEXT}; font-size: {FONT_BODY}px; padding: {SPACE_SM}px 10px;
    }}
    QLineEdit:focus, QTextEdit:focus {{ border-color: {ACCENT}; }}
"""


# ── PDF metadata worker ───────────────────────────────────────────────────────

class _PdfMetadataWorker(QThread):
    finished = pyqtSignal(object, str)   # PaperMetadata, pdf_path
    failed   = pyqtSignal(str)

    def __init__(self, pdf_path: str) -> None:
        super().__init__()
        self._path = pdf_path

    def run(self) -> None:
        try:
            meta = resolve_pdf_metadata(self._path)
            self.finished.emit(meta, self._path)
        except Exception as e:
            self.failed.emit(str(e))


# ── New-project dialog ────────────────────────────────────────────────────────
class NewProjectDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("New Project")
        self.setFixedWidth(440)
        self.setStyleSheet(f"background: {PANEL}; color: {TEXT};")
        self._color: int = _PRESET_COLORS[0]

        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 24)
        lay.setSpacing(14)

        title = QLabel("New Project")
        title.setStyleSheet(f"font-size: 20px; font-weight: bold; color: {ACCENT};")
        lay.addWidget(title)

        lay.addWidget(self._field_label("Name"))
        self._name = QLineEdit()
        self._name.setPlaceholderText("e.g. Diffusion Models")
        self._name.setStyleSheet(_INPUT_STYLE)
        lay.addWidget(self._name)

        lay.addWidget(self._field_label("Description  (optional)"))
        self._desc = QTextEdit()
        self._desc.setPlaceholderText("What is this project about?")
        self._desc.setFixedHeight(72)
        self._desc.setStyleSheet(_INPUT_STYLE)
        lay.addWidget(self._desc)

        lay.addWidget(self._field_label("Project tags  (comma-separated, optional)"))
        self._project_tags = QLineEdit()
        self._project_tags.setPlaceholderText("e.g. generative, vision")
        self._project_tags.setStyleSheet(_INPUT_STYLE)
        lay.addWidget(self._project_tags)

        lay.addWidget(self._field_label("Colour"))
        lay.addLayout(self._build_swatches())
        lay.addSpacing(SPACE_XS)

        self._err = QLabel("")
        self._err.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: #e05c5c;")
        lay.addWidget(self._err)

        btn_row = QHBoxLayout()
        cancel = QPushButton("Cancel")
        cancel.setStyleSheet(_BTN_MUTED_STYLE)
        cancel.clicked.connect(self.reject)
        self._create_btn = QPushButton("Create")
        self._create_btn.setStyleSheet(_BTN_STYLE)
        self._create_btn.clicked.connect(self._on_create)
        btn_row.addWidget(cancel)
        btn_row.addStretch()
        btn_row.addWidget(self._create_btn)
        lay.addLayout(btn_row)

    def _field_label(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {MUTED}; font-weight: 600;")
        return lbl

    def _build_swatches(self) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(SPACE_SM)
        self._swatch_btns: list[QPushButton] = []
        for color in _PRESET_COLORS:
            btn = QPushButton()
            btn.setFixedSize(28, 28)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setCheckable(True)
            btn.setChecked(color == self._color)
            btn.setStyleSheet(self._swatch_css(color, color == self._color))
            btn.clicked.connect(lambda _, c=color: self._select_color(c))
            self._swatch_btns.append(btn)
            row.addWidget(btn)
        row.addStretch()
        return row

    def _swatch_css(self, color: int, checked: bool) -> str:
        hex_color = project_svc.color_to_hex(color)
        border = "#ffffff" if checked else hex_color
        return (
            f"QPushButton {{ background: {hex_color}; border-radius: 14px;"
            f" border: 2px solid {border}; }}"
        )

    def _select_color(self, color: int) -> None:
        self._color = color
        for btn, c in zip(self._swatch_btns, _PRESET_COLORS):
            btn.setChecked(c == color)
            btn.setStyleSheet(self._swatch_css(c, c == color))

    def _on_create(self) -> None:
        name = self._name.text().strip()
        if not name:
            self._err.setText("Project name is required.")
            return
        desc = self._desc.toPlainText().strip()
        raw = self._project_tags.text().strip()
        project_tags = [t.strip() for t in raw.split(",") if t.strip()] if raw else []

        project_svc.ensure_projects_db()
        ensure_notes_db()

        p = Project(name=name, description=desc, color=self._color)
        p.save()
        if project_tags and p.id is not None:
            import storage.tags as _tags_storage
            _tags_storage.add_project_tags(p.id, project_tags)
        self.accept()


# ── Add-paper dialog ──────────────────────────────────────────────────────────

class AddPaperDialog(QDialog):
    def __init__(self, project, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._project = project
        self.setWindowTitle("Add Paper to Project")
        self.setFixedSize(560, 440)
        self.setStyleSheet(f"background: {PANEL}; color: {TEXT};")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, DIALOG_PAD, 24, DIALOG_PAD)
        lay.setSpacing(SPACE_MD)

        title = QLabel("Add Paper")
        title.setStyleSheet(f"font-size: {FONT_HEADING}px; font-weight: bold; color: {ACCENT};")
        lay.addWidget(title)

        self._filter = QLineEdit()
        self._filter.setPlaceholderText("Filter by title or arXiv ID…")
        self._filter.setStyleSheet(_INPUT_STYLE)
        self._filter.textChanged.connect(self._apply_filter)
        lay.addWidget(self._filter)

        self._list = QListWidget()
        self._list.setStyleSheet(f"""
            QListWidget {{
                background: {BG}; border: 1px solid {BORDER}; border-radius: {RADIUS_MD}px;
                color: {TEXT}; font-size: {FONT_SECONDARY}px;
            }}
            QListWidget::item:selected {{ background: {ACCENT}; color: #fff; }}
            QListWidget::item:hover    {{ background: #2a2a4a; }}
        """)
        self._list.itemDoubleClicked.connect(self._on_add)
        lay.addWidget(self._list)

        btn_row = QHBoxLayout()
        cancel = QPushButton("Cancel")
        cancel.setStyleSheet(_BTN_MUTED_STYLE)
        cancel.clicked.connect(self.reject)
        self._add_btn = QPushButton("Add to Project")
        self._add_btn.setStyleSheet(_BTN_STYLE)
        self._add_btn.clicked.connect(self._on_add)
        btn_row.addWidget(cancel)
        btn_row.addStretch()
        btn_row.addWidget(self._add_btn)
        lay.addLayout(btn_row)

        self._load_papers()

    def _load_papers(self) -> None:
        self._all_papers = paper_svc.list_papers()
        already = set(self._project.source_fks)
        self._papers = [r for r in self._all_papers if r["source_fk"] not in already]
        self._populate(self._papers)

    def _populate(self, papers) -> None:
        self._list.clear()
        for row in papers:
            item = QListWidgetItem(f"{row['title']}  [{row['source_id']}]")
            item.setData(Qt.ItemDataRole.UserRole, row["source_fk"])
            self._list.addItem(item)

    def _apply_filter(self, text: str) -> None:
        q = text.lower()
        filtered = [
            r for r in self._papers
            if q in r["title"].lower() or q in r["source_id"].lower()
        ] if q else self._papers
        self._populate(filtered)

    def _on_add(self) -> None:
        item = self._list.currentItem()
        if item is None:
            return
        paper_id = item.data(Qt.ItemDataRole.UserRole)
        self._project.add_paper(paper_id)
        self.accept()


# ── Clickable card base ───────────────────────────────────────────────────────

class _ClickableCard(QFrame):
    """QFrame that fires a callback on left-click (child widgets may still consume clicks)."""

    def __init__(self, on_click, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._on_click = on_click
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._on_click()
        super().mousePressEvent(event)


class _NoBarHorizontalScrollArea(QScrollArea):
    """Horizontal scroll area without visible scrollbars; supports wheel + drag."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._dragging = False
        self._drag_last_x = 0
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setCursor(Qt.CursorShape.OpenHandCursor)

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._dragging = True
            self._drag_last_x = int(event.position().x())
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._dragging:
            x = int(event.position().x())
            dx = x - self._drag_last_x
            self._drag_last_x = x
            bar = self.horizontalScrollBar()
            if bar is not None:
                bar.setValue(bar.value() - dx)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton and self._dragging:
            self._dragging = False
            self.setCursor(Qt.CursorShape.OpenHandCursor)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def wheelEvent(self, event) -> None:
        bar = self.horizontalScrollBar()
        delta = event.angleDelta().x() or event.angleDelta().y()
        if delta and bar is not None:
            bar.setValue(bar.value() - int(delta / 2))
            event.accept()
            return
        super().wheelEvent(event)


# ── Notes preview (Projects only) ─────────────────────────────────────────────
# Project notes used to embed MarkdownView (QWebEngineView). QWebEngine teardown while
# other WebEngine widgets (Graph, Search) stay alive reliably crashed on Linux and
# Windows after closing the notes dialog. Preview here is QTextBrowser + Qt Markdown
# (no KaTeX); storage is still plain Markdown text.

def _note_card_markdown(title: str, body: str) -> str:
    t = (title or "").strip() or "Untitled"
    return f"### {t}\n\n{body or ''}"


def _make_notes_qtext_preview(parent: QWidget | None) -> QTextBrowser:
    br = QTextBrowser(parent)
    br.setFrameShape(QFrame.Shape.NoFrame)
    br.setOpenExternalLinks(True)
    br.setStyleSheet(f"""
        QTextBrowser {{
            background: {BG}; border: none; color: {TEXT};
            font-size: {FONT_BODY}px; padding: 0;
        }}
    """)
    return br


# ── Note editor dialog (add + edit, with live Markdown preview) ───────────────

class NoteEditorDialog(QDialog):
    """Split-pane note editor: raw Markdown editor + QTextBrowser preview (no WebEngine).

    Add mode:  NoteEditorDialog(source_fk=..., project_id=..., parent=...)
    Edit mode: NoteEditorDialog(note=..., parent=...)
    """

    def __init__(
        self,
        *,
        note=None,
        source_fk: int | None = None,
        project_id: int | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._note       = note
        self._source_fk  = note.source_fk  if note else source_fk
        self._project_id = note.project_id if note else project_id

        mode = "Edit Note" if note else "Add Note"
        self.setWindowTitle(mode)
        self.setMinimumSize(920, 540)
        self.setStyleSheet(f"background: {PANEL}; color: {TEXT};")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(DIALOG_PAD, DIALOG_PAD, DIALOG_PAD, DIALOG_PAD)
        lay.setSpacing(SPACE_MD)

        heading = QLabel(mode)
        heading.setStyleSheet(f"font-size: {FONT_HEADING}px; font-weight: bold; color: {ACCENT};")
        lay.addWidget(heading)

        self._note_title = QLineEdit()
        self._note_title.setPlaceholderText("Title  (optional)")
        self._note_title.setStyleSheet(_INPUT_STYLE)
        if note:
            self._note_title.setText(note.title or "")
        lay.addWidget(self._note_title)

        # Split pane: raw editor | rendered preview
        self._splitter = QSplitter(Qt.Orientation.Horizontal)
        self._splitter.setStyleSheet("QSplitter::handle { background: #2e2e50; width: 2px; }")

        self._editor = QPlainTextEdit()
        self._editor.setPlaceholderText("Markdown supported (preview uses Qt rich text, not KaTeX)…")
        self._editor.setStyleSheet(f"""
            QPlainTextEdit {{
                background: {BG}; border: 1px solid {BORDER}; border-radius: {RADIUS_MD}px;
                color: {TEXT}; font-size: {FONT_BODY}px; padding: {SPACE_SM}px 10px;
                font-family: 'Cascadia Code', 'Courier New', monospace;
            }}
            QPlainTextEdit:focus {{ border-color: {ACCENT}; }}
        """)
        if note:
            self._editor.setPlainText(note.content or "")
        self._splitter.addWidget(self._editor)

        self._preview = _make_notes_qtext_preview(self)
        self._preview.setMarkdown(
            _note_card_markdown(self._note_title.text(), self._editor.toPlainText())
        )
        self._splitter.addWidget(self._preview)
        self._splitter.setSizes([460, 460])

        lay.addWidget(self._splitter, stretch=1)

        self._note_title.textChanged.connect(self._refresh_note_preview)
        self._editor.textChanged.connect(self._refresh_note_preview)

        btn_row = QHBoxLayout()
        cancel = QPushButton("Cancel")
        cancel.setStyleSheet(_BTN_MUTED_STYLE)
        cancel.clicked.connect(self.reject)
        save_btn = QPushButton("Save Note")
        save_btn.setStyleSheet(_BTN_STYLE)
        save_btn.clicked.connect(self._on_save)
        btn_row.addWidget(cancel)
        btn_row.addStretch()
        btn_row.addWidget(save_btn)
        lay.addLayout(btn_row)

    def _refresh_note_preview(self, *_args: object) -> None:
        self._preview.setMarkdown(
            _note_card_markdown(self._note_title.text(), self._editor.toPlainText())
        )

    def _on_save(self) -> None:
        import service.note as note_svc
        if self._note is not None:
            note_svc.upsert(note_svc.NoteIn(
                note_id    = self._note.note_id,
                source_fk  = self._note.source_fk,
                paper_id   = self._note.paper_id_fk,
                project_fk = self._note.project_id,
                title      = self._note_title.text().strip(),
                content    = self._editor.toPlainText().strip(),
            ))
        else:
            if self._source_fk is None:
                return
            note_svc.upsert(note_svc.NoteIn(
                source_fk  = self._source_fk,
                project_fk = self._project_id,
                title      = self._note_title.text().strip(),
                content    = self._editor.toPlainText().strip(),
            ))
        self.accept()



# ── Notes viewer dialog ───────────────────────────────────────────────────────

class NotesDialog(QDialog):
    """Shows all notes for a paper in a project, with add and delete actions."""

    def __init__(self, source_fk: int, project_id: int, paper_title: str,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._source_fk  = source_fk
        self._project_id = project_id
        self._cards: dict[int, QFrame] = {}
        self._retired_cards: list[QWidget] = []
        self.setWindowTitle("Notes")
        self.setFixedSize(560, 520)
        self.setStyleSheet(f"background: {PANEL}; color: {TEXT};")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, DIALOG_PAD, 24, DIALOG_PAD)
        lay.setSpacing(SPACE_MD)

        header_row = QHBoxLayout()
        title_lbl = QLabel("Notes")
        title_lbl.setStyleSheet(f"font-size: {FONT_HEADING}px; font-weight: bold; color: {ACCENT};")
        paper_lbl = QLabel(paper_title)
        paper_lbl.setStyleSheet(f"font-size: {FONT_TERTIARY}px; color: {MUTED};")
        paper_lbl.setWordWrap(True)
        header_col = QVBoxLayout()
        header_col.setSpacing(2)
        header_col.addWidget(title_lbl)
        header_col.addWidget(paper_lbl)
        header_row.addLayout(header_col, stretch=1)

        add_btn = QPushButton("＋  Add Note")
        add_btn.setStyleSheet(_BTN_STYLE)
        add_btn.setFixedHeight(BTN_H_LG)
        add_btn.clicked.connect(self._on_add)
        header_row.addWidget(add_btn, alignment=Qt.AlignmentFlag.AlignBottom)
        lay.addLayout(header_row)

        # Scrollable notes list
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent;")

        self._notes_widget = QWidget()
        self._notes_widget.setStyleSheet("background: transparent;")
        self._notes_layout = QVBoxLayout(self._notes_widget)
        self._notes_layout.setContentsMargins(0, 0, 0, 0)
        self._notes_layout.setSpacing(10)
        self._notes_layout.addStretch()
        scroll.setWidget(self._notes_widget)
        lay.addWidget(scroll)

        self._empty_lbl = QLabel("No notes yet.")
        self._empty_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_lbl.setStyleSheet(f"font-size: {FONT_BODY}px; color: {MUTED};")
        lay.addWidget(self._empty_lbl)

        close_btn = QPushButton("Close")
        close_btn.setStyleSheet(_BTN_MUTED_STYLE)
        close_btn.clicked.connect(self.accept)
        lay.addWidget(close_btn, alignment=Qt.AlignmentFlag.AlignRight)

        self._rebuild()

    def _rebuild(self) -> None:
        while self._notes_layout.count() > 1:
            item = cast(QLayoutItem, self._notes_layout.takeAt(0))
            w = item.widget()
            if w is not None:
                self._retire_card(w)
        self._cards.clear()

        import service.note as note_svc
        notes = note_svc.get_notes(note_svc.Notes(source_fk=self._source_fk, project_fk=self._project_id))

        if notes:
            self._empty_lbl.setVisible(False)
            for note in notes:
                card = NoteCard(self, note, {}, on_delete=lambda n=note: self._delete_note(n))
                self._notes_layout.insertWidget(self._notes_layout.count() - 1, card)
                if note.note_id is not None:
                    self._cards[note.note_id] = card
        else:
            self._empty_lbl.setVisible(True)

    def _retire_card(self, card: QWidget) -> None:
        """Hide card and keep it alive as a dialog child until closeEvent."""
        self._notes_layout.removeWidget(card)
        card.setParent(self)
        card.hide()
        self._retired_cards.append(card)

    def closeEvent(self, event: QCloseEvent) -> None:
        # Tear down note cards while this dialog still exists (orderly widget cleanup).
        while self._notes_layout.count() > 1:
            item = cast(QLayoutItem, self._notes_layout.takeAt(0))
            w = item.widget()
            if w is not None:
                self._retire_card(w)
        for card in self._retired_cards:
            card.deleteLater()
        self._retired_cards.clear()
        self._cards.clear()
        super().closeEvent(event)

    def _pop_and_recreate(self, note) -> None:
        note_id = note.note_id
        old_card = self._cards.pop(note_id, None) if note_id is not None else None
        if old_card is not None:
            idx = self._notes_layout.indexOf(old_card)
            self._retire_card(old_card)
        else:
            idx = self._notes_layout.count() - 1
        card = NoteCard(self, note, {}, on_delete=lambda n=note: self._delete_note(n))
        self._notes_layout.insertWidget(idx, card)
        if note_id is not None:
            self._cards[note_id] = card

    def _edit_note(self, note) -> None:
        dlg = NoteEditorDialog(note=note, parent=self.window() or self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._pop_and_recreate(note)

    def _delete_note(self, note) -> None:
        import service.note as note_svc
        note_id = note.note_id
        note_svc.delete(note_svc.Note(note_id=note_id))
        card = self._cards.pop(note_id, None) if note_id is not None else None
        if card is not None:
            self._retire_card(card)
            if self._notes_layout.count() <= 1:
                self._empty_lbl.setVisible(True)

    def _on_add(self) -> None:
        dlg = NoteEditorDialog(
            source_fk=self._source_fk, project_id=self._project_id, parent=self.window() or self
        )
        if dlg.exec() == QDialog.DialogCode.Accepted:
            import service.note as note_svc
            notes = note_svc.get_notes(note_svc.Notes(source_fk=self._source_fk, project_fk=self._project_id))
            new_notes = [n for n in notes if n.note_id not in self._cards]
            self._empty_lbl.setVisible(False)
            for note in new_notes:
                card = NoteCard(self, note, {}, on_delete=lambda n=note: self._delete_note(n))
                self._notes_layout.insertWidget(self._notes_layout.count() - 1, card)
                if note.note_id is not None:
                    self._cards[note.note_id] = card


# ── Trash row (compact, no click-to-open) ────────────────────────────────────

class _TrashRow(QFrame):
    def __init__(self, project, on_restore, on_hard_delete, parent=None) -> None:
        super().__init__(parent)
        self._confirming = False
        self._on_hard_delete = on_hard_delete
        self.setFixedHeight(36)
        self.setStyleSheet(
            f"QFrame {{ background: {PANEL}; border: 1px solid {BORDER};"
            f" border-radius: {RADIUS_SM}px; }}"
            f" QLabel {{ border: none; background: transparent; }}"
        )

        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 0, 8, 0)
        lay.setSpacing(8)

        name_lbl = ElidedLabel(project.name)
        name_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {MUTED};")
        lay.addWidget(name_lbl, stretch=1)

        restore_btn = QPushButton("Restore")
        restore_btn.setFixedHeight(24)
        restore_btn.setStyleSheet(_BTN_MUTED_STYLE)
        restore_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        restore_btn.clicked.connect(on_restore)
        lay.addWidget(restore_btn)

        self._del_btn = QPushButton("Delete forever")
        self._del_btn.setFixedHeight(24)
        self._del_btn.setStyleSheet(_BTN_DANGER)
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


# ── Project detail view ───────────────────────────────────────────────────────

class ProjectDetailView(QWidget):
    back_requested    = pyqtSignal()
    navigate_to_paper = pyqtSignal(int)   # source_fk

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setStyleSheet(f"background: {BG}; color: {TEXT};")
        self._project = None
        self._selected_pids: set[int] = set()
        self._pdf_worker: _PdfMetadataWorker | None = None
        self._pdf_window = PdfWindow(self)
        self._pdf_queue:  list[str] = []
        self._pdf_total  = 0
        self._pdf_added  = 0
        self._pdf_skipped = 0
        self._pdf_failed  = 0

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        content = QWidget()
        content.setStyleSheet(f"background: {BG};")
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(PAGE_MARGIN_H, 32, PAGE_MARGIN_H, 32)
        content_layout.setSpacing(0)
        outer.addWidget(content, stretch=1)

        # Header
        header = QHBoxLayout()
        header.setSpacing(16)

        back_btn = QPushButton("← Back")
        back_btn.setStyleSheet(_BTN_MUTED_STYLE)
        back_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        back_btn.setFixedWidth(90)
        back_btn.clicked.connect(self.back_requested)
        header.addWidget(back_btn)

        self._color_stripe = QWidget()
        self._color_stripe.setFixedSize(6, 36)
        self._color_stripe.setStyleSheet(f"background: {ACCENT}; border-radius: 3px;")
        header.addWidget(self._color_stripe, alignment=Qt.AlignmentFlag.AlignVCenter)

        self._title_lbl = QLabel()
        self._title_lbl.setStyleSheet(
            f"font-size: 28px; font-weight: bold; color: {TEXT}; background: transparent;"
        )
        self._title_lbl.setWordWrap(False)
        self._title_lbl.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)
        self._title_lbl.setMinimumWidth(0)

        # Keep long titles accessible in narrow windows via horizontal scrolling.
        self._title_scroll = _NoBarHorizontalScrollArea()
        self._title_scroll.setWidget(self._title_lbl)
        self._title_scroll.setWidgetResizable(False)
        self._title_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self._title_scroll.setStyleSheet("QScrollArea { background: transparent; border: none; }")
        self._title_scroll.setMinimumWidth(0)
        self._title_scroll.setFixedHeight(max(self._title_lbl.sizeHint().height(), 36))
        self._title_scroll.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        header.addWidget(self._title_scroll, stretch=1, alignment=Qt.AlignmentFlag.AlignVCenter)

        self._readonly_badge = QLabel("Read-only")
        self._readonly_badge.setStyleSheet(
            f"font-size: {FONT_TERTIARY}px; color: {MUTED}; background: {PANEL};"
            f" border: 1px solid {BORDER}; border-radius: {RADIUS_SM}px;"
            f" padding: 2px 8px;"
        )
        self._readonly_badge.setVisible(False)
        header.addWidget(self._readonly_badge, alignment=Qt.AlignmentFlag.AlignVCenter)

        self._archive_btn = QPushButton("Archive")
        self._archive_btn.setStyleSheet(_BTN_MUTED_STYLE)
        self._archive_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._archive_btn.setFixedHeight(BTN_H_MD)
        self._archive_btn.clicked.connect(self._on_archive)
        header.addWidget(self._archive_btn)

        self._delete_btn = QPushButton("Delete")
        self._delete_btn.setStyleSheet(_BTN_DANGER)
        self._delete_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._delete_btn.setFixedHeight(BTN_H_MD)
        self._delete_btn.clicked.connect(self._on_delete)
        self._delete_confirming = False
        header.addWidget(self._delete_btn)

        content_layout.addLayout(header)
        content_layout.addSpacing(16)

        # Meta (description + tags): bounded height so huge text cannot stress layout on resize.
        self._desc_scroll = QScrollArea()
        self._desc_scroll.setWidgetResizable(True)
        self._desc_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self._desc_scroll.setMaximumHeight(_PROJECT_DESC_VIEWPORT_MAX_H)
        self._desc_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._desc_scroll.setStyleSheet("QScrollArea { background: transparent; border: none; }")

        self._desc_lbl = QLabel()
        self._desc_lbl.setWordWrap(True)
        self._desc_lbl.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        self._desc_lbl.setStyleSheet(f"font-size: {FONT_BODY}px; color: {MUTED}; background: transparent;")
        content_layout.addWidget(self._desc_lbl)
        self._desc_scroll.setWidget(self._desc_lbl)
        content_layout.addWidget(self._desc_scroll)

        self._tags_lbl = QLabel()
        self._tags_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {ACCENT}; background: transparent;")
        content_layout.addWidget(self._tags_lbl)
        content_layout.addSpacing(SPACE_LG)

        # Papers section header
        papers_header = QHBoxLayout()
        self._papers_lbl = QLabel("Papers")
        self._papers_lbl.setStyleSheet(
            f"font-size: 16px; font-weight: 600; color: {TEXT}; background: transparent;"
        )
        self._add_paper_btn = QPushButton("＋  Add Paper")
        self._add_paper_btn.setStyleSheet(_BTN_STYLE)
        self._add_paper_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._add_paper_btn.setFixedHeight(BTN_H_LG)
        self._add_paper_btn.clicked.connect(self._on_add_paper)

        self._import_pdf_btn = QPushButton("Import PDF")
        self._import_pdf_btn.setStyleSheet(_BTN_MUTED_STYLE)
        self._import_pdf_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._import_pdf_btn.setFixedHeight(BTN_H_LG)
        self._import_pdf_btn.clicked.connect(self._on_import_pdf)

        papers_header.addWidget(self._papers_lbl)
        papers_header.addStretch()
        papers_header.addWidget(self._import_pdf_btn)
        papers_header.addWidget(self._add_paper_btn)
        content_layout.addLayout(papers_header)
        content_layout.addSpacing(10)

        # Scrollable papers list
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent;")

        self._papers_widget = QWidget()
        self._papers_widget.setStyleSheet("background: transparent;")
        self._papers_layout = QVBoxLayout(self._papers_widget)
        self._papers_layout.setContentsMargins(0, 0, 0, 0)
        self._papers_layout.setSpacing(SPACE_SM)
        self._papers_layout.addStretch()

        scroll.setWidget(self._papers_widget)
        content_layout.addWidget(scroll, stretch=1)

        self._empty_papers_lbl = QLabel("No papers yet — add one to get started.")
        self._empty_papers_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_papers_lbl.setStyleSheet(
            f"font-size: {FONT_BODY}px; color: {MUTED}; background: transparent;"
        )
        content_layout.addWidget(self._empty_papers_lbl)

        self._paper_action_bar = SelectionBar(show_remove=True, parent=self)
        self._paper_action_bar.download_requested.connect(self._on_bulk_download)
        self._paper_action_bar.add_to_project_requested.connect(self._on_add_to_project)
        self._paper_action_bar.remove_from_project_requested.connect(self._remove_selected_papers)
        self._paper_action_bar.clear_requested.connect(self._clear_paper_selection)
        outer.addWidget(self._paper_action_bar)

    def refresh_styles(self) -> None:
        self.setStyleSheet(f"background: {_theme.BG}; color: {_theme.TEXT};")
        self._title_lbl.setStyleSheet(
            f"font-size: {FONT_TITLE}px; font-weight: bold; color: {_theme.TEXT}; background: transparent;"
        )
        self._desc_lbl.setStyleSheet(f"font-size: {FONT_BODY}px; color: {_theme.MUTED}; background: transparent;")
        self._tags_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {_theme.ACCENT}; background: transparent;")
        self._papers_lbl.setStyleSheet(f"font-size: {FONT_SUBHEADING}px; font-weight: 600; color: {_theme.TEXT}; background: transparent;")
        self._empty_papers_lbl.setStyleSheet(f"font-size: {FONT_BODY}px; color: {_theme.MUTED}; background: transparent;")
        self._readonly_badge.setStyleSheet(
            f"font-size: {FONT_TERTIARY}px; color: {_theme.MUTED}; background: {_theme.PANEL};"
            f" border: 1px solid {_theme.BORDER}; border-radius: {RADIUS_SM}px;"
            f" padding: 2px 8px;"
        )
        self._archive_btn.setStyleSheet(_qt_styles.BTN_MUTED)
        self._delete_btn.setStyleSheet(_qt_styles.BTN_DANGER)
        self._add_paper_btn.setStyleSheet(_qt_styles.BTN_PRIMARY)
        self._import_pdf_btn.setStyleSheet(_qt_styles.BTN_MUTED)

    def _is_readonly(self) -> bool:
        return self._project is not None and self._project.status == Status.ARCHIVED

    def load(self, project) -> None:
        self._project = project
        self._delete_confirming = False
        self._delete_btn.setText("Delete")

        archived = project.status == Status.ARCHIVED
        self._readonly_badge.setVisible(archived)
        self._archive_btn.setText("Unarchive" if archived else "Archive")
        self._add_paper_btn.setEnabled(not archived)
        self._add_paper_btn.setVisible(not archived)
        self._import_pdf_btn.setEnabled(not archived)
        self._import_pdf_btn.setVisible(not archived)
        self._paper_action_bar.setVisible(not archived)

        hex_color = project_svc.color_to_hex(project.color) if project.color is not None else ACCENT
        self._color_stripe.setStyleSheet(f"background: {hex_color}; border-radius: 3px;")
        self._title_lbl.setText(project.name)
        self._title_lbl.adjustSize()
        hbar = self._title_scroll.horizontalScrollBar()
        if hbar is not None:
            hbar.setValue(0)
        self._desc_lbl.setText(project.description)
        self._desc_lbl.setVisible(bool(project.description))
        self._tags_lbl.setText("  ".join(f"#{t}" for t in project.project_tags))
        self._tags_lbl.setVisible(bool(project.project_tags))

        self._rebuild_papers()

    def _rebuild_papers(self) -> None:
        self._selected_pids.clear()
        self._paper_action_bar.set_count(0)

        while self._papers_layout.count() > 1:
            item = cast(QLayoutItem, self._papers_layout.takeAt(0))
            w = item.widget()
            if w is not None:
                w.deleteLater()

        paper_ids = self._project.source_fks if self._project and self._project.source_fks else []
        self._papers_lbl.setText(f"Papers  ({len(paper_ids)})")

        if paper_ids:
            assert self._project is not None  # paper_ids is non-empty only when _project is set
            self._empty_papers_lbl.setVisible(False)
            rendered_count = 0
            for pid in paper_ids:
                source_id = paper_svc.get_source_id(pid)
                if source_id is None:
                    continue
                row = paper_svc.get_paper(source_id)
                if row is None:
                    continue
                rendered_count += 1
                card = PaperCard(row, pdf_window=self._pdf_window, project_id=self._project.id)
                card.double_clicked.connect(
                    lambda r: self.navigate_to_paper.emit(r["source_fk"])
                )
                if not self._is_readonly():
                    card.selection_toggled.connect(self._on_card_selection_toggled)
                self._papers_layout.insertWidget(self._papers_layout.count() - 1, card)
            self._papers_lbl.setText(f"Papers  ({rendered_count})")
        else:
            self._empty_papers_lbl.setVisible(True)

    def _on_card_selection_toggled(self, source_fk: int, selected: bool) -> None:
        if selected:
            self._selected_pids.add(source_fk)
        else:
            self._selected_pids.discard(source_fk)
        self._paper_action_bar.set_count(len(self._selected_pids))

    def _clear_paper_selection(self) -> None:
        self._selected_pids.clear()
        for i in range(self._papers_layout.count() - 1):
            item = self._papers_layout.itemAt(i)
            if item is None:
                continue
            w = item.widget()
            if isinstance(w, PaperCard):
                w.set_selected(False)
        self._paper_action_bar.set_count(0)

    def _remove_selected_papers(self) -> None:
        if self._project is None or not self._selected_pids:
            return
        for source_fk in list(self._selected_pids):
            self._project.remove_paper(source_fk)
        self._rebuild_papers()

    def _on_bulk_download(self) -> None:
        for i in range(self._papers_layout.count() - 1):
            item = self._papers_layout.itemAt(i)
            if item is None:
                continue
            w = item.widget()
            if isinstance(w, PaperCard) and w.paper_id() in self._selected_pids:
                w.start_download_if_needed()
    #TODO: move to QT assets, too many imports for this spot
    def _on_add_to_project(self) -> None:
        if not self._selected_pids:
            return
        
        projects = filter_projects(Q("status = 'active'"))
        if not projects:
            QMessageBox.information(self, "No Projects", "Create a project first.")
            return

        dlg = QDialog(self)
        dlg.setWindowTitle("Add to Project")
        dlg.setStyleSheet(f"background: {BG}; color: {TEXT};")
        lay = QVBoxLayout(dlg)
        lay.setContentsMargins(DIALOG_PAD, CARD_PAD_V, DIALOG_PAD, CARD_PAD_V)
        lay.setSpacing(SPACE_MD)

        lay.addWidget(QLabel(f"Add {len(self._selected_pids)} paper(s) to:"))
        combo = QComboBox()
        combo.setStyleSheet(f"""
            QComboBox {{ background: {PANEL}; border: 1px solid {BORDER};
                border-radius: {RADIUS_SM}px; color: {TEXT}; padding: 4px 8px; font-size: {FONT_BODY}px; }}
        """)
        for p in projects:
            combo.addItem(p.name, userData=p)
        lay.addWidget(combo)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        btns.accepted.connect(dlg.accept)
        btns.rejected.connect(dlg.reject)
        lay.addWidget(btns)

        if dlg.exec() != QDialog.DialogCode.Accepted:
            return

        project = combo.currentData()
        for pid in self._selected_pids:
            try:
                project.add_paper(pid)
            except Exception:
                pass

    def _on_add_paper(self) -> None:
        if self._project is None:
            return
        dlg = AddPaperDialog(self._project, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._rebuild_papers()

    def _on_import_pdf(self) -> None:
        if self._project is None:
            return
        paths, _ = QFileDialog.getOpenFileNames(self, "Import PDFs", "", "PDF Files (*.pdf)")
        if not paths:
            return
        self._pdf_queue   = list(paths)
        self._pdf_total   = len(paths)
        self._pdf_added   = 0
        self._pdf_skipped = 0
        self._pdf_failed  = 0
        self._import_pdf_btn.setEnabled(False)
        self._start_next_pdf()

    def _start_next_pdf(self) -> None:
        idx = self._pdf_total - len(self._pdf_queue) + 1
        self._import_pdf_btn.setText(f"Resolving {idx}/{self._pdf_total}…")
        path = self._pdf_queue[0]
        self._pdf_worker = _PdfMetadataWorker(path)
        self._pdf_worker.finished.connect(self._on_pdf_metadata_done)
        self._pdf_worker.failed.connect(self._on_pdf_metadata_failed)
        self._pdf_worker.start()

    def _on_pdf_metadata_done(self, meta, path: str) -> None:
        self._pdf_queue.pop(0)
        if self._project is None:
            if not self._pdf_queue:
                self._finish_pdf_import()
            else:
                self._start_next_pdf()
            return
        existing = paper_svc.get_paper(meta.source_id)
        if existing is None:
            paper_svc.save_papers_metadata([meta])
            self._pdf_added += 1
        else:
            self._pdf_skipped += 1
        paper_svc.set_pdf_path(meta.source_id, path)
        paper_svc.set_has_pdf(meta.source_id, meta.version, True)
        root = paper_svc.get_paper_root(meta.source_id)
        if root is not None:
            try:
                self._project.add_paper(int(root["SOURCE_FK"]))
            except Exception:
                pass
        if self._pdf_queue:
            self._start_next_pdf()
        else:
            self._rebuild_papers()
            self._finish_pdf_import()

    def _on_pdf_metadata_failed(self, _err: str) -> None:
        self._pdf_queue.pop(0)
        self._pdf_failed += 1
        if self._pdf_queue:
            self._start_next_pdf()
        else:
            self._finish_pdf_import()

    def _finish_pdf_import(self) -> None:
        self._import_pdf_btn.setEnabled(True)
        self._import_pdf_btn.setText("Import PDF")
        parts = []
        if self._pdf_added:
            parts.append(f"Added {self._pdf_added} paper(s).")
        if self._pdf_skipped:
            parts.append(f"{self._pdf_skipped} already in library (added to project).")
        if self._pdf_failed:
            parts.append(f"{self._pdf_failed} failed to resolve.")
        QMessageBox.information(self, "Import Complete", "  ".join(parts) or "Nothing imported.")

    def _on_archive(self) -> None:
        if self._project is None:
            return
        fk = project_svc.Project(project_fk=self._project.id)
        if self._project.status == Status.ARCHIVED:
            project_svc.restore(fk)
        else:
            project_svc.archive(fk)
        self.back_requested.emit()

    def _on_delete(self) -> None:
        if self._project is None:
            return
        if not self._delete_confirming:
            self._delete_confirming = True
            self._delete_btn.setText("⚠ Confirm delete?")
        else:
            self._delete_confirming = False
            self._delete_btn.setText("Delete")
            project_svc.delete(project_svc.Project(project_fk=self._project.id))
            self.back_requested.emit()


# ── Project card ──────────────────────────────────────────────────────────────

class ProjectCard(QFrame):
    clicked = pyqtSignal(object)   # emits the Project

    def __init__(self, project, archived: bool = False, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._project = project
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        border_col = MUTED if archived else BORDER
        self.setStyleSheet(f"""
            QFrame {{
                background: {PANEL}; border: 1px solid {border_col}; border-radius: {RADIUS_LG}px;
            }}
            QLabel {{ border: none; background: transparent; }}
        """)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 16, 0)
        outer.setSpacing(0)

        stripe = QWidget()
        stripe.setFixedWidth(6)
        hex_color = project_svc.color_to_hex(project.color) if project.color is not None else ACCENT
        stripe.setStyleSheet(f"background: {hex_color}; border-radius: 10px 0 0 10px;")
        outer.addWidget(stripe)

        inner = QVBoxLayout()
        inner.setContentsMargins(CARD_PAD_H, CARD_PAD_V, 0, CARD_PAD_V)
        inner.setSpacing(SPACE_XS)

        name_lbl = QLabel(project.name)
        name_lbl.setStyleSheet(f"font-size: {FONT_SUBHEADING}px; font-weight: 600; color: {TEXT};")
        inner.addWidget(name_lbl)

        if project.description:
            desc_lbl = ElidedLabel(project.description)
            desc_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {MUTED};")
            inner.addWidget(desc_lbl)

        stats_row = QHBoxLayout()
        stats_row.setSpacing(SPACE_MD)
        stats_row.setContentsMargins(0, SPACE_XS, 0, 0)

        if not archived:
            paper_count = project.paper_count
            note_count = self._note_count(project)
            for icon, value, lbl_text in [
                ("📄", paper_count, "paper" if paper_count == 1 else "papers"),
                ("📝", note_count,  "note"  if note_count  == 1 else "notes"),
            ]:
                lbl = QLabel(f"{icon} {value} {lbl_text}")
                lbl.setStyleSheet(f"font-size: {FONT_TERTIARY}px; color: {MUTED};")
                stats_row.addWidget(lbl)

        if project.project_tags:
            tags_lbl = QLabel("  ".join(f"#{t}" for t in project.project_tags))
            tags_lbl.setStyleSheet(f"font-size: {FONT_TERTIARY}px; color: {ACCENT};")
            stats_row.addWidget(tags_lbl)

        stats_row.addStretch()
        inner.addLayout(stats_row)
        outer.addLayout(inner)

    def _note_count(self, project) -> int:
        if project.id is None:
            return 0
        try:
            return count_project_notes(project.id)
        except Exception:
            return 0

    def mousePressEvent(self, event) -> None:
        self.clicked.emit(self._project)
        super().mousePressEvent(event)


# ── Projects page ─────────────────────────────────────────────────────────────

class ProjectsPage(QWidget):
    navigate_to_paper = pyqtSignal(int)   # source_fk — bubbled from ProjectDetailView

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setStyleSheet(f"background: {BG}; color: {TEXT};")
        self._app_shell: AppShell | None = None
        self._library_page: LibraryPage | None = None
        self._project_detail_prior_shell_tab = False
        self._return_to_library_paper_id: int | None = None
        self._trash_expanded = False

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        self._inner = QStackedWidget()
        self._list_page_widget = self._build_list_page()
        self._inner.addWidget(self._list_page_widget)   # index 0

        self._detail_view = ProjectDetailView()
        self._detail_view.back_requested.connect(self._on_back)
        self._detail_view.navigate_to_paper.connect(self.navigate_to_paper)
        self._inner.addWidget(self._detail_view)          # index 1

        outer.addWidget(self._inner)
        self._refresh()

    def attach_app_shell(self, shell: AppShell) -> None:
        self._app_shell = shell

    def attach_library_page(self, library_page: LibraryPage) -> None:
        self._library_page = library_page

    def show_project_list(self) -> None:
        """Show the project list when returning to the Projects tab from elsewhere."""
        self._project_detail_prior_shell_tab = False
        self._return_to_library_paper_id = None
        self._inner.setCurrentIndex(0)

    def refresh_styles(self) -> None:
        self.setStyleSheet(f"background: {_theme.BG}; color: {_theme.TEXT};")
        self._list_page_widget.setStyleSheet(f"background: {_theme.BG};")
        self._proj_title_lbl.setStyleSheet(
            f"font-size: {FONT_TITLE}px; font-weight: bold; color: {_theme.ACCENT}; background: transparent;"
        )
        self._proj_subtitle_lbl.setStyleSheet(
            f"font-size: {FONT_BODY}px; color: {_theme.MUTED}; background: transparent;"
        )
        self._add_proj_btn.setStyleSheet(_qt_styles.BTN_PRIMARY)
        self._refresh_proj_btn.setStyleSheet(_qt_styles.BTN_MUTED)
        self._empty_lbl.setStyleSheet(
            f"font-size: {FONT_BODY}px; color: {_theme.MUTED}; background: transparent;"
        )
        self._detail_view.refresh_styles()
        self._refresh()

    # ── List page ─────────────────────────────────────────────────────────────

    def _build_list_page(self) -> QWidget:
        page = QWidget()
        page.setStyleSheet(f"background: {BG};")
        outer = QVBoxLayout(page)
        outer.setContentsMargins(PAGE_MARGIN_H, 40, PAGE_MARGIN_H, 40)
        outer.setSpacing(0)

        header = QHBoxLayout()
        col = QVBoxLayout()
        col.setSpacing(SPACE_XS)
        self._proj_title_lbl = title = QLabel("Projects")
        title.setStyleSheet(
            f"font-size: {FONT_TITLE}px; font-weight: bold; color: {ACCENT}; background: transparent;"
        )
        self._proj_subtitle_lbl = subtitle = QLabel("Organise papers into focused reading projects")
        subtitle.setStyleSheet(f"font-size: {FONT_BODY}px; color: {MUTED}; background: transparent;")
        col.addWidget(title)
        col.addWidget(subtitle)

        self._add_proj_btn = add_btn = QPushButton("＋  New Project")
        add_btn.setFixedSize(160, 40)
        add_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        add_btn.setStyleSheet(_BTN_STYLE)
        add_btn.clicked.connect(self._on_add)

        self._refresh_proj_btn = refresh_btn = QPushButton("Refresh")
        refresh_btn.setFixedHeight(40)
        refresh_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        refresh_btn.setStyleSheet(_BTN_MUTED_STYLE)
        refresh_btn.clicked.connect(self._refresh)

        header.addLayout(col)
        header.addStretch()
        header.addWidget(refresh_btn, alignment=Qt.AlignmentFlag.AlignBottom)
        header.addSpacing(SPACE_SM)
        header.addWidget(add_btn, alignment=Qt.AlignmentFlag.AlignBottom)
        outer.addLayout(header)
        outer.addSpacing(SPACE_XL)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent;")

        self._list_widget = QWidget()
        self._list_widget.setStyleSheet("background: transparent;")
        self._list_layout = QVBoxLayout(self._list_widget)
        self._list_layout.setContentsMargins(0, 0, 0, 0)
        self._list_layout.setSpacing(SPACE_MD)
        self._list_layout.addStretch()

        self._trash_toggle_btn = QPushButton("Trash (0)")
        self._trash_toggle_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._trash_toggle_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; border: none; text-align: left;"
            f" font-size: {FONT_SECONDARY}px; color: {MUTED}; padding: {SPACE_SM}px 0px; }}"
            f" QPushButton:hover {{ color: {TEXT}; }}"
        )
        self._trash_toggle_btn.setVisible(False)
        self._trash_toggle_btn.clicked.connect(self._toggle_trash)
        self._list_layout.addWidget(self._trash_toggle_btn)

        self._trash_container = QWidget()
        self._trash_container.setStyleSheet("background: transparent;")
        self._trash_cl = QVBoxLayout(self._trash_container)
        self._trash_cl.setContentsMargins(0, 0, 0, 0)
        self._trash_cl.setSpacing(4)
        self._trash_container.setVisible(False)
        self._list_layout.addWidget(self._trash_container)

        scroll.setWidget(self._list_widget)
        outer.addWidget(scroll, stretch=1)

        self._empty_lbl = QLabel("No projects yet — create one to get started.")
        self._empty_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_lbl.setStyleSheet(
            f"font-size: 14px; color: {MUTED}; background: transparent;"
        )
        outer.addWidget(self._empty_lbl)

        return page

    def _refresh(self) -> None:
        # Last 3 items are permanent: stretch, trash_toggle_btn, trash_container
        while self._list_layout.count() > 3:
            item = cast(QLayoutItem, self._list_layout.takeAt(0))
            w = item.widget()
            if w is not None:
                w.deleteLater()

        try:
            project_svc.ensure_projects_db()
            ensure_notes_db()
            active_projects   = filter_projects(Q("status = ?", Status.ACTIVE))
            archived_projects = filter_projects(Q("status = ?", Status.ARCHIVED))
            deleted_projects  = filter_projects(Q("status = ?", Status.DELETED))
        except Exception:
            active_projects = archived_projects = deleted_projects = []

        has_any = bool(active_projects or archived_projects)
        self._empty_lbl.setVisible(not has_any)

        # Insert before stretch (count - 3 = position just before stretch)
        for p in active_projects:
            card = ProjectCard(p)
            card.clicked.connect(self._open_project)
            self._list_layout.insertWidget(self._list_layout.count() - 3, card)

        if archived_projects:
            sep = QLabel("Archived")
            sep.setStyleSheet(
                f"font-size: {FONT_SECONDARY}px; color: {MUTED}; font-weight: 600;"
                f" padding-top: {SPACE_MD}px; background: transparent;"
            )
            self._list_layout.insertWidget(self._list_layout.count() - 3, sep)
            for p in archived_projects:
                card = ProjectCard(p, archived=True)
                card.clicked.connect(self._open_project)
                self._list_layout.insertWidget(self._list_layout.count() - 3, card)

        self._rebuild_trash(deleted_projects)

    def _rebuild_trash(self, deleted_projects) -> None:
        while self._trash_cl.count() > 0:
            item = self._trash_cl.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()

        count = len(deleted_projects)
        if count == 0:
            self._trash_toggle_btn.setVisible(False)
            self._trash_container.setVisible(False)
            return

        self._trash_toggle_btn.setVisible(True)
        indicator = "▲" if self._trash_expanded else "▼"
        self._trash_toggle_btn.setText(f"Trash ({count})  {indicator}")
        self._trash_container.setVisible(self._trash_expanded)

        for p in deleted_projects:
            row = _TrashRow(
                p,
                on_restore=lambda proj=p: self._on_trash_restore(proj),
                on_hard_delete=lambda proj=p: self._on_trash_hard_delete(proj),
            )
            self._trash_cl.addWidget(row)

    def _toggle_trash(self) -> None:
        self._trash_expanded = not self._trash_expanded
        self._trash_container.setVisible(self._trash_expanded)
        count = self._trash_cl.count()
        indicator = "▲" if self._trash_expanded else "▼"
        self._trash_toggle_btn.setText(f"Trash ({count})  {indicator}")

    def _on_trash_restore(self, project) -> None:
        project_svc.restore(project_svc.Project(project_fk=project.id))
        self._refresh()

    def _on_trash_hard_delete(self, project) -> None:
        project_svc.hard_delete(project_svc.Project(project_fk=project.id))
        self._refresh()

    # ── Navigation ────────────────────────────────────────────────────────────

    def open_project(
        self,
        project,
        *,
        opened_from_other_shell_tab: bool = False,
        return_to_library_paper_id: int | None = None,
    ) -> None:
        """Navigate directly to a project's detail view (callable from other pages).

        Set opened_from_other_shell_tab when opening from Library (etc.) so Back
        returns to the previous main tab. If return_to_library_paper_id is set, Back
        also re-opens that paper's detail in Library.
        """
        self._project_detail_prior_shell_tab = opened_from_other_shell_tab
        self._return_to_library_paper_id = (
            return_to_library_paper_id if opened_from_other_shell_tab else None
        )
        self._detail_view.load(project)
        self._inner.setCurrentIndex(1)

    def _open_project(self, project) -> None:
        self.open_project(project, opened_from_other_shell_tab=False)

    def _on_back(self) -> None:
        prior_shell = self._project_detail_prior_shell_tab
        paper_id = self._return_to_library_paper_id
        self._project_detail_prior_shell_tab = False
        self._return_to_library_paper_id = None
        self._refresh()
        self._inner.setCurrentIndex(0)
        if prior_shell and self._app_shell is not None:
            self._app_shell.go_back()
            if paper_id and self._library_page is not None:
                lib = self._library_page
                QTimer.singleShot(0, lambda pid=paper_id, lp=lib: lp.show_paper_detail_by_id(pid))

    def _on_add(self) -> None:
        dlg = NewProjectDialog(self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._refresh()
