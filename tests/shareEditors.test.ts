import { describe, expect, it } from 'vitest';
import { checkEditorEmail } from '../src/lib/utils/shareEditors';

describe('checkEditorEmail', () => {
  it('normalises a valid email', () => {
    expect(checkEditorEmail('  Ann@Example.COM ', [])).toEqual({ email: 'ann@example.com' });
  });
  it('rejects empty, malformed and duplicate input', () => {
    expect(checkEditorEmail('   ', [])).toEqual({ problem: 'empty' });
    for (const bad of ['ann', 'ann@', '@x.com', 'a b@x.com', 'ann@x', 'ann@x..com']) {
      expect(checkEditorEmail(bad, [])).toEqual({ problem: 'invalid' });
    }
    expect(checkEditorEmail('ANN@example.com', ['ann@example.com'])).toEqual({ problem: 'duplicate' });
  });
});
