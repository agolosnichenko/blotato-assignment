import { assert, constantFrom, date, property, record, uuid } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, type KeysetCursor } from '#src/shared/pagination.ts';

const arbitraryCursor = record({
  occurredAt: date({
    min: new Date(0),
    max: new Date('2200-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  }),
  id: uuid(),
  order: constantFrom('asc' as const, 'desc' as const),
});

const sampleCursor: KeysetCursor = {
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  id: '018f6f3e-2f1a-7c4a-9c1a-1234567890ab',
  order: 'desc',
};

describe('pagination cursor round-trip', () => {
  it('decodes what it encoded for any keyset position and order', () => {
    assert(
      property(arbitraryCursor, (cursor) => {
        const encoded = encodeCursor(cursor);
        const result = decodeCursor(encoded, cursor.order);

        expect(result).toEqual({ ok: true, cursor });
      }),
    );
  });
});

describe('pagination cursor hostile input', () => {
  it('rejects a cursor that is not valid base64url-encoded JSON', () => {
    const result = decodeCursor('!!!not-base64!!!', 'desc');

    expect(result).toEqual({ ok: false, error: 'MALFORMED' });
  });

  it('rejects a truncated cursor payload', () => {
    const encoded = encodeCursor(sampleCursor);
    const truncated = encoded.slice(0, encoded.length - 6);

    const result = decodeCursor(truncated, 'desc');

    expect(result).toEqual({ ok: false, error: 'MALFORMED' });
  });

  it('rejects a payload with the wrong field types', () => {
    const bogus = Buffer.from(
      JSON.stringify({ occurredAt: 42, id: null, order: 'desc' }),
      'utf8',
    ).toString('base64url');

    const result = decodeCursor(bogus, 'desc');

    expect(result).toEqual({ ok: false, error: 'MALFORMED' });
  });

  it('rejects a desc cursor replayed as asc', () => {
    const encoded = encodeCursor(sampleCursor);

    const result = decodeCursor(encoded, 'asc');

    expect(result).toEqual({ ok: false, error: 'ORDER_MISMATCH' });
  });
});
