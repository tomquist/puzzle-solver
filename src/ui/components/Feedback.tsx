/** Loading, progress, empty/error states, banners and snackbars. */
import { useEffect, type ReactNode } from 'react';
import type { Severity } from '../../model/types';
import { IconAlert, IconClose, IconError, IconInfo } from './Icons';

export function Spinner({ label, inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? 'spinner-row inline' : 'spinner-row'} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="muted">{label}</span>}
    </div>
  );
}

export function ProgressBar({ value, label, detail }: { value: number; label?: string; detail?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      {(label || detail) && (
        <div className="progress-head">
          <span>{label}</span>
          <span className="muted tabular">{detail ?? `${pct}%`}</span>
        </div>
      )}
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  tone,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: 'error';
}) {
  return (
    <div className="empty">
      {icon && <div className={tone ? `empty-icon ${tone}` : 'empty-icon'}>{icon}</div>}
      <h2>{title}</h2>
      {children && <div className="empty-body">{children}</div>}
      {actions && <div className="row center wrap gap">{actions}</div>}
    </div>
  );
}

/** Turn anything thrown into a user-presentable sentence. */
export function errorText(e: unknown, fallback = 'Something went wrong.'): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return fallback;
}

export function ErrorState({ title = 'Something went wrong', error, onRetry, actions }: { title?: string; error?: unknown; onRetry?: () => void; actions?: ReactNode }) {
  return (
    <EmptyState
      icon={<IconError size={32} />}
      tone="error"
      title={title}
      actions={
        <>
          {onRetry && (
            <button className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          )}
          {actions}
        </>
      }
    >
      {error !== undefined && <p>{errorText(error)}</p>}
    </EmptyState>
  );
}

export const SEVERITY_ICON: Record<Severity, (p: { size?: number }) => ReactNode> = {
  error: IconError,
  warning: IconAlert,
  info: IconInfo,
};

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
}: {
  tone?: Severity | 'ok';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = tone === 'ok' ? IconInfo : SEVERITY_ICON[tone];
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="banner-icon">
        <Icon size={20} />
      </span>
      <div className="banner-body">
        {title && <strong>{title}</strong>}
        {children && <div className="banner-text">{children}</div>}
      </div>
      {action && <div className="banner-action">{action}</div>}
      {onDismiss && (
        <button className="icon-btn small" onClick={onDismiss} aria-label="Dismiss">
          <IconClose size={18} />
        </button>
      )}
    </div>
  );
}

export interface SnackbarMessage {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** A transient message at the bottom of the screen with an optional action (e.g. Undo). */
export function Snackbar({ message, onClose, duration = 8000 }: { message: SnackbarMessage | undefined; onClose: () => void; duration?: number }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [message, onClose, duration]);
  if (!message) return null;
  return (
    <div className="snackbar" role="status" aria-live="polite">
      <span>{message.text}</span>
      {message.actionLabel && (
        <button
          className="btn btn-ghost btn-on-dark"
          onClick={() => {
            message.onAction?.();
            onClose();
          }}
        >
          {message.actionLabel}
        </button>
      )}
    </div>
  );
}
