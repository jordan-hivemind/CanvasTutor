// Minimal markdown + KaTeX renderer for tutor replies.
import katex from 'katex'

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function tex(src: string, display: boolean) {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, output: 'html' })
  } catch {
    return esc(src)
  }
}

function inline(s: string): string {
  // protect math first
  const math: string[] = []
  s = s.replace(/\\\((.+?)\\\)|\$([^$\n]+?)\$/g, (_, a, b) => {
    math.push(tex(a ?? b, false))
    return `\u0000${math.length - 1}\u0000`
  })
  // links: [text](https://…) and bare https://… (kept aside so * and _ in URLs aren't touched)
  const links: string[] = []
  const link = (href: string, text: string) => {
    links.push(`<a href="${esc(href).replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${text}</a>`)
    return `\u0002${links.length - 1}\u0002`
  }
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, href) => link(href, esc(text)))
  s = s.replace(/https?:\/\/[^\s<>\u0000\u0002]+/g, (m) => {
    const url = m.replace(/[.,;:!?)\]'"]+$/, '') // trailing punctuation isn't part of the link
    return link(url, esc(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))) + m.slice(url.length)
  })
  s = esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\u0002(\d+)\u0002/g, (_, i) => links[Number(i)])
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => math[Number(i)])
}

export function renderMarkdown(md: string): string {
  // pull out display math blocks
  const blocks: string[] = []
  md = md.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => {
    blocks.push(`<div class="math-block">${tex(a ?? b, true)}</div>`)
    return `\n\u0001${blocks.length - 1}\u0001\n`
  })
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  for (const line of md.split('\n')) {
    const t = line.trim()
    const blk = t.match(/^\u0001(\d+)\u0001$/)
    const ul = t.match(/^[-*•]\s+(.*)/)
    const ol = t.match(/^\d+[.)]\s+(.*)/)
    const h = t.match(/^#{1,4}\s+(.*)/)
    if (!t) {
      flush()
      closeList()
    } else if (blk) {
      flush()
      closeList()
      out.push(blocks[Number(blk[1])])
    } else if (ul || ol) {
      flush()
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`)
    } else if (h) {
      flush()
      closeList()
      out.push(`<h4>${inline(h[1])}</h4>`)
    } else {
      closeList()
      para.push(t)
    }
  }
  flush()
  closeList()
  return out.join('')
}

/** Plain text suitable for speaking when the model didn't provide a <say> block. */
export function speakable(md: string): string {
  return md
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1') // links: say the text, not the address
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\$\$[\s\S]+?\$\$/g, ' ')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/[*#`_>]/g, '')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
