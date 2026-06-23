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
    assert "先读全文" in msg or "完整阅读" in msg
    assert "只能输出原文" in msg or "原样复制" in msg
    assert "必须大段输出" in msg or "大段" in msg
    assert "多处匹配时只选最相关" in msg or "相似度最高" in msg
    assert "页脚" in msg or "页码标记" in msg
    assert "![](assets/" in msg or "Markdown 图片行" in msg
    assert "图片须单独成行" in msg
    assert "<image>" in msg
    assert "knowledge_p77-82_005.png" in msg
    assert "【引用】" in msg
    assert "L1 | alpha" not in msg


def test_strip_citation_lines_from_answer() -> None:
    raw = "快门在顶部。\n\n【引用】files/agent_1/knowledge.md L2-L3"
    assert strip_citation_lines_from_answer(raw) == "快门在顶部。"


def test_normalize_answer_image_markdown() -> None:
    from app.knowledge_loader import normalize_answer_image_markdown

    raw = (
        "- A 模式说明。[插图说明] A模式显示屏与拨盘图示![](assets/fake_a.png)\n"
        "- M 模式说明。[插图说明] M模式显示屏与拨盘图示![](assets/fake_m.png)"
    )
    out = normalize_answer_image_markdown(raw)
    assert "![A模式显示屏与拨盘图示](assets/fake_a.png)" in out
    assert "![M模式显示屏与拨盘图示](assets/fake_m.png)" in out
    assert "[插图说明]" not in out


def test_replace_invalid_images_matches_by_alt_hint(tmp_path: Path) -> None:
    agent_dir = tmp_path / "files" / "router_1" / "agent_31"
    md_dir = agent_dir / "md"
    assets = agent_dir / "assets"
    md_dir.mkdir(parents=True)
    assets.mkdir(parents=True)
    (assets / "knowledge_p119-124_006.png").write_bytes(b"png-a")
    (assets / "knowledge_p119-124_007.png").write_bytes(b"png-m")

    knowledge = "\n".join(
        [
            "## A（光圈优先自动）",
            "![A模式显示屏与拨盘图示](assets/knowledge_p119-124_006.png)",
            "## M（手动）",
            "![M模式显示屏与拨盘图示](assets/knowledge_p119-124_007.png)",
        ]
    )
    raw = "\n".join(
        [
            "## A（光圈优先自动）",
            "- 由您选择光圈。",
            "[插图说明] A模式显示屏与拨盘图示![](assets/ae3216169f8183d2f0e988c412960e74.png)",
            "## M（手动）",
            "- 您可根据曝光指示调整。",
            "[插图说明] M模式显示屏与拨盘图示![](assets/1381bd9d36158180e13de7864b43f79b.png)",
            "",
            "【引用】files/router_1/agent_31/md/knowledge_p119-124.md L2-L3",
            "【引用】files/router_1/agent_31/md/knowledge_p119-124.md L5-L6",
        ]
    )
    display, cites = finalize_model_answer_display(
        raw_answer=raw,
        knowledge=knowledge,
        knowledge_source="files/router_1/agent_31/md/knowledge_p119-124.md",
        project_root=tmp_path,
        files_dir="files/router_1/agent_31",
    )
    a_pos = display.find("knowledge_p119-124_006.png")
    m_pos = display.find("knowledge_p119-124_007.png")
    assert a_pos != -1
    assert m_pos != -1
    assert a_pos < m_pos
    assert "ae3216169" not in display
    assert "1381bd9d" not in display
    assets = [
        c.asset_file
        for c in cites
        if (c.asset_file or "").endswith(".png")
    ]
    assert any("knowledge_p119-124_006.png" in a for a in assets)
    assert any("knowledge_p119-124_007.png" in a for a in assets)
    assert len(assets) == 2


def test_replace_invalid_display_images_with_hallucinated_urls(tmp_path: Path) -> None:
    agent_dir = tmp_path / "files" / "agent_12"
    assets = agent_dir / "assets"
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


def test_resolve_image_tag_placeholders_inline(tmp_path: Path) -> None:
    from app.knowledge_loader import polish_answer_body, resolve_image_tag_placeholders
    from app.schemas import Citation

    agent_dir = tmp_path / "files" / "router_1" / "agent_13"
    assets = agent_dir / "assets"
    assets.mkdir(parents=True)
    for name in ("knowledge_p72-76_001.png", "knowledge_p72-76_002.png", "knowledge_p72-76_003.png"):
        (assets / name).write_bytes(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x0e\x00\x00\x00\x0e"
        )

    knowledge = "\n".join(
        [
            "<!-- page 72 -->",
            "1. **选择照片模式。**",
            "![照片/视频选择器操作示意图](assets/knowledge_p72-76_002.png)",
            "2. **旋转至 AUTO。**",
            "![模式选择器操作示意图](assets/knowledge_p72-76_003.png)",
            "<!-- page 73 -->",
        ]
    )
    raw = "\n".join(
        [
            "1. **选择照片模式。**",
            "[插图说明] 照片/视频选择器操作示意图",
            "<image>",
            "2. **旋转至 AUTO。**",
            "[插图说明] 模式选择器操作示意图",
            "<image>",
        ]
    )
    cites = [
        Citation(
            file="files/router_1/agent_13/md/knowledge_p72-76.md",
            line_start=2,
            line_end=5,
            snippet="",
        )
    ]
    display = resolve_image_tag_placeholders(
        raw,
        knowledge=knowledge,
        citations=cites,
        project_root=tmp_path,
        files_dir="files/router_1/agent_13",
    )
    assert "<image>" not in display
    assert "knowledge_p72-76_002.png" in display
    assert "knowledge_p72-76_003.png" in display
    pos2 = display.find("knowledge_p72-76_002.png")
    pos3 = display.find("knowledge_p72-76_003.png")
    assert pos2 != -1 and pos3 != -1
    assert pos2 < pos3

    polished = polish_answer_body(
        raw,
        knowledge=knowledge,
        citations=cites,
        project_root=tmp_path,
        files_dir="files/router_1/agent_13",
    )
    assert polished.count("knowledge_p72-76_002.png") == 1
    assert "knowledge_p72-76_001.png" not in polished


def test_resolve_illustration_lines_without_image_tag(tmp_path: Path) -> None:
    from app.knowledge_loader import resolve_image_tag_placeholders
    from app.schemas import Citation

    agent_dir = tmp_path / "files" / "router_1" / "agent_13"
    assets = agent_dir / "assets"
    assets.mkdir(parents=True)
    for name in ("knowledge_p72-76_001.png", "knowledge_p72-76_002.png"):
        (assets / name).write_bytes(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x0e\x00\x00\x00\x0e"
        )

    knowledge = "\n".join(
        [
            "![伸缩镜筒操作示意图](assets/knowledge_p72-76_001.png)",
            "![照片/视频选择器操作示意图](assets/knowledge_p72-76_002.png)",
        ]
    )
    raw = "\n".join(
        [
            "1. **选择照片模式。**",
            "[插图说明] 照片村频选择器操作示意图",
            "2. **旋转至 AUTO。**",
            "[插图说明] 模式选择器操作示意图",
        ]
    )
    cites = [Citation(file="k.md", line_start=1, line_end=2, snippet="")]
    display = resolve_image_tag_placeholders(
        raw,
        knowledge=knowledge,
        citations=cites,
        project_root=tmp_path,
        files_dir="files/router_1/agent_13",
    )
    assert "[插图说明]" not in display
    assert display.find("knowledge_p72-76_002.png") < display.find("模式选择器") or "knowledge_p72-76_001.png" in display


def test_finalize_model_answer_display(tmp_path: Path) -> None:
    agent_dir = tmp_path / "files" / "agent_1"
    assets = agent_dir / "assets"
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

    agent_dir = tmp_path / "files" / "agent_1"
    assets = agent_dir / "assets"
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

    agent_dir = tmp_path / "files" / "agent_1"
    assets = agent_dir / "assets"
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
