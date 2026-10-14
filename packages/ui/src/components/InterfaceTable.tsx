// Convert mode's interface table: every interface the source names, and its name on the target. None is renamed
// silently: a row stays unnamed (and the output keeps the source name) until the user types a name, takes the
// suggestion, or loads a map. Maps load and save as `from,to` lines or JSON, the CLI's --map format.
import { formatInterfaceMap } from '@dialect/core'
import { loadInterfaceMap } from '../actions'
import type { Platform } from '../platform'
import { SOURCE_PLUGIN, targetPlugin, useStore, type ConversionTab } from '../store'
import { CheckIcon, OpenIcon, SaveIcon, WarningIcon } from './Icons'

export function InterfaceTable({ tab, platform }: { tab: ConversionTab; platform: Platform }) {
  const { interfaces, interfaceMap } = tab
  const { setInterfaceName, takeSuggestions, revealAt, notify } = useStore.getState()
  const target = targetPlugin(tab.job.kind === 'convert' ? tab.job.target : '')
  const unnamed = interfaces.filter((i) => i.target === undefined)
  const suggestible = unnamed.filter((i) => i.suggestion)

  const saveMap = async (): Promise<void> => {
    try {
      await platform.saveText('interfaces.csv', formatInterfaceMap(interfaceMap), 'interface-map')
    } catch (e) {
      notify('error', `Couldn't save the map: ${(e as Error).message}`)
    }
  }

  return (
    <section className="interfaces" aria-label="Interfaces">
      <div className="section-header">
        <span>Interfaces</span>
        <span className="count" data-testid="interface-count">
          {interfaces.length === 0 ? 'none' : unnamed.length ? `${unnamed.length} of ${interfaces.length} need a name` : `all ${interfaces.length} named`}
        </span>
        <span className="section-actions">
          <button className="btn small" onClick={takeSuggestions} disabled={suggestible.length === 0} title="Name every unnamed interface as suggested">
            Use suggestions
          </button>
          <button className="btn small" onClick={() => void loadInterfaceMap(platform, tab.id)} title="Load names from a map file: from,to lines, or JSON">
            <OpenIcon /> Load map…
          </button>
          <button className="btn small" onClick={() => void saveMap()} disabled={Object.keys(interfaceMap).length === 0} title="Save the names as a map file (from,to lines), for next time or the command line">
            <SaveIcon /> Save map
          </button>
        </span>
      </div>
      {interfaces.length === 0 ? (
        <div className="problem-empty">The interfaces the config names appear here, to be named on {target.name}.</div>
      ) : (
        <div className="interface-scroll">
          <table className="interface-table">
            <thead>
              <tr>
                <th scope="col">{SOURCE_PLUGIN.name}</th>
                <th scope="col">{target.name}</th>
                <th scope="col">
                  <span className="visually-hidden">Suggestion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {interfaces.map((i) => (
                <tr key={i.source} className={i.target === undefined ? 'unnamed' : undefined} data-interface={i.source}>
                  <td>
                    <button className="link-button" onClick={() => i.line && revealAt('source', i.line, 1, true)} disabled={!i.line} title={i.line ? `Show it in the source (line ${i.line})` : undefined}>
                      {i.target === undefined ? <WarningIcon /> : <CheckIcon />}
                      <span>{i.source}</span>
                    </button>
                  </td>
                  <td>
                    <input
                      className="name-input"
                      aria-label={`${i.source} on ${target.name}`}
                      value={interfaceMap[i.source] ?? ''}
                      placeholder={i.suggestion ? `${i.suggestion} (suggested)` : 'Name it'}
                      spellCheck={false}
                      onChange={(e) => setInterfaceName(i.source, e.target.value)}
                    />
                  </td>
                  <td>
                    {i.suggestion && i.target !== i.suggestion && (
                      <button className="btn small subtle" onClick={() => setInterfaceName(i.source, i.suggestion!)} title={`Name it ${i.suggestion}`} aria-label={`Use ${i.suggestion} for ${i.source}`}>
                        Use
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
