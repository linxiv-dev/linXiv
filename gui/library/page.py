from __future__ import annotations

import os

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QDialog,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QStackedWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from formats.bibtex import BibTeXFormat
from formats.csv_fmt import CSVFormat
from formats.json_fmt import JSONFormat
from formats.markdown import MarkdownFormat, ObsidianFormat
from service import paper as paper_svc
from service import project as project_svc
from service.project import Q, Status
import service.files as _files
from gui.qt_assets import PaperCard, SelectionBar, AddPaperManuallyDialog
from gui.qt_assets.note_card import NoteCard
from gui.qt_assets.paper_card import _DownloadWorker
from gui.shell import AppShell

_bibtex_fmt   = BibTeXFormat()
_csv_fmt      = CSVFormat()
_json_fmt     = JSONFormat()
_markdown_fmt = MarkdownFormat()
_obsidian_fmt = ObsidianFormat()
import gui.theme as _theme
from gui.theme import BG as _BG, PANEL as PANEL, BORDER as BORDER
from gui.theme import ACCENT as _ACCENT, TEXT as _TEXT, MUTED as _MUTED
from gui.theme import (
    FONT_TITLE, FONT_SUBHEADING, FONT_BODY, FONT_SECONDARY, FONT_TERTIARY,
    SPACE_XL, SPACE_LG, SPACE_MD, SPACE_SM, SPACE_XS,
    RADIUS_LG, RADIUS_MD, RADIUS_SM,
    BTN_H_MD, BTN_H_SM,
    PAGE_MARGIN_H, PAGE_MARGIN_V, CARD_PAD_H, CARD_PAD_V, DIALOG_PAD,
    NOTE_HEIGHT, ABSTRACT_HEIGHT,
)

_BLUE  = "#5b8dee"
_GREEN = "#4caf7d"
_RED   = "#e05c5c"

import gui.qt_assets.styles as _qt_styles
from gui.qt_assets.styles import (
    BTN_PANEL as _BTN, BTN_PRIMARY, BTN_LINK, BTN_GHOST, BTN_DANGER, BTN_FILTER_ACTIVE,
    btn_colored_outline,
)


class _PdfMetadataWorker(QThread):
    finished = pyqtSignal(object, str)   # PaperMetadata, pdf_path
    failed   = pyqtSignal(str)

    def __init__(self, pdf_path: str) -> None:
        super().__init__()
        self._path = pdf_path

    def run(self) -> None:
        from sources.pdf_metadata import resolve_pdf_metadata
        try:
            meta = resolve_pdf_metadata(self._path)
            self.finished.emit(meta, self._path)
        except Exception as e:
            self.failed.emit(str(e))


# ── Paper detail view ────────────────────────────────────────────────────────

class PaperDetailView(QWidget):
    back_requested       = pyqtSignal()
    navigate_to_project  = pyqtSignal(object)   # emits Project

    def __init__(self, pdf_window=None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._current_row = None
        self._pdf_window  = pdf_window
        self._pdf_btn:    QPushButton | None = None
        self._pdf_worker: _DownloadWorker | None = None
        self.setStyleSheet(f"background: {_BG}; color: {_TEXT};")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(PAGE_MARGIN_H, 32, PAGE_MARGIN_H, 24)
        outer.setSpacing(0)

        # Back button
        self._back_btn = back_btn = QPushButton("← Back")
        back_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        back_btn.setStyleSheet(BTN_LINK)
        back_btn.setFixedHeight(BTN_H_SM)
        back_btn.clicked.connect(self.back_requested)
        self._repair_btn = repair = QPushButton("Edit")
        repair.setCursor(Qt.CursorShape.PointingHandCursor)
        repair.setStyleSheet(BTN_PRIMARY)
        repair.setFixedHeight(BTN_H_SM)
        repair.clicked.connect(self._on_repair)

        self._pdf_btn = QPushButton("PDF")
        self._pdf_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._pdf_btn.setStyleSheet(_BTN)
        self._pdf_btn.setFixedHeight(BTN_H_SM)
        self._pdf_btn.clicked.connect(self._on_pdf_action)

        nav_row = QHBoxLayout()
        nav_row.setContentsMargins(0, 0, 0, 0)
        nav_row.setSpacing(SPACE_SM)
        nav_row.addWidget(back_btn)
        nav_row.addStretch()
        nav_row.addWidget(self._pdf_btn)
        nav_row.addWidget(repair)
        outer.addLayout(nav_row)
        outer.addSpacing(SPACE_LG)
        # Scroll area holds everything below the back button
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent;")

        self._body = QWidget()
        self._body.setStyleSheet("background: transparent;")
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 24)
        self._body_layout.setSpacing(0)

        scroll.setWidget(self._body)
        outer.addWidget(scroll, stretch=1)

    def refresh_styles(self) -> None:
        self.setStyleSheet(f"background: {_theme.BG}; color: {_theme.TEXT};")
        self._back_btn.setStyleSheet(_qt_styles.BTN_LINK)
        self._repair_btn.setStyleSheet(_qt_styles.BTN_PRIMARY)
        if self._pdf_btn:
            self._pdf_btn.setStyleSheet(_qt_styles.BTN_PANEL)

    def load(self, row) -> None:
        self._current_row = row
        # Clear previous content
        while self._body_layout.count():
            item = self._body_layout.takeAt(0)
            if item:
                widget = item.widget()
                if widget:
                    widget.deleteLater()

        source_id  = row["source_id"]
        source_fk = row["source_fk"]

        # ── Title ─────────────────────────────────────────────────────────────
        title_lbl = QLabel(row["title"] or "(untitled)")
        title_lbl.setWordWrap(True)
        title_lbl.setStyleSheet(
            f"font-size: 22px; font-weight: bold; color: {_TEXT}; background: transparent;"
        )
        self._body_layout.addWidget(title_lbl)
        self._body_layout.addSpacing(10)

        # ── Meta row ──────────────────────────────────────────────────────────
        authors: list[str] = row["authors"] or []
        auth_str = ", ".join(authors) if authors else "Unknown authors"
        date_str = row["published"].isoformat() if row["published"] else ""
        cat_str  = row["category"] or ""
        doi_str  = row["doi"] if "doi" in row.keys() else None

        meta_parts = [auth_str, date_str, cat_str]
        meta_lbl = QLabel("  ·  ".join(filter(None, meta_parts)))
        meta_lbl.setWordWrap(True)
        meta_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {_MUTED}; background: transparent;")
        self._body_layout.addWidget(meta_lbl)

        if doi_str:
            doi_lbl = QLabel(f"DOI: {doi_str}")
            doi_lbl.setStyleSheet(f"font-size: {FONT_TERTIARY}px; color: {_MUTED}; background: transparent;")
            self._body_layout.addWidget(doi_lbl)

        tags: list[str] = row["tags"] or []
        if tags:
            tags_lbl = QLabel("  ".join(f"#{t}" for t in tags))
            tags_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {_ACCENT}; background: transparent;")
            self._body_layout.addSpacing(SPACE_XS)
            self._body_layout.addWidget(tags_lbl)

        self._body_layout.addSpacing(SPACE_LG)

        # ── Abstract ──────────────────────────────────────────────────────────
        self._body_layout.addWidget(self._section_label("Abstract"))
        self._body_layout.addSpacing(SPACE_SM)

        summary = row["summary"] if "summary" in row.keys() else None
        if summary:
            from gui.views import MarkdownView
            md = MarkdownView()
            md.set_content(summary)
            md.setFixedHeight(ABSTRACT_HEIGHT)
            self._body_layout.addWidget(md)
        else:
            no_abs = QLabel("No abstract available.")
            no_abs.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {_MUTED}; background: transparent;")
            self._body_layout.addWidget(no_abs)

        self._body_layout.addSpacing(SPACE_XL)

        # ── Projects containing this paper ────────────────────────────────────
        self._body_layout.addWidget(self._section_label("Projects"))
        self._body_layout.addSpacing(SPACE_SM)

        try:
            from service.project import filter_projects
            from service.paper import get_paper_root
            root = get_paper_root(source_id)
            source_fk = int(root["SOURCE_FK"]) if root else None
            all_projects = filter_projects()
            containing = [p for p in all_projects
                          if source_fk and source_fk in p.source_fks
                          and p.status != Status.DELETED]
        except Exception:
            containing = []

        if containing:
            proj_row = QHBoxLayout()
            proj_row.setSpacing(SPACE_SM)
            proj_row.setContentsMargins(0, 0, 0, 0)
            for proj in containing:
                archived = proj.status.value == "archived"
                color    = _RED if archived else _BLUE
                chip     = QPushButton(proj.name)
                chip.setCursor(
                    Qt.CursorShape.ArrowCursor if archived
                    else Qt.CursorShape.PointingHandCursor
                )
                chip.setStyleSheet(f"""
                    QPushButton {{
                        background: #1e1e36; border: 1px solid {color};
                        border-radius: 12px; color: {color};
                        font-size: {FONT_SECONDARY}px; padding: 3px 12px;
                        {'text-decoration: underline;' if not archived else ''}
                    }}
                    QPushButton:hover {{
                        background: {'#2a1a1a' if archived else '#1a1f2e'};
                    }}
                """)
                if not archived:
                    chip.clicked.connect(
                        lambda _checked=False, p=proj: self.navigate_to_project.emit(p)
                    )
                proj_row.addWidget(chip)
            proj_row.addStretch()
            proj_widget = QWidget()
            proj_widget.setStyleSheet("background: transparent;")
            proj_widget.setLayout(proj_row)
            self._body_layout.addWidget(proj_widget)
        else:
            np_lbl = QLabel("Not in any project.")
            np_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {_MUTED}; background: transparent;")
            self._body_layout.addWidget(np_lbl)

        self._body_layout.addSpacing(SPACE_XL)

        # ── Notes ─────────────────────────────────────────────────────────────
        add_note_btn = QPushButton("+ Add Note")
        add_note_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        add_note_btn.setStyleSheet(_BTN)
        add_note_btn.setFixedHeight(BTN_H_SM)
        if source_fk:
            add_note_btn.clicked.connect(lambda: self._add_note(source_fk))
        else:
            add_note_btn.setEnabled(False)
        notes_hdr = QHBoxLayout()
        notes_hdr.setContentsMargins(0, 0, 0, 0)
        notes_hdr.addWidget(self._section_label("Notes"))
        notes_hdr.addStretch()
        notes_hdr.addWidget(add_note_btn)
        notes_hdr_w = QWidget()
        notes_hdr_w.setStyleSheet("background: transparent;")
        notes_hdr_w.setLayout(notes_hdr)
        self._body_layout.addWidget(notes_hdr_w)
        self._body_layout.addSpacing(SPACE_SM)

        try:
            import service.note as note_svc
            all_notes = note_svc.get_notes(note_svc.Notes(source_fk=source_fk))
        except Exception:
            all_notes = []

        if not all_notes:
            nn_lbl = QLabel("No notes for this paper yet.")
            nn_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {_MUTED}; background: transparent;")
            self._body_layout.addWidget(nn_lbl)
        else:
            # Build project name lookup
            proj_names: dict[int, str] = {}
            for p in (containing if containing else []):
                if p.id:
                    proj_names[p.id] = p.name
            # Also fetch any projects not already in containing (e.g. archived ones holding notes)
            note_proj_ids = {n.project_id for n in all_notes if n.project_id}
            missing_ids = note_proj_ids - set(proj_names)
            if missing_ids:
                try:
                    for pid in missing_ids:
                        p = project_svc.get_project_details(pid)
                        if p and p.id:
                            proj_names[p.id] = p.name
                except Exception:
                    pass

            for note in all_notes:
                self._body_layout.addWidget(
                    NoteCard(self, note, proj_names, on_delete=lambda n=note: self._delete_note(n))
                )
                self._body_layout.addSpacing(SPACE_SM)

        self._body_layout.addStretch()
        self._refresh_pdf_btn()

    def _on_repair(self) -> None:
        if self._current_row is None:
            return
        dlg = AddPaperManuallyDialog(self)
        dlg.setWindowTitle("Repair Paper")
        dlg.load_from_row(self._current_row)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        source_fk    = self._current_row["source_fk"]
        old_source_id = self._current_row["source_id"]
        try:
            meta = dlg.get_metadata(old_source_id)
            paper_svc.repair_paper(source_fk, meta)
            new_source_id = paper_svc.get_source_id(source_fk)
            if new_source_id:
                new_row = paper_svc.get_paper(new_source_id)
                if new_row:
                    self.load(new_row)
        except Exception as e:
            print(f"[repair] {e}")
            QMessageBox.critical(self, "Repair Failed", str(e))

    def get_current_source_fk(self) -> int | None:
        if self._current_row is None:
            return None
        return self._current_row["source_fk"]

    # ── PDF ───────────────────────────────────────────────────────────────────

    def _local_pdf_path(self) -> str | None:
        if self._current_row is None:
            return None
        custom = self._current_row["pdf_path"] if "pdf_path" in self._current_row.keys() else None
        return _files.pdf_path(self._current_row["source_id"], self._current_row["version"], custom)

    def _is_arxiv(self) -> bool:
        if self._current_row is None:
            return False
        src = self._current_row["source"] if "source" in self._current_row.keys() else None
        return (src or "arxiv") == "arxiv"

    def _refresh_pdf_btn(self) -> None:
        if self._pdf_btn is None:
            return
        path = self._local_pdf_path()
        if path:
            self._pdf_btn.setText("Open PDF")
            self._pdf_btn.setStyleSheet(btn_colored_outline("#4caf7d", hover_bg="#1a2e1f"))
        elif self._is_arxiv():
            self._pdf_btn.setText("Download PDF")
            self._pdf_btn.setStyleSheet(_BTN)
        else:
            self._pdf_btn.setText("Link PDF")
            self._pdf_btn.setStyleSheet(_BTN)

    def _on_pdf_action(self) -> None:
        path = self._local_pdf_path()
        if path:
            if self._pdf_window:
                self._pdf_window.load_pdf(path)
        elif self._is_arxiv():
            self._start_download()
        else:
            self._link_pdf()

    def _start_download(self) -> None:
        if self._pdf_btn is None or self._current_row is None:
            return
        self._pdf_btn.setText("Downloading…")
        self._pdf_btn.setEnabled(False)
        pid, sid, ver = self._current_row["source_id"], self._current_row["source_id"], self._current_row["version"]
        self._pdf_worker = _DownloadWorker(pid, sid, ver)
        self._pdf_worker.finished.connect(self._on_download_done)
        self._pdf_worker.failed.connect(self._on_download_failed)
        self._pdf_worker.rate_limited.connect(self._on_download_rate_limited)
        self._pdf_worker.start()

    def _on_download_done(self, source_id: str, version: int, path: str) -> None:
        paper_svc.set_pdf_path(source_id, path)
        paper_svc.set_has_pdf(source_id, version, True)
        if self._pdf_btn:
            self._pdf_btn.setEnabled(True)
        self._refresh_pdf_btn()
        if self._pdf_window:
            self._pdf_window.load_pdf(path)

    def _on_download_rate_limited(self, _pid: str, _ver: int) -> None:
        if self._pdf_btn:
            self._pdf_btn.setText("Rate limited — retrying…")

    def _on_download_failed(self, _pid: str, _ver: int, err: str) -> None:
        if self._pdf_btn is None:
            return
        self._pdf_btn.setEnabled(True)
        self._pdf_btn.setText("Rate limited — retry?" if err == "rate limited" else "Failed — retry?")
        self._pdf_btn.setStyleSheet(BTN_DANGER)

    def _link_pdf(self) -> None:
        if self._current_row is None:
            return
        path, _ = QFileDialog.getOpenFileName(self, "Link PDF", "", "PDF Files (*.pdf)")
        if not path:
            return
        pid, ver = self._current_row["source_id"], self._current_row["version"]
        paper_svc.set_pdf_path(pid, path)
        paper_svc.set_has_pdf(pid, ver, True)
        self._refresh_pdf_btn()

    # ── Notes ─────────────────────────────────────────────────────────────────

    def _add_note(self, source_fk: int) -> None:
        from gui.projects import NoteEditorDialog
        dlg = NoteEditorDialog(source_fk=source_fk, parent=self)
        if dlg.exec() and self._current_row:
            self.load(self._current_row)

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _section_label(text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet(
            f"font-size: {FONT_SUBHEADING}px; font-weight: 600; color: {_TEXT}; background: transparent;"
        )
        return lbl

    def _edit_note(self, note) -> None:
        from gui.projects import NoteEditorDialog
        dlg = NoteEditorDialog(note=note, parent=self)
        if dlg.exec():
            self.load(self._current_row)

    def _delete_note(self, note) -> None:
        import service.note as note_svc
        note_svc.delete(note_svc.Note(note_id=note.note_id))
        if self._current_row:
            self.load(self._current_row)


# ── Library page ──────────────────────────────────────────────────────────────

class LibraryPage(QWidget):
    navigate_to_project = pyqtSignal(object)   # bubbled from PaperDetailView

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setStyleSheet(f"background: {_BG}; color: {_TEXT};")
        self._all_rows: list = []
        self._cards:    list[PaperCard] = []
        self._selected: set[int] = set()   # source_fks
        self._pdf_worker: _PdfMetadataWorker | None = None
        self._pdf_queue:  list[str] = []
        self._pdf_total  = 0
        self._pdf_added  = 0
        self._pdf_skipped = 0
        self._pdf_failed  = 0

        from gui.views import PdfWindow
        self._pdf_window = PdfWindow(self)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self._stack = QStackedWidget()
        root.addWidget(self._stack)

        # ── Page 0: list ──────────────────────────────────────────────────────
        self._list_page = list_page = QWidget()
        list_page.setStyleSheet(f"background: {_BG};")
        outer = QVBoxLayout(list_page)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._stack.addWidget(list_page)

        # ── Page 1: detail ────────────────────────────────────────────────────
        self._detail_view = PaperDetailView(pdf_window=self._pdf_window)
        self._app_shell: AppShell | None = None
        self._paper_detail_back_goes_to_prior_shell_tab = False
        self._source_fk_for_project_return: int | None = None
        self._detail_view.back_requested.connect(self._on_back_requested)
        self._detail_view.navigate_to_project.connect(self._on_detail_navigate_to_project)
        self._stack.addWidget(self._detail_view)

        # ── Inner (scrollable area + header + filter) ─────────────────────────
        self._inner_widget = inner_widget = QWidget()
        inner_widget.setStyleSheet(f"background: {_BG};")
        inner = QVBoxLayout(inner_widget)
        inner.setContentsMargins(PAGE_MARGIN_H, PAGE_MARGIN_V, PAGE_MARGIN_H, 16)
        inner.setSpacing(0)

        # Header row
        hdr = QHBoxLayout()
        self._title_lbl = title_lbl = QLabel("Library")
        title_lbl.setStyleSheet(
            f"font-size: {FONT_TITLE}px; font-weight: bold; color: {_ACCENT}; background: transparent;"
        )
        self._count_lbl = QLabel("")
        self._count_lbl.setStyleSheet(
            f"font-size: {FONT_BODY}px; color: {_MUTED}; background: transparent;"
        )
        hdr.addWidget(title_lbl)
        hdr.addSpacing(SPACE_MD)
        hdr.addWidget(self._count_lbl, alignment=Qt.AlignmentFlag.AlignBottom)
        hdr.addStretch()

        self._refresh_hdr_btn = refresh_btn = QPushButton("Refresh")
        refresh_btn.setFixedHeight(BTN_H_MD)
        refresh_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        refresh_btn.setStyleSheet(_BTN)
        refresh_btn.clicked.connect(self.refresh)
        hdr.addWidget(refresh_btn)

        self._import_btn = QPushButton("Import")
        self._import_btn.setFixedHeight(BTN_H_MD)
        self._import_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._import_btn.setStyleSheet(_BTN)
        self._import_btn.clicked.connect(self._show_import_menu)
        hdr.addWidget(self._import_btn)

        inner.addLayout(hdr)
        inner.addSpacing(SPACE_LG)

        # Filter bar
        filter_row = QHBoxLayout()
        filter_row.setSpacing(SPACE_MD)

        self._search = QLineEdit()
        self._search.setPlaceholderText("Search title or author…")
        self._search.setStyleSheet(f"""
            QLineEdit {{
                background: {PANEL}; border: 1px solid {BORDER};
                border-radius: {RADIUS_MD}px; color: {_TEXT}; font-size: {FONT_BODY}px; padding: 6px 12px;
            }}
            QLineEdit:focus {{ border-color: {_ACCENT}; }}
        """)
        self._search.textChanged.connect(self._apply_filter)

        self._filter_mode = "all"
        self._btn_all    = self._filter_btn("All",     "all")
        self._btn_haspdf = self._filter_btn("Has PDF", "has_pdf")
        self._btn_nopdf  = self._filter_btn("No PDF",  "no_pdf")
        self._sync_filter_btns()

        filter_row.addWidget(self._search, stretch=1)
        filter_row.addWidget(self._btn_all)
        filter_row.addWidget(self._btn_haspdf)
        filter_row.addWidget(self._btn_nopdf)
        inner.addLayout(filter_row)
        inner.addSpacing(SPACE_LG)

        # Cards scroll area
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("background: transparent;")

        self._cards_widget = QWidget()
        self._cards_widget.setStyleSheet("background: transparent;")
        self._cards_layout = QVBoxLayout(self._cards_widget)
        self._cards_layout.setContentsMargins(0, 0, 0, 0)
        self._cards_layout.setSpacing(SPACE_MD)
        self._cards_layout.addStretch()

        scroll.setWidget(self._cards_widget)
        inner.addWidget(scroll, stretch=1)

        self._empty_lbl = QLabel("No papers match the current filter.")
        self._empty_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_lbl.setStyleSheet(
            f"font-size: {FONT_BODY}px; color: {_MUTED}; background: transparent;"
        )
        self._empty_lbl.setVisible(False)
        inner.addWidget(self._empty_lbl)

        outer.addWidget(inner_widget, stretch=1)

        # ── Action bar (pinned to bottom, hidden when nothing selected) ───────
        self._action_bar = SelectionBar(
            show_select_all=True,
            show_remove_pdfs=True,
            show_remove_from_library=True,
            parent=self,
        )
        self._action_bar.download_requested.connect(self._on_bulk_download)
        self._action_bar.remove_pdfs_requested.connect(self._on_remove_pdfs)
        self._action_bar.add_to_project_requested.connect(self._on_add_to_project)
        self._action_bar.remove_from_library_requested.connect(self._on_remove_from_library)
        self._action_bar.clear_requested.connect(self._clear_selection)
        self._action_bar.select_all_requested.connect(self._select_all)
        outer.addWidget(self._action_bar)

        self.refresh()

    # ── Filter buttons ────────────────────────────────────────────────────────

    def _filter_btn(self, label: str, mode: str) -> QPushButton:
        btn = QPushButton(label)
        btn.setFixedHeight(BTN_H_MD)
        btn.setCursor(Qt.CursorShape.PointingHandCursor)
        btn.clicked.connect(lambda: self._set_filter(mode))
        return btn

    def _set_filter(self, mode: str) -> None:
        self._filter_mode = mode
        self._sync_filter_btns()
        self._apply_filter()

    def _sync_filter_btns(self) -> None:
        for btn, mode in [
            (self._btn_all,    "all"),
            (self._btn_haspdf, "has_pdf"),
            (self._btn_nopdf,  "no_pdf"),
        ]:
            if mode == self._filter_mode:
                btn.setStyleSheet(_qt_styles.BTN_FILTER_ACTIVE)
            else:
                btn.setStyleSheet(_qt_styles.BTN_PANEL)

    # ── Data ──────────────────────────────────────────────────────────────────

    def refresh_styles(self) -> None:
        self.setStyleSheet(f"background: {_theme.BG}; color: {_theme.TEXT};")
        self._list_page.setStyleSheet(f"background: {_theme.BG};")
        self._inner_widget.setStyleSheet(f"background: {_theme.BG};")
        self._title_lbl.setStyleSheet(
            f"font-size: {FONT_TITLE}px; font-weight: bold; color: {_theme.ACCENT}; background: transparent;"
        )
        self._count_lbl.setStyleSheet(
            f"font-size: {FONT_BODY}px; color: {_theme.MUTED}; background: transparent;"
        )
        self._search.setStyleSheet(f"""
            QLineEdit {{
                background: {_theme.PANEL}; border: 1px solid {_theme.BORDER};
                border-radius: {RADIUS_MD}px; color: {_theme.TEXT}; font-size: {FONT_BODY}px; padding: 6px 12px;
            }}
            QLineEdit:focus {{ border-color: {_theme.ACCENT}; }}
        """)
        self._empty_lbl.setStyleSheet(
            f"font-size: {FONT_BODY}px; color: {_theme.MUTED}; background: transparent;"
        )
        self._refresh_hdr_btn.setStyleSheet(_qt_styles.BTN_PANEL)
        self._import_btn.setStyleSheet(_qt_styles.BTN_PANEL)
        self._sync_filter_btns()
        self._detail_view.refresh_styles()
        self.refresh()

    def refresh(self) -> None:
        self._all_rows = paper_svc.list_papers(latest_only=True)
        self._apply_filter()

    def _apply_filter(self) -> None:
        query = self._search.text().strip().lower()
        mode  = self._filter_mode
        filtered = []
        for row in self._all_rows:
            has_pdf  = bool(row["has_pdf"])
            pdf_path = row["pdf_path"] if "pdf_path" in row.keys() else None
            local    = has_pdf or (pdf_path and os.path.isfile(pdf_path))
            if mode == "has_pdf" and not local:
                continue
            if mode == "no_pdf" and local:
                continue
            if query:
                title    = (row["title"] or "").lower()
                authors: list[str] = row["authors"] or []
                if query not in title and query not in " ".join(authors).lower():
                    continue
            filtered.append(row)

        self._rebuild_cards(filtered)
        self._count_lbl.setText(f"{len(filtered)} of {len(self._all_rows)} papers")

    def _rebuild_cards(self, rows: list) -> None:
        # Remove old cards
        while self._cards_layout.count() > 1:
            item = self._cards_layout.takeAt(0)
            if item:
                widget = item.widget()
                if widget:
                    widget.deleteLater()
        self._cards = []

        self._empty_lbl.setVisible(not rows)
        for row in rows:
            card = PaperCard(row, pdf_window=self._pdf_window, parent=self._cards_widget)
            if row["source_id"] in self._selected:
                card.set_selected(True)
            card.selection_toggled.connect(self._on_card_toggle)
            card.clicked.connect(self._on_paper_card_clicked)
            self._cards_layout.insertWidget(self._cards_layout.count() - 1, card)
            self._cards.append(card)

    # ── Selection ─────────────────────────────────────────────────────────────

    def attach_app_shell(self, shell: AppShell) -> None:
        """Shell reference for cross-tab Back after open_paper() from another page."""
        self._app_shell = shell

    def take_source_fk_for_project_return(self) -> int | None:
        """Consume paper id saved when jumping Library detail → Projects (for restoring detail)."""
        pid = self._source_fk_for_project_return
        self._source_fk_for_project_return = None
        return pid

    def _on_detail_navigate_to_project(self, project) -> None:
        self._source_fk_for_project_return = self._detail_view.get_current_source_fk()
        self.navigate_to_project.emit(project)

    def show_paper_detail_by_id(self, source_fk: int) -> None:
        """Re-open paper detail (e.g. after Back from Projects).

        Does not change cross-tab Back: if the user opened this paper via ``open_paper``
        from another tab (e.g. Graph), that return path stays active.
        """
        source_id = paper_svc.get_source_id(source_fk)
        if source_id is None:
            return
        row = paper_svc.get_paper(source_id)
        if row is None:
            return
        self._open_detail(row)

    def show_library_list(self) -> None:
        """Show the paper list (not detail). Used when switching back to the Library tab.

        Does not clear ``_paper_detail_back_goes_to_prior_shell_tab``: tab switches run
        before programmatic detail restore (e.g. Back from Projects), and clearing here
        would drop a Graph→Library ``open_paper`` handoff.
        """
        self._stack.setCurrentIndex(0)

    def open_paper(self, source_fk: int) -> None:
        """Open the detail view for a paper (e.g. from Graph). Back returns to prior shell tab."""
        source_id = paper_svc.get_source_id(source_fk)
        if source_id is None:
            return
        row = paper_svc.get_paper(source_id)
        if row:
            self._paper_detail_back_goes_to_prior_shell_tab = True
            self._open_detail(row)

    def _on_back_requested(self) -> None:
        shell_handoff = self._paper_detail_back_goes_to_prior_shell_tab
        self._paper_detail_back_goes_to_prior_shell_tab = False
        self._stack.setCurrentIndex(0)
        if shell_handoff and self._app_shell:
            self._app_shell.go_back()

    def _on_paper_card_clicked(self, row) -> None:
        self._paper_detail_back_goes_to_prior_shell_tab = False
        self._open_detail(row)

    def _open_detail(self, row) -> None:
        self._detail_view.load(row)
        self._stack.setCurrentIndex(1)

    def _on_card_toggle(self, source_fk: int, selected: bool) -> None:
        if selected:
            self._selected.add(source_fk)
        else:
            self._selected.discard(source_fk)
        self._sync_action_bar()

    def _clear_selection(self) -> None:
        self._selected.clear()
        for card in self._cards:
            card.set_selected(False)
        self._sync_action_bar()

    def _select_all(self) -> None:
        for card in self._cards:
            self._selected.add(card.paper_id())
            card.set_selected(True)
        self._sync_action_bar()

    def _sync_action_bar(self) -> None:
        self._action_bar.set_count(len(self._selected))

    # ── Bulk actions ──────────────────────────────────────────────────────────

    def _on_bulk_download(self) -> None:
        for card in self._cards:
            if card.paper_id() in self._selected:
                card.start_download_if_needed()

    # ── Import ────────────────────────────────────────────────────────────────

    def _show_import_menu(self) -> None:
        menu = QMenu(self)
        menu.addAction("BibTeX file…",           self._import_bibtex_file)
        menu.addAction("Paste BibTeX citation…", self._import_bibtex_paste)
        menu.addAction("JSON file…",             self._import_json_file)
        menu.addAction("CSV file…",              self._import_csv_file)
        menu.addAction("Markdown file…",         self._import_markdown_file)
        menu.addAction("Obsidian file…",         self._import_obsidian_file)
        menu.addSeparator()
        menu.addAction("PDF…",              self._import_pdf)
        menu.addAction("Folder…",           self._import_not_implemented)
        menu.addAction("Manual entry…",     self._import_manual)
        menu.exec(self._import_btn.mapToGlobal(self._import_btn.rect().bottomLeft()))

    def _import_bibtex_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Import BibTeX", "", "BibTeX (*.bib)")
        if not path:
            return
        try:
            papers = _bibtex_fmt.import_file(path)
        except Exception as e:
            from PyQt6.QtWidgets import QMessageBox
            QMessageBox.critical(self, "Import Failed", str(e))
            return
        self._finish_import(papers)

    def _import_bibtex_paste(self) -> None:
        from PyQt6.QtWidgets import QDialog, QDialogButtonBox
        dlg = QDialog(self)
        dlg.setWindowTitle("Paste BibTeX")
        dlg.setStyleSheet(f"background: {_BG}; color: {_TEXT};")
        dlg.resize(560, 340)

        lay = QVBoxLayout(dlg)
        lay.setContentsMargins(DIALOG_PAD, DIALOG_PAD, DIALOG_PAD, DIALOG_PAD)
        lay.setSpacing(SPACE_MD)

        lbl = QLabel("Paste one or more BibTeX entries below:")
        lbl.setStyleSheet(f"font-size: {FONT_BODY}px;")
        lay.addWidget(lbl)

        editor = QTextEdit()
        editor.setPlaceholderText("@article{...}")
        editor.setStyleSheet(f"""
            QTextEdit {{
                background: {PANEL}; border: 1px solid {BORDER};
                border-radius: {RADIUS_MD}px; color: {_TEXT};
                font-family: monospace; font-size: {FONT_SECONDARY}px; padding: 8px;
            }}
        """)
        lay.addWidget(editor, stretch=1)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        btns.accepted.connect(dlg.accept)
        btns.rejected.connect(dlg.reject)
        lay.addWidget(btns)

        if dlg.exec() != QDialog.DialogCode.Accepted:
            return

        text = editor.toPlainText().strip()
        if not text:
            return
        try:
            papers = _bibtex_fmt.import_string(text)
        except Exception as e:
            from PyQt6.QtWidgets import QMessageBox
            QMessageBox.critical(self, "Import Failed", str(e))
            return
        self._finish_import(papers)

    def _import_json_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Import JSON", "", "JSON (*.json)")
        if not path:
            return
        try:
            papers = _json_fmt.import_file(path)
        except Exception as e:
            from PyQt6.QtWidgets import QMessageBox
            QMessageBox.critical(self, "Import Failed", str(e))
            return
        self._finish_import(papers)

    def _import_csv_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Import CSV", "", "CSV (*.csv)")
        if not path:
            return
        try:
            papers = _csv_fmt.import_file(path)
        except Exception as e:
            from PyQt6.QtWidgets import QMessageBox
            QMessageBox.critical(self, "Import Failed", str(e))
            return
        self._finish_import(papers)

    def _import_markdown_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Import Markdown", "", "Markdown (*.md)")
        if not path:
            return
        try:
            papers = _markdown_fmt.import_file(path)
        except Exception as e:
            from PyQt6.QtWidgets import QMessageBox
            QMessageBox.critical(self, "Import Failed", str(e))
            return
        self._finish_import(papers)

    def _import_obsidian_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Import Obsidian", "", "Markdown (*.md)")
        if not path:
            return
        try:
            papers = _obsidian_fmt.import_file(path)
        except Exception as e:
            from PyQt6.QtWidgets import QMessageBox
            QMessageBox.critical(self, "Import Failed", str(e))
            return
        self._finish_import(papers)

    def _import_pdf(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(self, "Import PDFs", "", "PDF Files (*.pdf)")
        if not paths:
            return
        self._pdf_queue   = list(paths)
        self._pdf_total   = len(paths)
        self._pdf_added   = 0
        self._pdf_skipped = 0
        self._pdf_failed  = 0
        self._import_btn.setEnabled(False)
        self._start_next_pdf()

    def _start_next_pdf(self) -> None:
        idx = self._pdf_total - len(self._pdf_queue) + 1
        self._import_btn.setText(f"Resolving {idx}/{self._pdf_total}…")
        path = self._pdf_queue[0]
        self._pdf_worker = _PdfMetadataWorker(path)
        self._pdf_worker.finished.connect(self._on_pdf_metadata_done)
        self._pdf_worker.failed.connect(self._on_pdf_metadata_failed)
        self._pdf_worker.start()

    def _on_pdf_metadata_done(self, meta, path: str) -> None:
        self._pdf_queue.pop(0)
        existing = paper_svc.get_paper(meta.source_id)
        if existing is None:
            paper_svc.save_papers_metadata([meta])
            self._pdf_added += 1
        else:
            self._pdf_skipped += 1
        paper_svc.set_pdf_path(meta.source_id, path)
        paper_svc.set_has_pdf(meta.source_id, meta.version, True)
        if self._pdf_queue:
            self._start_next_pdf()
        else:
            self._finish_pdf_import()

    def _on_pdf_metadata_failed(self, _err: str) -> None:
        self._pdf_queue.pop(0)
        self._pdf_failed += 1
        if self._pdf_queue:
            self._start_next_pdf()
        else:
            self._finish_pdf_import()

    def _finish_pdf_import(self) -> None:
        self._import_btn.setEnabled(True)
        self._import_btn.setText("Import")
        self.refresh()
        from PyQt6.QtWidgets import QMessageBox
        parts = []
        if self._pdf_added:
            parts.append(f"Added {self._pdf_added} paper(s).")
        if self._pdf_skipped:
            parts.append(f"{self._pdf_skipped} already in library (PDF path updated).")
        if self._pdf_failed:
            parts.append(f"{self._pdf_failed} failed to resolve.")
        QMessageBox.information(self, "Import Complete", "  ".join(parts) or "Nothing imported.")

    def _import_manual(self) -> None:
        dlg = AddPaperManuallyDialog(self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        try:
            meta = dlg.get_metadata()
            if paper_svc.get_paper(meta.source_id):
                QMessageBox.warning(
                    self, "Already in Library",
                    f"A paper with ID '{meta.source_id}' is already in the library.\n"
                    "Edit it using the Repair button on its detail page.",
                )
                return
            paper_svc.save_paper_metadata(meta)
            self.refresh()
        except Exception as e:
            print(f"[import_manual] {e}")
            QMessageBox.critical(self, "Import Failed", str(e))

    def _import_not_implemented(self) -> None:
        from PyQt6.QtGui import QAction
        from PyQt6.QtWidgets import QMessageBox
        sender = self.sender()
        label = sender.text() if isinstance(sender, QAction) else "This"
        QMessageBox.warning(self, "Not Implemented", f"{label} is not yet implemented.")

    def _finish_import(self, papers) -> None:
        from PyQt6.QtWidgets import QMessageBox
        added = skipped = 0
        for meta in papers:
            existing = paper_svc.get_paper(meta.source_id)
            if existing:
                skipped += 1
            else:
                paper_svc.save_papers_metadata([meta])
                added += 1
        self.refresh()
        QMessageBox.information(
            self, "Import Complete",
            f"Added {added} paper(s).  Skipped {skipped} already in library."
        )

    def _on_add_to_project(self) -> None:
        if not self._selected:
            return
        from PyQt6.QtWidgets import QDialog, QComboBox, QDialogButtonBox, QMessageBox
        from service.project import filter_projects

        projects = filter_projects(Q("status = 'active'"))
        if not projects:
            QMessageBox.information(self, "No Projects", "Create a project first.")
            return

        dlg = QDialog(self)
        dlg.setWindowTitle("Add to Project")
        dlg.setStyleSheet(f"background: {_BG}; color: {_TEXT};")
        lay = QVBoxLayout(dlg)
        lay.setContentsMargins(DIALOG_PAD, CARD_PAD_V, DIALOG_PAD, CARD_PAD_V)
        lay.setSpacing(SPACE_MD)

        lay.addWidget(QLabel(f"Add {len(self._selected)} paper(s) to:"))
        combo = QComboBox()
        combo.setStyleSheet(f"""
            QComboBox {{ background: {PANEL}; border: 1px solid {BORDER};
                border-radius: {RADIUS_SM}px; color: {_TEXT}; padding: 4px 8px; font-size: {FONT_BODY}px; }}
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
        for pid in self._selected:
            try:
                project.add_paper(pid)
            except Exception:
                pass

    def _on_remove_pdfs(self) -> None:
        if not self._selected:
            return
        affected = [c for c in self._cards if c.paper_id() in self._selected and c.local_pdf_path()]
        if not affected:
            return
        n = len(affected)
        reply = QMessageBox.question(
            self,
            "Remove PDFs",
            f"Remove local PDFs for {n} paper(s)?\n\nPDFs downloaded by linXiv will be deleted from disk. Externally linked PDFs will be unlinked only.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        for card in affected:
            path = card.local_pdf_path()
            if path:
                try:
                    _files.delete_pdf(path)
                except OSError as e:
                    print(f"[remove_pdfs] Error removing PDF: {path}")
                    print(f"[remove_pdfs] {e}")
            sid = paper_svc.get_source_id(card.paper_id())
            if sid:
                paper_svc.set_pdf_path(sid, "")
                paper_svc.set_has_pdf(sid, card._row["version"], False)
        self.refresh()

    def _on_remove_from_library(self) -> None:
        if not self._selected:
            return
        n = len(self._selected)
        reply = QMessageBox.question(
            self,
            "Remove from library",
            f"Move {n} paper(s) to trash?\n\nPapers can be restored from the Trash panel in Projects.\nLinked PDFs will not be deleted from disk; PDFs downloaded by linXiv will be.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        for sfk in list(self._selected):
            sid = paper_svc.get_source_id(sfk)
            if sid:
                paper_svc.delete_paper(sid)
        self._selected.clear()
        self.refresh()
