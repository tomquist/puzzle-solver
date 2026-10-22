/** Puzzle workspace: header with progress and the Scan / Picture / History / Settings tabs. */
import { useEffect } from 'react';
import { Banner } from '../../components/Feedback';
import { GridJobStrip, GridSuggestionCard } from '../../components/GridSuggestion';
import { IconHistory, IconImage, IconScan, IconSettings } from '../../components/Icons';
import { TopBar } from '../../components/TopBar';
import { usePuzzle } from '../../context/PuzzleContext';
import { placedCount, progressPercent, totalCells } from '../../lib/progress';
import { href, type PuzzleTab } from '../../lib/routes';
import { rememberTab } from '../../lib/lastTab';
import { HistoryTab } from './HistoryTab';
import { PictureTab } from './PictureTab';
import { ScanTab } from './ScanTab';
import { SettingsTab } from './SettingsTab';

const TABS: { id: PuzzleTab; label: string; Icon: typeof IconScan }[] = [
  { id: 'scan', label: 'Scan', Icon: IconScan },
  { id: 'picture', label: 'Picture', Icon: IconImage },
  { id: 'history', label: 'History', Icon: IconHistory },
  { id: 'settings', label: 'Settings', Icon: IconSettings },
];

export function ProgressSummary() {
  const { puzzle, progress } = usePuzzle();
  const pct = progressPercent(progress, puzzle.grid);
  return (
    <span className="header-progress" aria-label={`${pct}% placed`}>
      <span className="progress-track">
        <span className="progress-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular">
        {pct}% · {placedCount(progress, puzzle.grid)}/{totalCells(puzzle.grid)} placed
      </span>
    </span>
  );
}

export function PuzzleWorkspace({ tab }: { tab: PuzzleTab }) {
  const { puzzle, matcher, scanJob } = usePuzzle();
  const analysing = scanJob?.kind === 'running';
  useEffect(() => rememberTab(puzzle.id, tab), [puzzle.id, tab]);
  return (
    <>
      <TopBar title={puzzle.name} back={href.home()} backLabel="All puzzles" subtitle={<ProgressSummary />} />
      <nav className="tabbar" aria-label="Puzzle sections">
        {TABS.map(({ id, label, Icon }) => (
          <a key={id} href={href.puzzle(puzzle.id, id)} className={id === tab ? 'tab active' : 'tab'} aria-current={id === tab ? 'page' : undefined}>
            <span className="tab-icon">
              <Icon size={22} />
              {id === 'scan' && analysing && <span className="tab-busy" aria-label="Analysing" />}
            </span>
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <main className="page with-tabbar stack" data-testid={`tab-${tab}`}>
        {matcher.kind === 'error' && (
          <Banner tone="error" title="The puzzle picture could not be prepared">
            {matcher.message}
          </Banner>
        )}
        <GridJobStrip />
        {tab !== 'settings' && <GridSuggestionCard />}
        {analysing && tab !== 'scan' && (
          <a className="job-strip" href={href.puzzle(puzzle.id, 'scan')} data-testid="job-strip">
            <span className="spinner small-spinner" aria-hidden="true" />
            <span className="grow">{scanJob.message}</span>
            <span className="tabular">{Math.round(scanJob.progress * 100)}%</span>
          </a>
        )}
        {tab === 'scan' && <ScanTab />}
        {tab === 'picture' && <PictureTab />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'settings' && <SettingsTab />}
      </main>
    </>
  );
}
