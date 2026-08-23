import { describe, it, expect } from 'vitest';
import { createInMemorySecureStore } from './secure-store.js';

describe('in-memory secure store', () => {
  it('round-trips and deletes a value', async () => {
    const store = createInMemorySecureStore();
    expect(await store.getItem('k')).toBeNull();

    await store.setItem('k', 'v');
    expect(await store.getItem('k')).toBe('v');

    await store.deleteItem('k');
    expect(await store.getItem('k')).toBeNull();
  });
});
