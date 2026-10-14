// Convert mode's needs-input panel: what the target asks for besides interface names (an OSPF key, a BGP password, a
// route policy, a VRF's route distinguisher), each by its source line and the plugin's question, with a field for the
// answer. Secrets are masked unless the user shows them. Answers live in the tab's memory only, never in storage, and
// no message repeats one.
import { useState } from 'react'
import { useStore, type ConversionTab } from '../store'
import { CheckIcon, WarningIcon } from './Icons'

export function NeedsInputPanel({ tab }: { tab: ConversionTab }) {
  const { inputs, answers } = tab
  const { setAnswer, revealAt } = useStore.getState()
  const [shown, setShown] = useState(false)
  const open = inputs.filter((i) => !i.answered).length
  const secrets = inputs.some((i) => i.kind === 'secret')

  return (
    <section className="needs-input" aria-label="Needs input">
      <div className="section-header">
        <span>Needs input</span>
        <span className="count" data-testid="input-count">
          {open ? `${open} of ${inputs.length} need an answer` : `all ${inputs.length} answered`}
        </span>
        {secrets && (
          <span className="section-actions">
            <button className="btn small" aria-pressed={shown} onClick={() => setShown(!shown)} title={shown ? 'Mask the keys and passwords again' : 'Show the keys and passwords as typed'}>
              {shown ? 'Hide secrets' : 'Show secrets'}
            </button>
          </span>
        )}
      </div>
      <ul className="input-list">
        {inputs.map((i, n) => {
          const label = `${tab.id}-input-${n}`
          return (
            <li key={i.id} className={`input-row${i.answered ? '' : ' unanswered'}`} data-input={i.kind}>
              <div className="input-question">
                {i.answered ? <CheckIcon /> : <WarningIcon />}
                <span id={label} className="input-message">
                  {i.message}
                </span>
                {i.lines.length > 0 && (
                  <span className="problem-place input-lines">
                    {i.lines.map((line) => (
                      <button key={line} className="link-button" onClick={() => revealAt('source', line, 1, true)} title={`Show it in the source (line ${line})`}>
                        <span>line {line}</span>
                      </button>
                    ))}
                  </span>
                )}
              </div>
              <input
                className="name-input"
                type={i.kind === 'secret' && !shown ? 'password' : 'text'}
                aria-labelledby={label}
                aria-invalid={i.rejected || undefined}
                value={answers[i.id] ?? ''}
                placeholder={i.kind === 'secret' ? 'Key or password' : 'Answer'}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setAnswer(i.id, e.target.value)}
              />
              {i.rejected && (
                <div className="input-note" role="status">
                  Not in the form asked for, so it isn't used.
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
