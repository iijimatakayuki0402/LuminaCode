import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { CopyButton } from './CopyButton'
import { ja } from '../locales/ja'

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

/** ハイライト前のコード（コピー用）を取り出す */
const textOf = (node: HastNode | undefined): string =>
  !node
    ? ''
    : node.type === 'text'
      ? (node.value ?? '')
      : (node.children ?? []).map(textOf).join('')

function languageOf(node: HastNode | undefined): string | null {
  const code = node?.children?.find((c) => c.tagName === 'code')
  const classes = code?.properties?.className
  const match = Array.isArray(classes)
    ? classes.map(String).find((c) => c.startsWith('language-'))
    : undefined
  return match ? match.slice('language-'.length) : null
}

const components: Components = {
  // CHT-05: コードブロックにコピーボタンを付ける（回答全体のコピー CHT-13 とは別）
  pre({ node, children }) {
    const hast = node as unknown as HastNode
    const code = textOf(hast).replace(/\n$/, '')
    const language = languageOf(hast)
    return (
      <div className="code-block">
        <div className="code-head">
          <span>{language ?? 'text'}</span>
          <CopyButton text={code} label={ja.chat.copyCode} className="btn btn-sm code-copy" />
        </div>
        <pre>{children}</pre>
      </div>
    )
  },
  // リンクは既定ブラウザで開く（main の setWindowOpenHandler が処理する）。
  // 相対パスは file: として解決されローカルのファイルを開きうるため、http(s)・mailto 以外はリンクにしない
  a({ href, children }) {
    if (!href || !/^(https?:|mailto:)/i.test(href)) return <>{children}</>
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
  // 外部の画像は読み込まない（SEC-33: Claude API 以外への送信をしない）
  img({ alt }) {
    return <span className="muted">[{alt || 'image'}]</span>
  }
}

/**
 * 応答の Markdown 表示（CHT-05）
 * 生の HTML は描画しない（react-markdown の既定）。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
