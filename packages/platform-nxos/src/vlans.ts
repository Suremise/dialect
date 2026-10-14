// VLAN lists as NX-OS writes them (`vlan 4,6-8`, `switchport trunk allowed vlan 10,20-30`) and as the model keeps a
// trunk's allowed VLANs: a leaf-list of single IDs (`"10"`) and ranges (`"20-30"`, first below last), 1 to 4094.

/** Every VLAN, as the model writes it. */
export const ALL_VLANS = '1-4094'

const ID = /^\d{1,4}$/
const vlanId = (s: string): number | null => (ID.test(s) && Number(s) >= 1 && Number(s) <= 4094 ? Number(s) : null)

/**
 * A VLAN list's entries, as the model writes them (`"10"`, `"20-30"`, a range of one VLAN as its ID), in the list's
 * order; null when an entry isn't a VLAN ID or a range of them from 1 to 4094, first not above last.
 */
export function vlanEntries(text: string): string[] | null {
  const out: string[] = []
  for (const part of text.split(',')) {
    const m = /^([^-]+)(?:-([^-]+))?$/.exec(part)
    const first = m ? vlanId(m[1]) : null
    const last = m?.[2] !== undefined ? vlanId(m[2]) : first
    if (first === null || last === null || first > last) return null
    out.push(first === last ? String(first) : `${first}-${last}`)
  }
  return out
}

/** The VLAN IDs a list's entries cover, in order, each once. */
export function vlanIds(entries: readonly string[]): number[] {
  const out = new Set<number>()
  for (const entry of entries) {
    const [first, last = first] = entry.split('-').map(Number)
    for (let id = first; id <= last; id++) out.add(id)
  }
  return [...out]
}

/** VLAN IDs as the model's entries: sorted, each run of consecutive IDs a range (`[1, 2, 3, 5]` → `1-3`, `5`). */
export function compactVlans(ids: Iterable<number>): string[] {
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return out
}
