from knowledge_router.app.pdf_sectionizer import is_trivial_section


def test_is_trivial_section_preface_heading_only() -> None:
    md = "## 前言"
    assert is_trivial_section(md, "前言") is True


def test_is_trivial_section_has_body() -> None:
    md = "## 手动模式\n\n旋转拨盘调整 ISO。"
    assert is_trivial_section(md, "手动模式") is False


def test_is_trivial_section_placeholder_title() -> None:
    md = "## 本页插图"
    assert is_trivial_section(md, "本页插图") is True
