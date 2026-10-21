/** Small footer line with the running build: which version a user has, e.g. when reporting a problem. */
import { versionLabel } from '../../appVersion';

export function AppVersion() {
  return (
    <p className="app-version small muted" data-testid="app-version">
      {versionLabel()}
    </p>
  );
}
