from __future__ import annotations

from PyQt6.QtCore import QThread, pyqtSignal

from sources.pdf_metadata import resolve_pdf_metadata


class PdfMetadataWorker(QThread):
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
            print(f"[PdfMetadataWorker] {e}")
            self.failed.emit(str(e))