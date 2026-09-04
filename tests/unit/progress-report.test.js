import test from 'node:test';
import assert from 'node:assert/strict';
import { mountProgressReportLink, progressReportTarget, PROGRESS_REPORT_URL } from '../../src/ui/progress-report.js';

test('report flag ignores injected destinations and stays absent in ordinary play', () => {
  assert.equal(progressReportTarget('http://localhost:4173/?mute=1#menu'), null);
  assert.equal(progressReportTarget('http://localhost:4173/?mute=1&progress-report#menu'), PROGRESS_REPORT_URL);
  assert.equal(progressReportTarget('http://localhost:4173/?progress-report=https://example.invalid/'), PROGRESS_REPORT_URL);
  assert.throws(() => progressReportTarget('http://localhost/?progress-report', 'javascript:alert(1)'), /trusted/);
  assert.throws(() => progressReportTarget('http://localhost/?progress-report', 'https://user:secret@example.invalid'), /trusted/);
});

test('normal visits create no developer UI; flagged visits mount just one return link', () => {
  const elements = [];
  const document = {
    getElementById: id => elements.find(e => e.id === id),
    createElement: tag => ({ tag, setAttribute(name, value) { this[name] = value; } }),
    body: { append: element => elements.push(element) },
  };
  mountProgressReportLink(document, 'http://localhost:4173/?mute=1');
  assert.equal(elements.length, 0);
  mountProgressReportLink(document, 'http://localhost:4173/?mute=1&progress-report');
  mountProgressReportLink(document, 'http://localhost:4173/?mute=1&progress-report');
  assert.equal(elements.length, 1);
  assert.equal(elements[0].tag, 'a');
  assert.equal(elements[0].href, PROGRESS_REPORT_URL);
  assert.equal(elements[0]['aria-label'], 'Return to the project Progress Report');
});
