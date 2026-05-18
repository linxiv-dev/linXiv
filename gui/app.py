import sys
from PyQt6.QtWidgets import QApplication
from gui.main_window import MainWindow
from service import paper as paper_svc


def run() -> None:
    paper_svc.init_db()
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())
