import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResidentCsv, validateResident } from '../backend/residents.js';

test('CSV handles BOM, CRLF and quoted names while preserving contact digits', () => {
  const result = parseResidentCsv(Buffer.from('\ufeffname,contact_number,age,sex\r\n"Dela Cruz, Ana ""Ann""",09123456789,22,Female\r\n'));
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows[0].name, 'Dela Cruz, Ana "Ann"');
  assert.equal(result.rows[0].contactNumber, '09123456789');
});

test('CSV reports invalid fields and marks normalized repeated identities', () => {
  const result = parseResidentCsv(Buffer.from('name,contact_number,age,sex\nAna,09123456789,22,F\n ANA ,0912-345-6789,23,Female\nBen,abc,-1,Male'));
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.duplicateRows, [3]);
  assert.equal(result.errors[0].row, 4);
  assert.throws(() => validateResident({ name: 'Ana', contactNumber: '09123456789', age: '', sex: 'Female' }));
  assert.throws(() => parseResidentCsv(Buffer.from('name,contact_number,age,sex\n"Ana,09123456789,22,Female')), { status: 400 });
});
