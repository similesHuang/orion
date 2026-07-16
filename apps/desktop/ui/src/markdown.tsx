import { memo, useEffect, useRef, useState, type ReactElement } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import { highlightCode } from './shiki'

interface CodeProps {
  inline?: boolean
  className?: string
  children?: React.ReactNode
}

function CopyButton({ code }: { code: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])
  return (
    <button
      type="button"
      className={`code-copy ${copied ? 'is-copied' : ''}`}
      onClick={() => {
        void navigator.clipboard.writeText(code).then(() => {
          setCopied(true)
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {copied ? '已复制' : '复制'}
    </button>
  )
}

/**
 * Streaming-safe code block. While the surrounding message is still streaming we
 * render plain <pre> text (cheap, no flicker). Shiki highlighting only runs once
 * the code has settled — debounced so a fast-growing block highlights at most a
 * few times instead of on every token.
 */
function CodeBlock({ lang, code, live }: { lang: string; code: string; live: boolean }): ReactElement {
  const [html, setHtml] = useState<string>('')

  useEffect(() => {
    if (live) return
    let cancelled = false
    const handle = window.setTimeout(() => {
      void highlightCode(code, lang).then((result) => {
        if (!cancelled) setHtml(result)
      })
    }, 60)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [code, lang, live])

  return (
    <figure className="code-block" data-lang={lang}>
      <figcaption>
        <span className="code-lang">{lang}</span>
        <CopyButton code={code} />
      </figcaption>
      {html && !live ? (
        <div className="code-scroll" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-plain">
          <code>{code}</code>
        </pre>
      )}
    </figure>
  )
}

export function Markdown({ text, isStreaming }: { text: string; isStreaming?: boolean }): ReactElement {
  return (
    <div className="markdown-body">
      <XMarkdown
        components={{
          code: ({ inline, className, children }: CodeProps) => {
            const code = String(children ?? '').replace(/\n$/, '')
            if (inline || !className) return <code className="inline-code">{code}</code>
            const lang = className.replace(/language-/, '') || 'text'
            return <CodeBlock lang={lang} code={code} live={!!isStreaming} />
          },
        }}
      >
        {text}
      </XMarkdown>
      {isStreaming && <span className="streaming-cursor" aria-hidden="true" />}
    </div>
  )
}

/**
 * Memoized wrapper: a message block only re-parses markdown when its own text
 * (or streaming flag) changes, instead of on every sibling block's update.
 */
export const MarkdownBlock = memo(
  Markdown,
  (prev, next) => prev.text === next.text && prev.isStreaming === next.isStreaming
)
