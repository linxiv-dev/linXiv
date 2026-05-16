import json
import os
from typing import cast
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEnginePage
from PyQt6.QtGui import QColor
from PyQt6.QtCore import QUrl


class TexView(QWebEngineView):
    """QWebEngineView that renders text containing LaTeX math via KaTeX."""

    def __init__(self, color: str = "#e8e8e8", bg: str = "transparent",
                 font_size: int = 13, parent=None):
        super().__init__(parent)
        self._wp: QWebEnginePage = cast(QWebEnginePage, self.page())
        self._loaded = False
        self._pending = ""
        self._color = color
        self._bg = bg
        self._font_size = font_size
        self._wp.setBackgroundColor(QColor(bg if bg != "transparent" else "transparent"))
        self.loadFinished.connect(self._on_load_finished)
        html_path = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "web", "tex_view.html")
        )
        self.load(QUrl.fromLocalFile(html_path))

    def set_content(self, text: str) -> None:
        self._pending = text
        if self._loaded:
            self._push()

    def _on_load_finished(self, ok: bool) -> None:
        if ok:
            self._loaded = True
            self._wp.runJavaScript(
                f"document.documentElement.style.setProperty('--fg', {json.dumps(self._color)});"
                f"document.documentElement.style.setProperty('--bg', {json.dumps(self._bg)});"
                f"document.documentElement.style.setProperty('--font-size', '{self._font_size}px');"
            )
            self._push()

    def _push(self) -> None:
        self._wp.runJavaScript(f"setContent({json.dumps(self._pending)})")
