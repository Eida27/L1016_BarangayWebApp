import { z } from 'zod';
import { HttpError } from './workflow.js';

export const residentCsvLimit = 2 * 1024 * 1024;
const sexValues = new Map([
  ['f', 'female'], ['female', 'female'], ['m', 'male'], ['male', 'male'],
  ['other', 'other'], ['undisclosed', 'undisclosed'],
]);
const schema = z.object({
  name: z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  contactNumber: z.string().trim().max(40).regex(/^\+?[\d ().-]+$/).refine(value => {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
  }),
  age: z.union([z.number(), z.string().trim().regex(/^\d{1,3}$/).transform(Number)])
    .pipe(z.number().int().min(0).max(130)),
  sex: z.string().trim().toLowerCase().transform(value => sexValues.get(value))
    .pipe(z.enum(['female', 'male', 'other', 'undisclosed'])),
});

export function validateResident(input) {
  const resident = schema.parse(input);
  const digits = resident.contactNumber.replace(/\D/g, '');
  return {
    ...resident,
    nameKey: resident.name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '),
    contactKey: digits.length === 12 && digits.startsWith('639') ? '0' + digits.slice(2) : digits,
  };
}

export function parseResidentCsv(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, 'Send a UTF-8 CSV file.');
  if (buffer.length > residentCsvLimit) throw new HttpError(413, 'The CSV exceeds 2 MiB.');
  let csv;
  try {
    csv = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new HttpError(400, 'Save the CSV as UTF-8.');
  }
  // The sticky match consumes one complete field and its separator.
  const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r\n|\r|\n|$)/y;
  const rows = [], errors = [], duplicateRows = [];
  const identities = new Set();
  let row = 1, count = 0, cursor = 0, cells = [];
  const columns = ['name', 'contact_number', 'age', 'sex'];
  const fields = ['name', 'contactNumber', 'age', 'sex'];
  while (cursor < csv.length || cells.length) {
    field.lastIndex = cursor;
    const match = field.exec(csv);
    if (!match) throw new HttpError(400, 'Malformed CSV at row ' + row + '. Check the quotes and separators.');
    cursor = field.lastIndex;
    cells.push(match[1] === undefined ? match[2] : match[1].replaceAll('""', '"'));
    if (match[3] === ',') continue;

    if (row === 1) {
      if (cells.length !== columns.length || !columns.every((column, index) => cells[index].trim() === column)) {
        throw new HttpError(400, 'Use the CSV headers name,contact_number,age,sex in that order.');
      }
    } else if (cells.length !== 1 || cells[0].trim()) {
      if (++count > 5000) throw new HttpError(400, 'The CSV exceeds 5,000 data rows.');
      if (cells.length !== fields.length) {
        errors.push({ row, message: 'Expected four columns.' });
      } else {
        try {
          const resident = validateResident(Object.fromEntries(fields.map((name, index) => [name, cells[index]])));
          const identity = JSON.stringify([resident.nameKey, resident.contactKey]);
          if (identities.has(identity)) duplicateRows.push(row);
          else {
            identities.add(identity);
            rows.push({ row, ...resident });
          }
        } catch (error) {
          if (!(error instanceof z.ZodError)) throw error;
          const invalid = [...new Set(error.issues.map(issue => columns[fields.indexOf(issue.path[0])]))];
          errors.push({ row, message: 'Check ' + invalid.join(', ') + '.' });
        }
      }
    }
    cells = [];
    row++;
  }
  if (!count) throw new HttpError(400, 'The CSV must contain at least one resident.');
  return { rows, errors, duplicateRows };
}

const recordset = 'jsonb_to_recordset($1::jsonb) AS input(row integer, name text, "contactNumber" text, age integer, sex text, "nameKey" text, "contactKey" text)';

export async function previewResidents(client, rows) {
  const result = await client.query(
    'SELECT input.row FROM ' + recordset +
    ' JOIN resident_register r ON (r.name_key, r.contact_key) = (input."nameKey", input."contactKey")',
    [JSON.stringify(rows)],
  );
  return result.rows.map(record => record.row);
}

export async function insertResidents(client, rows, source) {
  const result = await client.query(
    'INSERT INTO resident_register (name, contact_number, age, sex, name_key, contact_key, source) ' +
    'SELECT name, "contactNumber", age, sex, "nameKey", "contactKey", $2 FROM ' + recordset +
    ' ORDER BY "nameKey", "contactKey" ON CONFLICT (name_key, contact_key) DO NOTHING RETURNING id, name_key, contact_key',
    [JSON.stringify(rows), source],
  );
  return result.rows;
}
