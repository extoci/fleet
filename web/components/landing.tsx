'use client'

import { useEffect, useState } from 'react'

import { Dither } from './dither'
import { Plumbob } from './plumbob'

const guides = [
  {
    name: 'Quickstart',
    href: '/docs/quickstart',
    text: 'Install Fleet and open your first app.',
  },
  { name: 'Apps', href: '/docs/apps', text: 'A Preact client, server operations, and JSON data.' },
  { name: 'Agents', href: '/docs/agents', text: 'Your coding agent edits. Fleet rebuilds.' },
  { name: 'Networking', href: '/docs/networking', text: 'Private .fleet names over Tailscale.' },
  { name: 'iPhone', href: '/docs/iphone', text: 'Open your apps from your phone.' },
  { name: 'CLI', href: '/docs/cli', text: 'Every command.' },
]

function Arrow() {
  return (
    <svg className="fleet-arrow" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 11 11 5M6 5h5v5" />
    </svg>
  )
}

function RowArrow() {
  return (
    <svg className="fleet-arrow" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 8h12M9.5 3.5 14 8l-4.5 4.5" />
    </svg>
  )
}

export default function Landing() {
  const [activeRow, setActiveRow] = useState<number | null>(null)
  // Row fields only make sense where hover exists; skip the WebGL contexts elsewhere.
  const [rowFields, setRowFields] = useState(false)
  useEffect(() => {
    const hoverable = window.matchMedia('(hover: hover)')
    setRowFields(hoverable.matches)
    const onChange = (event: MediaQueryListEvent) => setRowFields(event.matches)
    hoverable.addEventListener('change', onChange)
    return () => hoverable.removeEventListener('change', onChange)
  }, [])

  return (
    <div className="fleet-landing">
      <section className="fleet-hero" aria-labelledby="fleet-title">
        <div className="fleet-hero-field" aria-hidden="true">
          <Dither focus={[0.55, 0.5]} spread={[1.1, 1.2]} gain={1.1} />
        </div>
        <div className="fleet-hero-copy">
          <h1 id="fleet-title">
            Personal apps, <span>on your own computers.</span>
          </h1>
          <p>
            Your agent writes them. Fleet runs them. Every device on your tailnet can open them.
          </p>
          <div className="fleet-actions">
            <a className="fleet-button" href="/docs/quickstart">
              Get started
            </a>
            <a className="fleet-link" href="https://github.com/extoci/fleet">
              GitHub <Arrow />
            </a>
          </div>
          <pre className="fleet-terminal" aria-label="Example commands">
            <code>
              <span>$</span> curl -fsSL https://fleet.extoci.lol/install | bash{'\n'}
              <span>$</span> fleet setup --install{'\n'}
              <span>$</span> fleet init notes{'\n'}
              <span>$</span> fleet open notes
            </code>
          </pre>
        </div>
        <div className="fleet-hero-mark" aria-hidden="true">
          <Plumbob />
        </div>
      </section>

      <section className="fleet-guides" aria-labelledby="fleet-guides-title">
        <h2 id="fleet-guides-title">Docs</h2>
        <ul>
          {guides.map((guide, index) => (
            <li key={guide.href}>
              <a
                href={guide.href}
                onPointerEnter={() => setActiveRow(index)}
                onPointerLeave={() => setActiveRow((cur) => (cur === index ? null : cur))}
                onFocus={() => setActiveRow(index)}
                onBlur={() => setActiveRow((cur) => (cur === index ? null : cur))}
              >
                {rowFields && (
                  <span className="fleet-row-field" aria-hidden="true">
                    <Dither
                      focus={[1, 0.5]}
                      spread={[4, 8]}
                      gain={1.05}
                      pixelSize={2}
                      seed={index * 1.37}
                      active={activeRow === index}
                    />
                  </span>
                )}
                <span className="fleet-row-name">{guide.name}</span>
                <span className="fleet-row-text">{guide.text}</span>
                <RowArrow />
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
