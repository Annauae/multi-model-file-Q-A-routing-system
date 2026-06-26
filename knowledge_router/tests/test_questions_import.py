from knowledge_router.app.questions_import import normalize_import_items, strip_md_frontmatter


def test_strip_md_frontmatter() -> None:
    text = "---\ntitle: x\n---\n\n# Hello"
    assert strip_md_frontmatter(text).startswith("# Hello")


def test_normalize_import_items() -> None:
    items = normalize_import_items(
        [
            {
                "question": "怎么调 ISO？",
                "variants": ["ISO 怎么设", "感光度怎么调"],
                "answer": "旋转拨盘。",
            }
        ]
    )
    assert len(items) == 1
    assert items[0]["question"] == "怎么调 ISO？"
    assert len(items[0]["variants"]) == 2
