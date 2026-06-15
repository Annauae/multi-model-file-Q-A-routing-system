import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_split import _run_pdf_extract  # noqa: E402


def test_run_pdf_extract_passes_pdf_flag(tmp_path: Path) -> None:
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(b"%PDF-1.4\n")
    out = tmp_path / "out"
    out.mkdir()
    (out / "assets").mkdir()
    (out / "knowledge_p1-2.md").write_text("# test", encoding="utf-8")

    with patch("app.agent_split.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
        _run_pdf_extract(
            project_root=tmp_path,
            pdf_path=pdf,
            page_start=1,
            page_end=2,
            temp_dir=out,
            model="test-model",
        )
        cmd = mock_run.call_args[0][0]
        assert "--pdf" in cmd
        pdf_idx = cmd.index("--pdf")
        assert cmd[pdf_idx + 1] == str(pdf)
        assert "--page-start" in cmd
        assert "--page-end" in cmd
