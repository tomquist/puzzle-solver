import type { ReactNode } from 'react';
import { IconBack } from './Icons';

/** Sticky page header with optional back link, title, subtitle and actions. */
export function TopBar({
  title,
  subtitle,
  back,
  onBack,
  backLabel = 'Back',
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: string;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {onBack ? (
          <button className="icon-btn" onClick={onBack} aria-label={backLabel}>
            <IconBack />
          </button>
        ) : back ? (
          <a className="icon-btn" href={back} aria-label={backLabel}>
            <IconBack />
          </a>
        ) : (
          <span className="topbar-logo" aria-hidden="true">
            🧩
          </span>
        )}
        <div className="topbar-title">
          <h1>{title}</h1>
          {subtitle && <div className="topbar-sub">{subtitle}</div>}
        </div>
        {actions && <div className="topbar-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
