// Trusted local project configuration. The query flag never supplies a URL.
export const PROGRESS_REPORT_URL = 'http://localhost:4191/';

export function progressReportTarget(href, reportUrl = PROGRESS_REPORT_URL) {
  if (!new URL(href).searchParams.has('progress-report')) return null;
  const target = new URL(reportUrl);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new TypeError('Progress Report requires a trusted HTTP(S) destination');
  }
  return target.href;
}

export function mountProgressReportLink(document, href) {
  const target = progressReportTarget(href);
  if (!target || document.getElementById('progress-report-link')) return;
  const link = document.createElement('a');
  link.id = 'progress-report-link';
  link.href = target;
  link.textContent = 'Progress Report';
  link.setAttribute('aria-label', 'Return to the project Progress Report');
  document.body.append(link);
}
