import { useState } from "react";

export interface MdSegment {
  kind: "code" | "text";
  lang?: string;
  code?: string;
  text?: string;
  /** 代码围栏是否已闭合（流式期间未闭合 → 内容不完整，安装/执行类 UI 需禁用） */
  closed?: boolean;
}

export function parseSegments(content: string): MdSegment[] {
  const segs: MdSegment[] = [];
  const lines = content.split("\n");
  let i = 0;
  let textBuf: string[] = [];
  const flush = () => {
    if (textBuf.length) {
      segs.push({ kind: "text", text: textBuf.join("\n") });
      textBuf = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^```\s*(\S*)\s*$/);
    if (m) {
      flush();
      const lang = m[1] || "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      const closed = i < lines.length;
      i++;
      segs.push({ kind: "code", lang, code: code.join("\n"), closed });
      continue;
    }
    textBuf.push(line);
    i++;
  }
  flush();
  return segs;
}

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith("`")) {
      out.push(
        <code key={key} className="md-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function TextBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;
  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push(
        lv <= 1 ? (
          <div key={key()} className="md-h md-h1">
            {inline(h[2], key())}
          </div>
        ) : (
          <div key={key()} className="md-h md-h2">
            {inline(h[2], key())}
          </div>
        ),
      );
      i++;
      continue;
    }
    if (/^(---+|\*\*\*+)$/.test(line.trim())) {
      out.push(<hr key={key()} className="md-hr" />);
      i++;
      continue;
    }
    if (/^\|.*\|/.test(line.trim())) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|/.test(lines[i].trim())) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        out.push(
          <table key={key()} className="md-table">
            <thead>
              <tr>
                {rows[0].map((c, ci) => (
                  <th key={ci}>{inline(c, `${ci}-h`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{inline(c, `${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        continue;
      }
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={key()} className="md-ul">
          {items.map((it, ii) => (
            <li key={ii}>{inline(it, `li${ii}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(
        <ol key={key()} className="md-ol">
          {items.map((it, ii) => (
            <li key={ii}>{inline(it, `ol${ii}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(
        <blockquote key={key()} className="md-quote">
          {q.map((l, li) => (
            <div key={li}>{inline(l, `q${li}`)}</div>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|>|\|)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <div key={key()} className="md-p">
        {inline(para.join("\n").replace(/\n/g, " "), `p${k}`)}
      </div>,
    );
  }
  return <>{out}</>;
}

export function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="md-codeblock">
      <div className="md-code-head">
        <span>{lang || "代码"}</span>
        <button className="md-copy" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const segs = parseSegments(text);
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "code" ? (
          <CodeBlock key={i} lang={s.lang} code={s.code ?? ""} />
        ) : (
          <TextBlock key={i} text={s.text ?? ""} />
        ),
      )}
    </>
  );
}
