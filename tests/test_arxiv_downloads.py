"""Tests for sources/arxiv_downloads.py."""

from __future__ import annotations

import io
import os
import tarfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from sources.arxiv_downloads import (
    _default_filename,
    _strip_tex_noise,
    _substitute_domain,
    cleanup_pdfs,
    download_pdf,
    download_pdf_batch,
    download_source,
    download_source_batch,
    extract_source,
    saved_pdfs_size,
)


def _make_paper(
    entry_id: str = "http://arxiv.org/abs/2204.12985v4",
    pdf_url: str | None = "https://arxiv.org/pdf/2204.12985v4",
) -> MagicMock:
    paper = MagicMock()
    paper.entry_id = entry_id
    paper.pdf_url = pdf_url
    return paper


def _make_tarball(files: dict[str, str]) -> bytes:
    """Create an in-memory .tar.gz with the given filename→content mapping."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            encoded = content.encode("utf-8")
            info = tarfile.TarInfo(name=name)
            info.size = len(encoded)
            tar.addfile(info, io.BytesIO(encoded))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# _substitute_domain
# ---------------------------------------------------------------------------

class TestSubstituteDomain:
    def test_replaces_netloc(self):
        url = "https://arxiv.org/pdf/2204.12985v4"
        result = _substitute_domain(url, "export.arxiv.org")
        netloc = result.split("//")[1].split("/")[0]
        assert netloc == "export.arxiv.org"

    def test_scheme_preserved(self):
        result = _substitute_domain("https://arxiv.org/pdf/2204.12985v4", "export.arxiv.org")
        assert result.startswith("https://")

    def test_path_preserved(self):
        result = _substitute_domain("https://arxiv.org/pdf/2204.12985v4", "export.arxiv.org")
        assert result.endswith("/pdf/2204.12985v4")

    def test_query_string_preserved(self):
        url = "https://arxiv.org/pdf/2204.12985v4?version=2"
        result = _substitute_domain(url, "export.arxiv.org")
        assert "version=2" in result
        assert "export.arxiv.org" in result


# ---------------------------------------------------------------------------
# _default_filename
# ---------------------------------------------------------------------------

class TestDefaultFilename:
    def test_uses_entry_id_tail_as_stem(self):
        paper = _make_paper(entry_id="http://arxiv.org/abs/2204.12985v4")
        assert _default_filename(paper, "pdf") == "2204.12985v4.pdf"

    def test_unsafe_chars_replaced_with_underscore(self):
        paper = _make_paper(entry_id="http://arxiv.org/abs/bad id:here")
        result = _default_filename(paper, "pdf")
        assert " " not in result
        assert ":" not in result

    def test_pdf_extension_appended(self):
        paper = _make_paper(entry_id="http://arxiv.org/abs/2204.12985v4")
        assert _default_filename(paper, "pdf").endswith(".pdf")

    def test_tar_gz_extension_appended(self):
        paper = _make_paper(entry_id="http://arxiv.org/abs/2204.12985v4")
        assert _default_filename(paper, "tar.gz").endswith(".tar.gz")


# ---------------------------------------------------------------------------
# _strip_tex_noise
# ---------------------------------------------------------------------------

class TestStripTexNoise:
    def test_removes_percent_comment(self):
        result = _strip_tex_noise("some text % this is a comment\nnext line")
        assert "this is a comment" not in result
        assert "next line" in result

    def test_preserves_escaped_percent(self):
        result = _strip_tex_noise(r"50\% of the time")
        assert r"50\%" in result

    def test_removes_usepackage(self):
        result = _strip_tex_noise(r"\usepackage{amsmath} some text")
        assert "\\usepackage" not in result
        assert "some text" in result

    def test_removes_documentclass(self):
        result = _strip_tex_noise(r"\documentclass{article} rest")
        assert "\\documentclass" not in result
        assert "rest" in result

    def test_removes_cite(self):
        result = _strip_tex_noise(r"See \cite{smith2020} for details.")
        assert "\\cite" not in result
        assert "See" in result
        assert "for details." in result

    def test_removes_label(self):
        result = _strip_tex_noise(r"\label{fig:main} caption")
        assert "\\label" not in result
        assert "caption" in result

    def test_removes_ref(self):
        result = _strip_tex_noise(r"Figure \ref{fig:main} shows")
        assert "\\ref" not in result
        assert "Figure" in result
        assert "shows" in result

    def test_removes_bibliography_commands(self):
        result = _strip_tex_noise(r"\bibliographystyle{plain}\bibliography{refs}")
        assert "\\bibliographystyle" not in result
        assert "\\bibliography" not in result

    def test_preserves_normal_prose(self):
        text = "This is a normal paragraph about deep learning."
        assert _strip_tex_noise(text) == text

    def test_removes_input(self):
        result = _strip_tex_noise(r"\input{sections/intro} rest")
        assert "\\input" not in result
        assert "rest" in result

    def test_removes_include(self):
        result = _strip_tex_noise(r"\include{appendix} content")
        assert "\\include" not in result
        assert "content" in result


# ---------------------------------------------------------------------------
# download_pdf
# ---------------------------------------------------------------------------

class TestDownloadPdf:
    def test_raises_when_pdf_url_is_none(self):
        paper = _make_paper(pdf_url=None)
        with pytest.raises(ValueError):
            download_pdf(paper)

    def test_applies_domain_substitution(self, tmp_path):
        paper = _make_paper(pdf_url="https://arxiv.org/pdf/2204.12985v4")
        with patch("sources.arxiv_downloads.urlretrieve", return_value=(str(tmp_path / "out.pdf"), {})) as mock_retrieve:
            download_pdf(paper, dirpath=str(tmp_path), domain="export.arxiv.org")
        assert "export.arxiv.org" in mock_retrieve.call_args[0][0]

    def test_uses_custom_filename_when_provided(self, tmp_path):
        paper = _make_paper(pdf_url="https://arxiv.org/pdf/2204.12985v4")
        expected = str(tmp_path / "custom.pdf")
        with patch("sources.arxiv_downloads.urlretrieve", return_value=(expected, {})):
            result = download_pdf(paper, dirpath=str(tmp_path), filename="custom.pdf")
        assert result == expected

    def test_uses_default_filename_when_none_provided(self, tmp_path):
        paper = _make_paper(
            entry_id="http://arxiv.org/abs/2204.12985v4",
            pdf_url="https://arxiv.org/pdf/2204.12985v4",
        )
        with patch("sources.arxiv_downloads.urlretrieve", return_value=(str(tmp_path / "out.pdf"), {})) as mock_retrieve:
            download_pdf(paper, dirpath=str(tmp_path))
        assert mock_retrieve.call_args[0][1].endswith("2204.12985v4.pdf")

    def test_returns_path_from_urlretrieve(self, tmp_path):
        paper = _make_paper(pdf_url="https://arxiv.org/pdf/2204.12985v4")
        written = str(tmp_path / "out.pdf")
        with patch("sources.arxiv_downloads.urlretrieve", return_value=(written, {})):
            result = download_pdf(paper, dirpath=str(tmp_path))
        assert result == written


# ---------------------------------------------------------------------------
# download_source
# ---------------------------------------------------------------------------

class TestDownloadSource:
    def test_raises_when_pdf_url_is_none(self):
        paper = _make_paper(pdf_url=None)
        with pytest.raises(ValueError):
            download_source(paper)

    def test_substitutes_pdf_with_src_in_url(self, tmp_path):
        paper = _make_paper(pdf_url="https://arxiv.org/pdf/2204.12985v4")
        with patch("sources.arxiv_downloads.urlretrieve", return_value=(str(tmp_path / "out.tar.gz"), {})) as mock_retrieve:
            download_source(paper, dirpath=str(tmp_path))
        called_url = mock_retrieve.call_args[0][0]
        assert "/src/" in called_url
        assert "/pdf/" not in called_url

    def test_applies_domain_substitution(self, tmp_path):
        paper = _make_paper(pdf_url="https://arxiv.org/pdf/2204.12985v4")
        with patch("sources.arxiv_downloads.urlretrieve", return_value=(str(tmp_path / "out.tar.gz"), {})) as mock_retrieve:
            download_source(paper, dirpath=str(tmp_path), domain="export.arxiv.org")
        assert "export.arxiv.org" in mock_retrieve.call_args[0][0]

    def test_default_filename_has_tar_gz_extension(self, tmp_path):
        paper = _make_paper(
            entry_id="http://arxiv.org/abs/2204.12985v4",
            pdf_url="https://arxiv.org/pdf/2204.12985v4",
        )
        with patch("sources.arxiv_downloads.urlretrieve", return_value=(str(tmp_path / "out.tar.gz"), {})) as mock_retrieve:
            download_source(paper, dirpath=str(tmp_path))
        assert mock_retrieve.call_args[0][1].endswith(".tar.gz")


# ---------------------------------------------------------------------------
# download_pdf_batch / download_source_batch
# ---------------------------------------------------------------------------

class TestDownloadBatch:
    def test_pdf_batch_calls_download_pdf_once_per_paper(self, tmp_path):
        papers = [_make_paper(), _make_paper()]
        with patch("sources.arxiv_downloads.download_pdf", return_value="p") as mock_dl:
            download_pdf_batch(papers, dirpath=str(tmp_path))
        assert mock_dl.call_count == 2

    def test_pdf_batch_creates_dirpath_if_missing(self, tmp_path):
        new_dir = str(tmp_path / "new_subdir")
        with patch("sources.arxiv_downloads.download_pdf", return_value="p"):
            download_pdf_batch([_make_paper()], dirpath=new_dir)
        assert os.path.isdir(new_dir)

    def test_pdf_batch_returns_paths_from_download_pdf(self, tmp_path):
        papers = [_make_paper(), _make_paper()]
        with patch("sources.arxiv_downloads.download_pdf", side_effect=["a.pdf", "b.pdf"]):
            result = download_pdf_batch(papers, dirpath=str(tmp_path))
        assert result == ["a.pdf", "b.pdf"]

    def test_source_batch_calls_download_source_once_per_paper(self, tmp_path):
        papers = [_make_paper(), _make_paper()]
        with patch("sources.arxiv_downloads.download_source", return_value="p") as mock_dl:
            download_source_batch(papers, dirpath=str(tmp_path))
        assert mock_dl.call_count == 2

    def test_source_batch_creates_dirpath_if_missing(self, tmp_path):
        new_dir = str(tmp_path / "src_subdir")
        with patch("sources.arxiv_downloads.download_source", return_value="p"):
            download_source_batch([_make_paper()], dirpath=new_dir)
        assert os.path.isdir(new_dir)

    def test_source_batch_returns_paths_from_download_source(self, tmp_path):
        papers = [_make_paper(), _make_paper()]
        with patch("sources.arxiv_downloads.download_source", side_effect=["a.tar.gz", "b.tar.gz"]):
            result = download_source_batch(papers, dirpath=str(tmp_path))
        assert result == ["a.tar.gz", "b.tar.gz"]


# ---------------------------------------------------------------------------
# cleanup_pdfs
# ---------------------------------------------------------------------------

class TestCleanupPdfs:
    def test_deletes_pdf_not_in_keep(self, tmp_path):
        pdf = tmp_path / "old.pdf"
        pdf.write_bytes(b"data")
        deleted = cleanup_pdfs(str(tmp_path), keep=set())
        assert str(pdf) in deleted
        assert not pdf.exists()

    def test_preserves_pdf_in_keep(self, tmp_path):
        pdf = tmp_path / "keep.pdf"
        pdf.write_bytes(b"data")
        cleanup_pdfs(str(tmp_path), keep={str(pdf)})
        assert pdf.exists()

    def test_does_not_touch_non_pdf_files(self, tmp_path):
        txt = tmp_path / "readme.txt"
        txt.write_text("hello")
        cleanup_pdfs(str(tmp_path))
        assert txt.exists()

    def test_none_keep_deletes_all_pdfs(self, tmp_path):
        for name in ("a.pdf", "b.pdf"):
            (tmp_path / name).write_bytes(b"x")
        deleted = cleanup_pdfs(str(tmp_path), keep=None)
        assert len(deleted) == 2

    def test_returns_list_of_deleted_paths(self, tmp_path):
        pdf = tmp_path / "target.pdf"
        pdf.write_bytes(b"x")
        deleted = cleanup_pdfs(str(tmp_path))
        assert len(deleted) == 1
        assert deleted[0].endswith("target.pdf")

    def test_empty_keep_deletes_all_pdfs(self, tmp_path):
        for name in ("a.pdf", "b.pdf"):
            (tmp_path / name).write_bytes(b"x")
        deleted = cleanup_pdfs(str(tmp_path), keep=set())
        assert len(deleted) == 2

    def test_skips_permission_error_and_does_not_add_to_deleted(self, tmp_path):
        pdf = tmp_path / "locked.pdf"
        pdf.write_bytes(b"data")
        with patch("sources.arxiv_downloads.os.remove", side_effect=PermissionError):
            deleted = cleanup_pdfs(str(tmp_path), keep=set())
        assert deleted == []


# ---------------------------------------------------------------------------
# saved_pdfs_size
# ---------------------------------------------------------------------------

class TestSavedPdfsSize:
    def test_returns_zero_for_empty_set(self):
        assert saved_pdfs_size(set()) == 0

    def test_returns_sum_of_file_sizes(self, tmp_path):
        f1 = tmp_path / "a.pdf"
        f2 = tmp_path / "b.pdf"
        f1.write_bytes(b"12345")       # 5 bytes
        f2.write_bytes(b"1234567890")  # 10 bytes
        assert saved_pdfs_size({str(f1), str(f2)}) == 15

    def test_skips_nonexistent_paths(self, tmp_path):
        missing = str(tmp_path / "ghost.pdf")
        assert saved_pdfs_size({missing}) == 0

    def test_mixed_existing_and_missing(self, tmp_path):
        real = tmp_path / "real.pdf"
        real.write_bytes(b"abc")  # 3 bytes
        assert saved_pdfs_size({str(real), str(tmp_path / "missing.pdf")}) == 3


# ---------------------------------------------------------------------------
# extract_source
# ---------------------------------------------------------------------------

class TestExtractSource:
    def test_returns_tex_content(self, tmp_path):
        tarpath = str(tmp_path / "src.tar.gz")
        Path(tarpath).write_bytes(_make_tarball({"main.tex": "Hello world in TeX."}))
        assert "Hello world in TeX." in extract_source(tarpath)

    def test_strips_comments_from_output(self, tmp_path):
        tarpath = str(tmp_path / "src.tar.gz")
        Path(tarpath).write_bytes(_make_tarball({"main.tex": "content % inline comment\nnext line"}))
        result = extract_source(tarpath)
        assert "inline comment" not in result
        assert "next line" in result

    def test_root_level_before_nested(self, tmp_path):
        tarpath = str(tmp_path / "src.tar.gz")
        Path(tarpath).write_bytes(_make_tarball({
            "main.tex": "ROOT",
            "subdir/section.tex": "NESTED",
        }))
        result = extract_source(tarpath)
        assert result.index("ROOT") < result.index("NESTED")

    def test_multiple_tex_files_concatenated(self, tmp_path):
        tarpath = str(tmp_path / "src.tar.gz")
        Path(tarpath).write_bytes(_make_tarball({
            "intro.tex": "INTRO",
            "body.tex": "BODY",
        }))
        result = extract_source(tarpath)
        assert "INTRO" in result
        assert "BODY" in result

    def test_returns_empty_when_no_tex_files(self, tmp_path):
        tarpath = str(tmp_path / "src.tar.gz")
        Path(tarpath).write_bytes(_make_tarball({"readme.txt": "no tex here"}))
        assert extract_source(tarpath) == ""

    def test_returns_empty_for_corrupt_tar(self, tmp_path):
        tarpath = str(tmp_path / "bad.tar.gz")
        Path(tarpath).write_bytes(b"this is not a tarball")
        assert extract_source(tarpath) == ""

    def test_skips_dotdot_path_members(self, tmp_path):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            content = b"UNSAFE"
            info = tarfile.TarInfo(name="../malicious.tex")
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        tarpath = str(tmp_path / "dotdot.tar.gz")
        Path(tarpath).write_bytes(buf.getvalue())
        assert "UNSAFE" not in extract_source(tarpath)

    def test_skips_absolute_path_members(self, tmp_path):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            content = b"ABSOLUTE"
            info = tarfile.TarInfo(name="/etc/evil.tex")
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        tarpath = str(tmp_path / "absolute.tar.gz")
        Path(tarpath).write_bytes(buf.getvalue())
        assert "ABSOLUTE" not in extract_source(tarpath)
