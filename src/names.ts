import { LabError } from './errors';

export type QueryType = 'A' | 'AAAA';

export function normalizeName(input: string, allowRoot = false): string {
  if (typeof input !== 'string' || input.length > 254 || /[^\x00-\x7f]/.test(input)) {
    throw new LabError('InvalidArgument', 'Name exceeds the supported hostname subset');
  }
  const name = input.endsWith('.') ? input.slice(0, -1).toLowerCase() : input.toLowerCase();
  if (!name && allowRoot) return '';
  if (!name || name.length > 253 || !name.split('.').every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new LabError('InvalidArgument', 'Use ASCII hostname labels, without escapes or wildcards');
  }
  return name;
}

export function isAncestor(owner: string, name: string): boolean {
  const a = owner ? owner.split('.') : [];
  const b = name.split('.');
  return a.length <= b.length && a.every((label, i) => label === b[b.length - a.length + i]);
}

export function queryType(type: string): QueryType {
  if (type !== 'A' && type !== 'AAAA') throw new LabError('InvalidArgument', 'Only A and AAAA are supported');
  return type;
}
