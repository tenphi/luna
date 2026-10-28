import { describe, it, expect } from 'bun:test';

import { ToolCallSlots } from './tool-call-slots.js';

describe('ToolCallSlots', () => {
  it('keys on index when the endpoint numbers its fragments', () => {
    const slots = new ToolCallSlots();
    expect(slots.slotFor('call_a', 0)).toBe(0);
    expect(slots.slotFor('call_b', 1)).toBe(1);
    // Argument fragments arrive interleaved, each still carrying its index.
    expect(slots.slotFor(undefined, 1)).toBe(1);
    expect(slots.slotFor(undefined, 0)).toBe(0);
  });

  it('returns the same slot for a repeated id', () => {
    const slots = new ToolCallSlots();
    expect(slots.slotFor('call_a', 0)).toBe(0);
    expect(slots.slotFor('call_a', 0)).toBe(0);
    // An id outranks a contradictory index — ids are stable for the stream.
    expect(slots.slotFor('call_a', 3)).toBe(0);
  });

  it('gives a fresh slot to a new id that claims an occupied index', () => {
    // The failure this class exists for: a gateway stamping `index: 0` on every
    // call in the batch. Without the id rule all three would merge into slot 0,
    // concatenating names and arguments into one unparseable call.
    const slots = new ToolCallSlots();
    expect(slots.slotFor('call_a', 0)).toBe(0);
    expect(slots.slotFor('call_b', 0)).toBe(1);
    expect(slots.slotFor('call_c', 0)).toBe(2);
    // Continuations still route by id, not by the useless index.
    expect(slots.slotFor('call_b', 0)).toBe(1);
  });

  it('allocates sequentially when no index is sent at all', () => {
    const slots = new ToolCallSlots();
    expect(slots.slotFor('call_a', undefined)).toBe(0);
    expect(slots.slotFor('call_b', undefined)).toBe(1);
    expect(slots.slotFor('call_a', undefined)).toBe(0);
  });

  it('treats a fragment with neither id nor index as a continuation', () => {
    const slots = new ToolCallSlots();
    slots.slotFor('call_a', undefined);
    slots.slotFor('call_b', undefined);
    // Argument-only deltas belong to whatever call is currently open.
    expect(slots.slotFor(undefined, undefined)).toBe(1);
    slots.slotFor('call_a', undefined);
    expect(slots.slotFor(undefined, undefined)).toBe(0);
  });

  it('does not let a sparse index collide with a later allocation', () => {
    const slots = new ToolCallSlots();
    expect(slots.slotFor('call_a', 5)).toBe(5);
    // The high-water mark moved past 5, so a fresh id cannot land back on it.
    expect(slots.slotFor('call_b', 5)).toBe(6);
  });

  it('ignores a non-integer or negative index', () => {
    const slots = new ToolCallSlots();
    expect(slots.slotFor('call_a', -1)).toBe(0);
    expect(slots.slotFor('call_b', 1.5)).toBe(1);
  });

  it('ignores a blank id', () => {
    const slots = new ToolCallSlots();
    expect(slots.slotFor('   ', 0)).toBe(0);
    expect(slots.slotFor('', 0)).toBe(0);
  });
});
