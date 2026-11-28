/**
 * JavaScript members known to script completion: methods / properties of the
 * value kinds a script handles (strings, numbers, dates, BSON helpers from the
 * shell worker, arrays, Map / Set) and the built-in namespaces (Math, JSON, …).
 *
 * `returns` lets the script typer follow chains (`name.trim().toUpperCase().`):
 * a kind, `same` (the receiver's type, e.g. filter / slice) or `elem` (an
 * element of the receiver array, e.g. find / at).
 *
 * Insert texts are Monaco snippets; `@x` is replaced by a callback parameter
 * name derived from the receiver (`covers` → `cover`).
 */

export type JsKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'objectId'
  | 'decimal'
  | 'long'
  | 'uuid'
  | 'array'
  | 'map'
  | 'set'
  | 'object'
  | 'regexp';

export type Returns = JsKind | 'same' | 'elem';

export interface JsMember {
  name: string;
  insert: string;
  doc: string;
  returns?: Returns;
  /** Element kind of a returned array (`split` → string[]). */
  of?: JsKind;
  /** Property (no call). */
  prop?: boolean;
}

const m = (name: string, insert: string, doc: string, returns?: Returns, of?: JsKind): JsMember => ({
  name,
  insert,
  doc,
  ...(returns ? { returns } : {}),
  ...(of ? { of } : {}),
});
const p = (name: string, doc: string, returns?: Returns): JsMember => ({ name, insert: name, doc, prop: true, ...(returns ? { returns } : {}) });

const CB = '((${1:@x}) => ${1:@x}$0)';

export const MEMBERS: Record<JsKind, JsMember[]> = {
  string: [
    p('length', 'Number of characters', 'number'),
    m('toUpperCase', 'toUpperCase()', 'Upper-case copy', 'string'),
    m('toLowerCase', 'toLowerCase()', 'Lower-case copy', 'string'),
    m('trim', 'trim()', 'Without leading / trailing whitespace', 'string'),
    m('trimStart', 'trimStart()', 'Without leading whitespace', 'string'),
    m('trimEnd', 'trimEnd()', 'Without trailing whitespace', 'string'),
    m('startsWith', 'startsWith("$0")', 'Starts with the text?', 'boolean'),
    m('endsWith', 'endsWith("$0")', 'Ends with the text?', 'boolean'),
    m('includes', 'includes("$0")', 'Contains the text?', 'boolean'),
    m('indexOf', 'indexOf("$0")', 'Position of the text (-1 if missing)', 'number'),
    m('slice', 'slice(${1:0}, ${2:10})', 'Part of the string', 'string'),
    m('substring', 'substring(${1:0}, ${2:10})', 'Part of the string', 'string'),
    m('split', 'split("${1:,}")', 'Split into an array of strings', 'array', 'string'),
    m('replace', 'replace(${1:/pattern/}, "$2")', 'Replace the first match (or all with /g)', 'string'),
    m('replaceAll', 'replaceAll("$1", "$2")', 'Replace every occurrence', 'string'),
    m('padStart', 'padStart(${1:10}, "${2: }")', 'Pad on the left to a length (aligned columns)', 'string'),
    m('padEnd', 'padEnd(${1:10}, "${2: }")', 'Pad on the right to a length (aligned columns)', 'string'),
    m('match', 'match(/$0/)', 'Regular-expression match (array or null)', 'array', 'string'),
    m('localeCompare', 'localeCompare($0)', 'Sort comparison (-1, 0, 1)', 'number'),
    m('charAt', 'charAt(${1:0})', 'Character at a position', 'string'),
    m('at', 'at(${1:-1})', 'Character at a position (negative from the end)', 'string'),
    m('repeat', 'repeat(${1:2})', 'Repeated N times', 'string'),
    m('concat', 'concat($0)', 'Joined with other strings', 'string'),
  ],
  number: [
    m('toFixed', 'toFixed(${1:2})', 'Fixed decimal places, as text', 'string'),
    m('toPrecision', 'toPrecision(${1:4})', 'Significant digits, as text', 'string'),
    m('toLocaleString', 'toLocaleString("${1:pl-PL}")', 'Formatted with thousands separators', 'string'),
    m('toString', 'toString()', 'As text', 'string'),
  ],
  boolean: [m('toString', 'toString()', 'As text', 'string')],
  date: [
    m('toISOString', 'toISOString()', 'ISO 8601 text (UTC)', 'string'),
    m('getTime', 'getTime()', 'Milliseconds since 1970 (compare / subtract dates)', 'number'),
    m('getFullYear', 'getFullYear()', 'Year (local time)', 'number'),
    m('getMonth', 'getMonth()', 'Month 0–11 (local time)', 'number'),
    m('getDate', 'getDate()', 'Day of the month (local time)', 'number'),
    m('getDay', 'getDay()', 'Day of the week, 0 = Sunday', 'number'),
    m('getHours', 'getHours()', 'Hour (local time)', 'number'),
    m('getMinutes', 'getMinutes()', 'Minutes', 'number'),
    m('getSeconds', 'getSeconds()', 'Seconds', 'number'),
    m('getUTCFullYear', 'getUTCFullYear()', 'Year (UTC)', 'number'),
    m('getUTCMonth', 'getUTCMonth()', 'Month 0–11 (UTC)', 'number'),
    m('getUTCDate', 'getUTCDate()', 'Day of the month (UTC)', 'number'),
    m('toLocaleDateString', 'toLocaleDateString("${1:pl-PL}")', 'Local date text', 'string'),
    m('toLocaleString', 'toLocaleString("${1:pl-PL}")', 'Local date and time text', 'string'),
    m('setDate', 'setDate($0)', 'Change the day of the month (mutates)', 'number'),
    m('setFullYear', 'setFullYear($0)', 'Change the year (mutates)', 'number'),
    m('toJSON', 'toJSON()', 'ISO text', 'string'),
  ],
  objectId: [
    m('toHexString', 'toHexString()', '24-character hex text', 'string'),
    m('toString', 'toString()', '24-character hex text', 'string'),
    m('getTimestamp', 'getTimestamp()', 'Creation time encoded in the id', 'date'),
    m('equals', 'equals($0)', 'Same id? (=== compares references, use this)', 'boolean'),
  ],
  decimal: [
    p('value', 'Exact decimal text', 'string'),
    m('toString', 'toString()', 'Exact decimal text', 'string'),
    m('valueOf', 'valueOf()', 'As a (float) number, for arithmetic', 'number'),
  ],
  long: [
    p('value', 'Exact integer text', 'string'),
    m('toString', 'toString()', 'Exact integer text', 'string'),
    m('valueOf', 'valueOf()', 'As a number (exact up to 2^53)', 'number'),
  ],
  uuid: [p('value', 'UUID text', 'string'), m('toString', 'toString()', 'UUID text', 'string')],
  array: [
    p('length', 'Number of elements', 'number'),
    m('forEach', 'forEach((${1:@x}) => {\n\t$0\n})', 'Run a function for each element'),
    m('map', `map${CB}`, 'New array of mapped values', 'array'),
    m('filter', `filter${CB}`, 'Elements matching a condition', 'same'),
    m('find', `find${CB}`, 'First element matching a condition', 'elem'),
    m('findLast', `findLast${CB}`, 'Last element matching a condition', 'elem'),
    m('findIndex', `findIndex${CB}`, 'Index of the first match (-1 if none)', 'number'),
    m('some', `some${CB}`, 'Does any element match?', 'boolean'),
    m('every', `every${CB}`, 'Do all elements match?', 'boolean'),
    m('flatMap', `flatMap${CB}`, 'Map and flatten one level', 'array'),
    m('reduce', 'reduce((${1:acc}, ${2:@x}) => ${1:acc} + ${2:@x}$0, ${3:0})', 'Fold into one value (sum, object, …)'),
    m('sort', 'sort((${1:a}, ${2:b}) => ${1:a}$0 - ${2:b})', 'Sort in place with a comparator', 'same'),
    m('toSorted', 'toSorted((${1:a}, ${2:b}) => ${1:a}$0 - ${2:b})', 'Sorted copy', 'same'),
    m('includes', 'includes($0)', 'Contains the value?', 'boolean'),
    m('indexOf', 'indexOf($0)', 'Index of the value (-1 if missing)', 'number'),
    m('join', 'join("${1:, }")', 'Join into a string', 'string'),
    m('slice', 'slice(${1:0}, ${2:10})', 'Part of the array', 'same'),
    m('concat', 'concat($0)', 'Joined with other arrays', 'same'),
    m('reverse', 'reverse()', 'Reverse in place', 'same'),
    m('at', 'at(${1:-1})', 'Element at a position (negative from the end)', 'elem'),
    m('push', 'push($0)', 'Append (returns the new length)', 'number'),
    m('pop', 'pop()', 'Remove and return the last element', 'elem'),
    m('shift', 'shift()', 'Remove and return the first element', 'elem'),
    m('unshift', 'unshift($0)', 'Prepend (returns the new length)', 'number'),
    m('flat', 'flat()', 'Flatten one level', 'array'),
    m('fill', 'fill($0)', 'Fill with a value', 'same'),
  ],
  map: [
    p('size', 'Number of entries', 'number'),
    m('get', 'get($0)', 'Value for a key'),
    m('set', 'set(${1:key}, ${2:value})', 'Store a value (chainable)', 'map'),
    m('has', 'has($0)', 'Has the key?', 'boolean'),
    m('delete', 'delete($0)', 'Remove a key', 'boolean'),
    m('keys', 'keys()', 'Iterator of keys (spread with [...])'),
    m('values', 'values()', 'Iterator of values (spread with [...])'),
    m('entries', 'entries()', 'Iterator of [key, value] pairs'),
    m('forEach', 'forEach((${1:value}, ${2:key}) => {\n\t$0\n})', 'Run a function for each entry'),
    m('clear', 'clear()', 'Remove everything'),
  ],
  set: [
    p('size', 'Number of values', 'number'),
    m('add', 'add($0)', 'Add a value (chainable)', 'set'),
    m('has', 'has($0)', 'Contains the value?', 'boolean'),
    m('delete', 'delete($0)', 'Remove a value', 'boolean'),
    m('values', 'values()', 'Iterator of values (spread with [...])'),
    m('forEach', 'forEach((${1:value}) => {\n\t$0\n})', 'Run a function for each value'),
    m('clear', 'clear()', 'Remove everything'),
  ],
  object: [m('hasOwnProperty', 'hasOwnProperty("$0")', 'Has its own property?', 'boolean')],
  regexp: [
    m('test', 'test($0)', 'Does the text match?', 'boolean'),
    m('exec', 'exec($0)', 'Match details (array or null)', 'array', 'string'),
    p('source', 'Pattern text', 'string'),
    p('flags', 'Flags (g, i, m, …)', 'string'),
  ],
};

/** Static members of built-in namespaces available in the script worker. */
export const NAMESPACES: Record<string, JsMember[]> = {
  Math: [
    m('max', 'max($0)', 'Largest of the numbers', 'number'),
    m('min', 'min($0)', 'Smallest of the numbers', 'number'),
    m('round', 'round($0)', 'Round to the nearest integer', 'number'),
    m('floor', 'floor($0)', 'Round down', 'number'),
    m('ceil', 'ceil($0)', 'Round up', 'number'),
    m('trunc', 'trunc($0)', 'Drop the fraction', 'number'),
    m('abs', 'abs($0)', 'Absolute value', 'number'),
    m('pow', 'pow(${1:base}, ${2:exp})', 'Power', 'number'),
    m('sqrt', 'sqrt($0)', 'Square root', 'number'),
    m('sign', 'sign($0)', '-1, 0 or 1', 'number'),
    m('random', 'random()', 'Random number in [0, 1)', 'number'),
    p('PI', 'π', 'number'),
  ],
  JSON: [
    m('stringify', 'stringify(${1:value}, null, ${2:2})', 'JSON text (BSON helpers become EJSON)', 'string'),
    m('parse', 'parse($0)', 'Parse JSON text'),
  ],
  Object: [
    m('keys', 'keys($0)', 'Own property names', 'array', 'string'),
    m('values', 'values($0)', 'Own property values', 'array'),
    m('entries', 'entries($0)', '[key, value] pairs', 'array', 'array'),
    m('fromEntries', 'fromEntries($0)', 'Object from [key, value] pairs', 'object'),
    m('assign', 'assign({}, $0)', 'Copy properties', 'object'),
    m('groupBy', 'groupBy(${1:items}, (${2:x}) => ${2:x}.$0)', 'Group array items into an object by a key', 'object'),
    m('freeze', 'freeze($0)', 'Make read-only'),
  ],
  Array: [
    m('from', 'from($0)', 'Array from an iterable (Set, Map.keys(), …)', 'array'),
    m('isArray', 'isArray($0)', 'Is it an array?', 'boolean'),
    m('of', 'of($0)', 'Array of the arguments', 'array'),
  ],
  Number: [
    m('parseInt', 'parseInt($0)', 'Integer from text', 'number'),
    m('parseFloat', 'parseFloat($0)', 'Number from text', 'number'),
    m('isInteger', 'isInteger($0)', 'Is it an integer?', 'boolean'),
    m('isFinite', 'isFinite($0)', 'Is it a finite number?', 'boolean'),
    m('isNaN', 'isNaN($0)', 'Is it NaN?', 'boolean'),
    p('MAX_SAFE_INTEGER', 'Largest exact integer (2^53 - 1)', 'number'),
  ],
  Date: [
    m('now', 'now()', 'Current time in milliseconds', 'number'),
    m('parse', 'parse("$0")', 'Milliseconds from date text', 'number'),
    m('UTC', 'UTC(${1:2026}, ${2:0}, ${3:1})', 'Milliseconds for a UTC date (month 0–11)', 'number'),
  ],
  console: [
    m('log', 'log($0)', 'Print to the console'),
    m('info', 'info($0)', 'Print to the console'),
    m('debug', 'debug($0)', 'Print to the console'),
    m('warn', 'warn($0)', 'Print a warning (amber)'),
    m('error', 'error($0)', 'Print an error (red)'),
  ],
};

/** Results of global functions / constructors (`new Date()`, `ObjectId()`, `String(x)`). */
export const GLOBAL_RETURNS: Record<string, JsKind> = {
  Date: 'date',
  ISODate: 'date',
  ObjectId: 'objectId',
  NumberDecimal: 'decimal',
  Decimal128: 'decimal',
  NumberLong: 'long',
  Long: 'long',
  NumberInt: 'number',
  Int32: 'number',
  UUID: 'uuid',
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
  parseInt: 'number',
  parseFloat: 'number',
  isNaN: 'boolean',
  tojson: 'string',
  Map: 'map',
  Set: 'set',
  RegExp: 'regexp',
  Array: 'array',
  Object: 'object',
};

/** JS kind of a documented / sampled field type (scalar fields only). */
export function kindOfFieldType(type: string | undefined): JsKind | null {
  switch ((type ?? '').toLowerCase()) {
    case 'string':
      return 'string';
    case 'date':
      return 'date';
    case 'objectid':
      return 'objectId';
    case 'int32':
    case 'int':
    case 'double':
    case 'number':
    case 'integer':
      return 'number';
    case 'long':
    case 'int64':
      return 'long';
    case 'decimal128':
    case 'decimal':
      return 'decimal';
    case 'uuid':
      return 'uuid';
    case 'boolean':
    case 'bool':
      return 'boolean';
    default:
      return null;
  }
}

/** Statement snippets offered at the start of a statement: [label, insert, doc]. */
export const STATEMENTS: [string, string, string][] = [
  ['const', 'const ${1:name} = $0;', 'Constant'],
  ['let', 'let ${1:name} = $0;', 'Variable'],
  ['if', 'if (${1:condition}) {\n\t$0\n}', 'if statement'],
  ['ifelse', 'if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}', 'if / else'],
  ['for', 'for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}', 'Counting loop'],
  ['forof', 'for (const ${1:item} of ${2:items}) {\n\t$0\n}', 'Loop over an array / cursor.toArray()'],
  ['forin', 'for (const ${1:key} in ${2:object}) {\n\t$0\n}', 'Loop over object keys'],
  ['while', 'while (${1:condition}) {\n\t$0\n}', 'while loop'],
  ['switch', 'switch (${1:value}) {\n\tcase ${2:"A"}:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}', 'switch statement'],
  ['try', 'try {\n\t$1\n} catch (e) {\n\tprint("error:", e.message);$0\n}', 'try / catch'],
  ['function', 'function ${1:name}(${2:args}) {\n\t$0\n}', 'Function declaration'],
  ['arrow', 'const ${1:name} = (${2:x}) => $0;', 'Arrow function'],
  ['return', 'return $0;', 'return'],
  // Mongo-flavoured recipes
  ['cursorLoop', 'const ${1:cursor} = db.${2:policies}.find({ $3 });\nwhile (${1:cursor}.hasNext()) {\n\tconst ${4:doc} = ${1:cursor}.next();\n\t$0\n}', 'Iterate a cursor document by document'],
  ['countBy', 'const ${1:counts} = {};\ndb.${2:policies}.find({ $3 }).forEach((${4:doc}) => {\n\tconst k = ${4:doc}.${5:status};\n\t${1:counts}[k] = (${1:counts}[k] || 0) + 1;\n});\nprintjson(${1:counts});$0', 'Count documents per field value'],
  ['findById', 'db.${1:policies}.findOne({ _id: ObjectId("$2") })$0', 'Document by ObjectId'],
  ['loadChildren', 'const ${1:parents} = db.${2:policies}.find({ $3 }).limit(${4:100}).toArray();\nconst ${5:children} = db.${6:claims}.find({ ${7:policyId}: { \\$in: ${1:parents}.map((p) => p._id) } }).toArray();\n$0', 'Batched $in join: parents, then their children in one query'],
  ['groupBy', 'const ${1:byKey} = new Map();\nfor (const ${2:doc} of ${3:docs}) {\n\tconst k = String(${2:doc}.${4:policyId});\n\tif (!${1:byKey}.has(k)) ${1:byKey}.set(k, []);\n\t${1:byKey}.get(k).push(${2:doc});\n}\n$0', 'Group documents into a Map by a key'],
  ['timed', 'const t0 = Date.now();\n$0\nprint("took", Date.now() - t0, "ms");', 'Measure how long a block takes'],
];

/** Keywords / literals offered anywhere an expression can start. */
export const KEYWORDS: [string, string][] = [
  ['true', 'Boolean true'],
  ['false', 'Boolean false'],
  ['null', 'null'],
  ['undefined', 'undefined'],
  ['new', 'Create an instance (new Date(), new Map(), new Set())'],
  ['typeof', 'Type name of a value'],
  ['instanceof', 'Instance check'],
  ['break', 'Leave a loop / switch'],
  ['continue', 'Next loop iteration'],
];
