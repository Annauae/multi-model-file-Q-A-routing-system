import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.knowledge_loader import (
    add_line_numbers,
    append_missing_images_to_display,
    build_answer_system_message,
    count_knowledge_lines,
    expand_citations_with_images_in_range,
    finalize_model_answer_display,
    format_cited_line_refs,
    format_used_file_label,
    locate_answer_lines_in_knowledge,
    parse_line_citations_from_answer,
    reconcile_answer_with_retrieval,
    replace_invalid_display_images,
    retrieve_raw_knowledge_answer,
    strip_citation_lines_from_answer,
)


def test_add_line_numbers() -> None:
    numbered = add_line_numbers("第一行\n第二行")
    assert numbered.splitlines()[0].startswith("L1 | 第一行")
    assert numbered.splitlines()[1].startswith("L2 | 第二行")


def test_build_answer_system_message_synthesizes_from_knowledge() -> None:
    msg = build_answer_system_message(
        agent_name="测试",
        knowledge="alpha\nbeta",
        knowledge_source="files/agent_1/knowledge.md",
        answer_instructions="",
    )
    assert "知识库全文" in msg or "唯一可引用" in msg
    assert "禁止编造" in msg or "禁止编造原文" in msg
    assert "![](assets/" in msg or "Markdown 图片行" in msg
    assert "【引用】" in msg
    assert "原样复制" not in msg
    assert "禁止加工" not in msg
    assert "L1 | alpha" not in msg


def test_strip_citation_lines_from_answer() -> None:
    raw = "快门在顶部。\n\n【引用】files/agent_1/knowledge.md L2-L3"
    assert strip_citation_lines_from_answer(raw) == "快门在顶部。"


def test_replace_invalid_display_images_with_hallucinated_urls(tmp_path: Path) -> None:
    assets = tmp_path / "files" / "assets"
    assets.mkdir(parents=True)
    (assets / "p012_docling_picture001.png").write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x0e\x00\x00\x00\x0e"
    )
    (assets / "p012_docling_picture002.png").write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x0e\x00\x00\x00\x0e"
    )

    knowledge = "\n".join(
        [
            "## 安装镜头",
            "取下机身盖和镜头后盖。",
            "对齐安装标记。",
            "## 本页插图",
            "![镜头盖步骤](assets/p012_docling_picture001.png)",
            "![安装标记](assets/p012_docling_picture002.png)",
        ]
    )
    raw = "\n".join(
        [
            "安装步骤：",
            "1. 确认相机关闭。",
            "2. 取下机身盖和镜头后盖。",
            "![](https://space.coze.cn/s/fake1/)",
            "3. 对齐安装标记。",
            "![](https://space.coze.cn/s/fake2/)",
            "",
            "【引用】files/agent_12/knowledge.md L1-L3",
            "【引用】files/agent_12/knowledge.md L4-L6",
        ]
    )
    display, cites = finalize_model_answer_display(
        raw_answer=raw,
        knowledge=knowledge,
        knowledge_source="files/agent_12/knowledge.md",
        project_root=tmp_path,
        files_dir="files/agent_12",
    )
    assert "space.coze.cn" not in display
    assert "assets/p012_docling_picture001.png" in display
    assert "assets/p012_docling_picture002.png" in display
    assert cites


def test_finalize_model_answer_display(tmp_path: Path) -> None:
    assets = tmp_path / "files" / "assets"
    assets.mkdir(parents=True)
    (assets / "demo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x0e\x00\x00\x00\x0e")

    knowledge = "\n".join(
        [
            "<!-- page 1 -->",
            "### 安装挂带",
            "快门在顶部。",
            "---",
            "## 本页插图",
            "![示意图](assets/demo.png)",
            "<!-- page 2 -->",
        ]
    )
    raw = "快门在顶部。\n\n【引用】files/agent_1/knowledge.md L3-L4"
    display, cites = finalize_model_answer_display(
        raw_answer=raw,
        knowledge=knowledge,
        knowledge_source="files/agent_1/knowledge.md",
        project_root=tmp_path,
        files_dir="files/agent_1",
    )
    assert "【引用】" not in display
    assert "快门在顶部" in display
    assert "![示意图](assets/demo.png)" in display
    assert cites
    assert cites[0].line_start == 3
    assert any(c.asset_file for c in cites)


def test_expand_citations_uses_page_block_when_cited_range_has_no_images(tmp_path: Path) -> None:
    from app.schemas import Citation

    assets = tmp_path / "files" / "assets"
    assets.mkdir(parents=True)
    (assets / "demo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x0e\x00\x00\x00\x0e")

    knowledge = "\n".join(
        [
            "<!-- page 1 -->",
            "### 安装挂带",
            "步骤文字",
            "---",
            "## 本页插图",
            "![图](assets/demo.png)",
            "<!-- page 2 -->",
        ]
    )
    cites = [
        Citation(
            file="files/agent_1/knowledge.md",
            line_start=2,
            line_end=3,
            snippet="步骤",
        )
    ]
    expanded = expand_citations_with_images_in_range(
        cites,
        knowledge=knowledge,
        project_root=tmp_path,
        files_dir="files/agent_1",
    )
    assert any(c.asset_file for c in expanded)


def test_build_answer_user_message_is_question_only() -> None:
    from app.knowledge_loader import build_answer_user_message

    knowledge = "\n".join(["无关", "快门释放按钮位于机身顶部中央。"])
    user_msg, cites = build_answer_user_message(
        question="快门在哪？",
        rewritten_query="",
        knowledge=knowledge,
        knowledge_source="files/agent_1/knowledge.md",
    )
    assert "用户问题：快门在哪？" in user_msg
    assert "【检索片段】" not in user_msg
    assert "【知识内容】" not in user_msg
    assert cites == []


def test_knowledge_to_content_parts_includes_image(tmp_path: Path) -> None:
    from app.knowledge_loader import knowledge_to_content_parts

    assets = tmp_path / "files" / "assets"
    assets.mkdir(parents=True)
    img = assets / "demo.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")

    md = "步骤说明\n\n![快门按钮](assets/demo.png)\n\n后续文字"
    parts = knowledge_to_content_parts(
        knowledge=md,
        project_root=tmp_path,
        files_dir="files/agent_1",
    )
    types = [p["type"] for p in parts]
    assert "text" in types
    assert "image_url" in types


def test_parse_line_citations_from_answer() -> None:
    knowledge = "\n".join(["无关", "快门释放按钮在顶部", "电源开关在右侧"])
    answer = "快门在顶部。\n\n【引用】files/agent_1/knowledge.md L2-L3"
    cites = parse_line_citations_from_answer(
        answer=answer,
        knowledge_source="files/agent_1/knowledge.md",
        knowledge=knowledge,
    )
    assert len(cites) == 1
    assert cites[0].line_start == 2
    assert cites[0].line_end == 3
    assert "快门" in cites[0].snippet


def test_retrieve_raw_knowledge_answer() -> None:
    knowledge = "\n".join(
        [
            "无关内容",
            "快门释放按钮位于机身顶部中央。",
            "电源开关在快门按钮周围。",
            "其他说明",
        ]
    )
    answer, cites = retrieve_raw_knowledge_answer(
        question="快门释放按钮在哪？",
        knowledge=knowledge,
        knowledge_source="files/agent_1/knowledge.md",
    )
    assert "--- files/agent_1/knowledge.md L" in answer
    assert "【原文】" not in answer
    assert "快门释放按钮位于机身顶部中央。" in answer
    assert "电源开关" in answer
    assert len(cites) >= 1
    assert cites[0].line_start >= 1
    assert cites[0].line_end >= cites[0].line_start


def test_format_used_file_label() -> None:
    assert format_used_file_label("files/agent_1/knowledge.md", 1031) == "files/agent_1/knowledge.md · 1031 行"
    assert count_knowledge_lines("a\nb\nc") == 3


def test_format_cited_line_refs() -> None:
    from app.schemas import Citation

    cites = [
        Citation(file="files/agent_3/knowledge.md", line_start=120, line_end=135, snippet="x"),
        Citation(file="files/agent_3/knowledge.md", line_start=200, line_end=200, snippet="y"),
    ]
    assert format_cited_line_refs(cites) == [
        "files/agent_3/knowledge.md · L120-L135",
        "files/agent_3/knowledge.md · L200",
    ]


def test_reconcile_answer_when_model_says_not_found() -> None:
    from app.schemas import Citation

    knowledge = "无关行\n取景器说明段落\n另一行"
    retrieval = [
        Citation(
            file="files/agent_1/knowledge.md",
            line_start=2,
            line_end=2,
            snippet="取景器说明段落",
        )
    ]
    out = reconcile_answer_with_retrieval(
        "当前知识库中未找到相关信息",
        knowledge=knowledge,
        retrieval_citations=retrieval,
    )
    assert out == "当前知识库中未找到相关信息"


def test_reconcile_fallback_to_citation_snippet() -> None:
    from app.schemas import Citation

    fallback = [
        Citation(
            file="assets/p018.png",
            snippet="图中显示相机取景器界面右上角的两个按钮",
        )
    ]
    out = reconcile_answer_with_retrieval(
        "当前知识库中未找到相关信息",
        knowledge="",
        retrieval_citations=[],
        fallback_citations=fallback,
    )
    assert out == "当前知识库中未找到相关信息"


def test_format_cited_line_refs_for_image_citation() -> None:
    from app.schemas import Citation

    cites = [
        Citation(
            file="files/agent_1/knowledge.md",
            line_start=404,
            line_end=404,
            snippet="alt",
            asset_file="files/assets/p020.png",
        )
    ]
    assert format_cited_line_refs(cites, "files/agent_1/knowledge.md") == [
        "files/agent_1/knowledge.md · L404"
    ]


def test_locate_answer_lines_in_knowledge() -> None:
    knowledge = "\n".join(
        [
            "无关内容",
            "通过按住 ISO 感光度拨盘锁定解除并旋转 ISO 感光度拨 盘，可以调节 ISO 感光度。",
            "",
            "在按住 ISO 感光度拨盘锁定解除的同时旋转 ISO 感光度 拨盘，可根据可用的光量调节照相机对光的敏感度 （ ISO 感光度）。",
        ]
    )
    answer = (
        "通过按住 ISO 感光度拨盘锁定解除并旋转 ISO 感光度拨 盘，可以调节 ISO 感光度。\n\n"
        "在按住 ISO 感光度拨盘锁定解除的同时旋转 ISO 感光度 拨盘，可根据可用的光量调节照相机对光的敏感度 （ ISO 感光度）。"
    )
    cites = locate_answer_lines_in_knowledge(
        answer=answer,
        knowledge=knowledge,
        knowledge_source="files/agent_1/knowledge.md",
    )
    assert cites
    assert cites[0].file == "files/agent_1/knowledge.md"
    assert cites[0].line_start == 2
    assert (cites[0].line_end or cites[0].line_start) >= 2


def test_retrieve_faq_block_includes_full_answer_not_only_question_line() -> None:
    knowledge = "\n".join(
        [
            "| OAuth | auth |",
            "| OIDC | OpenID Connect |",
            "",
            "## Q: OAuth 2.1 / OIDC flow key points?",
            "",
            "A: ```yaml",
            "Step 1: generate PKCE params",
            "  code_verifier: random string",
            "```",
            "",
            "---",
            "",
            "## Q: optimization checklist?",
            "",
            "A: | enable compression | gzip/brotli |",
        ]
    )
    retrieved, cites = retrieve_raw_knowledge_answer(
        question="What is OIDC flow?",
        knowledge=knowledge,
        knowledge_source="files/agent_3/knowledge.md",
        max_passages=1,
    )
    assert "PKCE" in retrieved
    assert "Step 1" in retrieved
    assert "enable compression" not in retrieved
    assert cites
    assert cites[0].line_start == 4
    assert cites[0].line_end >= 9
    assert cites[0].line_end <= 12
