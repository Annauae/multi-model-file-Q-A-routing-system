import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.faq_converter import (
    _build_faq_items,
    _ensure_all_images_present,
    build_knowledge_frontmatter,
    convert_chunk_to_faq_offline,
    convert_reference_md_to_faq,
    normalize_image_paths,
    split_whole_md_by_agent,
)


def test_split_whole_md_by_agent() -> None:
    whole = """---
page_start: 1
page_end: 4
---
line p1
![a](assets/p001_a.png)
more p2
![b](assets/p002_b.png)
"""
    chunks = split_whole_md_by_agent(whole, n_agents=2)
    assert len(chunks) == 2
    assert chunks[0][0] == 1
    assert "p001_a.png" in chunks[0][3]
    assert chunks[1][0] == 2
    assert "p002_b.png" in chunks[1][3]


def test_normalize_image_paths() -> None:
    text = "![x](assets/p001.png)\n![y](../assets/p002.png)"
    out = normalize_image_paths(text)
    assert "../assets/p001.png" in out
    assert "../assets/p002.png" in out


def test_ensure_all_images_present() -> None:
    source = "text\n![img](assets/p009.png)\n"
    faq = "## Q: test?\n\nA: answer\n"
    out = _ensure_all_images_present(source, faq)
    assert "![img](../assets/p009.png)" in out


def test_build_faq_items_reaches_min_faqs() -> None:
    chunk = "\n".join(
        [
            "模式选择器",
            "･ 使用模式选择器可选择一种拍摄模式。",
            "･ P 模式由照相机设定快门速度和光圈。",
            "![模式转盘](../assets/p013_docling_picture001.png)",
        ]
    )
    items = _build_faq_items(normalize_image_paths(chunk), min_faqs=5)
    assert len(items) >= 5


def test_convert_chunk_to_faq_offline_preserves_images() -> None:
    chunk = "\n".join(
        [
            "曝光补偿拨盘",
            "可以旋转曝光补偿拨盘来改变照相机所建议的曝光值。",
            "![曝光补偿示例](assets/p015_docling_picture001.png)",
        ]
    )
    faq = convert_chunk_to_faq_offline(chunk_text=chunk)
    assert "## Q:" in faq
    assert "![曝光补偿示例](../assets/p015_docling_picture001.png)" in faq


def test_build_knowledge_frontmatter() -> None:
    h = build_knowledge_frontmatter(agent_id=4, page_start=13, page_end=16)
    assert "format: faq" in h
    assert "agent_id: 4" in h


def test_convert_reference_md_to_faq() -> None:
    sample = """# Title

## 目录
- skip

## 1. Web 基础

### 1.1 HTML5 语义化

现代 HTML 使用语义化标签。

```html
<main></main>
```

| 标签 | 用途 |
|------|------|
| main | 主内容 |

![示例](assets/demo.png)

### 1.2 Flexbox

Flexbox 是一维布局。
"""
    faq = convert_reference_md_to_faq(sample)
    assert "## Q: Web 基础：HTML5 语义化有哪些要点？" in faq
    assert "<main></main>" in faq
    assert "| main | 主内容 |" in faq
    assert "![示例](../assets/demo.png)" in faq
    assert "## 目录" not in faq or "skip" not in faq.split("## Q:")[0]
