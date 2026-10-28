import { describe, expect, test } from 'bun:test';

import {
  filterMcpToolNames,
  filterMcpToolNamesWithWarnings,
  hasMcpToolFilter,
} from './filter-tools.js';

const ALL = ['search', 'get_page', 'put_page', 'code_callers'];

describe('filterMcpToolNames', () => {
  test('no policy returns all names', () => {
    expect(filterMcpToolNames(ALL)).toEqual(ALL);
    expect(filterMcpToolNames(ALL, {})).toEqual(ALL);
  });

  test('non-empty allowlist keeps only listed tools', () => {
    expect(filterMcpToolNames(ALL, { toolsAllow: ['search', 'get_page'] })).toEqual(['search', 'get_page']);
  });

  test('empty allowlist returns no tools', () => {
    expect(filterMcpToolNames(ALL, { toolsAllow: [] })).toEqual([]);
  });

  test('ignore only removes listed tools', () => {
    expect(filterMcpToolNames(ALL, { toolsIgnore: ['code_callers'] })).toEqual([
      'search',
      'get_page',
      'put_page',
    ]);
  });

  test('allow then ignore', () => {
    expect(
      filterMcpToolNames(ALL, {
        toolsAllow: ['search', 'get_page', 'code_callers'],
        toolsIgnore: ['code_callers'],
      }),
    ).toEqual(['search', 'get_page']);
  });

  test('unknown allow names are reported', () => {
    const { filtered, unknownAllow } = filterMcpToolNamesWithWarnings(ALL, {
      toolsAllow: ['search', 'not_a_tool'],
    });
    expect(filtered).toEqual(['search']);
    expect(unknownAllow).toEqual(['not_a_tool']);
  });
});

describe('hasMcpToolFilter', () => {
  test('false when no policy', () => {
    expect(hasMcpToolFilter()).toBe(false);
    expect(hasMcpToolFilter({})).toBe(false);
  });

  test('true when allow or ignore set', () => {
    expect(hasMcpToolFilter({ toolsAllow: [] })).toBe(true);
    expect(hasMcpToolFilter({ toolsIgnore: ['x'] })).toBe(true);
  });
});
