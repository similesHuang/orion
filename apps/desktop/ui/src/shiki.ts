import { createHighlighter, type Highlighter } from 'shiki'

let highlighterPromise: Promise<Highlighter> | null = null

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark'],
      langs: ['javascript', 'typescript', 'tsx', 'jsx', 'python', 'json', 'bash', 'shell', 'rust', 'yaml', 'markdown', 'html', 'css', 'sql'],
    })
  }
  return highlighterPromise
}

export async function highlightCode(code: string, lang = 'text'): Promise<string> {
  try {
    const highlighter = await getHighlighter()
    return highlighter.codeToHtml(code, {
      lang: lang === 'text' || !lang ? 'text' : lang,
      theme: 'github-dark',
    })
  } catch {
    return `<pre class="shiki-fallback"><code>${code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    }</code></pre>`
  }
}
