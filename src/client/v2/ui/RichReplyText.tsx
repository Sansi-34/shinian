// 安全无第三方依赖的 AI 回复富文本排版组件（仅使用 React JSX，不拼接原始 HTML）
import { Fragment, useState, type ReactNode } from 'react';
import styles from './RichReplyText.module.css';

type Block =
  | { type: 'code'; lang: string; content: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'paragraph'; text: string };

/** 解析行内 **加粗** 与 `行内代码` */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+?\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={`c-${key++}`} className={styles.inlineCode}>
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={`b-${key++}`} className={styles.strong}>
          {token.slice(2, -2)}
        </strong>
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // 围栏代码块
    const fence = trimmed.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
      continue;
    }

    // 标题 # / ## / ###
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // 无序列表
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // 普通段落：持续收集直到空行或下一个块级语法起点
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (
        !next ||
        next.startsWith('```') ||
        /^#{1,4}\s+/.test(next) ||
        /^[-*•]\s+/.test(next) ||
        /^\d+[.)]\s+/.test(next)
      ) {
        break;
      }
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
  }

  return blocks;
}

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 忽略剪贴板权限拒绝 */
    }
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span>{lang || 'code'}</span>
        <button type="button" className={styles.copyCodeBtn} onClick={() => void copyCode()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className={styles.codePre}>
        <code>{content}</code>
      </pre>
    </div>
  );
}

export default function RichReplyText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;

  return (
    <div className={styles.root}>
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          return <CodeBlock key={idx} lang={block.lang} content={block.content} />;
        }
        if (block.type === 'heading') {
          return (
            <h4 key={idx} className={styles.heading} data-level={block.level}>
              {renderInline(block.text)}
            </h4>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={idx} className={styles.list}>
              {block.items.map((item, k) => (
                <li key={k}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol key={idx} className={styles.list}>
              {block.items.map((item, k) => (
                <li key={k}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        const lines = block.text.split('\n');
        return (
          <p key={idx} className={styles.paragraph}>
            {lines.map((ln, lineIdx) => (
              <Fragment key={lineIdx}>
                {lineIdx > 0 && <br />}
                {renderInline(ln)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
