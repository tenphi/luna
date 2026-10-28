import { describe, it, expect } from 'bun:test';

import { stripHarmonyMarkers, stripReasoningArtifacts, stripReasoningTags } from './reasoning-tags.js';

describe('stripReasoningTags', () => {
  it('strips a stray closing tag leaked at the start (MiniMax-M3 on DeepInfra)', () => {
    expect(stripReasoningTags('</mm:think>The weather in Paris is sunny.')).toBe('The weather in Paris is sunny.');
  });

  it('strips a complete namespaced think block', () => {
    expect(stripReasoningTags('<mm:think>lots of reasoning</mm:think>\n\nHello!')).toBe('\n\nHello!');
  });

  it('strips a plain <think> block (Qwen/other reasoning models)', () => {
    expect(stripReasoningTags('<think>internal</think>Answer')).toBe('Answer');
  });

  it('strips orphaned open and close tags with attributes', () => {
    expect(stripReasoningTags('<think type="x">only reasoning, cut off')).toBe('only reasoning, cut off');
    expect(stripReasoningTags('done</think>')).toBe('done');
  });

  it('never touches ordinary prose containing the word think', () => {
    expect(stripReasoningTags('I think this is correct.')).toBe('I think this is correct.');
  });

  it('leaves tag-free text untouched and handles empties', () => {
    expect(stripReasoningTags('plain answer')).toBe('plain answer');
    expect(stripReasoningTags('')).toBe('');
  });

  it('reduces a tag-only leak to empty (so the loop treats it as no answer)', () => {
    expect(stripReasoningTags('</mm:think>').trim()).toBe('');
  });

  it('strips Gemma 4 <internal> reasoning blocks', () => {
    expect(
      stripReasoningTags(
        '<internal>\nThe user is asking for ZQX. I will search.\n</internal><call:web_search query="x"/>',
      ),
    ).toBe('<call:web_search query="x"/>');
  });

  it('strips orphaned <internal> open tags', () => {
    expect(stripReasoningTags('<internal>reasoning cut off')).toBe('reasoning cut off');
  });
});

describe('stripHarmonyMarkers', () => {
  it('keeps only the final answer after a mangled channel marker (GPT-OSS leak)', () => {
    // Observed: leading channel/label preamble then the answer after `<channel|>`.
    expect(
      stripHarmonyMarkers('thought\n<channel|>Done! I\'ve added the event to your Household calendar.'),
    ).toBe("Done! I've added the event to your Household calendar.");
  });

  it('handles a leak with both mangled markers around the reasoning label', () => {
    expect(stripHarmonyMarkers('<|channel>thought\n<channel|>Since I could not load details, here is a draft.')).toBe(
      'Since I could not load details, here is a draft.',
    );
  });

  it('reduces a bare reasoning-channel label to empty', () => {
    expect(stripHarmonyMarkers('thought')).toBe('');
    expect(stripHarmonyMarkers('analysis')).toBe('');
  });

  it('parses well-formed harmony channels and keeps the final body', () => {
    expect(
      stripHarmonyMarkers('<|channel|>analysis<|message|>reasoning here<|end|><|channel|>final<|message|>The answer.'),
    ).toBe('The answer.');
  });

  it('keeps the final body even when a terminator token trails it', () => {
    expect(stripHarmonyMarkers('<|channel|>final<|message|>The answer.<|return|>')).toBe('The answer.');
  });

  it('drops a leading label left on its own line after the marker', () => {
    expect(stripHarmonyMarkers('<|channel|>final\nThe answer.')).toBe('The answer.');
  });

  it('never touches the agent\'s own <message to="…"> addressing tags', () => {
    const addressed = '<message to="Laura">Hi Laura, running late.</message>';
    expect(stripHarmonyMarkers(addressed)).toBe(addressed);
  });

  it('leaves ordinary prose (including angle brackets and the word thought) untouched', () => {
    expect(stripHarmonyMarkers('I thought about it: a < b and c > d.')).toBe('I thought about it: a < b and c > d.');
    expect(stripHarmonyMarkers('plain answer')).toBe('plain answer');
    expect(stripHarmonyMarkers('')).toBe('');
  });
});

describe('stripReasoningArtifacts', () => {
  it('strips harmony markers and think tags together', () => {
    expect(stripReasoningArtifacts('thought\n<channel|>Done!')).toBe('Done!');
    expect(stripReasoningArtifacts('<think>reasoning</think>Answer')).toBe('Answer');
    expect(stripReasoningArtifacts('<|channel>thought\n<channel|>The <think>x</think>result.')).toBe('The result.');
  });
});
