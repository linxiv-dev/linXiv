from __future__ import annotations

from pathlib import Path
from typing import Literal

from PyQt6.QtCore import QThread, Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QCheckBox,
    QDialog,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QVBoxLayout,
    QWidget,
)

import gui.qt_assets.styles as _styles
from gui.theme import (
    ACCENT,
    BORDER,
    FONT_BODY,
    FONT_HEADING,
    FONT_SECONDARY,
    MUTED,
    PANEL,
    SPACE_MD,
    TEXT,
)
import service.export_import as _ei


# ---------------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------------

class _ExportWorker(QThread):
    finished = pyqtSignal(str)  # archive path
    failed   = pyqtSignal(str)

    def __init__(self, project_fk: int, dest_path: Path, include_pdfs: bool) -> None:
        super().__init__()
        self._project_fk  = project_fk
        self._dest_path   = dest_path
        self._include_pdfs = include_pdfs

    def run(self) -> None:
        try:
            out = _ei.export_project(self._project_fk, self._dest_path, self._include_pdfs)
            self.finished.emit(str(out))
        except Exception as exc:
            print(f"[export_import] export failed: {exc}")
            self.failed.emit(str(exc))


class _ImportWorker(QThread):
    finished = pyqtSignal(int)   # new project_fk
    failed   = pyqtSignal(str)

    def __init__(self, zip_path: Path, on_conflict: Literal["merge", "overwrite"]) -> None:
        super().__init__()
        self._zip_path: Path = zip_path
        self._on_conflict: Literal["merge", "overwrite"] = on_conflict

    def run(self) -> None:
        try:
            fk = _ei.commit_import(self._zip_path, on_conflict=self._on_conflict)
            self.finished.emit(fk)
        except Exception as exc:
            print(f"[export_import] import failed: {exc}")
            self.failed.emit(str(exc))


# ---------------------------------------------------------------------------
# Dialogs
# ---------------------------------------------------------------------------

class _ExportOptionsDialog(QDialog):
    """Pick export options (include PDFs) before writing the archive."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Export Project")
        self.setFixedWidth(360)
        self.setStyleSheet(f"background: {PANEL}; color: {TEXT};")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 20, 24, 20)
        lay.setSpacing(SPACE_MD)

        heading = QLabel("Export Project")
        heading.setStyleSheet(f"font-size: {FONT_HEADING}px; font-weight: bold; color: {ACCENT};")
        lay.addWidget(heading)

        self._include_pdfs = QCheckBox("Include bundled PDFs")
        self._include_pdfs.setStyleSheet(f"font-size: {FONT_BODY}px; color: {TEXT};")
        lay.addWidget(self._include_pdfs)

        note = QLabel("PDFs make the archive larger but let recipients open papers offline.")
        note.setWordWrap(True)
        note.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {MUTED};")
        lay.addWidget(note)

        btn_row = QHBoxLayout()
        cancel = QPushButton("Cancel")
        cancel.setStyleSheet(_styles.BTN_MUTED)
        cancel.clicked.connect(self.reject)
        ok = QPushButton("Export")
        ok.setStyleSheet(_styles.BTN_PRIMARY)
        ok.clicked.connect(self.accept)
        btn_row.addWidget(cancel)
        btn_row.addStretch()
        btn_row.addWidget(ok)
        lay.addLayout(btn_row)

    def include_pdfs(self) -> bool:
        return self._include_pdfs.isChecked()


class _ImportPreviewDialog(QDialog):
    """Show archive summary and let the user choose merge vs overwrite."""

    def __init__(self, preview: _ei.ImportPreview, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Import Project")
        self.setFixedWidth(400)
        self.setStyleSheet(f"background: {PANEL}; color: {TEXT};")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 20, 24, 20)
        lay.setSpacing(SPACE_MD)

        heading = QLabel("Import Project")
        heading.setStyleSheet(f"font-size: {FONT_HEADING}px; font-weight: bold; color: {ACCENT};")
        lay.addWidget(heading)

        def _row(label: str, value: str) -> None:
            row = QHBoxLayout()
            lbl = QLabel(label)
            lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {MUTED};")
            val = QLabel(value)
            val.setStyleSheet(f"font-size: {FONT_BODY}px; color: {TEXT};")
            row.addWidget(lbl)
            row.addStretch()
            row.addWidget(val)
            lay.addLayout(row)

        _row("Project",       preview.project_name)
        _row("Papers",        str(preview.paper_count))
        _row("Notes",         str(preview.note_count))
        _row("Includes PDFs", "Yes" if preview.has_pdfs else "No")

        sep = QWidget()
        sep.setFixedHeight(1)
        sep.setStyleSheet(f"background: {BORDER};")
        lay.addWidget(sep)

        conflict_lbl = QLabel("If papers already exist in the library:")
        conflict_lbl.setStyleSheet(f"font-size: {FONT_SECONDARY}px; color: {MUTED};")
        lay.addWidget(conflict_lbl)

        self._merge_radio = QRadioButton("Merge  (keep existing metadata, union tags)")
        self._merge_radio.setChecked(True)
        self._merge_radio.setStyleSheet(f"font-size: {FONT_BODY}px; color: {TEXT};")
        lay.addWidget(self._merge_radio)

        self._overwrite_radio = QRadioButton("Overwrite  (replace metadata from archive)")
        self._overwrite_radio.setStyleSheet(f"font-size: {FONT_BODY}px; color: {TEXT};")
        lay.addWidget(self._overwrite_radio)

        btn_row = QHBoxLayout()
        cancel = QPushButton("Cancel")
        cancel.setStyleSheet(_styles.BTN_MUTED)
        cancel.clicked.connect(self.reject)
        ok = QPushButton("Import")
        ok.setStyleSheet(_styles.BTN_PRIMARY)
        ok.clicked.connect(self.accept)
        btn_row.addWidget(cancel)
        btn_row.addStretch()
        btn_row.addWidget(ok)
        lay.addLayout(btn_row)

    def on_conflict(self) -> Literal["merge", "overwrite"]:
        return "overwrite" if self._overwrite_radio.isChecked() else "merge"


# ---------------------------------------------------------------------------
# Reusable button widgets
# ---------------------------------------------------------------------------

class ProjectExportButton(QPushButton):
    """Self-contained export button for the project detail view.

    Call set_project_fk() when a new project is loaded. Connect export_done
    if you need to react after a successful export.
    """
    export_done = pyqtSignal(str)  # path of written archive

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__("Export", parent)
        self._project_fk: int | None = None
        self._worker: _ExportWorker | None = None
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setStyleSheet(_styles.BTN_MUTED)
        self.clicked.connect(self._on_click)

    def set_project_fk(self, fk: int | None) -> None:
        self._project_fk = fk

    def refresh_styles(self) -> None:
        self.setStyleSheet(_styles.BTN_MUTED)

    def _on_click(self) -> None:
        if self._project_fk is None:
            return

        opts_dlg = _ExportOptionsDialog(self.window() or self)
        if opts_dlg.exec() != QDialog.DialogCode.Accepted:
            return

        include_pdfs = opts_dlg.include_pdfs()
        dest, _ = QFileDialog.getSaveFileName(
            self.window() or self,
            "Save Project Archive",
            "",
            "linxiv Project (*.lxproj)",
        )
        if not dest:
            return

        self.setEnabled(False)
        self.setText("Exporting…")
        self._worker = _ExportWorker(self._project_fk, Path(dest), include_pdfs)
        self._worker.finished.connect(self._on_done)
        self._worker.failed.connect(self._on_failed)
        self._worker.start()

    def _on_done(self, path: str) -> None:
        self.setEnabled(True)
        self.setText("Export")
        QMessageBox.information(
            self.window() or self,
            "Export Complete",
            f"Project exported to:\n{path}",
        )
        self.export_done.emit(path)

    def _on_failed(self, err: str) -> None:
        self.setEnabled(True)
        self.setText("Export")
        QMessageBox.warning(self.window() or self, "Export Failed", f"Export failed:\n{err}")


class ProjectImportButton(QPushButton):
    """Self-contained import button for the projects list page.

    Runs the full two-phase flow: file picker → preview dialog → commit worker.
    Connect import_done to refresh the project list.
    """
    import_done = pyqtSignal(int)  # new project_fk

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__("Import Project", parent)
        self._worker: _ImportWorker | None = None
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setStyleSheet(_styles.BTN_MUTED)
        self.clicked.connect(self._on_click)

    def refresh_styles(self) -> None:
        self.setStyleSheet(_styles.BTN_MUTED)

    def _on_click(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self.window() or self,
            "Import Project",
            "",
            "linxiv Project (*.lxproj)",
        )
        if not path:
            return

        try:
            preview = _ei.preview_import(Path(path))
        except Exception as exc:
            print(f"[export_import] preview failed: {exc}")
            QMessageBox.warning(
                self.window() or self,
                "Invalid Archive",
                f"Could not read archive:\n{exc}",
            )
            return

        prev_dlg = _ImportPreviewDialog(preview, self.window() or self)
        if prev_dlg.exec() != QDialog.DialogCode.Accepted:
            return

        on_conflict = prev_dlg.on_conflict()
        self.setEnabled(False)
        self.setText("Importing…")
        self._worker = _ImportWorker(Path(path), on_conflict)
        self._worker.finished.connect(self._on_done)
        self._worker.failed.connect(self._on_failed)
        self._worker.start()

    def _on_done(self, project_fk: int) -> None:
        self.setEnabled(True)
        self.setText("Import Project")
        QMessageBox.information(
            self.window() or self, "Import Complete", "Project imported successfully."
        )
        self.import_done.emit(project_fk)

    def _on_failed(self, err: str) -> None:
        self.setEnabled(True)
        self.setText("Import Project")
        QMessageBox.warning(self.window() or self, "Import Failed", f"Import failed:\n{err}")
