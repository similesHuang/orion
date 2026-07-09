import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { highlightCode } from './shiki'

interface CodeSegment {
  type: 'code'
  lang: string
  code: string
}

interface TextSegment {
  type: 'text'
  content: string
}

type Segment = CodeSegment | TextSegment

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const pattern = /\[FILE:([^\]]+)\]|`([^`]+)`|\*\*([^*]+)\*\*|(^|[\s(])\*([^*]+)\*(?=$|[\s).,!?])/g
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<span key={nodes.length}>{escapeHtml(text.slice(lastIndex, match.index))}</span>)
    }
    if (match[1] !== undefined) {
      nodes.push(<span key={nodes.length} className="file-ref">{match[1]}</span>)
    } else if (match[2] !== undefined) {
      nodes.push(<code key={nodes.length}>{match[2]}</code>)
    } else if (match[3] !== undefined) {
      nodes.push(<strong key={nodes.length}>{match[3]}</strong>)
    } else {
      nodes.push(<span key={nodes.length}>{match[4]}</span>)
      nodes.push(<em key={nodes.length}>{match[5]}</em>)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push(<span key={nodes.length}>{escapeHtml(text.slice(lastIndex))}</span>)
  }
  return nodes
}

function parseTextBlock(block: string): ReactNode {
  const lines = block.split('\n').filter((line) => line !== '')
  if (!lines.length) return null

  if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
    return (
      <ul>
        {lines.map((line, index) => (
          <li key={index}>{renderInlineMarkdown(line.replace(/^\s*[-*]\s+/, ''))}</li>
        ))}
      </ul>
    )
  }

  if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    return (
      <ol>
        {lines.map((line, index) => (
          <li key={index}>{renderInlineMarkdown(line.replace(/^\s*\d+\.\s+/, ''))}</li>
        ))}
      </ol>
    )
  }

  if (lines.every((line) => /^\s*>\s?/.test(line))) {
    return (
      <blockquote>
        {lines.map((line, index) => (
          <span key={index}>
            {renderInlineMarkdown(line.replace(/^\s*>\s?/, ''))}
            {index < lines.length - 1 && <br />}
          </span>
        ))}
      </blockquote>
    )
  }

  return (
    <p>
      {lines.map((line, index) => (
        <span key={index}>
          {renderInlineMarkdown(line)}
          {index < lines.length - 1 && <br />}
        </span>
      ))}
    </p>
  )
}

function splitSegments(text: string): Segment[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const codeBlock = /```([\w-]+)?\n([\s\S]*?)```/g
  const segments: Segment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = codeBlock.exec(normalized)) !== null) {
    const before = normalized.slice(lastIndex, match.index)
    if (before) segments.push({ type: 'text', content: before })
    segments.push({ type: 'code', lang: match[1] || 'code', code: match[2] })
    lastIndex = match.index + match[0].length
  }

  const tail = normalized.slice(lastIndex)
  if (tail) segments.push({ type: 'text', content: tail })
  return segments
}

function CodeBlock({ lang, code }: { lang: string; code: string }): ReactElement {
  const [html, setHtml] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    void highlightCode(code, lang).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  return (
    <figure className="code-block">
      <figcaption>{lang}</figcaption>
      {html ? (
        <pre dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre><code>{code}</code></pre>
      )}
    </figure>
  )
}

export function Markdown({ text, isStreaming }: { text: string; isStreaming?: boolean }): ReactElement {
  const segments = useMemo(() => splitSegments(text), [text])
  const nodes: ReactNode[] = []

  for (const segment of segments) {
    if (segment.type === 'code') {
      nodes.push(<CodeBlock key={nodes.length} lang={segment.lang} code={segment.code} />)
    } else {
      const blocks = segment.content
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
      for (const block of blocks) {
        nodes.push(<span key={nodes.length}>{parseTextBlock(block)}</span>)
      }
    }
  }

  if (!nodes.length) {
    nodes.push(<p key={0}>...</p>)
  }

  if (isStreaming) {
    nodes.push(<span key="cursor" className="streaming-cursor">▌</span>)
  }

  return <div className="markdown-body">{nodes}</div>
}
