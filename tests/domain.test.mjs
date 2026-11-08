/**
 * Testes dos utilitários de domínio.
 * Regressão do bug em que uma regra de "exemplo.com.br" era guardada em
 * "com.br" — o que aplicaria o bloqueio a todos os sites brasileiros.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostCandidates, registrableDomain } from '../src/common/domain.js';

test('domínio simples fica como está', () => {
  assert.equal(registrableDomain('exemplo.com'), 'exemplo.com');
  assert.equal(registrableDomain('EXEMPLO.COM'), 'exemplo.com');
});

test('www é removido', () => {
  assert.equal(registrableDomain('www.youtube.com'), 'youtube.com');
  assert.equal(registrableDomain('www.exemplo.com.br'), 'exemplo.com.br');
});

test('sufixo de dois níveis mantém três rótulos', () => {
  assert.equal(registrableDomain('exemplo.com.br'), 'exemplo.com.br');
  assert.equal(registrableDomain('noticias.exemplo.com.br'), 'exemplo.com.br');
  assert.equal(registrableDomain('a.b.exemplo.com.br'), 'exemplo.com.br');
  assert.equal(registrableDomain('site.co.uk'), 'site.co.uk');
  assert.equal(registrableDomain('loja.site.com.au'), 'site.com.au');
});

test('subdomínio comum volta ao domínio registrável', () => {
  assert.equal(registrableDomain('mail.google.com'), 'google.com');
  assert.equal(registrableDomain('a.b.c.exemplo.net'), 'exemplo.net');
});

test('IP e host de um rótulo não são quebrados', () => {
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('[::1]'), '[::1]');
});

test('entrada vazia ou inválida devolve vazio', () => {
  assert.equal(registrableDomain(''), '');
  assert.equal(registrableDomain(undefined), '');
});

test('hostCandidates vai do específico ao genérico', () => {
  assert.deepEqual(hostCandidates('www.youtube.com'), ['www.youtube.com', 'youtube.com']);
  assert.deepEqual(hostCandidates('a.exemplo.com.br'), ['a.exemplo.com.br', 'exemplo.com.br', 'com.br']);
});
