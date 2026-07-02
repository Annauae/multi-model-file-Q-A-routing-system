import { useState } from "react";

export type BatchAddRow = {
  id: string;
  question: string;
  variants: string;
  answer: string;
};

function emptyRow(): BatchAddRow {
  return { id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, question: "", variants: "", answer: "" };
}

export function BatchAddItemsForm({ onChange }: { onChange: (rows: BatchAddRow[]) => void }) {
  const [rows, setRows] = useState<BatchAddRow[]>([emptyRow()]);

  const update = (next: BatchAddRow[]) => {
    setRows(next);
    onChange(next);
  };

  return (
    <div>
      <p style={{ margin: "0 0 10px", color: "var(--text-secondary)", fontSize: 13 }}>可添加多组问题，一次批量提交。</p>
      <div id="multiItemBlocks">
        {rows.map((row, i) => (
          <div key={row.id} className="multiItemBlock">
            <div className="multiItemBlockHead">
              <span className="muted">第 {i + 1} 组</span>
              {rows.length > 1 && (
                <button type="button" className="btn btnXs ghost" onClick={() => update(rows.filter((r) => r.id !== row.id))}>删除本组</button>
              )}
            </div>
            <label className="fieldLabel">标准问题<textarea className="multiQ" rows={2} value={row.question} onChange={(e) => update(rows.map((r) => (r.id === row.id ? { ...r, question: e.target.value } : r)))} /></label>
            <label className="fieldLabel">其他问法（每行一条）<textarea className="multiV" rows={2} value={row.variants} onChange={(e) => update(rows.map((r) => (r.id === row.id ? { ...r, variants: e.target.value } : r)))} /></label>
            <label className="fieldLabel">回答 Markdown<textarea className="multiA" rows={4} value={row.answer} onChange={(e) => update(rows.map((r) => (r.id === row.id ? { ...r, answer: e.target.value } : r)))} /></label>
          </div>
        ))}
      </div>
      <button type="button" className="btn btnXs ghost" style={{ marginTop: 8 }} onClick={() => update([...rows, emptyRow()])}>+ 添加一组</button>
    </div>
  );
}

export function parseBatchAddRows(rows: BatchAddRow[]) {
  return rows.map((row) => ({
    question: row.question.trim(),
    answer: row.answer.trim(),
    variants: row.variants.split("\n").map((s) => s.trim()).filter(Boolean),
  })).filter((r) => r.question || r.answer);
}
