/**
 * AdShield — utilitários de domínio.
 *
 * Usado pelo service worker para decidir sob qual domínio guardar uma regra de
 * ocultação personalizada. Sem a Public Suffix List completa, uma lista curta
 * de sufixos de dois níveis evita o erro clássico de guardar a regra em
 * "com.br" (o que aplicaria o bloqueio a todos os sites brasileiros).
 */

/** Sufixos públicos de dois níveis mais comuns. */
export const MULTI_PART_SUFFIXES = new Set([
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br', 'blog.br', 'eco.br', 'eng.br',
  'jus.br', 'leg.br', 'med.br', 'nom.br', 'pro.br', 'psi.br', 'rec.br', 'srv.br', 'tmp.br',
  'tur.br', 'tv.br', 'vet.br',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk',
  'com.ar', 'com.co', 'com.mx', 'com.pe', 'com.ve', 'com.ec', 'com.uy', 'com.py', 'com.bo',
  'com.cl', 'com.pt', 'com.es', 'com.it', 'com.fr', 'com.de', 'com.tr', 'com.ru', 'com.cn',
  'com.hk', 'com.sg', 'com.my', 'com.ph', 'com.tw', 'com.ua', 'com.pl', 'com.gr', 'com.cy',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Hosts candidatos do mais específico ao mais genérico (sem o TLD sozinho). */
export function hostCandidates(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  const result = [];
  for (let index = 0; index < parts.length - 1; index++) result.push(parts.slice(index).join('.'));
  return result;
}

/**
 * Domínio registrável: "www.exemplo.com.br" → "exemplo.com.br".
 * IPs e hosts de um rótulo voltam como vieram.
 */
export function registrableDomain(host) {
  const clean = String(host || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  if (!clean) return '';
  if (IPV4.test(clean) || clean.includes(':') || !clean.includes('.')) return clean;

  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}
