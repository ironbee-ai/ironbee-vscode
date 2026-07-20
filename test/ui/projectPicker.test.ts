import { describe, it, expect } from 'vitest';
import { dedupePaths } from '../../src/ui/projectPicker';

describe('dedupePaths', () => {
    it('removes duplicates preserving first-seen order', () => {
        expect(dedupePaths(['/a', '/b', '/a', '/c', '/b'])).toEqual(['/a', '/b', '/c']);
    });
    it('drops empty entries', () => {
        expect(dedupePaths(['/a', '', '/b'])).toEqual(['/a', '/b']);
    });
    it('returns [] for empty input', () => {
        expect(dedupePaths([])).toEqual([]);
    });
});
