import { useEffect, useState, type ReactElement } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import { highlightCode } from './shiki'

interface CodeProps {
  inline?: boolean
  className?: string
  children?: React.ReactNode
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

function Code({ inline, className, children }: CodeProps): ReactElement {
  const code = String(children ?? '').replace(/\n$/, '')
  if (inline || !className) {
    return <code className="inline-code">{code}</code>
  }
  const lang = className.replace(/language-/, '')
  return <CodeBlock lang={lang || 'code'} code={code} />
}

export function Markdown({ text, isStreaming }: { text: string; isStreaming?: boolean }): ReactElement {
  return (
    <div className="markdown-body">
      <XMarkdown components={{ code: Code }}>{text}</XMarkdown>
      {isStreaming && <span className="streaming-cursor">▌</span>}
    </div>
  )
}
