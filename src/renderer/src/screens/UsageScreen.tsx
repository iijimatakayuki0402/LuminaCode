import { useCallback, useEffect, useState } from 'react'
import type { Project, ProjectUsage, UsageLimits, UsageSummary } from '@shared/types'
import { Message, type MessageState } from '../components/Message'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

/**
 * 使用量画面（要件 USG-02: スレッド・プロジェクト・全体（月別）の累計。USG-03: プロジェクト別の上限）
 */
export function UsageScreen(): React.JSX.Element {
  const [month, setMonth] = useState<string | undefined>(undefined)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [limits, setLimits] = useState<UsageLimits | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [message, setMessage] = useState<MessageState | null>(null)

  const fetchAll = useCallback(
    (m?: string) =>
      Promise.all([
        unwrap(window.lumina.usage.summary(m)),
        unwrap(window.lumina.usage.getLimits()),
        unwrap(window.lumina.projects.list({ includeArchived: true }))
      ]),
    []
  )

  useEffect(() => {
    let active = true
    fetchAll(month)
      .then(([s, l, p]) => {
        if (!active) return
        setSummary(s)
        setLimits(l)
        setProjects(p)
      })
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [fetchAll, month])

  const reload = async (): Promise<void> => {
    const [s, l, p] = await fetchAll(month)
    setSummary(s)
    setLimits(l)
    setProjects(p)
  }

  if (!summary || !limits) {
    return (
      <main className="screen">
        <Message message={message} />
        <p className="muted">{ja.common.loading}</p>
      </main>
    )
  }

  const total = summary.total
  const ratio = limits.monthlyLimit ? Math.min(1, total.cost / limits.monthlyLimit) : 0
  // USG-03: 当月に使用量のないプロジェクトにも上限を設定できるよう、全プロジェクトを並べる
  const rows: ProjectUsage[] = [
    ...summary.projects,
    ...projects
      .filter((p) => !summary.projects.some((u) => u.project_id === p.id))
      .map((p) => ({
        project_id: p.id,
        project_name: p.name,
        totals: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost: 0,
          requests: 0
        },
        limit: summary.projectLimits[p.id] ?? null
      }))
  ]
  const months = summary.months.some((m) => m.month === summary.month)
    ? summary.months
    : [{ month: summary.month, totals: total }, ...summary.months]

  return (
    <main className="screen" style={{ maxWidth: '64rem' }}>
      <h1 className="screen-title">{ja.usage.title}</h1>
      {/* USG-05: 概算である旨を明記する */}
      <p className="message message-info">{ja.usage.disclaimer}</p>
      <Message message={message} />

      <section className="panel" aria-labelledby="usage-total">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 id="usage-total">{ja.usage.total}</h2>
          <select
            className="select"
            aria-label={ja.usage.month}
            value={summary.month}
            onChange={(e) => setMonth(e.target.value)}
          >
            {months.map((m) => (
              <option key={m.month} value={m.month}>
                {m.month}
              </option>
            ))}
          </select>
        </div>
        <p className="usage-big mono">
          {limits.monthlyLimit
            ? ja.usage.ofLimit(total.cost, limits.monthlyLimit)
            : `${ja.usage.cost(total.cost)}（${ja.usage.noLimit}）`}
        </p>
        {limits.monthlyLimit && (
          <div
            className={`meter${ratio >= 1 ? ' over' : ratio >= 0.8 ? ' warn' : ''}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
          >
            <span style={{ width: `${ratio * 100}%` }} />
          </div>
        )}
        <p className="hint">
          {ja.usage.tokens(total.input_tokens, total.output_tokens)}・
          {ja.usage.requests(total.requests)}
        </p>
      </section>

      <section className="panel" aria-labelledby="usage-projects">
        <h2 id="usage-projects">{ja.usage.byProject}</h2>
        {rows.length === 0 ? (
          <p className="hint">{ja.usage.none}</p>
        ) : (
          <table className="log-table">
            <thead>
              <tr>
                <th>{ja.usage.project}</th>
                <th>{ja.usage.costColumn}</th>
                <th>{ja.usage.tokensColumn}</th>
                <th>{ja.usage.projectLimit}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <ProjectRow
                  key={p.project_id ?? p.project_name}
                  usage={p}
                  onSaved={() => void reload()}
                  onError={(text) => setMessage({ tone: 'error', text })}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" aria-labelledby="usage-months">
        <h2 id="usage-months">{ja.usage.byMonth}</h2>
        <ul className="month-list">
          {months.map((m) => (
            <li key={m.month} className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mono">{m.month}</span>
              <span className="mono">{ja.usage.cost(m.totals.cost)}</span>
              <span className="hint">{ja.usage.requests(m.totals.requests)}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}

function ProjectRow({
  usage,
  onSaved,
  onError
}: {
  usage: ProjectUsage
  onSaved: () => void
  onError: (text: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(usage.limit?.toString() ?? '')
  const save = async (limit: number | null): Promise<void> => {
    if (!usage.project_id) return
    try {
      await unwrap(window.lumina.usage.setProjectLimit(usage.project_id, limit))
      onSaved()
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <tr>
      <td>{usage.project_name}</td>
      <td className="mono">{ja.usage.cost(usage.totals.cost)}</td>
      <td className="mono">
        {(usage.totals.input_tokens + usage.totals.output_tokens).toLocaleString()}
      </td>
      <td>
        {usage.project_id && (
          <span className="row" style={{ gap: '0.25rem' }}>
            <input
              className="input"
              style={{ width: '6rem' }}
              type="number"
              min={0}
              step="0.01"
              aria-label={`${usage.project_name} ${ja.usage.projectLimit}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => void save(value === '' ? null : Number(value))}
            >
              {ja.usage.setLimit}
            </button>
            {usage.limit !== null && (
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => {
                  setValue('')
                  void save(null)
                }}
              >
                {ja.usage.clearLimit}
              </button>
            )}
          </span>
        )}
      </td>
    </tr>
  )
}
