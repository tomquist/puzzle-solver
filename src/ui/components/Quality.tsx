/** Reusable quality feedback: banner summary + issue list (scan results, box detection, reference). */
import { useState } from 'react';
import type { QualityIssue, QualityReport } from '../../model/types';
import { sortIssues, worstSeverity } from '../lib/quality';
import { SEVERITY_ICON } from './Feedback';
import { IconCheck, IconChevron } from './Icons';

export function issueKey(issue: QualityIssue, index: number): string {
  return `${issue.code}-${index}`;
}

export function IssueList({
  issues,
  selected,
  onSelect,
}: {
  issues: QualityIssue[];
  selected?: QualityIssue;
  onSelect?: (issue: QualityIssue | undefined) => void;
}) {
  const sorted = sortIssues(issues);
  return (
    <ul className="issue-list">
      {sorted.map((issue, i) => {
        const Icon = SEVERITY_ICON[issue.severity];
        const locatable = !!onSelect && (!!issue.regionIds?.length || !!issue.area);
        const active = selected === issue;
        const body = (
          <>
            <span className={`issue-icon sev-${issue.severity}`}>
              <Icon size={18} />
            </span>
            <span className="issue-text">
              <span className="issue-msg">{issue.message}</span>
              {issue.hint && <span className="issue-hint">{issue.hint}</span>}
            </span>
            {locatable && <span className="issue-show">{active ? 'Hide' : 'Show'}</span>}
          </>
        );
        return (
          <li key={issueKey(issue, i)} className={`issue sev-${issue.severity}${active ? ' active' : ''}`}>
            {locatable ? (
              <button className="issue-btn" onClick={() => onSelect(active ? undefined : issue)} aria-pressed={active}>
                {body}
              </button>
            ) : (
              <div className="issue-btn static">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Collapsible summary of a quality report. Shows "looks good" when there are no issues (unless
 * `hideWhenClean`), otherwise the worst severity colour and the issue list.
 */
export function QualityBanner({
  report,
  issues: issuesProp,
  subject = 'photo',
  selected,
  onSelect,
  defaultOpen,
  hideWhenClean = false,
}: {
  report?: QualityReport;
  issues?: QualityIssue[];
  subject?: string;
  selected?: QualityIssue;
  onSelect?: (issue: QualityIssue | undefined) => void;
  defaultOpen?: boolean;
  hideWhenClean?: boolean;
}) {
  const issues = issuesProp ?? report?.issues ?? [];
  const worst = worstSeverity(issues);
  const [open, setOpen] = useState(defaultOpen ?? worst === 'error');
  if (!worst) {
    if (hideWhenClean) return null;
    return (
      <div className="quality quality-ok">
        <span className="issue-icon sev-ok">
          <IconCheck size={18} />
        </span>
        <span>The {subject} looks good.</span>
      </div>
    );
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const summary =
    errors > 0
      ? `${errors === 1 ? 'A problem' : `${errors} problems`} with this ${subject}`
      : warnings > 0
        ? `${warnings === 1 ? '1 thing' : `${warnings} things`} to improve`
        : `${issues.length === 1 ? 'A note' : `${issues.length} notes`} about this ${subject}`;
  const Icon = SEVERITY_ICON[worst];
  return (
    <div className={`quality quality-${worst}${open ? ' open' : ''}`}>
      <button className="quality-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`issue-icon sev-${worst}`}>
          <Icon size={18} />
        </span>
        <span className="quality-summary">{summary}</span>
        {!open && <span className="quality-first muted">{sortIssues(issues)[0].message}</span>}
        <IconChevron size={18} className="chev" />
      </button>
      {open && <IssueList issues={issues} selected={selected} onSelect={onSelect} />}
    </div>
  );
}
