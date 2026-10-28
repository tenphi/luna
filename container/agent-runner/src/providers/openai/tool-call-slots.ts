/**
 * Slot assignment for tool calls accumulated from a stream.
 *
 * A streamed batch arrives as fragments: one delta carries `{index, id, name}`,
 * later deltas carry `{index, arguments}` pieces that have to land on the same
 * accumulator. Spec-compliant endpoints number every fragment with `index`, so
 * the index alone is enough — but a gateway that omits it, or stamps `index: 0`
 * on every call in the batch, would collapse the whole batch into one slot:
 * names concatenate (`search_memory` + `get_memory_page`) and argument
 * fragments concatenate into `{"a":1}{"b":2}`, which fails `JSON.parse` and
 * dispatches with empty args. One garbled call instead of three good ones, with
 * nothing in the logs to say so.
 *
 * **`id` is the authority, `index` is a hint.** A call's id is stable for the
 * whole stream and unique within the batch, so a fragment bearing a *new* id is
 * a new call no matter what its index claims. That single rule is what makes
 * the `index: 0`-for-everything case work, and it degrades to plain
 * index-keying on endpoints that behave.
 */

/** Ordered slot allocator; one instance per streamed completion. */
export class ToolCallSlots {
  /** Slot for each id seen so far — ids outrank indices. */
  private readonly byId = new Map<string, number>();
  /** Ids claimed per slot, so a fresh id never lands on an occupied one. */
  private readonly idBySlot = new Map<number, string>();
  /** Where a fragment with neither id nor index continues. */
  private lastSlot = 0;
  /** High-water mark, so a fresh allocation never collides. */
  private nextFree = 0;

  /**
   * Resolve the accumulator a streamed fragment belongs to.
   *
   * @param id       `tc.id` from the delta, when present.
   * @param index    `tc.index` from the delta, when it is a number.
   */
  slotFor(id: string | undefined, index: number | undefined): number {
    const key = typeof id === 'string' && id.trim() ? id.trim() : null;
    const hinted = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null;

    if (key !== null) {
      const known = this.byId.get(key);
      if (known !== undefined) return this.remember(known);

      // A new id: take the hinted slot only if no other id owns it. Otherwise
      // the endpoint is reusing indices and we allocate past the high-water
      // mark — the case a naive `tc.index ?? 0` turns into one garbled call.
      const claimant = hinted !== null ? this.idBySlot.get(hinted) : undefined;
      const slot = hinted !== null && claimant === undefined ? hinted : this.nextFree;
      this.byId.set(key, slot);
      this.idBySlot.set(slot, key);
      return this.remember(slot);
    }

    // No id. A numeric index is still trustworthy on its own — an endpoint that
    // omits ids has nothing better to offer, and holes get compacted later.
    if (hinted !== null) return this.remember(hinted);

    // Neither: a pure arguments continuation of whatever we are building.
    return this.lastSlot;
  }

  private remember(slot: number): number {
    this.lastSlot = slot;
    if (slot >= this.nextFree) this.nextFree = slot + 1;
    return slot;
  }
}
